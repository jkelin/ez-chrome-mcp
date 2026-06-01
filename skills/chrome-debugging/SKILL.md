---
name: chrome-debugging
description: Debug a running website in Chrome through the EZ Chrome MCP tools.
---

# Chrome Debugging

Use this skill when you need to inspect a running website in Chrome from Cursor.

1. Call `overview` first and choose the tab ID that matches the site you are debugging.
2. Call `logs` before using `eval`; the current logs often explain the failure without mutating the page.
3. Use `afterLogId` and `beforeLogId` to keep context small when reading long log histories.
4. Prefer small eval scripts that read state or call one page function at a time.
5. Treat `eval` as potentially destructive: it can click buttons, mutate storage, send requests, navigate, and change app state.

When debugging asynchronous UI behavior, pass a small `waitMs` to `eval` so the tool waits until console output is quiet before returning.
