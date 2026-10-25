import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonEventStore, type EventStore } from "../src/events.js";
import { describe, expect, it, vi } from "vitest";
import { HubstaffApiError, type HubstaffClient } from "../src/hubstaff-client.js";
import { registerTools } from "../src/tools.js";

interface RegisteredTool {
  config: { description?: string };
  handler: (input: Record<string, unknown>) => Promise<{
    isError?: boolean;
    structuredContent?: { result?: Record<string, unknown> };
  }>;
}

function registeredTools(get: ReturnType<typeof vi.fn>) {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  const client = { get } as unknown as HubstaffClient;
  registerTools(server, client);
  return tools;
}

describe("Hubstaff MCP tools", () => {
  async function withEventClient(run: (client: Client, store: EventStore) => Promise<void>, enabled = true) {
    const directory = await mkdtemp(join(tmpdir(), "hubstaff-tools-events-"));
    const store = new JsonEventStore(join(directory, "state.json"), { retention: 100 });
    const server = new McpServer({ name: "event-test", version: "1" });
    const client = new Client({ name: "event-test", version: "1" });
    try {
      await store.load();
      await store.baseline("tasks", 7, { raw: "private upstream snapshot" });
      for (const [record, organizationId, type] of [
        ["41", 7, "task.created"], ["42", 8, "task.updated"], ["43", 7, "task.updated"],
      ] as const) {
        await store.append({ id: "ignored", organizationId, source: "tasks", type, sourceRecordId: record,
          sourceTimestamp: "2026-10-25T09:00:00Z", observedAt: "2026-10-25T09:01:00Z",
          priority: "normal", summary: `Task ${record} changed`, payload: { taskId: record } }, record, "watermark");
      }
      await store.setSourceStatus({ source: "tasks", organizationId: 7, status: "healthy" });
      registerTools(server, { get: vi.fn() } as unknown as HubstaffClient, enabled ? store : undefined);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await run(client, store);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("lists selected event types after an exclusive cursor with bounded pagination", async () => {
    await withEventClient(async (client) => {
      const first = await client.callTool({ name: "hubstaff_list_events", arguments: { organization_id: 7, limit: 1 } });
      expect(first.structuredContent?.result).toMatchObject({
        events: [expect.objectContaining({ id: "0000000000000001", type: "task.created" })],
        next_cursor: "0000000000000001", source_status: [{ source: "tasks", organizationId: 7, status: "healthy" }],
      });
      const selected = await client.callTool({ name: "hubstaff_list_events", arguments: {
        organization_id: 7, after: "0000000000000001", types: ["task.updated"], limit: 10,
      } });
      expect(selected.structuredContent?.result).toMatchObject({
        events: [expect.objectContaining({ id: "0000000000000003", type: "task.updated" })], next_cursor: "0000000000000003",
      });
      const empty = await client.callTool({ name: "hubstaff_list_events", arguments: {
        organization_id: 7, after: "0000000000000003",
      } });
      expect(empty.structuredContent?.result).toMatchObject({ events: [], next_cursor: "0000000000000003" });
      const tool = (await client.listTools()).tools.find((item) => item.name === "hubstaff_list_events")!;
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["hubstaff.read"] }]);
      expect(tool.inputSchema.properties?.limit).toMatchObject({ default: 50, minimum: 1, maximum: 100 });
    });
  });

  it("reads hubstaff://events/7 as stable JSON feed, cursor, and safe source status", async () => {
    await withEventClient(async (client) => {
      const resource = await client.readResource({ uri: "hubstaff://events/7" });
      expect(resource.contents[0]).toMatchObject({ uri: "hubstaff://events/7", mimeType: "application/json" });
      const text = (resource.contents[0] as { text: string }).text;
      expect(JSON.parse(text)).toMatchObject({
        events: [expect.objectContaining({ sourceRecordId: "41" }), expect.objectContaining({ sourceRecordId: "43" })],
        next_cursor: "0000000000000003", source_status: [{ source: "tasks", organizationId: 7, status: "healthy" }],
      });
      expect(text).not.toContain("private upstream snapshot");
      expect(await client.readResource({ uri: "hubstaff://events/7" })).toEqual(resource);
      const empty = await client.readResource({ uri: "hubstaff://events/99" });
      expect(JSON.parse((empty.contents[0] as { text: string }).text)).toEqual({ events: [], next_cursor: null, source_status: [] });
    });
  });

  it("refreshes the resource with the latest 50 events while preserving tool pagination", async () => {
    await withEventClient(async (client, store) => {
      const sample = store.list(7)[0]!;
      for (let i = 1; i <= 55; i++) {
        await store.append({ ...sample, sourceRecordId: `new-${i}` }, `new-${i}`, "watermark");
      }
      const readFeed = async () => JSON.parse((await client.readResource({ uri: "hubstaff://events/7" })).contents[0]!.text as string);
      const before = await readFeed();
      expect(before.events).toHaveLength(50);
      expect(before.events[0].sourceRecordId).toBe("new-6");
      expect(before.events.at(-1).sourceRecordId).toBe("new-55");
      expect(before.next_cursor).toBe(before.events.at(-1).id);
      await store.append({ ...sample, sourceRecordId: "new-56" }, "new-56", "watermark");
      const after = await readFeed();
      expect(after.events[0].sourceRecordId).toBe("new-7");
      expect(after.events.at(-1).sourceRecordId).toBe("new-56");
      expect(after.next_cursor > before.next_cursor).toBe(true);
      expect(JSON.stringify(after)).not.toContain("private upstream snapshot");
      const next = await client.callTool({ name: "hubstaff_list_events", arguments: { organization_id: 7, after: before.next_cursor } });
      expect(next.structuredContent?.result).toMatchObject({ events: [expect.objectContaining({ sourceRecordId: "new-56" })], next_cursor: after.next_cursor });
      const first = await client.callTool({ name: "hubstaff_list_events", arguments: { organization_id: 7, limit: 1 } });
      expect(first.structuredContent?.result).toMatchObject({ events: [expect.objectContaining({ sourceRecordId: "41" })] });
    });
  });

  it("rejects invalid event tool arguments and noninteger organization resource URIs", async () => {
    await withEventClient(async (client) => {
      for (const args of [{ organization_id: 0 }, { organization_id: 7.5 }, { organization_id: 7, limit: 0 },
        { organization_id: 7, limit: 101 }, { organization_id: 7, types: ["unknown"] }, { organization_id: 7, after: "" }]) {
        const response = await client.callTool({ name: "hubstaff_list_events", arguments: args });
        expect(response.isError).toBe(true);
      }
      for (const id of ["abc", "0", "-1", "7.5", "1e2", "9007199254740992"]) {
        await expect(client.readResource({ uri: `hubstaff://events/${id}` })).rejects.toThrow();
      }
    });
  });

  it("keeps raw store failures out of public resource errors", async () => {
    await withEventClient(async (client, store) => {
      vi.spyOn(store, "list").mockImplementation(() => { throw new Error("private upstream payload token=secret"); });
      let failure: unknown;
      try { await client.readResource({ uri: "hubstaff://events/7" }); } catch (error) { failure = error; }
      expect(String(failure)).toContain("could not read the Hubstaff event feed");
      expect(String(failure)).not.toContain("token=secret");
    });
  });

  it("omits event tool and resource template when monitoring is disabled", async () => {
    await withEventClient(async (client) => {
      expect((await client.listTools()).tools.some((tool) => tool.name === "hubstaff_list_events")).toBe(false);
      expect(client.getServerCapabilities()?.resources).toBeUndefined();
      await expect(client.readResource({ uri: "hubstaff://events/7" })).rejects.toThrow();
    }, false);
  });

  it("registers only documented Hubstaff V2 data tools", () => {
    const tools = registeredTools(vi.fn());

    expect([...tools.keys()]).toEqual([
      "hubstaff_capabilities",
      "hubstaff_list_organizations",
      "hubstaff_list_tasks",
      "hubstaff_get_task",
      "hubstaff_recent_updates",
      "hubstaff_task_hours",
      "hubstaff_list_audit_log_entries",
    ]);
    expect([...tools.keys()].some((name) => name.startsWith("hubstaff_tasks_"))).toBe(false);
  });

  it("adds source identifiers and an explicit comments capability to a task", async () => {
    const get = vi.fn().mockResolvedValue({
      task: {
        id: 42,
        project_type: "github",
        integration_id: 7,
        remote_id: "copperdiver/example#12",
        remote_alternate_id: "12",
      },
    });
    const tool = registeredTools(get).get("hubstaff_get_task");

    const response = await tool?.handler({ task_id: 42 });
    const output = response?.structuredContent?.result;

    expect(get).toHaveBeenCalledWith("/v2/tasks/42");
    expect(output?.task_source).toMatchObject({
      project_type: "github",
      integration_id: 7,
      remote_id: "copperdiver/example#12",
      comments_available_via_hubstaff_v2: false,
    });
  });

  it("returns a structured, actionable error instead of throwing a generic MCP argument error", async () => {
    const get = vi.fn().mockRejectedValue(new HubstaffApiError(404, JSON.stringify({ error: "missing" })));
    const tool = registeredTools(get).get("hubstaff_get_task");

    const response = await tool?.handler({ task_id: 999 });
    const output = response?.structuredContent?.result;

    expect(response?.isError).toBe(true);
    expect(output?.error).toMatchObject({ code: "HUBSTAFF_RESOURCE_NOT_FOUND", status: 404 });
  });

  it("reads official V2 audit events and can filter them to a task record", async () => {
    const get = vi.fn().mockResolvedValue({
      organization_audit_log_entries: [
        { id: 1, record_type: "Task", record_id: 42 },
        { id: 2, record_type: "Project", record_id: 42 },
        { id: 3, record_type: "Task", record_id: 99 },
      ],
    });
    const tool = registeredTools(get).get("hubstaff_list_audit_log_entries");

    const response = await tool?.handler({
      organization_id: 5,
      start: "2026-08-10T00:00:00.000Z",
      stop: "2026-08-17T00:00:00.000Z",
      task_id: 42,
      max_items: 200,
    });
    const output = response?.structuredContent?.result;

    expect(get).toHaveBeenCalledWith(
      "/v2/organizations/5/audit_log_entries",
      expect.objectContaining({
        "created[start]": "2026-08-10T00:00:00.000Z",
        "created[stop]": "2026-08-17T00:00:00.000Z",
      }),
    );
    expect(output?.entries).toEqual([{ id: 1, record_type: "Task", record_id: 42 }]);
    expect(output?.comments_included).toBe(false);
  });

  it("explains Enterprise requirements when audit logs are forbidden", async () => {
    const get = vi.fn().mockRejectedValue(new HubstaffApiError(403, JSON.stringify({ error: "forbidden" })));
    const tool = registeredTools(get).get("hubstaff_list_audit_log_entries");

    const response = await tool?.handler({
      organization_id: 5,
      start: "2026-08-10T00:00:00.000Z",
      stop: "2026-08-17T00:00:00.000Z",
      max_items: 200,
    });
    const output = response?.structuredContent?.result;

    expect(response?.isError).toBe(true);
    expect(output?.error).toMatchObject({ code: "HUBSTAFF_ACCESS_DENIED", status: 403 });
    expect(JSON.stringify(output)).toContain("Enterprise");
  });
});
