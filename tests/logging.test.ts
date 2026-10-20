import { afterEach, describe, expect, it, vi } from "vitest";
import { inDiagnostic, logDiagnostic, newDiagnostic, setDiagnosticOperation } from "../src/diagnostics.js";

afterEach(() => vi.restoreAllMocks());

describe("diagnostic log redaction", () => {
  it("drops all unapproved fields and strings including nested credentials and query values", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "DO_NOT_LOG_b184";
    const error = Object.assign(new Error(`Bearer ${secret}`, { cause: new Error(secret) }), {
      body: { tasks: [{ email: secret }] }, headers: { Authorization: secret },
    });
    error.name = secret;
    error.stack = `${secret}\n    at ${secret} (C:\\private\\src\\tools.ts:10:3)\n    at https://example.test/?secret=${secret}`;
    inDiagnostic(newDiagnostic(), () => {
      setDiagnosticOperation(secret, secret, { organization_id: 405914, max_items: secret, email: secret });
      logDiagnostic("tool.failed", {
        authorization: secret, Authorization: secret, cookie: secret, "Set-Cookie": secret,
        access_token: secret, refreshToken: secret, apiKey: secret,
        headers: { Authorization: secret }, url: `https://test.invalid/?token=${secret}`,
        query: { page_start_id: secret }, page_start_id: secret, body: { task: secret, email: secret },
        diagnostic_id: secret, mcp_method: secret, event: secret, phase: secret,
        error_kind: secret, upstream_status: secret, page_limit: secret,
        attempt: 1, duration_ms: 12.5, page_start_id_present: true,
      }, error);
    });
    const output = String(log.mock.calls[0]![0]);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("private");
    expect(JSON.parse(output)).toMatchObject({
      level: "error", mcp_method: "unknown", organization_id: 405914,
      exception_class: "Error", attempt: 1, duration_ms: 12.5,
      page_start_id_present: true, stack: [{ file: "tools.ts", line: 10, column: 3 }],
    });
  });

  it("does not throw when exception introspection or the output sink fails", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("private error");
    Object.defineProperty(error, "stack", { get() { throw new Error("private getter"); } });
    expect(() => logDiagnostic("tool.failed", {}, error)).not.toThrow();
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ exception_class: "UnknownError" });
    log.mockImplementation(() => { throw new Error("closed pipe"); });
    expect(() => logDiagnostic("tool.failed", {}, new Error("private error"))).not.toThrow();
  });
});
