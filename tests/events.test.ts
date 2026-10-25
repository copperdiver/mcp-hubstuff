import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonEventStore, type HubstaffEvent } from "../src/events.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryStore(retention = 2) {
  const directory = await mkdtemp(join(tmpdir(), "hubstaff-events-"));
  directories.push(directory);
  const path = join(directory, "state.json");
  const store = new JsonEventStore(path, { retention });
  await store.load();
  return { store, path, directory };
}

function event(record: string, organizationId = 7, type: HubstaffEvent["type"] = "task.created"): HubstaffEvent {
  return { id: "caller-id", organizationId, source: "tasks", type, sourceRecordId: record,
    sourceTimestamp: "2026-10-25T09:00:00Z", observedAt: "2026-10-25T09:01:00Z",
    priority: "normal", summary: `Task ${record} created`, payload: { taskId: record } };
}

describe("JsonEventStore", () => {
  it("baselines without output, deduplicates replay, and bounds the retained feed", async () => {
    const { store, path } = await temporaryStore();
    await store.baseline("tasks", 7, { "42": { updated_at: "2026-10-25T09:00:00Z" } });
    expect(store.list(7)).toEqual([]);
    expect(await store.append(event("42"), "tasks:7:42:one", "one")).toBe(true);
    expect(await store.append(event("42"), "tasks:7:42:one", "one")).toBe(false);
    await store.append(event("43"), "tasks:7:43:two", "two");
    await store.append(event("44"), "tasks:7:44:three", "three");
    expect(store.list(7).map((item) => item.sourceRecordId)).toEqual(["43", "44"]);
    const disk = JSON.parse(await readFile(path, "utf8"));
    expect(disk.events).toHaveLength(2);
    expect(disk.dedupeKeys).toHaveLength(2);
  });

  it("restores baseline, watermark, source health and replay protection after reload", async () => {
    const { store, path } = await temporaryStore();
    await store.baseline("tasks", 7, { "42": { status: "active" } });
    await store.append(event("42"), "one", "2026-10-25T09:00:00Z");
    await store.setSourceStatus({ source: "tasks", organizationId: 7, status: "healthy",
      lastSuccessAt: "2026-10-25T09:01:00Z" });
    const restored = new JsonEventStore(path, { retention: 2 });
    await restored.load();
    expect(await restored.append(event("42"), "one", "later")).toBe(false);
    expect(restored.getSourceState("tasks", 7)).toEqual({ initialized: true,
      snapshot: { "42": { status: "active" } }, watermark: "2026-10-25T09:00:00Z" });
    expect(restored.getSourceState("tasks", 8)).toBeUndefined();
    expect(restored.status(7)).toEqual([{ source: "tasks", organizationId: 7, status: "healthy",
      lastSuccessAt: "2026-10-25T09:01:00Z" }]);
  });

  it("uses exclusive ordered cursors with organization, type, and limit filtering", async () => {
    const { store } = await temporaryStore(10);
    await store.append(event("41"), "one", "one");
    await store.append(event("42", 8), "other-org", "one");
    await store.append(event("43", 7, "task.updated"), "two", "two");
    await store.append(event("44"), "three", "three");
    const first = store.list(7)[0]!;
    expect(first.id).not.toBe("caller-id");
    expect(store.list(7, first.id).map((item) => item.sourceRecordId)).toEqual(["43", "44"]);
    expect(store.list(7, first.id, ["task.created"], 1).map((item) => item.sourceRecordId)).toEqual(["44"]);
    expect(store.list(7, undefined, undefined, 0)).toEqual([]);
    expect(store.list(7).map((item) => item.id)).toEqual(store.list(7).map((item) => item.id).sort());
    expect(store.status(8)).toEqual([]);
  });

  it("retains cursor ordering across reload and eviction", async () => {
    const { store, path } = await temporaryStore();
    await store.append(event("41"), "one", "one");
    const cursor = store.list(7)[0]!.id;
    await store.append(event("42"), "two", "two");
    const restored = new JsonEventStore(path, { retention: 2 });
    await restored.load();
    await restored.append(event("43"), "three", "three");
    expect(restored.list(7, cursor).map((item) => item.sourceRecordId)).toEqual(["42", "43"]);
  });

  it.each(["{secret-token", "null", '{"version":999}', '{"version":1,"events":[]}'])(
    "fails safely for malformed or unsupported state %j", async (content) => {
      const { path } = await temporaryStore();
      await writeFile(path, content);
      await expect(new JsonEventStore(path, { retention: 2 }).load()).rejects.toThrow("Invalid event state");
      try { await new JsonEventStore(path, { retention: 2 }).load(); }
      catch (error) {
        expect(String(error)).not.toContain(path);
        expect(String(error)).not.toContain("secret-token");
      }
    },
  );

  it("serializes concurrent writes and leaves an atomic private state file", async () => {
    const { store, path, directory } = await temporaryStore(10);
    await Promise.all([store.append(event("41"), "one", "one"), store.append(event("42"), "two", "two")]);
    const restored = new JsonEventStore(path, { retention: 10 });
    await restored.load();
    expect(restored.list(7).map((item) => item.sourceRecordId)).toEqual(["41", "42"]);
    expect(await readdir(directory)).toEqual(["state.json"]);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("does not publish a failed write or advance its watermark and can recover", async () => {
    const { store, path } = await temporaryStore();
    await store.append(event("41"), "one", "one");
    await mkdir(`${path}.${process.pid}.tmp`);
    await expect(store.append(event("42"), "two", "two")).rejects.toThrow();
    expect(store.list(7).map((item) => item.sourceRecordId)).toEqual(["41"]);
    expect(store.getSourceState("tasks", 7)?.watermark).toBe("one");
    await rm(`${path}.${process.pid}.tmp`, { recursive: true });
    expect(await store.append(event("42"), "two", "two")).toBe(true);
  });

  it("isolates its state from mutation through caller objects and returned data", async () => {
    const { store } = await temporaryStore();
    const input = event("42");
    await store.append(input, "one", "one");
    input.payload.taskId = "mutated";
    store.list(7)[0]!.payload.taskId = "also mutated";
    expect(store.list(7)[0]!.payload).toEqual({ taskId: "42" });
    const snapshot = { "42": { status: "active" } };
    await store.baseline("tasks", 7, snapshot);
    snapshot["42"].status = "changed";
    (store.getSourceState("tasks", 7)!.snapshot as typeof snapshot)["42"].status = "changed again";
    expect(store.getSourceState("tasks", 7)?.snapshot).toEqual({ "42": { status: "active" } });
  });
});
