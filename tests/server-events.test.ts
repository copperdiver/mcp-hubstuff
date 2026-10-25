import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { expect, it, vi } from "vitest";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { JsonEventStore } from "../src/events.js";
import { EventMonitor } from "../src/event-monitor.js";
import { HubstaffClient } from "../src/hubstaff-client.js";
import { createHttpApp } from "../src/server.js";

const auth = "test-mcp-bearer-with-at-least-32-characters";
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
} };

it.each(["get", "post", "delete"] as const)("rejects unauthenticated and unknown-session %s safely", async (method) => {
  const app = createHttpApp(loadConfig({ MCP_AUTH_TOKEN: auth }));
  const anonymous = await request(app)[method]("/mcp").set("Mcp-Session-Id", "private-unknown-id");
  expect(anonymous.status).toBe(401);
  const unknown = await request(app)[method]("/mcp").set("Authorization", `Bearer ${auth}`)
    .set("Mcp-Session-Id", "private-unknown-id").send(method === "post" ? initialize : undefined);
  expect(unknown.status).toBe(404);
  expect(JSON.stringify(unknown.body)).not.toContain("private-unknown-id");
  expect(unknown.headers["x-diagnostic-id"]).toMatch(/^[0-9a-f-]{36}$/);
});

it("executes normal tools with monitoring disabled and removes a deleted session", async () => {
  const monitor = { onEvents: vi.fn(), start: vi.fn(), stop: vi.fn() } as unknown as EventMonitor;
  const app = createHttpApp(loadConfig({ MCP_AUTH_TOKEN: auth }), { store: {} as JsonEventStore, monitor });
  const post = () => request(app).post("/mcp").set("Authorization", `Bearer ${auth}`)
    .set("Accept", "application/json, text/event-stream");
  const initialized = await post().send(initialize).expect(200);
  const id = initialized.headers["mcp-session-id"] as string;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(initialized.text).not.toContain('"subscribe":true');
  const upstream = vi.spyOn(HubstaffClient.prototype, "get").mockResolvedValue({ task: { id: 42 } });
  try {
    const reply = await post().set("Mcp-Session-Id", id).send({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "hubstaff_get_task", arguments: { task_id: 42 } } }).expect(200);
    expect(reply.text).toContain('"id":42');
    await post().set("Mcp-Session-Id", id).send({ jsonrpc: "2.0", id: 3, method: "resources/subscribe",
      params: { uri: "hubstaff://events/7" } }).expect(200).then((reply) => expect(reply.text).toContain('"code":-32601'));
    await request(app).delete("/mcp").set("Authorization", `Bearer ${auth}`).set("Mcp-Session-Id", id).expect(200);
    await post().set("Mcp-Session-Id", id).send(initialize).expect(404);
    expect(monitor.onEvents).not.toHaveBeenCalled();
    expect(monitor.start).not.toHaveBeenCalled();
    expect(monitor.stop).not.toHaveBeenCalled();
  } finally { upstream.mockRestore(); await app.locals.close(); }
});

it("notifies only the session subscribed to the organization event resource", async () => {
  const directory = await mkdtemp(join(tmpdir(), "server-events-"));
  const config = loadConfig({ MCP_AUTH_TOKEN: auth, HUBSTAFF_ORGANIZATION_TOKEN: "hsoat_test",
    HUBSTAFF_EVENTS_ENABLED: "true", HUBSTAFF_EVENT_ORGANIZATION_IDS: "7,8" });
  const store = new JsonEventStore(join(directory, "events.json"), { retention: 100 });
  await store.load();
  const monitor = new EventMonitor(config.events, new HubstaffClient(config), store);
  const upstream = vi.spyOn(HubstaffClient.prototype, "getWithMeta").mockResolvedValue({
    data: { tasks: [{ id: 1, summary: "private event data", status: "active" }] }, meta: {},
  });
  const app = createHttpApp(config, { store, monitor });
  const http = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const address = http.address() as { port: number };
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const a = new Client({ name: "A", version: "1" });
  const b = new Client({ name: "B", version: "1" });
  const receivedA: unknown[] = [], receivedB: unknown[] = [];
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  a.setNotificationHandler(ResourceUpdatedNotificationSchema, (message) => { receivedA.push(message); });
  b.setNotificationHandler(ResourceUpdatedNotificationSchema, (message) => { receivedB.push(message); });
  try {
    for (const client of [a, b]) await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${auth}` } },
    }));
    await a.subscribeResource({ uri: "hubstaff://events/7" });
    await b.subscribeResource({ uri: "hubstaff://events/8" });
    await expect(a.subscribeResource({ uri: "hubstaff://events/999" })).rejects.toThrow("Unknown event resource");
    await monitor.runSource(7, "tasks");
    upstream.mockResolvedValue({ data: { tasks: [{ id: 1, summary: "changed private event data", status: "active" }] }, meta: {} });
    await monitor.runSource(7, "tasks");
    await vi.waitFor(() => expect(receivedA).toHaveLength(1));
    expect(receivedA).toEqual([{ method: "notifications/resources/updated", params: { uri: "hubstaff://events/7" } }]);
    expect(receivedB).toEqual([]);
    const send = vi.spyOn(Server.prototype, "sendResourceUpdated")
      .mockRejectedValueOnce(new Error(`private event data ${directory} ${auth}`));
    try {
      upstream.mockResolvedValue({ data: { tasks: [{ id: 1, summary: "another private event data" }] }, meta: {} });
      await monitor.runSource(7, "tasks");
      await vi.waitFor(() => expect(errors.mock.calls.some(([line]) => JSON.parse(String(line)).event === "mcp.failed")).toBe(true));
      expect(store.list(7)).toHaveLength(2);
    } finally { send.mockRestore(); }
    await a.unsubscribeResource({ uri: "hubstaff://events/7" });
    upstream.mockResolvedValue({ data: { tasks: [{ id: 2, summary: "more private data" }] }, meta: {} });
    await monitor.runSource(7, "tasks");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(receivedA).toHaveLength(1);
    const diagnostics = JSON.stringify([...logs.mock.calls, ...errors.mock.calls]);
    expect(diagnostics).not.toContain("private event data");
    expect(diagnostics).not.toContain(directory);
    expect(diagnostics).not.toContain(auth);
  } finally {
    await a.close(); await b.close();
    await app.locals.close?.();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    upstream.mockRestore();
    logs.mockRestore(); errors.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
