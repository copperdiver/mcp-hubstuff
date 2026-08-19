import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OAUTH_SCOPE } from "../src/oauth.js";
import { createHttpApp } from "../src/server.js";

const issuer = "https://mcp.example.com";
const resource = `${issuer}/mcp`;
const statePath = join(tmpdir(), `hubstaff-mcp-oauth-${process.pid}-${Date.now()}.json`);
const app = createHttpApp(loadConfig({
  OAUTH_ISSUER: issuer,
  OAUTH_RESOURCE: resource,
  OAUTH_USERNAME: "owner",
  OAUTH_PASSWORD: "correct-horse-battery-staple",
  OAUTH_SIGNING_SECRET: "test-signing-secret-that-is-longer-than-32-characters",
  OAUTH_STATE_PATH: statePath,
}));

afterAll(async () => {
  await rm(statePath, { force: true });
});

describe("OAuth 2.1 server", () => {
  it("publishes discovery and completes DCR + authorization code PKCE + refresh", async () => {
    const metadata = await request(app).get("/.well-known/oauth-authorization-server").expect(200);
    expect(metadata.body.code_challenge_methods_supported).toContain("S256");
    expect(metadata.body.registration_endpoint).toBe(`${issuer}/oauth/register`);

    const protectedResource = await request(app).get("/.well-known/oauth-protected-resource").expect(200);
    expect(protectedResource.body).toMatchObject({ resource, authorization_servers: [issuer] });

    const registration = await request(app)
      .post("/oauth/register")
      .send({
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        token_endpoint_auth_method: "none",
      })
      .expect(201);
    const clientId = registration.body.client_id as string;

    const verifier = "pkce-verifier-with-more-than-forty-three-characters-1234567890";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        resource,
        scope: OAUTH_SCOPE,
        state: "test-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })
      .expect(200);
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(authorization.text)?.[1];
    expect(pendingId).toBeTruthy();
    expect(authorization.headers["content-security-policy"]).toContain("form-action 'self' https://chatgpt.com");

    await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({ pending_id: pendingId, username: "owner", password: "wrong-password", decision: "approve" })
      .expect(401);

    const approval = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({ pending_id: pendingId, username: "owner", password: "correct-horse-battery-staple", decision: "approve" })
      .expect(302);
    const callback = new URL(approval.headers.location);
    expect(callback.searchParams.get("state")).toBe("test-state");
    expect(callback.searchParams.get("iss")).toBe(issuer);

    const token = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        code: callback.searchParams.get("code"),
        code_verifier: verifier,
        resource,
      })
      .expect(200);
    expect(token.body).toMatchObject({ token_type: "Bearer", scope: OAUTH_SCOPE, expires_in: 3600 });

    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
      .expect(200);

    const refreshed = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "refresh_token", client_id: clientId, refresh_token: token.body.refresh_token, resource })
      .expect(200);
    expect(refreshed.body.refresh_token).not.toBe(token.body.refresh_token);

    await request(app)
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "refresh_token", client_id: clientId, refresh_token: token.body.refresh_token, resource })
      .expect(400, { error: "invalid_grant" });
  });

  it("returns an OAuth discovery challenge for anonymous MCP requests", async () => {
    const response = await request(app).post("/mcp").send({}).expect(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata=");
    expect(response.headers["www-authenticate"]).toContain(OAUTH_SCOPE);
  });

  it("rejects dynamic clients with untrusted redirects", async () => {
    await request(app)
      .post("/oauth/register")
      .send({ redirect_uris: ["https://attacker.example/callback"], token_endpoint_auth_method: "none" })
      .expect(400);
  });
});
