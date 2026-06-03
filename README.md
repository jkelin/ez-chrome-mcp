# ez-chrome-mcp

**ez-chrome-mcp** is a [Model Context Protocol](https://modelcontextprotocol.io/) server that connects AI assistants to **live Chrome tabs** over the Chrome DevTools Protocol (CDP). Use it from Cursor or any MCP client to inspect pages you are already developing — read console output, capture screenshots, run targeted JavaScript, and open URLs without leaving the editor.

## Features

| Tool         | Purpose                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `overview`   | List debuggable tabs across configured Chrome remote-debugging endpoints             |
| `open-tab`   | Open a URL on an existing endpoint, or launch Chrome with remote debugging           |
| `logs`       | Stream grouped console, exception, and CDP log output with cursor-based paging       |
| `eval`       | Run JavaScript in a tab and return the result plus recent logs (can mutate the page) |
| `screenshot` | Capture a PNG of the current tab viewport                                            |

The server prefers **read-only inspection** (`overview` → `logs` → `screenshot`) before `eval`, because evaluation can change application state.

## Requirements

- [Bun](https://bun.sh) `>=1.1.0` (runtime for the MCP server)
- Google Chrome or Chromium
- For `open-tab` with `startNewChromeInstanceIfNotRunning`: Playwright’s Chromium binary (`npx playwright install chromium` after install)

Chrome must expose remote debugging, for example:

```bash
chrome --remote-debugging-port=9222
```

The server also defaults to `http://127.0.0.1:9222`.

## Install

From npm (after publish):

```bash
bun add -g ez-chrome-mcp
# or use without global install:
bunx ez-chrome-mcp
```

From source:

```bash
git clone https://github.com/jkelin/ez-chrome-mcp.git
cd ez-chrome-mcp
bun install
bun run start
```

First-time launch via Playwright:

```bash
bunx playwright install chromium
```

## MCP configuration

### Published package (`bunx`)

Add to `.cursor/mcp.json`, Claude Desktop, or another MCP config:

```json
{
  "mcpServers": {
    "ez-chrome-mcp": {
      "command": "bunx",
      "args": ["ez-chrome-mcp"]
    }
  }
}
```

### Local development

```json
{
  "mcpServers": {
    "ez-chrome-mcp": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/ez-chrome-mcp/index.ts"],
      "env": {
        "CHROME_DEBUGGING_URLS": "http://127.0.0.1:9222"
      }
    }
  }
}
```

See [`mcp.json`](mcp.json) in this repo for a minimal example.

## Environment variables

| Variable                              | Default | Description                                                                                       |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `CHROME_DEBUGGING_URLS`               | (none)  | Comma/newline-separated debugging origins or tab WebSocket URLs (in addition to `127.0.0.1:9222`) |
| `CHROME_DEBUGGING_URL`                | (none)  | Alias for a single endpoint                                                                       |
| `EZ_CHROME_MCP_LAUNCH_DEBUGGING_PORT` | `9222`  | Port when launching Chrome from `open-tab`                                                        |
| `EZ_CHROME_MCP_DEFAULT_QUIET_MS`      | `250`   | Default log quiet period after `eval`                                                             |
| `EZ_CHROME_MCP_MAX_QUIET_MS`          | `5000`  | Maximum quiet period for `eval`                                                                   |
| `EZ_CHROME_MCP_HARD_WAIT_CAP_MS`      | `10000` | Upper bound on waits                                                                              |
| `EZ_CHROME_MCP_LOG_BUFFER_SIZE`       | `5000`  | Retained raw log entries per tab                                                                  |
| `EZ_CHROME_MCP_DEFAULT_LOG_LIMIT`     | `200`   | Default `logs` / `eval` log limit                                                                 |
| `EZ_CHROME_MCP_MAX_LOG_LIMIT`         | `1000`  | Maximum log limit per request                                                                     |

## Agent skills

Optional workflow skills ship under [`skills/`](skills/):

- **chrome-debugging** — MCP tool workflow and log cursor navigation
- **eval-elevator-saga** — End-to-end smoke test against [Elevator Saga](https://play.elevatorsaga.com/)

## Development

```bash
bun install
just check          # typecheck + all tests (or: bun run typecheck && bun run test)
bun run dev         # server + MCP inspector
bun run inspector   # inspector only
```

### Scripts

| Script                     | Description                        |
| -------------------------- | ---------------------------------- |
| `bun run start`            | Run the stdio MCP server           |
| `bun run typecheck`        | TypeScript check                   |
| `bun run test`             | Unit and integration tests         |
| `bun run test:integration` | Headless browser integration tests |

## Publishing

The package is published to npm as **`ez-chrome-mcp`**. Maintainers:

```bash
bun run typecheck && bun run test
npm publish
```

`prepublishOnly` runs typecheck and tests automatically.

## License

MIT — see [LICENSE](LICENSE).
