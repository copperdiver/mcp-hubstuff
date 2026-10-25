import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { EventConfig } from "../src/config.js";
import { JsonEventStore } from "../src/events.js";
import { HubstaffClient } from "../src/hubstaff-client.js";
import { EventMonitor } from "../src/event-monitor.js";
import { HubstaffApiError, HubstaffRequestError } from "../src/errors.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hubstaff-monitor-"));
  directories.push(directory);
  const store = new JsonEventStore(join(directory, "state.json"), { retention: 100 });
  await store.load();
  const getWithMeta = vi.fn();
  const client = { getWithMeta } as unknown as HubstaffClient;
  const config: EventConfig = { enabled: true, organizationIds: [7], statePath: "unused", retention: 100,
    intervalsMs: { tasks: 300_000, activities: 1_200_000, timeEdits: 600_000, audit: 600_000 } };
  let now = new Date("2026-10-25T09:10:00Z");
  const monitor = new EventMonitor(config, client, store, () => now);
  return { monitor, store, getWithMeta, config, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

function response(key: string, records: object[]) { return { data: { [key]: records }, meta: {} }; }

it("baselines tasks then emits a meaningful update and creation", async () => {
  const { monitor, store, getWithMeta } = await setup();
  getWithMeta.mockResolvedValueOnce(response("tasks", [{ id: 1, status: "active", summary: "Initial", updated_at: "2026-10-25T09:00:00Z" }]))
    .mockResolvedValueOnce(response("tasks", [{ id: 1, status: "completed", summary: "Initial", updated_at: "2026-10-25T09:05:00Z" }, { id: 2, status: "active", summary: "New", updated_at: "2026-10-25T09:05:00Z" }]));
  await monitor.runSource(7, "tasks");
  expect(store.list(7)).toEqual([]);
  await monitor.runSource(7, "tasks");
  expect(store.list(7).map(({ type, sourceRecordId }) => [type, sourceRecordId])).toEqual([["task.updated", "1"], ["task.created", "2"]]);
});

it("pages task snapshots, normalizes assignees, ignores unrelated fields and preserves hidden tasks", async () => {
  const { monitor, store, getWithMeta } = await setup();
  getWithMeta.mockResolvedValueOnce({ data: { tasks: [{ id: 1, assignee_ids: [2, 1], summary: "one" }], pagination: { next_page_start_id: 2 } }, meta: {} })
    .mockResolvedValueOnce(response("tasks", [{ id: 2, summary: "two" }]))
    .mockResolvedValueOnce(response("tasks", [{ id: 1, assignee_ids: [1, 2], summary: "one", screenshot: "secret" }]))
    .mockResolvedValueOnce(response("tasks", [{ id: 2, summary: "changed" }]));
  await monitor.runSource(7, "tasks");
  expect(getWithMeta.mock.calls[0]![1]).toMatchObject({ status: ["active", "completed"] });
  expect(getWithMeta.mock.calls[1]![1]).toMatchObject({ page_start_id: "2" });
  await monitor.runSource(7, "tasks");
  expect(store.list(7)).toEqual([]);
  expect(JSON.stringify(store.getSourceState("tasks", 7))).not.toContain("screenshot");
  await monitor.runSource(7, "tasks");
  expect(store.list(7).map((event) => event.type)).toEqual(["task.updated"]);
});

it("emits repeated task transitions even when the upstream timestamp is unchanged", async () => {
  const { monitor, store, getWithMeta, advance } = await setup();
  for (const status of ["active", "completed", "active", "completed"]) {
    getWithMeta.mockResolvedValueOnce(response("tasks", [{ id: 1, status, updated_at: "2026-10-25T09:00:00Z" }]));
    await monitor.runSource(7, "tasks");
    advance(1_000);
  }
  expect(store.list(7).map((item) => item.payload.status)).toEqual(["completed", "active", "completed"]);
});

it("aggregates overlap-deduplicated activity blocks to one activity event per poll", async () => {
  const { monitor, store, getWithMeta, advance } = await setup();
  const first = { id: 1, updated_at: "2026-10-25T09:09:00Z", screenshot: "secret" };
  const second = { id: 2, updated_at: "2026-10-25T09:11:00Z" };
  getWithMeta.mockResolvedValueOnce(response("activities", [first]))
    .mockResolvedValueOnce(response("activities", [first, second, second]))
    .mockResolvedValueOnce(response("activities", [second]));
  await monitor.runSource(7, "activities");
  expect(store.list(7)).toEqual([]);
  advance(120_000);
  await monitor.runSource(7, "activities");
  expect(getWithMeta.mock.calls[1]).toEqual(["/v2/organizations/7/activities/updates", expect.objectContaining({
    "updated[start]": "2026-10-25T09:08:00.000Z", "updated[stop]": "2026-10-25T09:12:00.000Z" })]);
  expect(store.list(7)).toMatchObject([{ type: "activity.changed", payload: { count: 1,
    start: "2026-10-25T09:11:00Z", stop: "2026-10-25T09:11:00Z" } }]);
  expect(JSON.stringify(store.list(7))).not.toContain("screenshot");
  await monitor.runSource(7, "activities");
  expect(store.list(7)).toHaveLength(1);
});

it.each([["time_edits", "time_edit_logs", "time_edit.created"], ["audit", "organization_audit_log_entries", "audit.created"]] as const)(
  "emits %s only for newly seen immutable IDs", async (source, key, type) => {
    const { monitor, store, getWithMeta } = await setup();
    getWithMeta.mockResolvedValueOnce(response(key, [{ id: 1, created_at: "2026-10-25T09:09:00Z" }]))
      .mockResolvedValueOnce(response(key, [{ id: 1, created_at: "2026-10-25T09:10:00Z" },
        { id: 2, created_at: "2026-10-25T09:10:00Z", user_id: 3, screenshot: "secret", body: "secret" }]))
      .mockResolvedValueOnce(response(key, [{ id: 2, created_at: "2026-10-25T09:10:00Z" }]));
    await monitor.runSource(7, source);
    await monitor.runSource(7, source);
    await monitor.runSource(7, source);
    expect(store.list(7)).toMatchObject([{ type, sourceRecordId: "2" }]);
    expect(store.list(7)).toHaveLength(1);
    expect(JSON.stringify(store.list(7))).not.toContain("secret");
    expect(getWithMeta.mock.calls[0]![1]).toMatchObject({ "created[stop]": "2026-10-25T09:10:00.000Z" });
  },
);

it("disables forbidden audit without stopping a task source", async () => {
  const { monitor, store, getWithMeta } = await setup();
  getWithMeta.mockRejectedValueOnce(new HubstaffApiError(403, "secret"))
    .mockResolvedValueOnce(response("tasks", []));
  await monitor.runSource(7, "audit");
  await monitor.runSource(7, "audit");
  await monitor.runSource(7, "tasks");
  expect(getWithMeta).toHaveBeenCalledTimes(2);
  expect(store.status(7)).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "audit", status: "unavailable", lastErrorCode: "http_403" }),
    expect.objectContaining({ source: "tasks", status: "healthy" }),
  ]));
  expect(JSON.stringify(store.status(7))).not.toContain("secret");
});

it("postpones rate-limited work without advancing watermark", async () => {
  const { monitor, store, getWithMeta, advance } = await setup();
  getWithMeta.mockResolvedValueOnce(response("activities", []))
    .mockRejectedValueOnce(new HubstaffApiError(429, "secret", undefined, 60_000))
    .mockResolvedValueOnce(response("activities", []));
  await monitor.runSource(7, "activities");
  advance(1_000);
  await monitor.runSource(7, "activities");
  expect(store.getSourceState("activities", 7)?.watermark).toBe("2026-10-25T09:10:00.000Z");
  await monitor.runSource(7, "activities");
  expect(getWithMeta).toHaveBeenCalledTimes(2);
  expect(store.status(7)[0]).toMatchObject({ status: "backoff", nextPollAt: "2026-10-25T09:11:01.000Z" });
  advance(60_000);
  await monitor.runSource(7, "activities");
  expect(store.getSourceState("activities", 7)?.watermark).toBe("2026-10-25T09:11:01.000Z");
});

it("honors exhausted response rate metadata before starting the next run", async () => {
  const { monitor, store, getWithMeta, advance } = await setup();
  getWithMeta.mockResolvedValueOnce({ data: { tasks: [] }, meta: { rateLimit: {
    remaining: 0, resetAt: Date.parse("2026-10-25T09:20:00Z"),
  } } }).mockResolvedValueOnce(response("tasks", [{ id: 1 }]));
  await monitor.runSource(7, "tasks");
  await monitor.runSource(7, "tasks");
  expect(store.list(7)).toEqual([]);
  expect(store.status(7)[0]?.nextPollAt).toBe("2026-10-25T09:20:00.000Z");
  expect(getWithMeta).toHaveBeenCalledTimes(1);
  advance(600_000);
  await monitor.runSource(7, "tasks");
  expect(store.list(7)).toMatchObject([{ type: "task.created", sourceRecordId: "1" }]);
});

it("does not advance progress or publish earlier pages if a later page fails", async () => {
  const { monitor, store, getWithMeta, advance } = await setup();
  getWithMeta.mockResolvedValueOnce(response("tasks", []))
    .mockResolvedValueOnce({ data: { tasks: [{ id: 1 }], next_page_start_id: 2 }, meta: {} })
    .mockRejectedValueOnce(new HubstaffRequestError("timeout", new Error("secret")));
  await monitor.runSource(7, "tasks");
  advance(60_000);
  await monitor.runSource(7, "tasks");
  expect(store.list(7)).toEqual([]);
  expect(store.getSourceState("tasks", 7)).toEqual({ initialized: true, snapshot: {}, watermark: "2026-10-25T09:10:00.000Z" });
  expect(store.status(7)[0]).toMatchObject({ status: "backoff", lastErrorCode: "timeout" });
});

it("notifies once after a committed batch and isolates listener failures", async () => {
  const { monitor, store, getWithMeta } = await setup();
  const notified: number[] = [];
  monitor.onEvents(() => { throw new Error("listener failure"); });
  const unsubscribe = monitor.onEvents((id) => { expect(store.list(id)).toHaveLength(2); notified.push(id); });
  getWithMeta.mockResolvedValueOnce(response("tasks", []))
    .mockResolvedValueOnce(response("tasks", [{ id: 1 }, { id: 2 }]))
    .mockResolvedValueOnce(response("tasks", [{ id: 3 }]));
  await monitor.runSource(7, "tasks");
  await monitor.runSource(7, "tasks");
  expect(notified).toEqual([7]);
  unsubscribe();
  await monitor.runSource(7, "tasks");
  expect(notified).toEqual([7]);
});

it("backs off transient failures exponentially and resets after success", async () => {
  const { monitor, store, getWithMeta, advance } = await setup();
  getWithMeta.mockRejectedValueOnce(new HubstaffRequestError("network", new Error("secret")))
    .mockRejectedValueOnce(new HubstaffApiError(503, "secret"))
    .mockResolvedValueOnce(response("tasks", []));
  await monitor.runSource(7, "tasks");
  expect(store.status(7)[0]).toMatchObject({ status: "backoff", nextPollAt: "2026-10-25T09:10:01.000Z" });
  advance(1_000);
  await monitor.runSource(7, "tasks");
  expect(store.status(7)[0]).toMatchObject({ status: "backoff", nextPollAt: "2026-10-25T09:10:03.000Z" });
  advance(2_000);
  await monitor.runSource(7, "tasks");
  expect(store.status(7)[0]).toMatchObject({ status: "healthy" });
});

it("schedules recursively, avoids concurrent runs and stops future work", async () => {
  vi.useFakeTimers();
  const { monitor, getWithMeta } = await setup();
  let resolve!: (value: ReturnType<typeof response>) => void;
  getWithMeta.mockImplementation(() => new Promise((done) => { resolve = done; }));
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(getWithMeta).toHaveBeenCalledTimes(4);
  await monitor.runSource(7, "tasks");
  expect(getWithMeta).toHaveBeenCalledTimes(4);
  monitor.stop();
  resolve(response("organization_audit_log_entries", []));
  await vi.advanceTimersByTimeAsync(2_000_000);
  expect(getWithMeta).toHaveBeenCalledTimes(4);
});

it("keeps the configured interval when a rate reset is earlier than the next poll", async () => {
  vi.useFakeTimers();
  const { monitor, store, getWithMeta, advance } = await setup();
  getWithMeta.mockImplementation(async (path: string) => {
    const key = path.endsWith("tasks") ? "tasks" : path.endsWith("activities/updates") ? "activities" :
      path.endsWith("time_edit_logs") ? "time_edit_logs" : "organization_audit_log_entries";
    return { data: { [key]: [] }, meta: { rateLimit: { remaining: 0, resetAt: Date.parse("2026-10-25T09:11:00Z") } } };
  });
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(store.status(7)).toHaveLength(4));
  advance(100_000);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(getWithMeta.mock.calls.filter(([path]) => path.endsWith("/tasks"))).toHaveLength(1);
  monitor.stop();
});
