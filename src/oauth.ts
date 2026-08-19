import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { jwtVerify, SignJWT } from "jose";
import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import type { Config } from "./config.js";

export const OAUTH_SCOPE = "hubstaff.read";

interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  subject: string;
  expiresAt: number;
}

interface RefreshGrant {
  clientId: string;
  scope: string;
  resource: string;
  subject: string;
  expiresAt: number;
}

interface OAuthState {
  clients: Record<string, RegisteredClient>;
  pending: Record<string, PendingAuthorization>;
  codes: Record<string, AuthorizationCode>;
  refreshTokens: Record<string, RefreshGrant>;
}

interface TokenBundle {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const emptyState = (): OAuthState => ({ clients: {}, pending: {}, codes: {}, refreshTokens: {} });
const now = () => Math.floor(Date.now() / 1000);
const opaqueToken = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");

function constantTimeMatches(supplied: string, expected: string): boolean {
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character] ?? character;
  });
}

function renderLogin(pendingId: string, clientName: string, error?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Hubstaff MCP</title><style>
body{font-family:system-ui,sans-serif;background:#f4f6f8;color:#17212b;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #d9e0e7;border-radius:16px;padding:32px;width:min(420px,calc(100% - 48px));box-shadow:0 12px 40px #24344718}
h1{font-size:24px;margin:0 0 8px}p{line-height:1.5;color:#52606d}label{display:block;font-weight:600;margin:20px 0 8px}
input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aab7c4;border-radius:8px;font-size:16px}
.error{color:#a61b1b;background:#fff1f1;padding:10px;border-radius:8px}.actions{display:flex;gap:10px;margin-top:24px}
button{border:0;border-radius:8px;padding:12px 18px;font-weight:700;cursor:pointer}.approve{background:#1769e0;color:#fff}.cancel{background:#e9eef3;color:#263442}
</style></head><body><main><h1>Authorize Hubstaff MCP</h1>
<p><strong>${htmlEscape(clientName)}</strong> requests read-only access to Hubstaff tasks, comments, updates, and tracked hours.</p>
${error ? `<p class="error">${htmlEscape(error)}</p>` : ""}
<form method="post" action="/oauth/authorize"><input type="hidden" name="pending_id" value="${htmlEscape(pendingId)}">
<label for="username">Username</label><input id="username" name="username" autocomplete="username" required>
<label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required>
<div class="actions"><button class="approve" name="decision" value="approve">Authorize</button><button class="cancel" name="decision" value="deny">Cancel</button></div>
</form></main></body></html>`;
}

function loginResponseHeaders(redirectUri: string): Record<string, string> {
  const callbackOrigin = new URL(redirectUri).origin;
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
  };
}

class OAuthStore {
  private state = emptyState();
  private initialized?: Promise<void>;
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        try {
          this.state = JSON.parse(await readFile(this.path, "utf8")) as OAuthState;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.cleanup();
      })();
    }
    await this.initialized;
  }

  private cleanup(): void {
    const current = now();
    for (const collection of [this.state.pending, this.state.codes, this.state.refreshTokens]) {
      for (const [key, record] of Object.entries(collection)) {
        if (record.expiresAt <= current) delete collection[key];
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.initialize();
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this.cleanup();
      const value = await operation();
      await this.persist();
      return value;
    } finally {
      release();
    }
  }

  async registerClient(clientName: string, redirectUris: string[]): Promise<RegisteredClient> {
    return this.mutate(() => {
      const clientId = `mcp_${opaqueToken()}`;
      const client = { clientId, clientName, redirectUris, createdAt: now() };
      this.state.clients[clientId] = client;
      return client;
    });
  }

  async getClient(clientId: string): Promise<RegisteredClient | undefined> {
    await this.initialize();
    return this.state.clients[clientId];
  }

  async createPending(value: Omit<PendingAuthorization, "id" | "expiresAt">): Promise<PendingAuthorization> {
    return this.mutate(() => {
      const pending = { ...value, id: opaqueToken(), expiresAt: now() + 10 * 60 };
      this.state.pending[pending.id] = pending;
      return pending;
    });
  }

  async getPending(id: string): Promise<PendingAuthorization | undefined> {
    await this.initialize();
    const pending = this.state.pending[id];
    return pending?.expiresAt && pending.expiresAt > now() ? pending : undefined;
  }

  async consumePending(id: string): Promise<PendingAuthorization | undefined> {
    return this.mutate(() => {
      const pending = this.state.pending[id];
      delete this.state.pending[id];
      return pending?.expiresAt && pending.expiresAt > now() ? pending : undefined;
    });
  }

  async issueCode(pending: PendingAuthorization, subject: string): Promise<string> {
    return this.mutate(() => {
      const code = opaqueToken();
      this.state.codes[digest(code)] = {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        scope: pending.scope,
        resource: pending.resource,
        codeChallenge: pending.codeChallenge,
        subject,
        expiresAt: now() + 5 * 60,
      };
      return code;
    });
  }

  async consumeCode(code: string): Promise<AuthorizationCode | undefined> {
    return this.mutate(() => {
      const key = digest(code);
      const grant = this.state.codes[key];
      delete this.state.codes[key];
      return grant?.expiresAt && grant.expiresAt > now() ? grant : undefined;
    });
  }

  async issueRefreshToken(grant: Omit<RefreshGrant, "expiresAt">): Promise<string> {
    return this.mutate(() => {
      const token = opaqueToken();
      this.state.refreshTokens[digest(token)] = { ...grant, expiresAt: now() + 30 * 24 * 3600 };
      return token;
    });
  }

  async rotateRefreshGrant(token: string, clientId: string, resource: string): Promise<{ grant: RefreshGrant; token: string } | undefined> {
    return this.mutate(() => {
      const key = digest(token);
      const grant = this.state.refreshTokens[key];
      if (!grant || grant.expiresAt <= now() || grant.clientId !== clientId || grant.resource !== resource) return undefined;
      delete this.state.refreshTokens[key];
      const replacement = opaqueToken();
      this.state.refreshTokens[digest(replacement)] = { ...grant, expiresAt: now() + 30 * 24 * 3600 };
      return { grant, token: replacement };
    });
  }
}

export class OAuthService {
  readonly issuer: string;
  readonly resource: string;
  readonly metadataUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly signingKey: Uint8Array;
  private readonly store: OAuthStore;

  constructor(config: Config) {
    if (!config.oauthIssuer || !config.oauthResource || !config.oauthUsername || !config.oauthPassword || !config.oauthSigningSecret) {
      throw new Error("OAuth is not fully configured");
    }
    this.issuer = config.oauthIssuer;
    this.resource = config.oauthResource;
    this.metadataUrl = `${this.issuer}/.well-known/oauth-protected-resource`;
    this.username = config.oauthUsername;
    this.password = config.oauthPassword;
    this.signingKey = new TextEncoder().encode(config.oauthSigningSecret);
    this.store = new OAuthStore(config.oauthStatePath);
  }

  challenge(error?: string, description?: string): string {
    const parts = [`Bearer resource_metadata="${this.metadataUrl}"`, `scope="${OAUTH_SCOPE}"`];
    if (error) parts.push(`error="${error.replace(/["\\]/g, "")}"`);
    if (description) parts.push(`error_description="${description.replace(/["\\]/g, "")}"`);
    return parts.join(", ");
  }

  async verifyAccessToken(token: string): Promise<boolean> {
    try {
      const { payload } = await jwtVerify(token, this.signingKey, {
        issuer: this.issuer,
        audience: this.resource,
        algorithms: ["HS256"],
      });
      const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
      return scopes.includes(OAUTH_SCOPE);
    } catch {
      return false;
    }
  }

  router(): Router {
    const router = express.Router();

    const protectedResource = (_request: Request, response: Response) => response.json({
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ["header"],
      resource_documentation: `${this.issuer}/`,
    });
    router.get("/.well-known/oauth-protected-resource", protectedResource);
    router.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

    router.get("/.well-known/oauth-authorization-server", (_request, response) => response.json({
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [OAUTH_SCOPE],
      authorization_response_iss_parameter_supported: true,
    }));

    router.post("/oauth/register", async (request, response) => {
      const redirectUris = Array.isArray(request.body?.redirect_uris) ? request.body.redirect_uris : [];
      const validRedirects = redirectUris.every((value: unknown) => {
        if (typeof value !== "string") return false;
        try {
          const url = new URL(value);
          return url.protocol === "https:" && ["chatgpt.com", "platform.openai.com"].includes(url.hostname);
        } catch { return false; }
      });
      if (!redirectUris.length || !validRedirects) {
        response.status(400).json({ error: "invalid_redirect_uri" });
        return;
      }
      if (request.body?.token_endpoint_auth_method && request.body.token_endpoint_auth_method !== "none") {
        response.status(400).json({ error: "invalid_client_metadata" });
        return;
      }
      const client = await this.store.registerClient(String(request.body?.client_name ?? "ChatGPT MCP client"), redirectUris);
      response.status(201).json({
        client_id: client.clientId,
        client_id_issued_at: client.createdAt,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    });

    router.get("/oauth/authorize", async (request, response) => {
      const clientId = String(request.query.client_id ?? "");
      const redirectUri = String(request.query.redirect_uri ?? "");
      const resource = String(request.query.resource ?? "");
      const scope = String(request.query.scope ?? OAUTH_SCOPE);
      const codeChallenge = String(request.query.code_challenge ?? "");
      const client = await this.store.getClient(clientId);
      if (!client || !client.redirectUris.includes(redirectUri)) {
        response.status(400).send("Invalid OAuth client or redirect URI");
        return;
      }
      const fail = (error: string, description: string) => {
        const target = new URL(redirectUri);
        target.searchParams.set("error", error);
        target.searchParams.set("error_description", description);
        if (request.query.state) target.searchParams.set("state", String(request.query.state));
        target.searchParams.set("iss", this.issuer);
        response.redirect(target.toString());
      };
      if (request.query.response_type !== "code") return fail("unsupported_response_type", "Only authorization code is supported");
      if (resource !== this.resource) return fail("invalid_target", "Invalid resource");
      if (request.query.code_challenge_method !== "S256" || !codeChallenge) return fail("invalid_request", "PKCE S256 is required");
      if (!scope.split(" ").includes(OAUTH_SCOPE)) return fail("invalid_scope", `Required scope: ${OAUTH_SCOPE}`);

      const pending = await this.store.createPending({
        clientId,
        redirectUri,
        ...(request.query.state ? { state: String(request.query.state) } : {}),
        scope: OAUTH_SCOPE,
        resource,
        codeChallenge,
      });
      response.set(loginResponseHeaders(redirectUri));
      response.send(renderLogin(pending.id, client.clientName));
    });

    router.post("/oauth/authorize", async (request, response) => {
      const pendingId = String(request.body?.pending_id ?? "");
      const pending = await this.store.getPending(pendingId);
      if (!pending) {
        response.status(400).send("Authorization request expired");
        return;
      }
      const client = await this.store.getClient(pending.clientId);
      if (!client) {
        response.status(400).send("OAuth client no longer exists");
        return;
      }
      if (request.body?.decision === "deny") {
        await this.store.consumePending(pendingId);
        const target = new URL(pending.redirectUri);
        target.searchParams.set("error", "access_denied");
        if (pending.state) target.searchParams.set("state", pending.state);
        target.searchParams.set("iss", this.issuer);
        response.redirect(target.toString());
        return;
      }
      const username = String(request.body?.username ?? "");
      const password = String(request.body?.password ?? "");
      if (!constantTimeMatches(username, this.username) || !constantTimeMatches(password, this.password)) {
        response.status(401).set(loginResponseHeaders(pending.redirectUri));
        response.send(renderLogin(pending.id, client.clientName, "Invalid username or password"));
        return;
      }
      const consumed = await this.store.consumePending(pendingId);
      if (!consumed) {
        response.status(400).send("Authorization request expired");
        return;
      }
      const code = await this.store.issueCode(consumed, username);
      const target = new URL(consumed.redirectUri);
      target.searchParams.set("code", code);
      if (consumed.state) target.searchParams.set("state", consumed.state);
      target.searchParams.set("iss", this.issuer);
      response.redirect(target.toString());
    });

    router.post("/oauth/token", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      const grantType = String(request.body?.grant_type ?? "");
      const clientId = String(request.body?.client_id ?? "");
      const resource = String(request.body?.resource ?? "");
      const client = await this.store.getClient(clientId);
      if (!client) {
        response.status(401).json({ error: "invalid_client" });
        return;
      }
      try {
        let subject: string;
        let scope: string;
        let refreshToken: string | undefined;
        if (grantType === "authorization_code") {
          const grant = await this.store.consumeCode(String(request.body?.code ?? ""));
          const verifier = String(request.body?.code_verifier ?? "");
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!grant || grant.clientId !== clientId || grant.redirectUri !== request.body?.redirect_uri || grant.resource !== resource || !constantTimeMatches(challenge, grant.codeChallenge)) {
            response.status(400).json({ error: "invalid_grant" });
            return;
          }
          subject = grant.subject;
          scope = grant.scope;
        } else if (grantType === "refresh_token") {
          const rotated = await this.store.rotateRefreshGrant(String(request.body?.refresh_token ?? ""), clientId, resource);
          if (!rotated) {
            response.status(400).json({ error: "invalid_grant" });
            return;
          }
          const grant = rotated.grant;
          refreshToken = rotated.token;
          subject = grant.subject;
          scope = grant.scope;
        } else {
          response.status(400).json({ error: "unsupported_grant_type" });
          return;
        }
        response.json(await this.issueTokens(clientId, subject, scope, resource, refreshToken));
      } catch (error) {
        console.error("OAuth token issuance failed", error);
        response.status(500).json({ error: "server_error" });
      }
    });

    return router;
  }

  private async issueTokens(clientId: string, subject: string, scope: string, resource: string, refreshToken?: string): Promise<TokenBundle> {
    const expiresIn = 3600;
    const accessToken = await new SignJWT({ scope, client_id: clientId })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(this.issuer)
      .setAudience(resource)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .setJti(opaqueToken())
      .sign(this.signingKey);
    const issuedRefreshToken = refreshToken ?? await this.store.issueRefreshToken({ clientId, scope, resource, subject });
    return { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, refresh_token: issuedRefreshToken, scope };
  }
}

export function oauthMiddleware(oauth: OAuthService, legacyToken?: string) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const authorization = request.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const legacyValid = legacyToken ? constantTimeMatches(token, legacyToken) : false;
    if (legacyValid || (token && await oauth.verifyAccessToken(token))) {
      next();
      return;
    }
    response.setHeader("WWW-Authenticate", oauth.challenge(token ? "invalid_token" : undefined, token ? "The access token is missing, expired, or invalid" : undefined));
    response.status(401).json({ error: "Unauthorized" });
  };
}
