import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { HubstaffClient } from "../src/hubstaff-client.js";

afterEach(() => vi.unstubAllGlobals());

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
});
