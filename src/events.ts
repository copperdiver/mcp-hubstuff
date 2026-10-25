import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const sourceSchema = z.enum(["tasks", "activities", "time_edits", "audit"]);
const typeSchema = z.enum(["task.created", "task.updated", "activity.changed", "time_edit.created", "audit.created"]);
export type EventSource = z.infer<typeof sourceSchema>;
export type HubstaffEventType = z.infer<typeof typeSchema>;

const eventSchema = z.object({
  id: z.string(), organizationId: z.number().int().positive(), source: sourceSchema, type: typeSchema,
  sourceRecordId: z.string(), sourceTimestamp: z.string(), observedAt: z.string(),
  priority: z.enum(["normal", "high"]), summary: z.string(), payload: z.record(z.unknown()),
}).strict();
export type HubstaffEvent = z.infer<typeof eventSchema>;

const statusSchema = z.object({
  source: sourceSchema, organizationId: z.number().int().positive(),
  status: z.enum(["idle", "healthy", "backoff", "unavailable", "error"]),
  lastSuccessAt: z.string().optional(), nextPollAt: z.string().optional(), lastErrorCode: z.string().optional(),
}).strict();
export type MonitorSourceStatus = z.infer<typeof statusSchema>;

export interface StoredSourceState {
  initialized: boolean;
  snapshot: unknown;
  watermark?: string;
}

export interface EventStore {
  load(): Promise<void>;
  baseline(source: EventSource, organizationId: number, snapshot: unknown): Promise<void>;
  append(event: HubstaffEvent, dedupeKey: string, watermark: string): Promise<boolean>;
  list(organizationId: number, after?: string, types?: HubstaffEventType[], limit?: number): HubstaffEvent[];
  status(organizationId: number): MonitorSourceStatus[];
  setSourceStatus(status: MonitorSourceStatus): Promise<void>;
  getSourceState(source: EventSource, organizationId: number): StoredSourceState | undefined;
  commitSourceBatch(source: EventSource, organizationId: number, snapshot: unknown, watermark: string,
    batch: { event: HubstaffEvent; dedupeKey: string }[]): Promise<number>;
}

const stateSchema = z.object({
  version: z.literal(1), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  events: z.array(eventSchema), dedupeKeys: z.array(z.string()),
  sources: z.record(z.object({
    initialized: z.boolean(), snapshot: z.unknown(), watermark: z.string().optional(),
  }).strict().refine((value) => Object.hasOwn(value, "snapshot"))),
  health: z.record(statusSchema),
}).strict();
type Document = z.infer<typeof stateSchema>;

function emptyDocument(): Document {
  return { version: 1, sequence: 0, events: [], dedupeKeys: [], sources: {}, health: {} };
}

function key(source: EventSource, organizationId: number): string {
  return `${source}:${organizationId}`;
}

/** Single-process store for normalized, allowlisted monitor data. Dedupe spans the retained feed. */
export class JsonEventStore implements EventStore {
  private document = emptyDocument();
  private pending: Promise<unknown> = Promise.resolve();
  private readonly retention: number;

  constructor(private readonly statePath: string, options: { retention: number }) {
    if (!Number.isSafeInteger(options.retention) || options.retention < 1) {
      throw new Error("Event retention must be a positive integer");
    }
    this.retention = options.retention;
  }

  async load(): Promise<void> {
    return this.enqueue(async () => {
      let raw: string;
      try { raw = await readFile(this.statePath, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.document = emptyDocument();
          return;
        }
        throw new Error("Unable to read event state");
      }
      try {
        const document = stateSchema.parse(JSON.parse(raw));
        if (document.events.length !== document.dedupeKeys.length) throw new Error();
        this.document = document;
      } catch { throw new Error("Invalid event state"); }
    });
  }

  async baseline(source: EventSource, organizationId: number, snapshot: unknown): Promise<void> {
    return this.enqueue(async () => {
      const next = structuredClone(this.document);
      next.sources[key(source, organizationId)] = {
        ...next.sources[key(source, organizationId)], initialized: true, snapshot: structuredClone(snapshot),
      };
      await this.commit(next);
    });
  }

  async append(event: HubstaffEvent, dedupeKey: string, watermark: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.document.dedupeKeys.includes(dedupeKey)) return false;
      const next = structuredClone(this.document);
      if (next.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Event sequence exhausted");
      const id = (++next.sequence).toString(36).padStart(16, "0");
      next.events.push(structuredClone({ ...event, id }));
      next.dedupeKeys.push(dedupeKey);
      next.events = next.events.slice(-this.retention);
      next.dedupeKeys = next.dedupeKeys.slice(-this.retention);
      const sourceKey = key(event.source, event.organizationId);
      next.sources[sourceKey] = {
        ...(next.sources[sourceKey] ?? { initialized: false, snapshot: null }), watermark,
      };
      await this.commit(next);
      return true;
    });
  }

  /** Publish the source checkpoint and all new events in one durable replacement. */
  async commitSourceBatch(source: EventSource, organizationId: number, snapshot: unknown, watermark: string,
    batch: { event: HubstaffEvent; dedupeKey: string }[]): Promise<number> {
    return this.enqueue(async () => {
      const next = structuredClone(this.document);
      let appended = 0;
      for (const { event, dedupeKey } of batch) {
        if (event.source !== source || event.organizationId !== organizationId) throw new Error("Invalid event batch");
        if (next.dedupeKeys.includes(dedupeKey)) continue;
        if (next.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Event sequence exhausted");
        const id = (++next.sequence).toString(36).padStart(16, "0");
        next.events.push(structuredClone({ ...event, id }));
        next.dedupeKeys.push(dedupeKey);
        appended++;
      }
      next.events = next.events.slice(-this.retention);
      next.dedupeKeys = next.dedupeKeys.slice(-this.retention);
      next.sources[key(source, organizationId)] = { initialized: true, snapshot: structuredClone(snapshot), watermark };
      await this.commit(next);
      return appended;
    });
  }

  list(organizationId: number, after?: string, types?: HubstaffEventType[], limit = this.retention): HubstaffEvent[] {
    return structuredClone(this.document.events.filter((event) =>
      event.organizationId === organizationId && (after === undefined || event.id > after) &&
      (types === undefined || types.includes(event.type)),
    ).slice(0, Math.max(0, Math.min(limit, this.retention))));
  }

  getSourceState(source: EventSource, organizationId: number): StoredSourceState | undefined {
    const state = this.document.sources[key(source, organizationId)];
    return state === undefined ? undefined : structuredClone({ ...state, snapshot: state.snapshot });
  }

  status(organizationId: number): MonitorSourceStatus[] {
    return structuredClone(Object.values(this.document.health).filter((item) => item.organizationId === organizationId));
  }

  async setSourceStatus(status: MonitorSourceStatus): Promise<void> {
    return this.enqueue(async () => {
      const next = structuredClone(this.document);
      next.health[key(status.source, status.organizationId)] = structuredClone(status);
      await this.commit(next);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async commit(next: Document): Promise<void> {
    try {
      // Validate the actual JSON representation before it can replace durable state.
      const serialized = JSON.stringify(stateSchema.parse(next));
      const persisted = stateSchema.parse(JSON.parse(serialized));
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      await mkdir(dirname(this.statePath), { recursive: true });
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        try {
          await file.writeFile(serialized, "utf8");
          await file.sync();
        } finally { await file.close(); }
        await rename(temporaryPath, this.statePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
      this.document = persisted;
    } catch {
      // Neither filesystem paths nor validation input may reach public diagnostics.
      throw new Error("Unable to write event state");
    }
  }
}
