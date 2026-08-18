import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HubstaffApiError, HubstaffClient, nextPageStartId, type Query } from "./hubstaff-client.js";

type JsonObject = Record<string, unknown>;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { result: data },
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
    "hubstaff_list_organizations",
    {
      title: "List Hubstaff organizations",
      description: "Lists organizations visible to the configured Hubstaff credential. Use this to discover organization_id.",
      inputSchema: { page_limit: z.number().int().min(1).max(100).default(100) },
      annotations: readOnly,
    },
    async ({ page_limit }) => result(await client.get("/v2/organizations", { page_limit })),
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
    },
    async ({ organization_id, status, project_ids, user_ids, max_items }) => {
      const tasks = await collectPages(
        client,
        `/v2/organizations/${organization_id}/tasks`,
        "tasks",
        { status, project_ids, user_ids, include: ["users", "projects"] },
        max_items,
      );
      return result({ tasks, count: tasks.length });
    },
  );

  server.registerTool(
    "hubstaff_get_task",
    {
      title: "Get a Hubstaff task",
      description: "Returns the full Hubstaff time-tracking task record by task ID.",
      inputSchema: { task_id: z.number().int().positive() },
      annotations: readOnly,
    },
    async ({ task_id }) => result(await client.get(`/v2/tasks/${task_id}`)),
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
    },
    async ({ organization_id, since, until, include_time_updates, max_items }) => {
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
          throw new Error("Hubstaff limits activity update queries to 7 days; choose a shorter interval.");
        }
        timeUpdates = await collectPages(
          client,
          `/v2/organizations/${organization_id}/activities/updates`,
          "activities",
          { "updated[start]": since, "updated[stop]": stop, include: ["users", "projects", "tasks"] },
          max_items,
        );
      }
      return result({ since, until: stop, task_updates: taskUpdates, time_updates: timeUpdates });
    },
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
    },
    async ({ organization_id, task_id, start, stop, max_entries }) => {
      const startMs = Date.parse(start);
      const stopMs = Date.parse(stop);
      if (stopMs <= startMs) throw new Error("stop must be later than start");
      if (stopMs - startMs > 183 * 24 * 3600 * 1000) throw new Error("The requested range cannot exceed 183 days.");

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
    },
  );

  server.registerTool(
    "hubstaff_tasks_list_projects",
    {
      title: "List Hubstaff Tasks projects",
      description: "Lists project boards from the Hubstaff Tasks API v1.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => result(await client.get("/v1/tasks/projects")),
  );

  server.registerTool(
    "hubstaff_tasks_list_project_tasks",
    {
      title: "List Hubstaff Tasks board tasks",
      description: "Lists tasks in a Hubstaff Tasks project board.",
      inputSchema: { project_id: z.string().min(1) },
      annotations: readOnly,
    },
    async ({ project_id }) => result(await client.get(`/v1/tasks/projects/${encodeURIComponent(project_id)}/tasks`)),
  );

  server.registerTool(
    "hubstaff_tasks_get_task",
    {
      title: "Get a Hubstaff Tasks board task",
      description: "Returns a task from the Hubstaff Tasks API v1, including any embedded history or comments.",
      inputSchema: { task_id: z.string().min(1) },
      annotations: readOnly,
    },
    async ({ task_id }) => result(await client.get(`/v1/tasks/tasks/${encodeURIComponent(task_id)}`)),
  );

  server.registerTool(
    "hubstaff_tasks_list_comments",
    {
      title: "List comments on a Hubstaff Tasks task",
      description: "Lists comments for a Hubstaff Tasks board task. Availability depends on the Tasks API plan and token scope.",
      inputSchema: { task_id: z.string().min(1) },
      annotations: readOnly,
    },
    async ({ task_id }) => {
      const encoded = encodeURIComponent(task_id);
      try {
        return result(await client.get(`/v1/tasks/tasks/${encoded}/comments`));
      } catch (error) {
        if (!(error instanceof HubstaffApiError) || error.status !== 404) throw error;
        const task = await client.get<JsonObject>(`/v1/tasks/tasks/${encoded}`);
        const record = (task.task as JsonObject | undefined) ?? task;
        const embedded = record.comments ?? record.updates ?? record.history;
        if (embedded !== undefined) return result({ task_id, comments: embedded, source: "embedded_task_data" });
        throw new Error(
          "The Hubstaff Tasks API did not expose a comments endpoint or embedded comments for this task/token. Ensure the token has tasks:read and the organization plan exposes task comments.",
        );
      }
    },
  );
}
