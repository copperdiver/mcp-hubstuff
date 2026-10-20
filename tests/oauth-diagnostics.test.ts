import { readFile, writeFile } from "node:fs/promises";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/server.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("redacts the existing OAuth exception log and correlates its safe server_error", async () => {
  const secret = "SYNTHETIC_SECRET_c871";
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected test fetch"); }));
  // Entire state and storage failure are synthetic; no credential file is touched.
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({
    clients: { example: { clientId: "example", clientName: "test", redirectUris: [], createdAt: 0 } },
    pending: {}, codes: {}, refreshTokens: {},
  }));
  vi.mocked(writeFile).mockRejectedValue(Object.assign(new Error(`Authorization: Bearer ${secret}`), {
    code: "EACCES", body: { refresh_token: secret },
  }));
  const app = createHttpApp(loadConfig({
    OAUTH_ISSUER: "https://example.test", OAUTH_RESOURCE: "https://example.test/mcp",
    OAUTH_USERNAME: "test", OAUTH_PASSWORD: "synthetic-password-for-tests",
    OAUTH_SIGNING_SECRET: "synthetic-signing-secret-at-least-32-characters",
    OAUTH_STATE_PATH: "synthetic-state-never-written.json",
  }));
  const response = await request(app).post("/oauth/token").type("form").send({
    client_id: "example", grant_type: "authorization_code", code: secret,
    code_verifier: secret, resource: "https://example.test/mcp",
  }).expect(500);
  expect(response.body).toMatchObject({ error: "server_error", diagnostic_id: expect.any(String) });
  expect(response.body.diagnostic_id).toBe(response.headers["x-diagnostic-id"]);
  expect(log.mock.calls[0]).toHaveLength(1);
  const event = JSON.parse(String(log.mock.calls[0]![0]));
  expect(event).toMatchObject({
    event: "oauth.failed", error_category: "internal", exception_code: "EACCES",
    diagnostic_id: response.body.diagnostic_id,
  });
  expect(JSON.stringify({ event, response: response.body })).not.toContain(secret);
});
