import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HubstaffApiError, HubstaffClient, nextPageStartId, type Query } from "./hubstaff-client.js";

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

function errorResult(code: string, message: string, status?: number): ToolResult {
  return {
    ...result({ error: { code, message, ...(status === undefined ? {} : { status }) } }),
    isError: true,
  };
}

class ToolInputError extends Error {}

function apiErrorDetail(error: HubstaffApiError): string | undefined {
  try {
    const body = JSON.parse(error.body) as Record<string, unknown>;
    const detail = body.error_description ?? body.error ?? body.code;
    return typeof detail === "string" && detail.trim() ? detail.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function hubstaffErrorResult(error: unknown, forbiddenMessage?: string): ToolResult {
  if (error instanceof ToolInputError) return errorResult("INVALID_ARGUMENT", error.message);
  if (!(error instanceof HubstaffApiError)) {
    return errorResult("TOOL_EXECUTION_FAILED", "The Hubstaff request could not be completed.");
  }

  const detail = apiErrorDetail(error);
  const suffix = detail ? ` Hubstaff response: ${detail}.` : "";
  switch (error.status) {
    case 400:
      return errorResult("HUBSTAFF_INVALID_REQUEST", `Hubstaff rejected the request parameters.${suffix}`, 400);
    case 401:
      return errorResult(
        "HUBSTAFF_AUTHENTICATION_FAILED",
        `Hubstaff rejected the configured credential. Check that the PAT refresh token is current and that token rotation is persisted.${suffix}`,
        401,
      );
    case 403:
      return errorResult(
        "HUBSTAFF_ACCESS_DENIED",
        `${forbiddenMessage ?? "The configured Hubstaff member, plan, or hubstaff:read scope does not permit this request."}${suffix}`,
        403,
      );
    case 404:
      return errorResult(
        "HUBSTAFF_RESOURCE_NOT_FOUND",
        `Hubstaff could not find this V2 resource. Verify that the ID belongs to the configured organization.${suffix}`,
        404,
      );
    case 429:
      return errorResult("HUBSTAFF_RATE_LIMITED", `Hubstaff rate-limited the request. Retry later.${suffix}`, 429);
    default:
      return errorResult("HUBSTAFF_API_ERROR", `Hubstaff returned HTTP ${error.status}.${suffix}`, error.status);
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

async function collectPages(
  client: HubstaffClient,
  path: string,
  collection: string,
  query: Query,
  maxItems = 1000,
): Promise<JsonObject[]> {
  const items: JsonObject[] = [];
  let pageStartId: string | undefined;
  while (items.length < maxItems) {
    const page = await client.get<JsonObject>(path, {
      ...query,
      page_limit: Math.min(100, maxItems - items.length),
      ...(pageStartId ? { page_start_id: pageStartId } : {}),
    });
    const current = Array.isArray(page[collection]) ? (page[collection] as JsonObject[]) : [];
    items.push(...current);
    const next = nextPageStartId(page);
    if (!next || current.length === 0 || next === pageStartId) break;
    pageStartId = next;
  }
  return items;
}

export function registerTools(server: McpServer, client: HubstaffClient): void {
  server.registerTool(
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

  server.registerTool(
    "hubstaff_list_organizations",
    {
      title: "List Hubstaff organizations",
      description: "Lists organizations visible to the configured Hubstaff credential. Use this to discover organization_id.",
      inputSchema: { page_limit: z.number().int().min(1).max(100).default(100) },
      annotations: readOnly,
      _meta: { securitySchemes: oauthSecurity },
    },
    async ({ page_limit }) => safeTool(async () => result(await client.get("/v2/organizations", { page_limit }))),
  );

  server.registerTool(
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

  server.registerTool(
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
      return result({ ...task, task_source: taskSource(task) });
    }),
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
}
