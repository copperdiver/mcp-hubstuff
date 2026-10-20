import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { classifyError } from "./errors.js";

interface Diagnostic {
  diagnostic_id: string;
  request_id: string;
  started: number;
  mcp_method: string;
  tool_name?: string;
  parameters: Record<string, number>;
  pages_count: number;
  records_count: number;
  attempts: number;
  retries: number;
  children: Diagnostic[];
}

const context = new AsyncLocalStorage<Diagnostic>();
const tools = new Set([
  "hubstaff_capabilities", "hubstaff_list_organizations", "hubstaff_list_tasks", "hubstaff_get_task",
  "hubstaff_recent_updates", "hubstaff_task_hours", "hubstaff_list_audit_log_entries",
]);
const methods = new Set(["initialize", "tools/call", "tools/list", "ping", "notifications/initialized"]);
const numericFields = new Set([
  "organization_id", "task_id", "max_items", "max_entries", "page_limit", "page_number",
  "pages_count", "records_count", "page_records", "attempts", "retries", "attempt",
  "retry_count", "duration_ms", "upstream_status", "http_status", "timeout_ms", "port",
]);
const enumFields: Record<string, Set<string>> = {
  error_category: new Set(["validation", "upstream", "internal"]),
  error_kind: new Set(["validation", "http", "network", "timeout", "response", "internal"]),
  phase: new Set(["api", "token_refresh"]),
  retry_reason: new Set(["unauthorized"]),
  stop_reason: new Set(["max_items", "no_next_page", "empty_page", "repeated_cursor"]),
  http_method: new Set(["GET", "POST"]),
};

export function newDiagnostic(parent?: Diagnostic): Diagnostic {
  const id = randomUUID();
  const diagnostic: Diagnostic = {
    diagnostic_id: id, request_id: parent?.request_id ?? id,
    started: performance.now(), mcp_method: "unknown", parameters: {},
    pages_count: 0, records_count: 0, attempts: 0, retries: 0, children: [],
  };
  parent?.children.push(diagnostic);
  return diagnostic;
}

export function currentDiagnostic(): Diagnostic | undefined {
  return context.getStore();
}

export function inDiagnostic<T>(diagnostic: Diagnostic, run: () => T): T {
  return context.run(diagnostic, run);
}

export function setDiagnosticOperation(method: unknown, tool?: unknown, parameters?: unknown): void {
  const diagnostic = currentDiagnostic();
  if (!diagnostic) return;
  diagnostic.mcp_method = typeof method === "string" && methods.has(method) ? method : "unknown";
  diagnostic.tool_name = typeof tool === "string" && tools.has(tool) ? tool : undefined;
  diagnostic.parameters = safeParameters(parameters);
}

function safeParameters(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, number> = {};
  for (const field of ["organization_id", "task_id", "max_items", "max_entries", "page_limit"]) {
    const item = (value as Record<string, unknown>)[field];
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) output[field] = item;
  }
  return output;
}

// Fail closed: arbitrary strings, headers, URLs, query values and payloads are
// omitted, even if a future caller accidentally passes them to this logger.
export function redactDiagnosticFields(fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (numericFields.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      output[key] = value;
    } else if (typeof value === "string" && enumFields[key]?.has(value)) {
      output[key] = value;
    } else if (["page_start_id_present", "next_page_present"].includes(key) && typeof value === "boolean") {
      output[key] = value;
    }
  }
  return output;
}

function safeException(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { exception_class: "NonError" };
  const classes = new Set([
    "Error", "TypeError", "SyntaxError", "RangeError", "AbortError", "TimeoutError",
    "ToolInputError", "HubstaffApiError", "HubstaffRequestError",
  ]);
  const code = (error as NodeJS.ErrnoException).code;
  const codes = new Set([
    "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET", "ENOENT", "EACCES", "EPERM", "ENOSPC", "ERR_INVALID_URL",
  ]);
  // Keep only known source filenames and numeric locations, never messages,
  // function names, absolute paths, arbitrary frames, or error.body.
  const stack = (error.stack ?? "").split("\n").slice(1, 21).flatMap((frame) => {
    const match = /[/\\]src[/\\](tools|hubstaff-client|diagnostics|errors|server|oauth|index)\.([jt]s):(\d+):(\d+)\)?$/.exec(frame);
    return match ? [{ file: `${match[1]}.${match[2]}`, line: Number(match[3]), column: Number(match[4]) }] : [];
  });
  return {
    exception_class: classes.has(error.name) ? error.name : "Error",
    ...(code && codes.has(code) ? { exception_code: code } : {}),
    stack,
    ...(depth < 2 && error.cause !== undefined ? { cause: safeException(error.cause, depth + 1) } : {}),
  };
}

export type DiagnosticEvent =
  | "tool.started" | "tool.completed" | "tool.failed"
  | "upstream.started" | "upstream.completed" | "upstream.failed" | "upstream.retry"
  | "pagination.page" | "pagination.completed"
  | "mcp.completed" | "mcp.failed" | "oauth.failed" | "server.started";

export function logDiagnostic(
  event: DiagnosticEvent, fields: Record<string, unknown> = {}, error?: unknown,
): void {
  const failed = arguments.length >= 3;
  // Logging must not replace an upstream result with a logging failure.
  try {
    const diagnostic = currentDiagnostic() ?? newDiagnostic();
    let exception: Record<string, unknown> = {};
    if (failed) {
      try { exception = safeException(error); } catch { exception = { exception_class: "UnknownError", stack: [] }; }
    }
    const entry = {
      timestamp: new Date().toISOString(),
      level: failed ? "error" : "info",
      event,
      diagnostic_id: diagnostic.diagnostic_id,
      request_id: diagnostic.request_id,
      mcp_method: diagnostic.mcp_method,
      tool_name: diagnostic.tool_name,
      ...diagnostic.parameters,
      ...diagnostic.children.reduce((totals, child) => ({
        pages_count: totals.pages_count + child.pages_count,
        records_count: totals.records_count + child.records_count,
        attempts: totals.attempts + child.attempts,
        retries: totals.retries + child.retries,
      }), {
        pages_count: diagnostic.pages_count, records_count: diagnostic.records_count,
        attempts: diagnostic.attempts, retries: diagnostic.retries,
      }),
      ...redactDiagnosticFields(fields),
      ...(failed ? { ...classifyError(error), ...exception } : {}),
    };
    (failed ? console.error : console.log)(JSON.stringify(entry));
  } catch {
    // No fallback that could print an unredacted Error.
  }
}

export function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}
