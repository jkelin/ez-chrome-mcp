# ADR 0001: Tab Activity Timeline

## Status

Accepted

## Context

The `logs` tool previously exposed only console, exception, and browser log events from CDP `Runtime` and `Log` domains. Debugging modern web apps also requires XHR/fetch traffic and URL changes in chronological order with request and response bodies.

## Decision

- Keep the existing `logs` MCP tool as the user-facing workflow.
- Replace the in-memory array `LogBuffer` with an `ActivityTimeline` backed by Bun `bun:sqlite` (`Database(":memory:")` per tab).
- Capture activity through CDP `Network` and `Page` domains (not page script injection).
- Record XHR/fetch as separate request-start and request-finish entries linked by a correlation ID.
- Record main-frame document navigations and same-document URL changes; ignore subframe navigations.
- Store full captured JSON/text request and response bodies in SQLite when CDP provides them; store metadata only for binary/non-text bodies.
- Truncate displayed bodies to 10 KiB in rendered log output while retaining full stored JSON/text bodies in SQLite.
- Store all available request/response headers without redaction; document that logs may contain secrets.

## Consequences

- Agents see a single chronological timeline mixing console output, navigations, and HTTP activity.
- The MCP process holds sensitive network data in memory until the tab is removed or the server shuts down.
- CDP may still fail to provide bodies for some requests despite application-level storage policy.
- `eval` quiet-period semantics now observe any timeline activity, not only console logs.

## Alternatives Considered

- **Page script monkey-patching**: Rejected as primary mechanism; CDP already attaches per tab and can fetch bodies via `Network.getRequestPostData` / `Network.getResponseBody`.
- **Separate `activity` tool**: Rejected to avoid splitting the debugging workflow.
- **Header redaction by default**: Rejected in favor of maximum debugging fidelity with explicit documentation warnings.
