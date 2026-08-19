import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
