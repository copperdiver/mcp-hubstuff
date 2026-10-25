import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HubstaffApiError, HubstaffClient, nextPageStartId, type Query } from "./hubstaff-client.js";
import { classifyError, HubstaffRequestError, ToolInputError } from "./errors.js";
import type { EventStore, HubstaffEventType } from "./events.js";
import {
  currentDiagnostic, elapsed, inDiagnostic, logDiagnostic, newDiagnostic, setDiagnosticOperation,
} from "./diagnostics.js";

type JsonObject = Record<string, unknown>;
type ToolResult = ReturnType<typeof result> & { isError?: boolean };

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const oauthSecurity = [{ type: "oauth2" as const, scopes: ["hubstaff.read"] }];

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { result: data },
  };
}

function errorResult(code: string, message: string, category: string, diagnosticId: string, status?: number): ToolResult {
  return {
    ...result({ error: {
      code, message, category, diagnostic_id: diagnosticId, ...(status === undefined ? {} : { status }),
    } }),
    isError: true,
  };
}

export function hubstaffErrorResult(error: unknown, forbiddenMessage?: string): ToolResult {
  const diagnostic = currentDiagnostic() ?? newDiagnostic();
  inDiagnostic(diagnostic, () => logDiagnostic("tool.failed", { duration_ms: elapsed(diagnostic.started) }, error));
  const failure = (code: string, message: string, status?: number) =>
    errorResult(code, message, classifyError(error).error_category, diagnostic.diagnostic_id, status);
  if (error instanceof ToolInputError) return failure("INVALID_ARGUMENT", error.message);
  if (error instanceof HubstaffRequestError) {
    const messages = {
      timeout: ["HUBSTAFF_TIMEOUT", "The Hubstaff request timed out."],
      network: ["HUBSTAFF_NETWORK_ERROR", "The connection to Hubstaff could not be completed."],
      response: ["HUBSTAFF_INVALID_RESPONSE", "Hubstaff returned an unreadable response."],
    } as const;
    const [code, message] = messages[error.kind];
    return failure(code, message, error.status);
  }
  if (!(error instanceof HubstaffApiError)) {
    return failure("INTERNAL_ERROR", "The server could not complete the Hubstaff tool call.");
  }

  switch (error.status) {
    case 400:
      return failure("HUBSTAFF_INVALID_REQUEST", "Hubstaff rejected the request parameters.", 400);
    case 401:
      return failure(
        "HUBSTAFF_AUTHENTICATION_FAILED",
        "Hubstaff rejected the configured credential. Check that the PAT refresh token is current and that token rotation is persisted.",
        401,
      );
    case 403:
      return failure(
        "HUBSTAFF_ACCESS_DENIED",
        forbiddenMessage ?? "The configured Hubstaff member, plan, or hubstaff:read scope does not permit this request.",
        403,
      );
    case 404:
      return failure(
        "HUBSTAFF_RESOURCE_NOT_FOUND",
        "Hubstaff could not find this V2 resource. Verify that the ID belongs to the configured organization.",
        404,
      );
    case 429:
      return failure("HUBSTAFF_RATE_LIMITED", "Hubstaff rate-limited the request. Retry later.", 429);
    default:
      return failure("HUBSTAFF_API_ERROR", `Hubstaff returned HTTP ${error.status}.`, error.status);
  }
}

async function safeTool(run: () => Promise<ToolResult>, forbiddenMessage?: string): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    return hubstaffErrorResult(error, forbiddenMessage);
  }
}

function taskRecord(response: JsonObject): JsonObject {
  const nested = response.task;
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as JsonObject : response;
}

export function taskSource(response: JsonObject) {
  const task = taskRecord(response);
  return {
    project_type: task.project_type ?? null,
    integration_id: task.integration_id ?? null,
    remote_id: task.remote_id ?? null,
    remote_alternate_id: task.remote_alternate_id ?? null,
    comments_available_via_hubstaff_v2: false,
    guidance:
      "Hubstaff V2 exposes task metadata and tracked time, but not task comments. Use project_type and remote_id to query the source system when applicable.",
  };
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) || 0 : 0;
}

function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

function recordPage(records: number): void {
  const diagnostic = currentDiagnostic();
  if (diagnostic) {
    diagnostic.pages_count++;
    diagnostic.records_count += records;
  }
}

async function collectPages(
  client: HubstaffClient,
  path: string,
  collection: string,
  query: Query,
  maxItems = 1000,
): Promise<JsonObject[]> {
  const items: JsonObject[] = [];
  const started = performance.now();
  let pages = 0;
  let pageStartId: string | undefined;
  while (items.length < maxItems) {
    const pageLimit = Math.min(100, maxItems - items.length);
    const page = await client.get<JsonObject>(path, {
      ...query,
      page_limit: pageLimit,
      ...(pageStartId ? { page_start_id: pageStartId } : {}),
    });
    const current = Array.isArray(page[collection]) ? (page[collection] as JsonObject[]) : [];
    items.push(...current);
    pages++;
    recordPage(current.length);
    const next = nextPageStartId(page);
    logDiagnostic("pagination.page", {
      page_number: pages, page_limit: pageLimit, page_records: current.length,
      page_start_id_present: pageStartId !== undefined, next_page_present: next !== undefined,
    });
    const stopReason = !next ? "no_next_page" : current.length === 0 ? "empty_page"
      : next === pageStartId ? "repeated_cursor" : items.length >= maxItems ? "max_items" : undefined;
    if (stopReason) {
      logDiagnostic("pagination.completed", { stop_reason: stopReason, duration_ms: elapsed(started) });
      break;
    }
    pageStartId = next;
  }
  return items;
}

export function eventResourceUri(organizationId: number): string {
  return `hubstaff://events/${organizationId}`;
}

export function registerTools(server: McpServer, client: HubstaffClient, events?: EventStore): Map<string, z.AnyZodObject> {
  const schemas = new Map<string, z.AnyZodObject>();
  // Reuse exactly the SDK's advertised schemas for safe HTTP validation errors.
  function registerTool<Shape extends z.ZodRawShape>(
    name: string,
    config: {
      title: string; description: string; inputSchema: Shape;
      annotations: typeof readOnly; _meta: Record<string, unknown>;
    },
    handler: (args: z.output<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ) {
    schemas.set(name, z.object(config.inputSchema));
    server.registerTool<z.ZodRawShape, z.ZodRawShape>(name, config, async (args) => {
      const diagnostic = currentDiagnostic() ?? newDiagnostic();
      return inDiagnostic(diagnostic, async () => {
        setDiagnosticOperation("tools/call", name, args);
        logDiagnostic("tool.started");
        const output = await safeTool(() => handler(args as z.output<z.ZodObject<Shape>>));
        if (!output.isError) logDiagnostic("tool.completed", { duration_ms: elapsed(diagnostic.started) });
        return output;
      });
    });
  }

  if (events) {
    const eventStore = events;
    const eventInput = z.object({
      organization_id: z.number().int().positive().safe(),
      after: z.string().min(1).optional(),
      types: z.array(z.enum(["task.created", "task.updated", "activity.changed", "time_edit.created", "audit.created"])).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    });
    function feed(organizationId: number, after?: string, types?: HubstaffEventType[], limit = 50) {
      const page = eventStore.list(organizationId, after, types, limit);
      return { events: page, next_cursor: page.at(-1)?.id ?? after ?? null, source_status: eventStore.status(organizationId) };
    }
    registerTool("hubstaff_list_events", {
      title: "List observed Hubstaff events",
      description: "Reads retained polling events for an organization after an exclusive cursor, with optional event type filters.",
      inputSchema: eventInput.shape, annotations: readOnly, _meta: { securitySchemes: oauthSecurity },
    }, async (input) => {
      const { organization_id, after, types, limit } = eventInput.parse(input);
      return result(feed(organization_id, after, types, limit));
    });
    server.registerResource("hubstaff_events", new ResourceTemplate("hubstaff://events/{organizationId}", { list: undefined }), {
      title: "Observed Hubstaff events", description: "The latest 50 retained events in cursor order and source status for an organization. Use next_cursor with hubstaff_list_events to read subsequent events.",
      mimeType: "application/json", _meta: { securitySchemes: oauthSecurity },
    }, async (_uri, variables) => {
      const id = variables.organizationId;
      if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
        throw new McpError(ErrorCode.InvalidParams, "organizationId must be a positive safe integer.");
      }
      const organizationId = Number(id);
      try {
        const page = eventStore.list(organizationId).slice(-50);
        const latest = { events: page, next_cursor: page.at(-1)?.id ?? null, source_status: eventStore.status(organizationId) };
        return { contents: [{ uri: eventResourceUri(organizationId), mimeType: "application/json", text: JSON.stringify(latest, null, 2) }] };
      } catch {
        throw new McpError(ErrorCode.InternalError, "The server could not read the Hubstaff event feed.");
      }
    });
  }

  registerTool(
    "hubstaff_capabilities",
    {
      title: "Describe Hubstaff MCP capabilities",
      description:
        "Explains which Hubstaff data this server can read and where unsupported comments or task history may be available.",
      inputSchema: {},
      annotations: readOnly,
      _meta: { securitySchemes: oauthSecurity },
    },
    async () => result({
      tasks: {
        available: true,
        api: "Hubstaff V2",
        fields: ["task details", "status", "created_at", "updated_at", "source identifiers"],
      },
      tracked_time: { available: true, per_task: true, per_user: true },
      task_comments: {
        available: false,
        reason: "The public Hubstaff V2 API does not expose task comments.",
        alternative: "Use project_type and remote_id to query the originating task system when available.",
      },
      audit_history: {
        available: "conditional",
        requirement: "Hubstaff Enterprise plan and an Owner or Organization Manager with permission to view others' data",
        includes_comments: false,
      },
    }),
  );

  registerTool(
    "hubstaff_list_organizations",
    {
      title: "List Hubstaff organizations",
      description: "Lists organizations visible to the configured Hubstaff credential. Use this to discover organization_id.",
      inputSchema: { page_limit: z.number().int().min(1).max(100).default(100) },
      annotations: readOnly,
      _meta: { securitySchemes: oauthSecurity },
    },
    async ({ page_limit }) => safeTool(async () => {
      const organizations = await client.get<JsonObject>("/v2/organizations", { page_limit });
      recordPage(Array.isArray(organizations?.organizations) ? organizations.organizations.length : 0);
      return result(organizations);
    }),
  );

  registerTool(
    "hubstaff_list_tasks",
    {
      title: "List Hubstaff tasks",
      description: "Lists time-tracking tasks for an organization, with optional status, project, and assignee filters.",
      inputSchema: {
        organization_id: z.number().int().positive(),
        status: z.array(z.enum(["active", "completed", "deleted", "archived"])).optional(),
        project_ids: z.array(z.number().int().positive()).optional(),
        user_ids: z.array(z.number().int().positive()).optional(),
        max_items: z.number().int().min(1).max(1000).default(200),
      },
      annotations: readOnly,
      _meta: { securitySchemes: oauthSecurity },
    },
    async ({ organization_id, status, project_ids, user_ids, max_items }) => safeTool(async () => {
      const tasks = await collectPages(
        client,
        `/v2/organizations/${organization_id}/tasks`,
        "tasks",
        { status, project_ids, user_ids, include: ["users", "projects"] },
        max_items,
      );
      return result({
        tasks,
        count: tasks.length,
        capabilities: { comments_available_via_hubstaff_v2: false, source_fields: ["project_type", "integration_id", "remote_id"] },
      });
    }),
  );

  registerTool(
    "hubstaff_get_task",
    {
      title: "Get a Hubstaff task",
      description: "Returns the full Hubstaff time-tracking task record by task ID.",
      inputSchema: { task_id: z.number().int().positive() },
      annotations: readOnly,
      _meta: { securitySchemes: oauthSecurity },
    },
    async ({ task_id }) => safeTool(async () => {
      const task = await client.get<JsonObject>(`/v2/tasks/${task_id}`);
      recordPage(1);
      return result({ ...task, task_source: taskSource(task) });
    }),
  );

  registerTool(
    "hubstaff_recent_updates",
    {
      title: "Get recent task and time updates",
      description: "Returns tasks updated since a timestamp and optionally activity records changed in the same period.",
      inputSchema: {
        organization_id: z.number().int().positive(),
        since: z.string().datetime(),
        until: z.string().datetime().optional(),
        include_time_updates: z.boolean().default(true),
        max_items: z.number().int().min(1).max(1000).default(200),
      },
      annotations: readOnly,
      _meta: { securitySchemes: oauthSecurity },
    },
    async ({ organization_id, since, until, include_time_updates, max_items }) => safeTool(async () => {
      const stop = until ?? new Date().toISOString();
      const allTasks = await collectPages(
        client,
        `/v2/organizations/${organization_id}/tasks`,
        "tasks",
        { include: ["users", "projects"] },
        max_items,
      );
      const taskUpdates = allTasks
        .filter((task) => timestamp(task.updated_at) >= Date.parse(since) && timestamp(task.updated_at) < Date.parse(stop))
        .sort((a, b) => timestamp(b.updated_at) - timestamp(a.updated_at));
      let timeUpdates: JsonObject[] = [];
      if (include_time_updates) {
        const span = Date.parse(stop) - Date.parse(since);
        if (span > 7 * 24 * 3600 * 1000) {
          throw new ToolInputError("Hubstaff limits activity update queries to 7 days; choose a shorter interval.");
        }
        timeUpdates = await collectPages(
          client,
          `/v2/organizations/${organization_id}/activities/updates`,
          "activities",
          { "updated[start]": since, "updated[stop]": stop, include: ["users", "projects", "tasks"] },
          max_items,
        );
      }
      return result({
        since,
        until: stop,
        task_updates: taskUpdates,
        time_updates: timeUpdates,
        capabilities: { comments_available_via_hubstaff_v2: false },
      });
    }),
  );

  registerTool(
    "hubstaff_task_hours",
    {
      title: "Calculate hours spent on a task",
      description: "Aggregates tracked seconds and hours for a task over a date range, including a per-user breakdown.",
      inputSchema: {
        organization_id: z.number().int().positive(),
        task_id: z.number().int().positive(),
        start: z.string().datetime(),
        stop: z.string().datetime(),
        max_entries: z.number().int().min(1).max(10000).default(5000),
      },
      annotations: readOnly,
      _meta: { securitySchemes: oauthSecurity },
    },
    async ({ organization_id, task_id, start, stop, max_entries }) => safeTool(async () => {
      const startMs = Date.parse(start);
      const stopMs = Date.parse(stop);
      if (stopMs <= startMs) throw new ToolInputError("stop must be later than start");
      if (stopMs - startMs > 183 * 24 * 3600 * 1000) {
        throw new ToolInputError("The requested range cannot exceed 183 days.");
      }

      const activities: JsonObject[] = [];
      const chunkMs = 7 * 24 * 3600 * 1000;
      for (let cursor = startMs; cursor < stopMs && activities.length < max_entries; cursor += chunkMs) {
        const chunkStop = Math.min(stopMs, cursor + chunkMs);
        activities.push(
          ...(await collectPages(
            client,
            `/v2/organizations/${organization_id}/activities`,
            "activities",
            {
              "time_slot[start]": new Date(cursor).toISOString(),
              "time_slot[stop]": new Date(chunkStop).toISOString(),
              task_ids: [task_id],
              include: ["users", "projects", "tasks"],
            },
            max_entries - activities.length,
          )),
        );
      }
      const perUser = new Map<string, number>();
      let totalSeconds = 0;
      for (const activity of activities) {
        const tracked = typeof activity.tracked === "number" ? activity.tracked : 0;
        totalSeconds += tracked;
        const userId = String(activity.user_id ?? "unknown");
        perUser.set(userId, (perUser.get(userId) ?? 0) + tracked);
      }
      return result({
        task_id,
        start,
        stop,
        total_seconds: totalSeconds,
        total_hours: hours(totalSeconds),
        activity_records: activities.length,
        truncated: activities.length >= max_entries,
        by_user: [...perUser.entries()].map(([user_id, seconds]) => ({ user_id, seconds, hours: hours(seconds) })),
      });
    }),
  );

  registerTool(
    "hubstaff_list_audit_log_entries",
    {
      title: "List Hubstaff audit log entries",
      description:
        "Lists organization audit events from the official Hubstaff V2 API. Enterprise plan and elevated organization permissions are required. Audit events are not task comments.",
      inputSchema: {
        organization_id: z.number().int().positive(),
        start: z.string().datetime(),
        stop: z.string().datetime(),
        event_action: z.string().min(1).optional(),
        record_type: z.string().min(1).optional(),
        subject_user_id: z.number().int().positive().optional(),
        task_id: z.number().int().positive().optional(),
        max_items: z.number().int().min(1).max(1000).default(200),
      },
      annotations: readOnly,
      _meta: { securitySchemes: oauthSecurity },
    },
    async ({ organization_id, start, stop, event_action, record_type, subject_user_id, task_id, max_items }) =>
      safeTool(async () => {
        const startMs = Date.parse(start);
        const stopMs = Date.parse(stop);
        if (stopMs <= startMs) throw new ToolInputError("stop must be later than start");
        if (stopMs - startMs > 7 * 24 * 3600 * 1000) {
          throw new ToolInputError("Hubstaff limits each audit log query to 7 days.");
        }
        const fetched = await collectPages(
          client,
          `/v2/organizations/${organization_id}/audit_log_entries`,
          "organization_audit_log_entries",
          {
            "created[start]": start,
            "created[stop]": stop,
            event_action,
            record_type,
            subject_user_id,
          },
          max_items,
        );
        const entries = task_id === undefined
          ? fetched
          : fetched.filter((entry) => {
              const type = typeof entry.record_type === "string" ? entry.record_type.toLowerCase() : "";
              return Number(entry.record_id) === task_id && type.includes("task");
            });
        return result({
          start,
          stop,
          entries,
          count: entries.length,
          fetched_count: fetched.length,
          truncated: fetched.length >= max_items,
          task_filter: task_id ?? null,
          comments_included: false,
        });
      }, "Hubstaff Audit Log requires an Enterprise plan and an Owner or Organization Manager with permission to view others' data."),
  );
  return schemas;
}
