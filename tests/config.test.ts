import { describe, expect, it } from "vitest";
import { hasHubstaffCredentials, hasOAuth, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads safe defaults without requiring Hubstaff credentials at startup", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.apiBase).toBe("https://api.hubstaff.com");
    expect(hasHubstaffCredentials(config)).toBe(false);
  });

  it("rejects a weak MCP bearer token", () => {
    expect(() => loadConfig({ MCP_AUTH_TOKEN: "short" })).toThrow(/at least 32/);
  });

  it("recognizes an organization token", () => {
    const config = loadConfig({ HUBSTAFF_ORGANIZATION_TOKEN: "hsoat_test" });
    expect(hasHubstaffCredentials(config)).toBe(true);
  });

  it("requires a complete, strong OAuth configuration", () => {
    expect(() => loadConfig({ OAUTH_ISSUER: "https://mcp.example.com" })).toThrow(/OAuth requires/);
    const config = loadConfig({
      OAUTH_ISSUER: "https://mcp.example.com",
      OAUTH_USERNAME: "owner",
      OAUTH_PASSWORD: "a-strong-password-123",
      OAUTH_SIGNING_SECRET: "a-signing-secret-with-at-least-32-characters",
    });
    expect(hasOAuth(config)).toBe(true);
    expect(config.oauthResource).toBe("https://mcp.example.com/mcp");
  });
});
