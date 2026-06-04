# ez-chrome-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server that connects AI assistants to **live Chrome tabs** over the Chrome DevTools Protocol (CDP). It is great for local debugging of web applications because it enables seamless text-based log/request inspection and JavaScript evaluation which is everything an agent needs. As such it is more token efficient than full-fledged Chrome CDP MCP Server.

## Features

| Tool         | Purpose                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `overview`   | List debuggable tabs across configured Chrome remote-debugging endpoints             |
| `open-tab`   | Open a URL on an existing endpoint, or launch Chrome with remote debugging           |
| `logs`       | Stream grouped console, navigation, and XHR/fetch activity with cursor-based paging  |
| `log_detail` | Show pretty JSON detail for one raw log/activity ID, optionally saving full output   |
| `eval`       | Run JavaScript in a tab and return the result plus recent logs (can mutate the page) |
| `screenshot` | Capture a PNG of the current tab viewport                                            |

## Requirements

- [Bun](https://bun.sh) `>=1.1.0` (runtime for the MCP server)

## MCP configuration

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

See [`mcp.json`](mcp.json) in this repo for a minimal example.

## Agent skills

Optional workflow skills ship under [`skills/`](skills/):

## Environment variables

| Variable                                  | Default    | Description                                                                                       |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `CHROME_DEBUGGING_URLS`                   | (none)     | Comma/newline-separated debugging origins or tab WebSocket URLs (in addition to `127.0.0.1:9222`) |
| `CHROME_DEBUGGING_URL`                    | (none)     | Alias for a single endpoint                                                                       |
| `EZ_CHROME_MCP_LAUNCH_DEBUGGING_PORT`     | `9222`     | Port when launching Chrome from `open-tab`                                                        |
| `EZ_CHROME_MCP_DEFAULT_QUIET_MS`          | `250`      | Default log quiet period after `eval`                                                             |
| `EZ_CHROME_MCP_MAX_QUIET_MS`              | `5000`     | Maximum quiet period for `eval`                                                                   |
| `EZ_CHROME_MCP_HARD_WAIT_CAP_MS`          | `10000`    | Upper bound on waits                                                                              |
| `EZ_CHROME_MCP_LOG_BUFFER_SIZE`           | `5000`     | Retained activity entries per tab                                                                 |
| `EZ_CHROME_MCP_DEFAULT_LOG_LIMIT`         | `200`      | Default `logs` / `eval` log limit                                                                 |
| `EZ_CHROME_MCP_MAX_LOG_LIMIT`             | `1000`     | Maximum log limit per request                                                                     |
| `EZ_CHROME_MCP_CDP_MAX_TOTAL_BUFFER_SIZE` | `67108864` | CDP network payload buffer per session                                                            |
| `EZ_CHROME_MCP_CDP_MAX_POST_DATA_SIZE`    | `67108864` | Max POST body included in CDP request events                                                      |

**Note:** `log_detail` can include cookies, authorization headers, and API payloads. Treat detailed log output as potentially sensitive.
