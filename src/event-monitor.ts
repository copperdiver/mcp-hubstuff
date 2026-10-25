import type { EventConfig } from "./config.js";
import type { EventSource, EventStore, HubstaffEvent } from "./events.js";
import { HubstaffClient, nextPageStartId, type Query } from "./hubstaff-client.js";
import { HubstaffApiError, HubstaffRequestError } from "./errors.js";

type Row = Record<string, unknown>;
type Batch = { event: HubstaffEvent; dedupeKey: string }[];
const sources: EventSource[] = ["tasks", "activities", "time_edits", "audit"];
const overlapMs = 120_000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function taskSnapshot(row: Row): Row {
  const snapshot: Row = {};
  for (const field of ["id", "status", "due_at", "due_date", "summary", "details", "metadata", "updated_at"]) {
    if (row[field] !== undefined) snapshot[field] = row[field];
  }
  snapshot.assignee_ids = [...(Array.isArray(row.assignee_ids) ? row.assignee_ids : [])].sort();
  return canonical(JSON.parse(JSON.stringify(snapshot))) as Row;
}

export class EventMonitor {
  private running = false;
  private generation = 0;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly listeners = new Set<(organizationId: number) => void>();

  constructor(private readonly config: EventConfig, private readonly client: HubstaffClient,
    private readonly store: EventStore, private readonly clock: () => Date = () => new Date()) {}

  start(): void {
    if (this.running || !this.config.enabled) return;
    this.running = true;
    const generation = ++this.generation;
    for (const organizationId of this.config.organizationIds) {
      for (const source of sources) this.schedule(organizationId, source, 0, generation);
    }
  }

  stop(): void {
    this.running = false;
    this.generation++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  onEvents(listener: (organizationId: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async runSource(organizationId: number, source: EventSource): Promise<void> {
    const key = `${source}:${organizationId}`;
    if (!this.config.enabled || !this.config.organizationIds.includes(organizationId) || this.inFlight.has(key) ||
        this.unavailable.has(key) || (this.retryAt.get(key) ?? 0) > this.clock().getTime()) return;
    this.inFlight.add(key);
    const observedAt = this.clock().toISOString();
    const previousHealth = this.store.status(organizationId).find((item) => item.source === source);
    let rateResetAt: number | undefined;
    try {
      const previous = this.store.getSourceState(source, organizationId);
      const snapshot: Record<string, unknown> = { ...(previous?.snapshot as Record<string, unknown> | undefined) };
      const batch: Batch = [];
      const base = `/v2/organizations/${organizationId}`;
      const start = new Date(Math.max(Date.parse(previous?.watermark ?? observedAt) - overlapMs,
        Date.parse(observedAt) - 7 * 24 * 3600_000)).toISOString();
      const spec = source === "tasks" ? { path: "tasks", key: "tasks", query: { status: ["active", "completed"] } } :
        source === "activities" ? { path: "activities/updates", key: "activities", query: { "updated[start]": start, "updated[stop]": observedAt } } :
        source === "time_edits" ? { path: "time_edit_logs", key: "time_edit_logs", query: { "created[start]": start, "created[stop]": observedAt } } :
        { path: "audit_log_entries", key: "organization_audit_log_entries", query: { "created[start]": start, "created[stop]": observedAt } };
      const rows = await this.pages(`${base}/${spec.path}`, spec.key, spec.query, (resetAt) => {
        rateResetAt = Math.max(rateResetAt ?? 0, resetAt);
      });
      const event = (id: string, timestamp: string, type: HubstaffEvent["type"], payload: Row): HubstaffEvent => ({
        id: "", source, organizationId, type, sourceRecordId: id, sourceTimestamp: timestamp, observedAt,
        priority: "normal", summary: type === "activity.changed" ? "Activity changed" : `${source === "tasks" ? "Task" : source === "time_edits" ? "Time edit" : "Audit entry"} ${id} ${type.endsWith("updated") ? "updated" : "created"}`,
        payload,
      });
      const changedActivities = new Map<string, string>();
      for (const row of rows) {
        if ((typeof row.id !== "string" && typeof row.id !== "number") || String(row.id).length === 0) {
          throw new Error("Invalid source record");
        }
        const id = String(row.id);
        const timestamp = String((source === "tasks" || source === "activities" ? row.updated_at : row.created_at) ?? observedAt);
        if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Invalid source timestamp");
        if (source === "tasks") {
          const normalized = taskSnapshot(row);
          const old = snapshot[id];
          snapshot[id] = normalized;
          if (previous?.initialized && JSON.stringify(old) !== JSON.stringify(normalized)) {
            batch.push({ event: event(id, timestamp, old ? "task.updated" : "task.created", normalized),
              dedupeKey: `${key}:${id}:${observedAt}:${JSON.stringify(normalized)}` });
          }
        } else {
          const identity = source === "activities" ? `${id}:${timestamp}` : id;
          if (snapshot[identity] !== undefined) continue;
          snapshot[identity] = timestamp;
          if (!previous?.initialized) continue;
          if (source === "activities") changedActivities.set(identity, timestamp);
          else {
            const payload: Row = { id };
            for (const field of ["user_id", "project_id", "task_id", "action", "event_action", "record_type", "record_id"]) {
              if (typeof row[field] === "string" || typeof row[field] === "number") payload[field] = row[field];
            }
            batch.push({ event: event(id, timestamp, source === "time_edits" ? "time_edit.created" : "audit.created", payload),
              dedupeKey: `${key}:${identity}` });
          }
        }
      }
      if (changedActivities.size) {
        const timestamps = [...changedActivities.values()].sort((a, b) => Date.parse(a) - Date.parse(b));
        const first = timestamps[0]!;
        const last = timestamps.at(-1)!;
        const identity = [...changedActivities.keys()].sort().join(",");
        batch.push({ event: event(observedAt, last, "activity.changed", { count: changedActivities.size, start: first, stop: last }),
          dedupeKey: `${key}:${identity}` });
      }
      // Window sources only need identities still inside the next overlapping query.
      if (source !== "tasks") {
        const cutoff = Date.parse(observedAt) - overlapMs;
        for (const [identity, timestamp] of Object.entries(snapshot)) {
          if (Date.parse(String(timestamp)) < cutoff) delete snapshot[identity];
        }
      }
      const appended = await this.store.commitSourceBatch(source, organizationId, snapshot, observedAt, batch);
      if (appended) {
        for (const listener of this.listeners) {
          try { listener(organizationId); } catch { /* A subscriber cannot interrupt other subscribers or polling. */ }
        }
      }
      this.failures.delete(key);
      this.retryAt.delete(key);
      if (rateResetAt !== undefined && rateResetAt > this.clock().getTime()) this.retryAt.set(key, rateResetAt);
      await this.store.setSourceStatus({ source, organizationId, status: "healthy", lastSuccessAt: observedAt,
        nextPollAt: new Date(Math.max(Date.parse(observedAt) + this.interval(source), rateResetAt ?? 0)).toISOString() });
    } catch (error) {
      const status = error instanceof HubstaffApiError ? error.status : undefined;
      const forbidden = source === "audit" && status === 403;
      const transient = status === 429 || (status !== undefined && status >= 500) ||
        (error instanceof HubstaffRequestError && (error.kind === "network" || error.kind === "timeout"));
      const failures = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, failures);
      const delay = status === 429 && error instanceof HubstaffApiError ? error.retryAfterMs ?? this.interval(source) :
        transient ? Math.min(this.interval(source), 1000 * 2 ** Math.min(failures - 1, 30)) : this.interval(source);
      const nextPollAt = this.clock().getTime() + delay;
      this.retryAt.set(key, nextPollAt);
      if (forbidden) this.unavailable.add(key);
      await this.store.setSourceStatus({ source, organizationId,
        status: forbidden ? "unavailable" : transient ? "backoff" : "error",
        ...(previousHealth?.lastSuccessAt ? { lastSuccessAt: previousHealth.lastSuccessAt } : {}),
        ...(!forbidden ? { nextPollAt: new Date(nextPollAt).toISOString() } : {}),
        lastErrorCode: status === undefined ? error instanceof HubstaffRequestError ? error.kind : "internal" : `http_${status}` });
    } finally { this.inFlight.delete(key); }
  }

  private interval(source: EventSource): number {
    return this.config.intervalsMs[source === "time_edits" ? "timeEdits" : source];
  }

  private schedule(organizationId: number, source: EventSource, delay: number, generation: number): void {
    const key = `${source}:${organizationId}`;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.runSource(organizationId, source).catch(() => undefined).finally(() => {
        if (!this.running || this.generation !== generation || this.unavailable.has(key)) return;
        const retryAt = this.retryAt.get(key);
        const health = this.store.status(organizationId).find((item) => item.source === source);
        const retryDelay = retryAt === undefined ? this.interval(source) : Math.max(0, retryAt - this.clock().getTime());
        this.schedule(organizationId, source, retryAt === undefined ? this.interval(source) :
          health?.status === "healthy" ? Math.max(this.interval(source), retryDelay) : retryDelay, generation);
      });
    }, Math.min(delay, 2_147_483_647));
    timer.unref();
    this.timers.set(key, timer);
  }

  private async pages(path: string, key: string, query: Query, onRateReset: (resetAt: number) => void): Promise<Row[]> {
    const rows: Row[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.client.getWithMeta<Record<string, unknown>>(path,
        { ...query, page_limit: 500, page_start_id: cursor });
      const { data } = result;
      const rateLimit = result.meta.rateLimit;
      if (rateLimit?.remaining === 0 && rateLimit.resetAt !== undefined) onRateReset(rateLimit.resetAt);
      if (!Array.isArray(data[key])) throw new Error("Invalid source response");
      rows.push(...data[key] as Row[]);
      cursor = nextPageStartId(data);
      if (cursor !== undefined && visited.has(cursor)) throw new Error("Repeated page cursor");
      if (cursor !== undefined) visited.add(cursor);
    } while (cursor !== undefined);
    return rows;
  }
}
