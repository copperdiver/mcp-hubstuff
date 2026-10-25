import { describe, expect, it } from "vitest";
import { hasHubstaffCredentials, hasOAuth, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires an explicit positive unique organization scope only when events are enabled", () => {
    expect(loadConfig({}).events).toMatchObject({ enabled: false, organizationIds: [] });
    expect(() => loadConfig({ HUBSTAFF_EVENTS_ENABLED: "true" })).toThrow(/HUBSTAFF_EVENT_ORGANIZATION_IDS/);
    expect(() => loadConfig({ HUBSTAFF_EVENTS_ENABLED: "true", HUBSTAFF_EVENT_ORGANIZATION_IDS: "7,7" })).toThrow(/unique/);
  });

  it("uses the event scheduling defaults", () => {
    expect(loadConfig({ HUBSTAFF_EVENTS_ENABLED: "true", HUBSTAFF_EVENT_ORGANIZATION_IDS: "7" }).events)
      .toMatchObject({ statePath: "/data/events-state.json", retention: 1000,
        intervalsMs: { tasks: 300_000, activities: 1_200_000, timeEdits: 600_000, audit: 600_000 } });
  });

  it("loads explicit event configuration and trims organization IDs", () => {
    expect(loadConfig({
      HUBSTAFF_EVENTS_ENABLED: "false",
      HUBSTAFF_EVENT_ORGANIZATION_IDS: " 7, 12 ",
      HUBSTAFF_EVENT_STATE_PATH: "/custom/events.json",
      HUBSTAFF_EVENT_RETENTION: "25",
      HUBSTAFF_EVENT_TASKS_INTERVAL_MS: "100",
      HUBSTAFF_EVENT_ACTIVITIES_INTERVAL_MS: "200",
      HUBSTAFF_EVENT_TIME_EDITS_INTERVAL_MS: "300",
      HUBSTAFF_EVENT_AUDIT_INTERVAL_MS: "400",
    }).events).toEqual({
      enabled: false,
      organizationIds: [7, 12],
      statePath: "/custom/events.json",
      retention: 25,
      intervalsMs: { tasks: 100, activities: 200, timeEdits: 300, audit: 400 },
    });
  });

  it.each(["yes", "1", "TRUE", "", " true "])("rejects the invalid event boolean %j", (value) => {
    expect(() => loadConfig({ HUBSTAFF_EVENTS_ENABLED: value })).toThrow(/HUBSTAFF_EVENTS_ENABLED/);
  });

  it.each(["", " ", "0", "-7", "7.5", "abc", "7,", ",7", "7,,8", "7,07", "1e2", "0x7", "9007199254740993"])(
    "rejects invalid enabled organization scope %j", (value) => {
      expect(() => loadConfig({ HUBSTAFF_EVENTS_ENABLED: "true", HUBSTAFF_EVENT_ORGANIZATION_IDS: value }))
        .toThrow(/HUBSTAFF_EVENT_ORGANIZATION_IDS/);
    },
  );

  it.each([
    "HUBSTAFF_EVENT_RETENTION",
    "HUBSTAFF_EVENT_TASKS_INTERVAL_MS",
    "HUBSTAFF_EVENT_ACTIVITIES_INTERVAL_MS",
    "HUBSTAFF_EVENT_TIME_EDITS_INTERVAL_MS",
    "HUBSTAFF_EVENT_AUDIT_INTERVAL_MS",
  ])("rejects invalid positive integers for %s", (name) => {
    for (const value of ["0", "-1", "1.5", "nope", "", "1e3", "0x10", "9007199254740993"]) {
      expect(() => loadConfig({ [name]: value })).toThrow(name);
    }
  });

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
