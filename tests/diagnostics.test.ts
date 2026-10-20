import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/server.js";
import { HubstaffClient } from "../src/hubstaff-client.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const auth = "test-mcp-bearer-with-at-least-32-characters";
const secret = "SENSITIVE_PAYLOAD_7c82";
const config = () => loadConfig({
  MCP_AUTH_TOKEN: auth,
  HUBSTAFF_ORGANIZATION_TOKEN: "hsoat_fake_test_token",
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

let fetchMock: ReturnType<typeof vi.fn>;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn(() => { throw new Error("Unexpected test fetch"); });
  vi.stubGlobal("fetch", fetchMock);
  stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function events() {
  return [...stdout.mock.calls, ...stderr.mock.calls]
    .map(([line]) => JSON.parse(String(line)) as Record<string, any>);
}

function rpcMessages(response: any): any[] {
  if (!response.headers["content-type"]?.includes("text/event-stream")) {
    return Array.isArray(response.body) ? response.body : [response.body];
  }
  return [...response.text.matchAll(/^data: (.+)$/gm)].map((match: RegExpMatchArray) => JSON.parse(match[1]!));
}

async function callTool(
  name = "hubstaff_list_tasks",
  args: Record<string, unknown> = { organization_id: 405914, max_items: 1000 },
  app = createHttpApp(config()),
) {
  const response = await request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${auth}`)
    .set("Cookie", `session=${secret}`)
    .set("X-Request-Id", secret)
    .set("Accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: secret, method: "tools/call", params: { name, arguments: args } })
    .expect(200);
  const payload = rpcMessages(response)[0];
  return { response, result: payload.result };
}

function expectSafeDiagnostic(result: any, response: any, category: string, code: string) {
  expect(result.isError).toBe(true);
  const error = result.structuredContent.result.error;
  expect(error).toMatchObject({ category, code, diagnostic_id: expect.any(String) });
  expect(error.diagnostic_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.headers["x-diagnostic-id"]).toBe(error.diagnostic_id);
  expect(result.content[0].text).toContain(error.diagnostic_id);
  const failure = events().find((event) => event.event === "tool.failed");
  expect(failure).toMatchObject({
    diagnostic_id: error.diagnostic_id, mcp_method: "tools/call", error_category: category,
    tool_name: "hubstaff_list_tasks", duration_ms: expect.any(Number),
  });
  const serialized = JSON.stringify({ logs: events(), result });
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain(auth);
  expect(serialized).not.toContain("hsoat_fake_test_token");
  return failure!;
}

describe("safe MCP diagnostics", () => {
  it("rejects max_items=5000 as validation before contacting Hubstaff", async () => {
    const { result, response } = await callTool(undefined, {
      organization_id: 405914, max_items: 5000, Authorization: secret,
    });
    const failure = expectSafeDiagnostic(result, response, "validation", "INVALID_ARGUMENT");
    expect(failure).toMatchObject({ attempts: 0, retries: 0, pages_count: 0, records_count: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts 1000 records and logs correlated page counts without task bodies or cursors", async () => {
    let page = 0;
    fetchMock.mockImplementation(async () => json({
      tasks: Array.from({ length: 100 }, (_, i) => ({ id: page * 100 + i, title: secret, email: secret })),
      pagination: { next_page_start_id: `${secret}-${++page}` },
    }));
    const { result, response } = await callTool();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.result.count).toBe(1000);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    const logs = events();
    const completed = logs.find((event) => event.event === "tool.completed");
    expect(completed).toMatchObject({
      diagnostic_id: response.headers["x-diagnostic-id"],
      mcp_method: "tools/call", tool_name: "hubstaff_list_tasks",
      organization_id: 405914, max_items: 1000,
      pages_count: 10, records_count: 1000, attempts: 10, retries: 0,
    });
    expect(logs.filter((event) => event.event === "pagination.page")).toHaveLength(10);
    expect(logs.filter((event) => event.event === "upstream.completed")).toHaveLength(10);
    expect(logs.every((event) => /^\d{4}-\d\d-\d\dT.*Z$/.test(event.timestamp))).toBe(true);
    expect(logs.every((event) => event.diagnostic_id === completed!.diagnostic_id)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(auth);
    expect(JSON.stringify(logs)).not.toContain("hsoat_fake_test_token");
  });

  it.each([
    ["network", () => { throw new TypeError(secret, { cause: Object.assign(new Error(secret), { code: "ECONNRESET" }) }); }, "HUBSTAFF_NETWORK_ERROR", "network", undefined],
    ["timeout", () => { throw new DOMException(secret, "TimeoutError"); }, "HUBSTAFF_TIMEOUT", "timeout", undefined],
    ["abort", () => { throw new DOMException(secret, "AbortError"); }, "HUBSTAFF_NETWORK_ERROR", "network", undefined],
    ["bad JSON", () => new Response(`{"task":"${secret}"`, { status: 200 }), "HUBSTAFF_INVALID_RESPONSE", "response", 200],
    ["HTTP 503", () => json({ error_description: secret, task: secret }, 503), "HUBSTAFF_API_ERROR", "http", 503],
  ])("classifies a later-page %s failure and preserves partial progress", async (_label, fail, code, kind, status) => {
    fetchMock.mockResolvedValueOnce(json({ tasks: [{ id: 1, title: secret }], next_page_start_id: secret }));
    fetchMock.mockImplementationOnce(fail as () => Response);
    const { result, response } = await callTool();
    const failure = expectSafeDiagnostic(result, response, "upstream", code as string);
    expect(failure).toMatchObject({
      error_kind: kind, pages_count: 1, records_count: 1, attempts: 2, retries: 0,
    });
    expect(failure.upstream_status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const upstream = events().find((event) => event.event === "upstream.failed");
    expect(upstream).toMatchObject({ attempt: 1, retry_count: 0, duration_ms: expect.any(Number) });
  });

  it.each([
    [400, "HUBSTAFF_INVALID_REQUEST"], [401, "HUBSTAFF_AUTHENTICATION_FAILED"],
    [403, "HUBSTAFF_ACCESS_DENIED"], [404, "HUBSTAFF_RESOURCE_NOT_FOUND"],
    [429, "HUBSTAFF_RATE_LIMITED"], [500, "HUBSTAFF_API_ERROR"],
  ])("keeps HTTP %i classified as upstream and never echoes the body", async (status, code) => {
    fetchMock.mockResolvedValue(json({
      error_description: `${secret} Authorization: Bearer ${auth}`,
      error: { access_token: secret }, task: { email: secret },
    }, status));
    const { result, response } = await callTool();
    const failure = expectSafeDiagnostic(result, response, "upstream", code);
    expect(failure.upstream_status).toBe(status);
    expect(result.structuredContent.result.error.status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies internal failures separately and logs only safe stack locations", async () => {
    const failure = new TypeError(`${secret} https://example.test/?api_key=${secret}`);
    failure.stack = `TypeError: ${secret}\n    at ${secret} (D:\\private\\src\\tools.ts:42:9)\n    at ${secret} (https://example.test/?token=${secret}:1:2)`;
    vi.spyOn(HubstaffClient.prototype, "get").mockRejectedValue(failure);
    const { result, response } = await callTool();
    const log = expectSafeDiagnostic(result, response, "internal", "INTERNAL_ERROR");
    expect(log).toMatchObject({ exception_class: "TypeError", stack: [{ file: "tools.ts", line: 42, column: 9 }] });
    expect(JSON.stringify(events())).not.toContain("D:\\private");
  });

  it("keeps diagnostic contexts separate for concurrent requests", async () => {
    fetchMock.mockImplementation(async (url: URL) => {
      await new Promise((resolve) => setTimeout(resolve, url.pathname.includes("/1/") ? 15 : 1));
      return json({ error_description: secret }, 503);
    });
    const app = createHttpApp(config());
    const replies = await Promise.all([1, 2].map((organization_id) => callTool(
      undefined, { organization_id, max_items: 1000 }, app,
    )));
    const ids = replies.map(({ response }) => response.headers["x-diagnostic-id"]);
    expect(new Set(ids).size).toBe(2);
    for (const [index, id] of ids.entries()) {
      const logs = events().filter((event) => event.diagnostic_id === id);
      expect(logs.find((event) => event.event === "tool.failed")).toMatchObject({
        organization_id: index + 1, attempts: 1, pages_count: 0,
      });
    }
  });

  it("includes a diagnostic ID on malformed JSON without logging its body", async () => {
    const response = await request(createHttpApp(config()))
      .post("/mcp").set("Content-Type", "application/json")
      .send(`{"broken":"${secret}"`).expect(400);
    expect(response.body.error).toMatchObject({
      code: "INVALID_ARGUMENT", category: "validation",
      diagnostic_id: response.headers["x-diagnostic-id"],
    });
    expect(JSON.stringify(events())).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not report an invalid local URL as a network failure", async () => {
    const app = createHttpApp({ ...config(), apiBase: "not a valid URL" });
    const { result, response } = await callTool(undefined, undefined, app);
    expectSafeDiagnostic(result, response, "internal", "INTERNAL_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("recognizes deadline AbortError during body=%s", async (duringBody) => {
    fetchMock.mockImplementation((_url, init: RequestInit) => {
      if (!duringBody) return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException(secret, "AbortError")));
      });
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init.signal!.addEventListener("abort", () => controller.error(new DOMException(secret, "AbortError")));
        },
      }), { status: 200 }));
    });
    const { result, response } = await callTool(undefined, undefined, createHttpApp({
      ...config(), requestTimeoutMs: 5,
    }));
    expectSafeDiagnostic(result, response, "upstream", "HUBSTAFF_TIMEOUT");
  });

  it("classifies a non-Error rejection without losing the failure log", async () => {
    vi.spyOn(HubstaffClient.prototype, "get").mockRejectedValue(undefined);
    const { result, response } = await callTool();
    const failure = expectSafeDiagnostic(result, response, "internal", "INTERNAL_ERROR");
    expect(failure).toMatchObject({ level: "error", exception_class: "NonError" });
  });

  it("classifies the tool's own range validation without leaking inputs", async () => {
    const { result } = await callTool("hubstaff_task_hours", {
      organization_id: 405914, task_id: 1,
      start: "2026-10-20T00:00:00Z", stop: "2026-10-19T00:00:00Z",
    });
    expect(result.structuredContent.result.error).toMatchObject({
      code: "INVALID_ARGUMENT", category: "validation", diagnostic_id: expect.any(String),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send unknown tool names or invalid enum values to logs or the client error", async () => {
    const unknown = await callTool(secret, {});
    expect(unknown.result.structuredContent.result.error.category).toBe("validation");
    const invalid = await callTool(undefined, { organization_id: 405914, status: [secret] });
    expect(invalid.result.structuredContent.result.error.category).toBe("validation");
    expect(JSON.stringify([events(), unknown.result, invalid.result])).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["hubstaff_get_task", { task_id: 42 }, { task: { id: 42, title: secret } }, 1],
    ["hubstaff_list_organizations", { page_limit: 100 }, { organizations: [{ id: 1 }, { id: 2 }] }, 2],
  ])("counts the single response from %s", async (name, args, body, count) => {
    fetchMock.mockResolvedValue(json(body));
    const { result } = await callTool(name, args);
    expect(result.isError).not.toBe(true);
    expect(events().find((event) => event.event === "tool.completed")).toMatchObject({
      tool_name: name, pages_count: 1, records_count: count, attempts: 1,
    });
    expect(JSON.stringify(events())).not.toContain(secret);
  });

  it("returns safe diagnostics when tools/call itself has malformed params", async () => {
    const response = await request(createHttpApp(config()))
      .post("/mcp").set("Authorization", `Bearer ${auth}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: [secret] } }).expect(200);
    expect(rpcMessages(response)[0].result.structuredContent.result.error).toMatchObject({
      category: "validation", code: "INVALID_ARGUMENT", diagnostic_id: response.headers["x-diagnostic-id"],
    });
    expect(JSON.stringify(events())).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts and classifies each invalid tool call in a JSON-RPC batch", async () => {
    const response = await request(createHttpApp(config()))
      .post("/mcp").set("Authorization", `Bearer ${auth}`)
      .set("Accept", "application/json, text/event-stream")
      .send([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: secret, arguments: {} } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
          name: "hubstaff_list_tasks", arguments: { organization_id: 405914, status: [secret] },
        } },
      ]).expect(200);
    const replies = rpcMessages(response);
    expect(replies).toHaveLength(2);
    const ids = replies.map(({ result }) => {
      expect(result.structuredContent.result.error).toMatchObject({ category: "validation", code: "INVALID_ARGUMENT" });
      return result.structuredContent.result.error.diagnostic_id;
    });
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(events().find((event) => event.diagnostic_id === id)).toMatchObject({
        request_id: response.headers["x-diagnostic-id"],
      });
    }
    expect(JSON.stringify({ replies, logs: events() })).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates overlapping tool calls within a batch while retaining the HTTP request ID", async () => {
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === "/v2/tasks/42") return json({ task: { id: 42 } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json({ tasks: [{ id: 1 }, { id: 2 }] });
    });
    const response = await request(createHttpApp(config()))
      .post("/mcp").set("Authorization", `Bearer ${auth}`)
      .set("Accept", "application/json, text/event-stream")
      .send([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "hubstaff_list_tasks", arguments: { organization_id: 405914, max_items: 1000 },
        } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
          name: "hubstaff_get_task", arguments: { task_id: 42 },
        } },
      ]).expect(200);
    expect(rpcMessages(response)).toHaveLength(2);
    const completed = events().filter((event) => event.event === "tool.completed");
    expect(completed).toHaveLength(2);
    expect(new Set(completed.map((event) => event.diagnostic_id)).size).toBe(2);
    expect(completed.find((event) => event.tool_name === "hubstaff_list_tasks")).toMatchObject({
      organization_id: 405914, pages_count: 1, records_count: 2, attempts: 1,
      request_id: response.headers["x-diagnostic-id"],
    });
    const task = completed.find((event) => event.tool_name === "hubstaff_get_task");
    expect(task).toMatchObject({ task_id: 42, pages_count: 1, records_count: 1, attempts: 1 });
    expect(task).not.toHaveProperty("organization_id");
  });

  it.each(["/mcp/", "/MCP"])("redacts body-parser errors on the accepted route %s", async (path) => {
    const response = await request(createHttpApp(config()))
      .post(path).set("Content-Type", "application/json").send(`{"broken":"${secret}"`).expect(400);
    expect(response.body.error).toMatchObject({
      code: "INVALID_ARGUMENT", diagnostic_id: response.headers["x-diagnostic-id"],
    });
    expect(JSON.stringify(events())).not.toContain(secret);
  });

  it.each(["accept", "content-type", "protocol"])("preserves the SDK's %s rejection before tool validation", async (guard) => {
    let pending = request(createHttpApp(config())).post("/mcp").set("Authorization", `Bearer ${auth}`);
    if (guard !== "accept") pending = pending.set("Accept", "application/json, text/event-stream");
    if (guard === "protocol") pending = pending.set("MCP-Protocol-Version", "unsupported");
    const response = guard === "content-type"
      ? await pending.type("form").send({ jsonrpc: "2.0", id: "1", method: "tools/call" })
      : await pending.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "hubstaff_list_tasks", arguments: { organization_id: 405914, max_items: 5000 },
      } });
    expect(response.status).toBe(guard === "accept" ? 406 : guard === "content-type" ? 415 : 400);
    expect(response.headers["x-diagnostic-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["charset", 415], ["encoding", 415], ["broken-gzip", 400], ["body-size", 413],
  ])("preserves the parser's %s rejection with safe validation diagnostics", async (scenario, status) => {
    let pending = request(createHttpApp(config())).post("/mcp").set("Content-Type", "application/json");
    if (scenario === "charset") pending = pending.set("Content-Type", `application/json; charset=${secret}`);
    if (scenario === "encoding") pending = pending.set("Content-Encoding", secret);
    if (scenario === "broken-gzip") pending = pending.set("Content-Encoding", "gzip");
    const body = JSON.stringify({ data: scenario === "body-size" ? secret.repeat(100_000) : secret });
    const response = await pending.send(body).expect(status as number);
    expect(response.body.error).toMatchObject({
      code: "INVALID_ARGUMENT", category: "validation", diagnostic_id: response.headers["x-diagnostic-id"],
    });
    expect(JSON.stringify({ response: response.body, logs: events() })).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a correlated safe internal error if the MCP transport throws", async () => {
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest").mockRejectedValue(new Error(secret));
    const response = await request(createHttpApp(config()))
      .post("/mcp").set("Authorization", `Bearer ${auth}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(500);
    expect(response.body.error).toMatchObject({
      category: "internal", code: "INTERNAL_ERROR", diagnostic_id: response.headers["x-diagnostic-id"],
    });
    expect(events().find((event) => event.event === "mcp.failed")).toMatchObject({
      diagnostic_id: response.body.error.diagnostic_id, mcp_method: "tools/list", exception_class: "Error",
    });
    expect(JSON.stringify({ logs: events(), body: response.body })).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
