# Hubstaff MCP Server

A read-only remote MCP server for the official Hubstaff API v2. It gives ChatGPT and other MCP clients access to tasks, recent changes, task source metadata, tracked time, and—on eligible Enterprise accounts—audit events over Streamable HTTP.

The server includes an OAuth 2.1 authorization server for ChatGPT Developer mode, with Dynamic Client Registration, Authorization Code + PKCE S256, audience-bound JWT access tokens, and rotating refresh tokens.

## MCP tools

- `hubstaff_capabilities` describes the data the server can and cannot access.
- `hubstaff_list_organizations` lists visible organizations and their IDs.
- `hubstaff_list_tasks` lists and filters organization tasks.
- `hubstaff_get_task` returns task details and source-system identifiers.
- `hubstaff_recent_updates` returns recently changed tasks and time records.
- `hubstaff_task_hours` totals tracked time by task and user.
- `hubstaff_list_audit_log_entries` returns organization audit events. It requires Hubstaff Enterprise and an Owner or Manager role with the necessary permissions.

Every tool is read-only.

## Configuration

1. Copy `.env.example` to `.env`.
2. Set `MCP_AUTH_TOKEN` to a random value at least 32 characters long.
3. For ChatGPT, set `OAUTH_ISSUER`, `OAUTH_USERNAME`, `OAUTH_PASSWORD`, and `OAUTH_SIGNING_SECRET`. OAuth state is stored in `/data/oauth-state.json`.
4. Choose one Hubstaff authentication method:

   - `HUBSTAFF_ORGANIZATION_TOKEN` (`hsoat_...`) is the recommended option for a long-running service.
   - `HUBSTAFF_REFRESH_TOKEN` accepts the refresh token Hubstaff issues when you create a Personal Access Token.
   - `HUBSTAFF_ACCESS_TOKEN` accepts a short-lived access token for testing.

A PAT needs the `hubstaff:read` scope. Hubstaff rotates refresh tokens after every exchange, so the server atomically stores the latest token pair in `/data/token.json` inside the named Docker volume. The original secret remains in `.env`; `.env` is excluded from both Git and the Docker build context.

Run from source:

```bash
npm ci
npm run build
npm test
npm start
```

Run with Docker:

```bash
docker compose up -d --build
```

## Connect an MCP client

Endpoint:

```text
https://hubstuff-mcp.copperdiver.studio/mcp
```

Traditional MCP clients can authenticate with a static bearer token:

```text
Authorization: Bearer <MCP_AUTH_TOKEN>
```

ChatGPT discovers and completes OAuth automatically. The server publishes:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/oauth/register`, `/oauth/authorize`, and `/oauth/token`

In ChatGPT, enable **Settings → Security and login → Developer mode**. Add `https://hubstuff-mcp.copperdiver.studio/mcp` as a custom app using OAuth/DCR, then sign in with the `OAUTH_USERNAME` and `OAUTH_PASSWORD` configured on the server.

Check availability without sending a secret:

```bash
curl https://hubstuff-mcp.copperdiver.studio/health
```

## Hubstaff API limitations

- The Activity API accepts no more than seven days per request. `hubstaff_task_hours` splits longer ranges automatically.
- Detailed activity history is limited by Hubstaff's retention period and your organization plan.
- The public Hubstaff API v2 does not expose task comments. For integrated tasks, use `project_type` and `remote_id` to query the source system directly.
- The Audit Log API is available only to Enterprise organizations and requires an Owner or Organization Manager with permission to view other members' data. Audit events do not include task comments.

Official documentation: [Hubstaff API](https://developer.hubstaff.com/), [authentication](https://developer.hubstaff.com/authentication/), [tasks](https://developer.hubstaff.com/reference/tasks/), [activities](https://developer.hubstaff.com/reference/activities/), and [audit log](https://developer.hubstaff.com/reference/audit_log_entries/).
