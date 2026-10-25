import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, JSONRPCRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema,
  isInitializeRequest, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { hasHubstaffCredentials, hasOAuth } from "./config.js";
import { HubstaffClient } from "./hubstaff-client.js";
import { eventResourceUri, hubstaffErrorResult, registerTools } from "./tools.js";
import type { EventStore } from "./events.js";
import type { EventMonitor } from "./event-monitor.js";
import { OAuthService, oauthMiddleware } from "./oauth.js";
import { ToolInputError } from "./errors.js";
import {
  currentDiagnostic, elapsed, inDiagnostic, logDiagnostic, newDiagnostic, setDiagnosticOperation,
} from "./diagnostics.js";

function bearerMatches(request: Request, expected: string): boolean {
  const authorization = request.header("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

type McpSession = { server: McpServer; transport: StreamableHTTPServerTransport; subscribedUris: Set<string> };

function createMcpServer(client: HubstaffClient, events?: EventStore) {
  const server = new McpServer({ name: "hubstaff-mcp", version: "1.0.0" });
  const schemas = registerTools(server, client, events);
  return { server, schemas };
}

export function createHttpApp(config: Config, events?: { store: EventStore; monitor: EventMonitor }) {
  const app = express();
  const client = new HubstaffClient(config);
  const sessions = new Map<string, McpSession>();
  const batchRequests = new WeakSet<object>();
  const enabledEvents = config.events.enabled ? events : undefined;
  const unsubscribe = enabledEvents?.monitor.onEvents((organizationId) => {
    const uri = eventResourceUri(organizationId);
    for (const session of sessions.values()) {
      if (session.subscribedUris.has(uri)) {
        void session.server.server.sendResourceUpdated({ uri }).catch((error: unknown) => {
          logDiagnostic("mcp.failed", {}, error);
        });
      }
    }
  });
  app.locals.close = async () => {
    enabledEvents?.monitor.stop();
    unsubscribe?.();
    await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
    sessions.clear();
  };
  app.disable("x-powered-by");
  app.use("/mcp", (_request, response, next) => {
    const diagnostic = newDiagnostic();
    response.setHeader("X-Diagnostic-Id", diagnostic.diagnostic_id);
    response.on("finish", () => inDiagnostic(diagnostic, () => logDiagnostic("mcp.completed", {
      http_status: response.statusCode, duration_ms: elapsed(diagnostic.started),
    })));
    inDiagnostic(diagnostic, next);
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const oauth = hasOAuth(config) ? new OAuthService(config) : undefined;
  const authenticateOAuth = oauth ? oauthMiddleware(oauth, config.mcpAuthToken) : undefined;
  if (oauth) app.use(oauth.router());

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", hubstaff_configured: hasHubstaffCredentials(config), oauth_configured: Boolean(oauth) });
  });

  app.get("/", (_request, response) => {
    response.json({ name: "hubstaff-mcp", transport: "streamable-http", endpoint: "/mcp", health: "/health" });
  });

  app.use("/mcp", (request: Request, response: Response, next: NextFunction) => {
    if (Array.isArray(request.body)) batchRequests.add(currentDiagnostic()!);
    setDiagnosticOperation(request.body?.method, request.body?.params?.name, request.body?.params?.arguments);
    if (authenticateOAuth) {
      authenticateOAuth(request, response, next).catch(next);
      return;
    }
    if (!config.mcpAuthToken) {
      response.status(503).json({ error: "MCP_AUTH_TOKEN is not configured" });
      return;
    }
    if (!bearerMatches(request, config.mcpAuthToken)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  app.all("/mcp", async (request, response, next) => {
    if (!["POST", "GET", "DELETE"].includes(request.method)) return next();
    const sessionId = request.header("Mcp-Session-Id");
    const retained = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId !== undefined && !retained) {
      response.status(404).json({ error: "Unknown MCP session" });
      return;
    }
    if (!retained && request.method !== "POST") {
      response.status(400).json({ error: "Mcp-Session-Id is required" });
      return;
    }
    if (retained) {
      try { await retained.transport.handleRequest(request, response, request.body); }
      catch (error) { next(error); }
      return;
    }
    const stateful = isInitializeRequest(request.body);
    const { server, schemas } = createMcpServer(client, enabledEvents?.store);
    const subscribedUris = new Set<string>();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: stateful ? () => randomUUID() : undefined,
      onsessioninitialized: (id) => { sessions.set(id, { server, transport, subscribedUris }); },
    });
    if (!stateful) response.on("close", () => {
      void server.close().catch((error: unknown) => logDiagnostic("mcp.failed", {}, error));
    });
    try {
      if (enabledEvents && stateful) {
        server.server.registerCapabilities({ resources: { subscribe: true } });
        server.server.setRequestHandler(SubscribeRequestSchema, ({ params }) => {
          if (!config.events.organizationIds.some((id) => eventResourceUri(id) === params.uri)) {
            throw new McpError(ErrorCode.InvalidParams, "Unknown event resource");
          }
          subscribedUris.add(params.uri);
          return {};
        });
        server.server.setRequestHandler(UnsubscribeRequestSchema, ({ params }) => {
          subscribedUris.delete(params.uri);
          return {};
        });
      }
      await server.connect(transport);
      const onclose = transport.onclose;
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        subscribedUris.clear();
        onclose?.();
      };
      const receive = transport.onmessage!;
      // Intercept messages only after the transport has checked HTTP headers,
      // protocol version and JSON-RPC envelopes. This also covers each batch item.
      transport.onmessage = (message, extra) => {
        const activeDiagnostic = currentDiagnostic() ?? newDiagnostic();
        const diagnostic = batchRequests.has(activeDiagnostic) ? newDiagnostic(activeDiagnostic) : activeDiagnostic;
        inDiagnostic(diagnostic, () => {
          const envelope = JSONRPCRequestSchema.safeParse(message);
          const call = CallToolRequestSchema.safeParse(message);
          if (envelope.success) {
            setDiagnosticOperation(envelope.data.method, envelope.data.params?.name, envelope.data.params?.arguments);
          }
          if (envelope.success && envelope.data.method === "tools/call") {
            const schema = call.success ? schemas.get(call.data.params.name) : undefined;
            if (!call.success || !schema || !schema.safeParse(call.data.params.arguments).success) {
              const result = hubstaffErrorResult(new ToolInputError(
                !call.success ? "Invalid tools/call parameters." :
                  schema ? "Invalid tool arguments. Check the tool input schema." : "Unknown Hubstaff tool.",
              ));
              void transport.send({ jsonrpc: "2.0", id: envelope.data.id, result })
                .catch((error: unknown) => logDiagnostic("mcp.failed", {}, error));
              return;
            }
          }
          receive(message, extra);
        });
      };
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      await server.close().catch((closeError: unknown) => logDiagnostic("mcp.failed", {}, closeError));
      logDiagnostic("mcp.failed", {}, error);
      if (!response.headersSent) response.status(500).json({ error: {
        code: "INTERNAL_ERROR", category: "internal", message: "Internal MCP error",
        diagnostic_id: currentDiagnostic()?.diagnostic_id,
      } });
    }
  });

  app.all("/mcp", (_request, response) => {
    response.setHeader("Allow", "POST, GET, DELETE");
    response.status(405).json({ error: "Use POST, GET or DELETE for Streamable HTTP MCP" });
  });

  app.use("/mcp", (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    // Preserve intentional parser/middleware 4xx responses (including charset,
    // compression and body size errors), without exposing their raw messages.
    const suppliedStatus = (error as { status?: unknown } | null)?.status;
    const status = typeof suppliedStatus === "number" && Number.isInteger(suppliedStatus) &&
      suppliedStatus >= 400 && suppliedStatus < 500 ? suppliedStatus : 500;
    const validation = status < 500;
    logDiagnostic("mcp.failed", { error_category: validation ? "validation" : "internal" },
      validation ? new ToolInputError("Invalid MCP request body.") : error);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.status(status).json({ error: {
      code: validation ? "INVALID_ARGUMENT" : "INTERNAL_ERROR",
      category: validation ? "validation" : "internal",
      message: validation ? "Invalid MCP request body." : "Internal MCP error",
      diagnostic_id: currentDiagnostic()?.diagnostic_id,
    } });
  });

  return app;
}
