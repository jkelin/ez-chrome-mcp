# Context

## Glossary

### Browser Debugging Origin

A local HTTP origin exposed by Chrome remote debugging, such as `http://127.0.0.1:9222`, that lists debuggable browser targets.

### Chrome Debugging Endpoint

A configured connection point for Chrome debugging. It can be either a browser debugging origin or a tab WebSocket URL.

### Tab Target

A debuggable Chrome page target returned by Chrome remote debugging. Tool calls identify a tab target by the short tab ID returned by the server.

### Log Entry

A browser-observed diagnostic event from console API calls, uncaught exceptions, or Chrome's log stream. Each raw log entry has a globally unique compact alphanumeric ID.

### Log Cursor

A raw log entry ID used to request logs before or after a known point in a tab's log history.

### Quiet Period

The interval of no newly observed logs required before an eval call returns its result.
