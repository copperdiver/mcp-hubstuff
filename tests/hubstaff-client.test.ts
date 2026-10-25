import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { HubstaffClient } from "../src/hubstaff-client.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

function metadataClient(headers?: HeadersInit, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json({ tasks: [] }, status, headers)));
  return new HubstaffClient(loadConfig({ HUBSTAFF_ORGANIZATION_TOKEN: "hsoat_example" }));
}

describe("HubstaffClient", () => {
  it("uses the organization token and serializes arrays with bracket query keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new HubstaffClient(loadConfig({ HUBSTAFF_ORGANIZATION_TOKEN: "hsoat_example" }));

    await client.get("/v2/organizations/1/tasks", { status: ["active", "completed"] });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/v2/organizations/1/tasks");
    expect(url.searchParams.getAll("status[]")).toEqual(["active", "completed"]);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer hsoat_example");
  });

  it("fails with a useful message when no Hubstaff credential exists", async () => {
    const client = new HubstaffClient(loadConfig({}));
    await expect(client.get("/v2/organizations")).rejects.toThrow(/not configured/);
  });

  it("returns rate-limit metadata alongside the response data", async () => {
    const client = metadataClient({
      "x-rate-limit-limit": "120", "x-rate-limit-remaining": "119", "x-rate-limit-reset": "1790000000",
    });
    await expect(client.getWithMeta("/v2/organizations/7/tasks")).resolves.toEqual({
      data: { tasks: [] },
      meta: { rateLimit: { limit: 120, remaining: 119, resetAt: 1_790_000_000_000 } },
    });
    await expect(client.get("/v2/organizations/7/tasks")).resolves.toEqual({ tasks: [] });
  });

  it("adds a retry delay in milliseconds to a 429 error", async () => {
    const client = metadataClient({ "retry-after": "12" }, 429);
    await expect(client.getWithMeta("/v2/organizations/7/tasks")).rejects.toMatchObject({
      status: 429, retryAfterMs: 12_000,
    });
  });

  it.each([
    "Sun, 25 Oct 2026 12:00:12 GMT",
    "Sunday, 25-Oct-26 12:00:12 GMT",
    "Sun Oct 25 12:00:12 2026",
  ])("parses HTTP-date retry delays and clamps past dates to zero: %s", async (date) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("Sun, 25 Oct 2026 12:00:00 GMT"));
    const future = metadataClient({ "retry-after": date }, 429);
    await expect(future.getWithMeta("/tasks")).rejects.toMatchObject({ retryAfterMs: 12_000 });
    const past = metadataClient({ "retry-after": "Sun, 25 Oct 2026 11:59:59 GMT" }, 429);
    await expect(past.getWithMeta("/tasks")).rejects.toMatchObject({ retryAfterMs: 0 });
  });

  it.each(["-1", "NaN", "Infinity", "", "12junk", "1e309", "Sun 1"])(
    "ignores invalid numeric rate and retry headers: %j", async (value) => {
      const client = metadataClient({
        "x-rate-limit-limit": value, "x-rate-limit-remaining": value, "x-rate-limit-reset": value,
      });
      await expect(client.getWithMeta("/tasks")).resolves.toEqual({ data: { tasks: [] }, meta: {} });
      const limited = metadataClient({ "retry-after": value }, 429);
      await expect(limited.getWithMeta("/tasks")).rejects.toMatchObject({ retryAfterMs: undefined });
    },
  );

  it("retains zero rate values and ignores missing headers", async () => {
    const zero = metadataClient({ "x-rate-limit-remaining": "0", "x-rate-limit-reset": "0" });
    await expect(zero.getWithMeta("/tasks")).resolves.toMatchObject({
      meta: { rateLimit: { remaining: 0, resetAt: 0 } },
    });
    await expect(metadataClient().getWithMeta("/tasks")).resolves.toEqual({ data: { tasks: [] }, meta: {} });
  });
});
