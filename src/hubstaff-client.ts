import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import { currentDiagnostic, elapsed, inDiagnostic, logDiagnostic, newDiagnostic } from "./diagnostics.js";
import { HubstaffApiError, HubstaffRequestError, isTimeout } from "./errors.js";

export { HubstaffApiError } from "./errors.js";

type QueryValue = string | number | boolean | Array<string | number> | undefined;
export type Query = Record<string, QueryValue>;

export interface HubstaffResponseMeta {
  rateLimit?: { limit?: number; remaining?: number; resetAt?: number };
}

function nonNegativeHeader(value: string | null, multiplier = 1): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const parsed = Number(value) * multiplier;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function responseMeta(headers: Headers): HubstaffResponseMeta {
  const limit = nonNegativeHeader(headers.get("x-rate-limit-limit"));
  const remaining = nonNegativeHeader(headers.get("x-rate-limit-remaining"));
  const resetAt = nonNegativeHeader(headers.get("x-rate-limit-reset"), 1000);
  if (limit === undefined && remaining === undefined && resetAt === undefined) return {};
  return { rateLimit: {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  } };
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  const seconds = nonNegativeHeader(value, 1000);
  if (seconds !== undefined) return seconds;
  // Date.parse also accepts bare numbers and incomplete dates. Only allow
  // the three HTTP-date formats before parsing an upstream header.
  const httpDates = [
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} ( \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/,
  ];
  if (value === null || !httpDates.some((format) => format.test(value))) return undefined;
  const date = Date.parse(value.endsWith(" GMT") ? value : `${value} GMT`);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

interface CachedToken {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export class HubstaffClient {
  private accessToken?: string;
  private refreshToken?: string;
  private expiresAt?: number;
  private initialized = false;
  private refreshPromise?: Promise<string>;

  constructor(private readonly config: Config) {
    this.accessToken = config.organizationToken ?? config.accessToken;
    this.refreshToken = config.refreshToken;
    if (config.accessToken) this.expiresAt = Date.now() + 55 * 60 * 1000;
  }

  async request<T>(method: string, path: string, query?: Query): Promise<T> {
    return (await this.requestWithMeta<T>(method, path, query)).data;
  }

  private async requestWithMeta<T>(
    method: string, path: string, query?: Query,
  ): Promise<{ data: T; meta: HubstaffResponseMeta }> {
    if (!currentDiagnostic()) {
      return inDiagnostic(newDiagnostic(), () => this.requestWithMeta<T>(method, path, query));
    }
    const token = await this.getToken();
    const canRefresh = Boolean(this.refreshToken && !this.config.organizationToken);
    const response = await this.fetchWithToken<T>(method, path, token, query, 1, canRefresh);
    if (response.status === 401 && canRefresh) {
      logDiagnostic("upstream.retry", { phase: "api", retry_reason: "unauthorized", retry_count: 1 });
      this.expiresAt = 0;
      const refreshed = await this.refresh();
      const replay = await this.fetchWithToken<T>(method, path, refreshed, query, 2);
      return { data: replay.data as T, meta: replay.meta };
    }
    return { data: response.data as T, meta: response.meta };
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  async getWithMeta<T>(path: string, query?: Query): Promise<{ data: T; meta: HubstaffResponseMeta }> {
    try {
      return await this.requestWithMeta<T>("GET", path, query);
    } catch (error) {
      if (error instanceof HubstaffApiError && error.status === 429) {
        throw new HubstaffApiError(error.status, "", undefined, error.retryAfterMs);
      }
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.refreshToken) return;
    try {
      const cache = JSON.parse(await readFile(this.config.tokenCachePath, "utf8")) as CachedToken;
      if (cache.refreshToken) this.refreshToken = cache.refreshToken;
      if (cache.accessToken) this.accessToken = cache.accessToken;
      if (cache.expiresAt) this.expiresAt = cache.expiresAt;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  private async getToken(): Promise<string> {
    await this.initialize();
    if (this.config.organizationToken) return this.config.organizationToken;
    if (this.accessToken && (!this.expiresAt || this.expiresAt > Date.now() + 60_000)) {
      return this.accessToken;
    }
    if (this.refreshToken) return this.refresh();
    if (this.accessToken) return this.accessToken;
    throw new Error(
      "Hubstaff is not configured. Set HUBSTAFF_ORGANIZATION_TOKEN, HUBSTAFF_ACCESS_TOKEN, or HUBSTAFF_REFRESH_TOKEN in .env.",
    );
  }

  private async refresh(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async performRefresh(): Promise<string> {
    if (!this.refreshToken) throw new Error("No Hubstaff refresh token is available");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.config.authMode === "oauth") {
      headers.authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`;
    }
    const token = await this.send<TokenResponse>("token_refresh", new URL(this.config.tokenUrl), {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    }, async (response) => {
      if (!response.ok) {
        throw new HubstaffApiError(
          response.status, await this.readBody<string>(response, true), "Unable to refresh the Hubstaff access token",
        );
      }
      return this.readBody<TokenResponse>(response);
    });
    this.accessToken = token.access_token;
    this.refreshToken = token.refresh_token ?? this.refreshToken;
    this.expiresAt = Date.now() + token.expires_in * 1000;
    await this.persistToken();
    return this.accessToken;
  }

  private async persistToken(): Promise<void> {
    const target = this.config.tokenCachePath;
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt }),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, target);
  }

  private fetchWithToken<T>(
    method: string, path: string, token: string, query?: Query, attempt = 1, canRefresh = false,
  ): Promise<{ status: number; data?: T; meta: HubstaffResponseMeta }> {
    const url = new URL(path, `${this.config.apiBase}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key.endsWith("[]") ? key : `${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return this.send("api", url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    }, async (response) => ({
      status: response.status,
      meta: responseMeta(response.headers),
      data: response.status === 401 && canRefresh ? undefined : await this.parseResponse<T>(response),
    }), attempt, query);
  }

  private async send<T>(
    phase: "api" | "token_refresh",
    url: URL,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    attempt = 1,
    query?: Query,
  ): Promise<T> {
    const started = performance.now();
    const diagnostic = currentDiagnostic();
    if (diagnostic) {
      diagnostic.attempts++;
      if (attempt > 1) diagnostic.retries++;
    }
    const fields = {
      phase, http_method: init.method, attempt, retry_count: attempt - 1,
      timeout_ms: this.config.requestTimeoutMs,
      page_limit: query?.page_limit,
      page_start_id_present: query?.page_start_id !== undefined,
    };
    logDiagnostic("upstream.started", fields);
    let status: number | undefined;
    try {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        throw new HubstaffRequestError(isTimeout(error) ? "timeout" : "network", error);
      }
      status = response.status;
      const data = await consume(response);
      logDiagnostic("upstream.completed", { ...fields, upstream_status: status, duration_ms: elapsed(started) });
      return data;
    } catch (error) {
      // Fetch may report AbortError while consuming a body even when the
      // configured deadline (TimeoutError on the signal) caused the abort.
      if (error instanceof HubstaffRequestError && error.kind === "network" &&
          init.signal?.aborted && isTimeout(init.signal.reason)) {
        error = new HubstaffRequestError("timeout", error.cause, status);
      }
      logDiagnostic("upstream.failed", { ...fields, upstream_status: status, duration_ms: elapsed(started) }, error);
      throw error;
    }
  }

  private async readBody<T>(response: Response, text = false): Promise<T> {
    try {
      return (text ? await response.text() : await response.json()) as T;
    } catch (error) {
      throw new HubstaffRequestError(
        isTimeout(error) ? "timeout" : error instanceof SyntaxError ? "response" : "network",
        error, response.status,
      );
    }
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new HubstaffApiError(
        response.status, await this.readBody<string>(response, true), undefined, retryAfterMs(response.headers),
      );
    }
    if (response.status === 204) return {} as T;
    return this.readBody<T>(response);
  }
}

export function nextPageStartId(response: Record<string, unknown>): string | undefined {
  const pagination = response.pagination as Record<string, unknown> | undefined;
  const value = response.next_page_start_id ?? pagination?.next_page_start_id;
  return value === undefined || value === null ? undefined : String(value);
}
