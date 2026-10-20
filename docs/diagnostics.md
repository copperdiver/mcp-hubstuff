# Hubstaff MCP diagnostics

## Local investigation

The reported failure was `hubstaff_list_tasks` with `organization_id=405914`
and `max_items=1000`: `TOOL_EXECUTION_FAILED / The Hubstaff request could not
be completed.`, presented by an external wrapper as `INVALID_ARGUMENT`.
`hubstaff_recent_updates` and `hubstaff_get_task` reportedly worked.

The local source establishes the following:

- `max_items=1000` passes the tool schema; `5000` fails its maximum of 1000.
- `list_tasks` and `recent_updates` call the same organization tasks endpoint
  through `collectPages`. `list_tasks` additionally accepts status, project and
  user filters. `get_task` makes one task request.
- `collectPages` requests up to 100 records per page. With 100 records returned
  per page, a request for 1000 records needs ten upstream requests. The existing
  timeout applies to each HTTP request, including its body; it is not an overall
  MCP deadline.
- Previously, every exception other than `HubstaffApiError` or `ToolInputError`
  became the same generic `TOOL_EXECUTION_FAILED`. Network errors, timeouts,
  JSON parsing errors, cache I/O errors and programming errors could therefore
  produce the same client symptom.
- The SDK validates arguments before running a tool callback. Per-message
  validation now uses the same registered schemas, after the transport's HTTP
  and protocol checks, so these errors also receive a safe structured result
  and diagnostic ID.
- The external wrapper is outside this repository. Its `INVALID_ARGUMENT`
  label does not establish that the input failed this server's validation.

The production root cause remains **unconfirmed**. Local fixtures demonstrate
the diagnostic paths, including a successful 1000-record response and a failure
on a later page; they do not reproduce the reported production incident.
Pagination behavior, filters, limits, credential storage, timeout settings and
the existing single replay after a refreshable 401 are preserved.

## Log format and correlation

Each event is one JSON line. Normal events go to stdout; failures go to stderr.
Every event contains an ISO 8601 UTC `timestamp`, `level`, `event`,
`diagnostic_id`, `request_id`, `mcp_method` and progress counters. Known tool calls
also include `tool_name`. A fresh UUID is generated locally for each HTTP MCP
request; client-supplied request IDs and JSON-RPC IDs are not logged.

The response header `X-Diagnostic-Id` identifies the HTTP request, including
transport-level rejections. For a single message it equals `diagnostic_id`.
Batch messages have separate diagnostic IDs and counters, linked by the shared
`request_id` from that header. Structured tool errors include
`structuredContent.result.error.diagnostic_id`, `category`, `code` and a safe
message; the text content contains the same error. Search logs by this ID.
HTTP 200 alone is not tool success: inspect `isError` and `tool.failed`.

| Event / field | Meaning |
| --- | --- |
| `tool.started`, `tool.completed`, `tool.failed` | Tool execution and final outcome |
| `upstream.started`, `upstream.completed`, `upstream.failed` | One HTTP attempt, including body consumption |
| `upstream.retry` | Existing 401 refresh/replay path selected; does not mean a replay has already happened |
| `phase` | `api` or `token_refresh`; refresh calls are visible without credentials |
| `attempt`, `retry_count` | Attempt within one API request; initial attempt is 1/0, replay is 2/1 |
| `attempts`, `retries` | HTTP attempts actually started in this diagnostic context, including refresh; actual replay attempts |
| `pagination.page`, `pagination.completed` | Page count, record count, safe limit and termination reason |
| `pages_count`, `records_count` | Successfully collected data pages/records across the tool, before filtering; preserved on later failure |
| `page_number`, `page_records` | Progress within the current collection |
| `page_start_id_present`, `next_page_present` | Cursor presence only; cursor values are omitted |
| `duration_ms` | Monotonic elapsed time on completion/failure; tool duration starts at the HTTP request boundary (message dispatch for batches) |
| `upstream_status` | Actual HTTP status when available; absent if no response arrived |
| `timeout_ms` | Configured per-request timeout |
| `mcp.completed` | HTTP completion, status, duration and summed batch counters, including auth/transport rejections |
| `mcp.failed` | HTTP parsing or internal MCP transport failure |
| `oauth.failed` | Existing OAuth token-issuance catch, now sanitized and linked to its `server_error` diagnostic ID |

The direct organization-list and get-task tools count their single data
response as one page. Capabilities and preflight validation do not contact
Hubstaff and have zero data pages. A refresh shared by concurrent requests is
counted in the context that started that HTTP attempt.

## Error classification

| Category | Codes / interpretation |
| --- | --- |
| `validation` | `INVALID_ARGUMENT`: local schema or explicit tool range validation |
| `upstream` | Existing HTTP codes such as `HUBSTAFF_INVALID_REQUEST`, `HUBSTAFF_AUTHENTICATION_FAILED`, `HUBSTAFF_ACCESS_DENIED`, `HUBSTAFF_RATE_LIMITED`, `HUBSTAFF_API_ERROR` |
| `upstream` | `HUBSTAFF_NETWORK_ERROR`: fetch/body transport failure |
| `upstream` | `HUBSTAFF_TIMEOUT`: known deadline/timeout, including an AbortError caused by the configured timeout signal |
| `upstream` | `HUBSTAFF_INVALID_RESPONSE`: malformed upstream JSON |
| `internal` | `INTERNAL_ERROR`: other server failures, including local configuration/cache I/O/programming failures |

An upstream HTTP 400 remains an upstream failure, not local input validation.
An arbitrary TypeError is internal unless it arises at the fetch/body boundary.
An AbortError without evidence of a timeout is classified as a network failure.
This change does not introduce retries for 429, 5xx, network errors or timeouts.

## Redaction

Logging uses a strict allowlist. Allowed parameters are numeric organization/task
IDs, `max_items`, `max_entries`, and `page_limit`. Other inputs, filters, headers,
URLs, query strings and arbitrary strings are dropped, including nested values.
Authorization, cookies, access/refresh tokens, API keys, task contents and email
bodies are never passed to the output sink by this diagnostic logger.

Neither client errors nor logs include upstream error bodies or raw exception
messages. Exceptions retain only allowlisted class/code names and up to two
cause levels. Stack traces contain known project source filenames plus line
and column numbers; messages, function names, absolute paths and other frames
are omitted. Unknown exception names are masked. Logging failures cannot replace
the tool's result with a logging exception.

## Docker source inspection

`Dockerfile` starts `node dist/src/index.js` directly. It does not redirect stdout
or stderr to files, so application JSON lines reach the container logging driver.
`compose.yml` has **no explicit `logging` block**, driver or rotation options.
The deployed Docker daemon's actual driver, retention and available disk space
cannot be inferred from this repository. Docker was not run during this work.

An authorized operator should inspect the effective container logging
configuration and retention before release. No daemon, Compose runtime, access,
credential, network or firewall configuration was changed by this work.

## Local verification

Use `npm test`, `npm run typecheck`, `npm run build` and `git diff --check`.
New HTTP integration tests use the real Express/MCP stack with mocked upstream
fetch. Refresh tests mock filesystem operations so no token cache is read or
written. Existing OAuth tests use disposable synthetic fixtures.

To keep all test temporary files inside the worktree on PowerShell:

```powershell
$env:TEMP = Join-Path (Get-Location).Path '.local-checks/tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
npm test
npm run typecheck
npm run build
git diff --check
```

Do not stage `.local-checks`, `node_modules`, `dist`, `.env`, or credential data.

## Remaining release and production verification

These are future actions requiring separate authorization. They were not
performed during the local task.

1. Review the local commit, push the feature branch and merge the approved
   change into `main`. Record the resulting **release commit SHA**, which can
   differ from the local feature commit.
2. The existing `.github/workflows/publish-ghcr.yml` runs on pushes to `main`
   (or explicit workflow dispatch). Verify that it succeeds and record the
   digest of `ghcr.io/copperdiver/mcp-hubstuff:sha-<full-release-SHA>`.
   Do not treat `latest` alone as proof of the deployed revision.
3. In the existing approved deployment, deploy that revision and verify its
   image digest. The checked-in Compose file uses `build:`, not `image:`.
   With that exact Compose setup, the operator must update the source checkout
   to the approved release and rebuild/recreate `server`. A deployment that
   consumes GHCR must use its existing image configuration pinned to the
   recorded digest. Preserve the existing credential/state volumes and access
   configuration; no new credentials are needed for this code change.
4. Verify container health and effective logging driver/retention. Confirm a
   `server.started` JSON line and current timestamps from the new revision.
5. Through an already authorized MCP client, perform one controlled
   `hubstaff_list_tasks` call with `organization_id=405914`, `max_items=1000`
   and the original filters, if known. Save only its diagnostic ID, UTC time,
   outcome and safe counts. Do not paste credentials or task payloads into logs.
6. Compare the log sequence under that ID. A later-page failure must retain
   completed page/record counts, failing HTTP status if available, phase,
   exception/timeout class, attempts/retries and safe stack locations.
   If only `upstream.started` exists, check the container and caller/transport
   lifecycle before assigning a cause.
7. Run the known-working `hubstaff_get_task` with an already accessible task ID
   and `hubstaff_recent_updates` with its previously successful arguments.
   Confirm outcomes and distinct diagnostic IDs. Confirm `max_items=5000`
   remains `validation / INVALID_ARGUMENT` with zero upstream attempts.
8. Use the collected evidence to propose any functional fix separately. If the
   external wrapper still labels a failure `INVALID_ARGUMENT`, compare the
   server's structured category/code and ID before blaming validation.
