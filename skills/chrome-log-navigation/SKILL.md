---
name: chrome-log-navigation
description: Navigate large Chrome log buffers with raw log cursors.
---

# Chrome Log Navigation

Use raw log IDs to avoid replaying large browser log buffers into context.

- Start with `logs` using the default limit.
- To continue forward, pass `afterLogId` with the last raw log ID you already inspected.
- To inspect older history, pass `beforeLogId` with the first raw log ID currently visible.
- Grouped rows may display an ID span such as `abc123..z9x8w7`; use either raw endpoint ID from the span when paging.
- If a cursor is no longer retained, call `logs` without cursors to re-anchor on the current retained window.
