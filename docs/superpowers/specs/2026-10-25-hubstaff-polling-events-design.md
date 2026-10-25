# Hubstaff Polling Events Design

## Goal

Add a read-only, persistent event monitor that polls the Hubstaff API for
meaningful changes, records normalized events, and exposes them to MCP clients
as an event-feed resource and a read-only tool. The monitor must not create or
manage Hubstaff webhooks and must not require `hubstaff:write`.

## Scope

The first release monitors the organizations explicitly configured through the
new events configuration. It supports these sources:

| Source | Normalized event | Meaningful change | Default interval |
| --- | --- | --- | --- |
| Tasks | `task.created`, `task.updated` | New task; status, assignees, due date, summary, details, or task metadata changes | 5 minutes |
| Activity updates | `activity.changed` | A new or changed Hubstaff activity block, aggregated per polling pass | 20 minutes |
| Time edit logs | `time_edit.created` | Manual addition, edit, or deletion of tracked time | 10 minutes |
| Audit log | `audit.created` | A newly visible organization audit-log entry | 10 minutes |

Audit-log monitoring is optional. It requires Hubstaff Enterprise and the
required organization role; a `403` disables only that source for the current
process and is reported in monitor status instead of failing all monitoring.

Comments and messages are deliberately out of scope: Hubstaff API v2 does not
expose task comments or a messages API. Integrated task comments remain
available only from the originating system identified by `project_type` and
`remote_id`.

## Configuration

Monitoring is disabled by default. `HUBSTAFF_EVENTS_ENABLED=true` starts it.

```
HUBSTAFF_EVENTS_ENABLED=false
HUBSTAFF_EVENT_ORGANIZATION_IDS=123,456
HUBSTAFF_EVENT_STATE_PATH=/data/events-state.json
HUBSTAFF_EVENT_TASKS_INTERVAL_MS=300000
HUBSTAFF_EVENT_ACTIVITIES_INTERVAL_MS=1200000
HUBSTAFF_EVENT_TIME_EDITS_INTERVAL_MS=600000
HUBSTAFF_EVENT_AUDIT_INTERVAL_MS=600000
HUBSTAFF_EVENT_RETENTION=1000
```

`HUBSTAFF_EVENT_ORGANIZATION_IDS` is required when monitoring is enabled. This
avoids silently monitoring every organization visible to a shared credential.
Intervals must be positive integers and event retention must be a positive
integer. The state path is persisted on the existing `/data` volume.

## Architecture

`EventMonitor` is a process-wide service, instantiated once at application
startup alongside the shared `HubstaffClient`. It owns independent polling
schedules per configured organization and source. It is never created by a
tool request.

`EventStore` owns durable state:

- source-specific watermarks and baseline markers;
- an append-only, bounded event feed;
- deduplication keys;
- source health, including a disabled Enterprise-only audit source.

The JSON state file is written atomically with owner-only permissions, using
the same approach as the OAuth token cache. Retention removes only the oldest
delivered events after a successful append; watermarks and dedupe state remain
consistent with the feed.

Each event has a stable ID, organization ID, normalized type, source record
ID, observed timestamp, source timestamp, priority, summary, and a minimal
sanitized payload. It never contains Hubstaff credentials, raw upstream error
bodies, or screenshots.

## Polling and Event Semantics

The first successful poll of each source records a baseline and watermark but
does not emit historical events. It prevents an initial connection from
flooding the MCP client. A source becomes active only after this baseline is
durably saved.

Task polling fetches active and completed organization tasks with cursor
pagination. It compares an allowlist of meaningful fields against the last
stored task snapshot and emits one event per changed task. A task not present
in a later poll is not interpreted as deletion because task listing filters
and permissions can hide it.

Activity polling calls the Hubstaff updates endpoint with an overlapping time
window. The overlap protects against late API visibility; a stable source-ID
and updated-at dedupe key prevents duplicate output. Events are aggregated by
organization and poll rather than emitting every ten-minute time block.

Time-edit and audit polling use overlapping `created` windows and deduplicate
by their immutable Hubstaff record IDs. Audit requests use at most a seven-day
window; time-edit requests use at most a 31-day window. The implementation
will use only short, polling-sized windows.

The monitor reads rate-limit response headers when present. On `429` it honors
`Retry-After` and postpones that source without advancing its watermark. On
network errors, timeouts, and 5xx responses it retries in a bounded exponential
backoff on a later scheduled run. Authentication and validation failures are
reported in source health and are not retried in a tight loop.

## MCP Interface

The server exposes a resource URI template:

```
hubstaff://events/{organizationId}
```

Reading it returns the current bounded event feed plus its newest cursor and
monitor status for that organization. A new `hubstaff_list_events` read-only
tool exposes the same events with `organization_id`, optional cursor, optional
event types, and a bounded limit. It is the reliable fallback for MCP clients
that do not subscribe to resource updates.

When the feed changes, the server sends the standard MCP
`notifications/resources/updated` notification for the matching URI to active
subscribers. The notification contains no event payload; clients re-read the
resource or invoke the tool. This requires stateful Streamable HTTP sessions
kept in a process-local session registry. The existing one-request, stateless
MCP server construction is replaced with a session-aware server factory.

Events are not guaranteed to appear as operating-system or ChatGPT push
notifications. A client must support and maintain an MCP resource subscription
to receive the protocol notification. Regardless of client support, it can
read the durable feed through the resource or tool.

## Error Handling and Security

All existing Hubstaff credentials remain read-only. No Hubstaff mutation is
introduced. The incoming MCP authentication boundary remains unchanged.

The monitor follows the project's safe diagnostics conventions: it records
source name, organization ID, outcome, timing, and safe HTTP status, but it
does not log event payloads, authorization headers, Hubstaff error bodies, or
local state-file paths. The new event interfaces return structured, actionable
monitor status without leaking those values.

## Testing

Tests cover:

1. config validation and disabled-by-default behavior;
2. first-poll baseline without events;
3. task creation and meaningful-field-change detection;
4. activity aggregation and overlapping-window deduplication;
5. time-edit and audit deduplication;
6. atomic state restoration and bounded retention;
7. `429` postponement without watermark advancement;
8. Enterprise audit `403` source disablement without stopping other sources;
9. event tool/resource cursor filtering; and
10. an MCP resource-updated notification delivered only to the matching active
   subscription.

## Non-goals

- Hubstaff webhook creation, activation, deletion, or verification.
- Hubstaff task comments or messages.
- Treating missing task-list entries as task deletions.
- Multi-process event fan-out. This first release assumes one server process;
  a distributed deployment needs a shared event store and subscription bus.
