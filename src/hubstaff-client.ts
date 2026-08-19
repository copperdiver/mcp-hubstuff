import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.js";

type QueryValue = string | number | boolean | Array<string | number> | undefined;
export type Query = Record<string, QueryValue>;

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

export class HubstaffApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message = `Hubstaff API request failed with HTTP ${status}`,
  ) {
    super(message);
    this.name = "HubstaffApiError";
  }
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
    const token = await this.getToken();
    const response = await this.fetchWithToken(method, path, token, query);
    if (response.status === 401 && this.refreshToken && !this.config.organizationToken) {
      this.expiresAt = 0;
      const refreshed = await this.refresh();
      return this.parseResponse<T>(await this.fetchWithToken(method, path, refreshed, query));
    }
    return this.parseResponse<T>(response);
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query);
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
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new HubstaffApiError(response.status, await response.text(), "Unable to refresh the Hubstaff access token");
    }
    const token = (await response.json()) as TokenResponse;
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

  private fetchWithToken(method: string, path: string, token: string, query?: Query): Promise<Response> {
    const url = new URL(path, `${this.config.apiBase}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key.endsWith("[]") ? key : `${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) throw new HubstaffApiError(response.status, await response.text());
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }
}

export function nextPageStartId(response: Record<string, unknown>): string | undefined {
  const pagination = response.pagination as Record<string, unknown> | undefined;
  const value = response.next_page_start_id ?? pagination?.next_page_start_id;
  return value === undefined || value === null ? undefined : String(value);
}
