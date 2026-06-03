---
name: chrome-debugging
description: Debug and visually inspect a running website in Chrome through the EZ Chrome MCP tools. Use for live React, Svelte, or other browser apps, console logs, screenshots, and tab inspection.
---

# Chrome Debugging

Use this skill when you need to inspect a running website in Chrome from Cursor.

## Workflow

1. Call `overview` first and choose the tab ID that matches the site you are debugging.
2. Call `logs` before using `eval`; the current logs often explain the failure without mutating the page.
3. Call `screenshot` when you need to inspect the live GUI, compare rendered state, or check for overlapping elements.
4. Use `afterLogId` and `beforeLogId` to keep context small when reading long log histories.
5. Prefer small eval scripts that read state or call one page function at a time.
6. Treat `eval` as potentially destructive: it can click buttons, mutate storage, send requests, navigate, and change app state.

When debugging asynchronous UI behavior, pass a small `waitMs` to `eval` so the tool waits until console output is quiet before returning.

## Log Navigation

Use raw log IDs to avoid replaying large browser log buffers into context.

- Start with `logs` using the default limit.
- To continue forward, pass `afterLogId` with the last raw log ID you already inspected.
- To inspect older history, pass `beforeLogId` with the first raw log ID currently visible.
- Grouped rows may display an ID span such as `abc123..z9x8w7`; use either raw endpoint ID from the span when paging.
- If a cursor is no longer retained, call `logs` without cursors to re-anchor on the current retained window.

## Example Usage

When working on a React or Svelte application, use the ezChrome MCP server to test your live application instead of reasoning only from source code.

1. Start the app with the project command, for example `just dev` when available.
2. Use `open-tab` to open the local app URL if a tab is not already available.
3. Use `overview` to get the tab ID.
4. Use `logs` to check console output and runtime errors.
5. Use `screenshot` to inspect the rendered GUI. For example, capture a screenshot after changing layout code to check whether buttons, menus, modals, or form fields overlap.
6. Use `eval` only when needed for precise DOM state, such as reading `document.querySelector('[data-testid="submit"]').getBoundingClientRect()`.
