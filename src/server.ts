import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { hasHubstaffCredentials, hasOAuth } from "./config.js";
import { HubstaffClient } from "./hubstaff-client.js";
import { hubstaffErrorResult, registerTools } from "./tools.js";
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

function createMcpServer(client: HubstaffClient) {
  const server = new McpServer({ name: "hubstaff-mcp", version: "1.0.0" });
  const schemas = registerTools(server, client);
  return { server, schemas };
}

export function createHttpApp(config: Config) {
  const app = express();
  const client = new HubstaffClient(config);
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

  app.post("/mcp", async (request, response) => {
    const { server, schemas } = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const httpDiagnostic = currentDiagnostic()!;
    response.on("close", () => {
      const failed = (error: unknown) => inDiagnostic(httpDiagnostic, () => logDiagnostic("mcp.failed", {}, error));
      void transport.close().catch(failed);
      void server.close().catch(failed);
    });
    try {
      await server.connect(transport);
      const receive = transport.onmessage!;
      // Intercept messages only after the transport has checked HTTP headers,
      // protocol version and JSON-RPC envelopes. This also covers each batch item.
      transport.onmessage = (message, extra) => {
        const diagnostic = Array.isArray(request.body) ? newDiagnostic(httpDiagnostic) : httpDiagnostic;
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
      logDiagnostic("mcp.failed", {}, error);
      if (!response.headersSent) response.status(500).json({ error: {
        code: "INTERNAL_ERROR", category: "internal", message: "Internal MCP error",
        diagnostic_id: currentDiagnostic()?.diagnostic_id,
      } });
    }
  });

  app.all("/mcp", (_request, response) => {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Use POST for stateless Streamable HTTP MCP" });
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
