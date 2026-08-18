import { describe, expect, it } from "vitest";
import { hasHubstaffCredentials, loadConfig } from "../src/config.js";

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
});
