export interface Config {
  port: number;
  mcpAuthToken?: string;
  organizationToken?: string;
  accessToken?: string;
  refreshToken?: string;
  authMode: "pat" | "oauth";
  clientId?: string;
  clientSecret?: string;
  apiBase: string;
  tokenUrl: string;
  tokenCachePath: string;
  requestTimeoutMs: number;
  oauthIssuer?: string;
  oauthResource?: string;
  oauthUsername?: string;
  oauthPassword?: string;
  oauthSigningSecret?: string;
  oauthStatePath: string;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = env.HUBSTAFF_AUTH_MODE === "oauth" ? "oauth" : "pat";
  const config: Config = {
    port: positiveInteger(env.PORT, 3000, "PORT"),
    authMode,
    apiBase: (optional(env.HUBSTAFF_API_BASE) ?? "https://api.hubstaff.com").replace(/\/$/, ""),
    tokenUrl: optional(env.HUBSTAFF_TOKEN_URL) ?? "https://account.hubstaff.com/access_tokens",
    tokenCachePath: optional(env.TOKEN_CACHE_PATH) ?? "/data/token.json",
    requestTimeoutMs: positiveInteger(env.REQUEST_TIMEOUT_MS, 30_000, "REQUEST_TIMEOUT_MS"),
    oauthStatePath: optional(env.OAUTH_STATE_PATH) ?? "/data/oauth-state.json",
  };

  const values: Array<[keyof Config, string | undefined]> = [
    ["mcpAuthToken", optional(env.MCP_AUTH_TOKEN)],
    ["organizationToken", optional(env.HUBSTAFF_ORGANIZATION_TOKEN)],
    ["accessToken", optional(env.HUBSTAFF_ACCESS_TOKEN)],
    ["refreshToken", optional(env.HUBSTAFF_REFRESH_TOKEN)],
    ["clientId", optional(env.HUBSTAFF_CLIENT_ID)],
    ["clientSecret", optional(env.HUBSTAFF_CLIENT_SECRET)],
    ["oauthIssuer", optional(env.OAUTH_ISSUER)?.replace(/\/$/, "")],
    ["oauthResource", optional(env.OAUTH_RESOURCE)],
    ["oauthUsername", optional(env.OAUTH_USERNAME)],
    ["oauthPassword", optional(env.OAUTH_PASSWORD)],
    ["oauthSigningSecret", optional(env.OAUTH_SIGNING_SECRET)],
  ];
  for (const [key, value] of values) {
    if (value !== undefined) Object.assign(config, { [key]: value });
  }

  if (config.mcpAuthToken && config.mcpAuthToken.length < 32) {
    throw new Error("MCP_AUTH_TOKEN must contain at least 32 characters");
  }
  if (config.authMode === "oauth" && config.refreshToken && (!config.clientId || !config.clientSecret)) {
    throw new Error("OAuth refresh mode requires HUBSTAFF_CLIENT_ID and HUBSTAFF_CLIENT_SECRET");
  }
  const oauthValues = [
    config.oauthIssuer,
    config.oauthUsername,
    config.oauthPassword,
    config.oauthSigningSecret,
  ];
  if (oauthValues.some(Boolean) && !oauthValues.every(Boolean)) {
    throw new Error("OAuth requires OAUTH_ISSUER, OAUTH_USERNAME, OAUTH_PASSWORD, and OAUTH_SIGNING_SECRET");
  }
  if (config.oauthIssuer) {
    const issuer = new URL(config.oauthIssuer);
    if (issuer.protocol !== "https:" && issuer.hostname !== "localhost") {
      throw new Error("OAUTH_ISSUER must use HTTPS");
    }
    config.oauthResource ??= `${config.oauthIssuer}/mcp`;
    if ((config.oauthPassword?.length ?? 0) < 16) {
      throw new Error("OAUTH_PASSWORD must contain at least 16 characters");
    }
    if ((config.oauthSigningSecret?.length ?? 0) < 32) {
      throw new Error("OAUTH_SIGNING_SECRET must contain at least 32 characters");
    }
  }
  return config;
}

export function hasHubstaffCredentials(config: Config): boolean {
  return Boolean(config.organizationToken || config.accessToken || config.refreshToken);
}

export function hasOAuth(config: Config): boolean {
  return Boolean(
    config.oauthIssuer &&
      config.oauthResource &&
      config.oauthUsername &&
      config.oauthPassword &&
      config.oauthSigningSecret,
  );
}
