import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { hasHubstaffCredentials, hasOAuth } from "./config.js";
import { HubstaffClient } from "./hubstaff-client.js";
import { registerTools } from "./tools.js";
import { OAuthService, oauthMiddleware } from "./oauth.js";

function bearerMatches(request: Request, expected: string): boolean {
  const authorization = request.header("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function createMcpServer(client: HubstaffClient): McpServer {
  const server = new McpServer({ name: "hubstaff-mcp", version: "1.0.0" });
  registerTools(server, client);
  return server;
}

export function createHttpApp(config: Config) {
  const app = express();
  const client = new HubstaffClient(config);
  app.disable("x-powered-by");
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
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!response.headersSent) response.status(500).json({ error: "Internal MCP error" });
    }
  });

  app.all("/mcp", (_request, response) => {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Use POST for stateless Streamable HTTP MCP" });
  });

  return app;
}
