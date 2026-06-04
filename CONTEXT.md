# Context

## Glossary

### Browser Debugging Origin

A local HTTP origin exposed by Chrome remote debugging, such as `http://127.0.0.1:9222`, that lists debuggable browser targets.

### Chrome Debugging Endpoint

A configured connection point for Chrome debugging. It can be either a browser debugging origin or a tab WebSocket URL.

### Tab Target

A debuggable Chrome page target returned by Chrome remote debugging. Tool calls identify a tab target by the short tab ID returned by the server.

### Public Tab ID

The short alphanumeric tab ID returned by `overview` and used in tool calls. It is an alias over Chrome's internal target ID.

### Activity Entry

A single chronological event in a tab's retained activity timeline. Kinds include console output, uncaught exceptions, browser log stream events, main-frame navigations, and XHR/fetch request lifecycle events.

### Activity Timeline

The per-tab retained sequence of activity entries stored in an in-memory SQLite database for cursor paging and rendering through the `logs` tool.

### Log Entry

A console, exception, or browser-log activity entry. The `logs` tool output may also include navigations and network request events; those are activity entries, not log entries in the narrow sense.

### Log Cursor

A raw activity entry ID used to request logs before or after a known point in a tab's activity timeline.

### Network Request Event

An activity entry recording an XHR/fetch request at start or finish time, linked to its counterpart by a correlation ID.

### Navigation Event

An activity entry recording a main-frame document load or same-document URL change in the tab.

### Quiet Period

The interval of no newly observed activity entries required before an eval call returns its result.
