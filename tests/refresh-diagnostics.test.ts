import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { HubstaffClient } from "../src/hubstaff-client.js";
import { inDiagnostic, newDiagnostic } from "../src/diagnostics.js";
import { hubstaffErrorResult } from "../src/tools.js";

// Token storage is entirely synthetic. No real credential or cache file is read or written.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn(),
}));

const secret = "FAKE_REFRESH_SECRET_9d12";
let logs: Record<string, any>[];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(JSON.parse(line)));
  vi.spyOn(console, "error").mockImplementation((line) => logs.push(JSON.parse(line)));
  vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("missing synthetic cache"), { code: "ENOENT" }));
  vi.mocked(writeFile).mockResolvedValue();
  fetchMock = vi.fn(() => { throw new Error("Unexpected test fetch"); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function client() {
  return new HubstaffClient(loadConfig({
    HUBSTAFF_ACCESS_TOKEN: secret, HUBSTAFF_REFRESH_TOKEN: secret,
    HUBSTAFF_API_BASE: `https://api.example.test/?api_key=${secret}`,
    HUBSTAFF_TOKEN_URL: `https://auth.example.test/token?client_secret=${secret}`,
    TOKEN_CACHE_PATH: "synthetic-cache-never-written.json",
  }));
}

async function runClient() {
  return inDiagnostic(newDiagnostic(), async () => {
    try {
      return await client().get("/v2/organizations/405914/tasks", { page_limit: 100 });
    } catch (error) {
      return hubstaffErrorResult(error);
    }
  });
}

describe("Hubstaff refresh diagnostics", () => {
  it("correlates standalone client attempts even without a tool context", async () => {
    fetchMock.mockResolvedValue(json({ tasks: [] }));
    const standalone = new HubstaffClient(loadConfig({ HUBSTAFF_ORGANIZATION_TOKEN: secret }));
    expect(await standalone.get("/v2/organizations/405914/tasks")).toEqual({ tasks: [] });
    expect(new Set(logs.map((event) => event.diagnostic_id)).size).toBe(1);
    expect(logs.at(-1)).toMatchObject({ attempts: 1, retries: 0 });
  });

  it("records the existing single 401 replay and counts refresh separately without logging tokens", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: secret, refresh_token: secret, expires_in: 3600 }))
      .mockResolvedValueOnce(json({ tasks: [] }));
    expect(await runClient()).toEqual({ tasks: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logs.filter((event) => event.event === "upstream.completed").map((event) => [
      event.phase, event.attempt, event.retry_count, event.upstream_status,
    ])).toEqual([["api", 1, 0, 401], ["token_refresh", 1, 0, 200], ["api", 2, 1, 200]]);
    expect(logs.at(-1)).toMatchObject({ attempts: 3, retries: 1 });
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("classifies refresh HTTP failure and does not replay the API request", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({ error_description: secret }, 400));
    const result = await runClient() as any;
    expect(result.structuredContent.result.error).toMatchObject({
      category: "upstream", code: "HUBSTAFF_INVALID_REQUEST", status: 400,
    });
    expect(logs.find((event) => event.event === "upstream.failed")).toMatchObject({
      phase: "token_refresh", upstream_status: 400, attempts: 2, retries: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify({ logs, result })).not.toContain(secret);
  });

  it("does not retry a second 401 after refreshing", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: secret, expires_in: 3600 }))
      .mockResolvedValueOnce(json({ error: secret }, 401));
    const result = await runClient() as any;
    expect(result.structuredContent.result.error.code).toBe("HUBSTAFF_AUTHENTICATION_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logs.at(-1)).toMatchObject({ attempts: 3, retries: 1, upstream_status: 401 });
  });

  it("classifies cache persistence errors as internal after a successful refresh", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: secret, expires_in: 3600 }));
    vi.mocked(writeFile).mockRejectedValue(Object.assign(new Error(secret), { code: "EACCES" }));
    const result = await runClient() as any;
    expect(result.structuredContent.result.error).toMatchObject({ category: "internal", code: "INTERNAL_ERROR" });
    expect(logs.at(-1)).toMatchObject({ exception_code: "EACCES", attempts: 2, retries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify({ logs, result })).not.toContain(secret);
  });

  it("classifies invalid local cache JSON as internal before any HTTP attempt", async () => {
    vi.mocked(readFile).mockResolvedValue(`{"access_token":"${secret}"`);
    const result = await runClient() as any;
    expect(result.structuredContent.result.error).toMatchObject({ category: "internal", code: "INTERNAL_ERROR" });
    expect(logs.at(-1)).toMatchObject({ exception_class: "SyntaxError", attempts: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify({ logs, result })).not.toContain(secret);
  });
});
