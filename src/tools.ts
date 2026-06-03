import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ChromeDebugService } from "./chrome/service";

const logsInputSchema = z.object({
  tabId: z.string().min(1).describe("Chrome target ID returned by overview."),
  limit: z.number().int().positive().optional().describe("Maximum raw log entries to render before grouping."),
  afterLogId: z.string().min(1).optional().describe("Return logs after this raw log ID."),
  beforeLogId: z.string().min(1).optional().describe("Return logs before this raw log ID."),
});

const evalInputSchema = logsInputSchema.extend({
  script: z.string().min(1).describe("JavaScript expression or script to evaluate in the tab."),
  waitMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Quiet period for log debounce after evaluation settles."),
});

const screenshotInputSchema = z.object({
  tabId: z.string().min(1).describe("Chrome target ID returned by overview."),
});

const openTabInputSchema = z.object({
  url: z.string().min(1).optional().describe("URL to open. Defaults to about:blank."),
  startNewChromeInstanceIfNotRunning: z
    .boolean()
    .optional()
    .describe("Launch Chrome with remote debugging if no debugging endpoint is available."),
});

export function registerChromeTools(server: McpServer, chrome: ChromeDebugService): void {
  server.registerTool(
    "overview",
    {
      title: "Chrome Tabs Overview",
      description: "List all tabs discovered across default and configured Chrome remote debugging endpoints.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (): Promise<CallToolResult> => {
      const tabs = await chrome.overview();
      const text =
        tabs.length === 0
          ? "No Chrome tabs were discovered. Start Chrome with remote debugging enabled, for example `--remote-debugging-port=9222`."
          : [
              "# Chrome Tabs",
              "",
              ...tabs.map(
                (tab) =>
                  `- \`${tab.tabId}\` ${tab.title || "(untitled)"}\n  URL: ${tab.url || "(unknown)"}\n  Source: ${tab.source}`,
              ),
            ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: { tabs },
      };
    },
  );

  server.registerTool(
    "open-tab",
    {
      title: "Open Chrome Tab",
      description:
        "Open a URL in a Chrome tab on an existing debugging endpoint, or launch Chrome with remote debugging if allowed.",
      inputSchema: openTabInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      const result = await chrome.openTab(args);

      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: {
          tab: result.tab,
          launchedChrome: result.launchedChrome,
        },
      };
    },
  );

  server.registerTool(
    "logs",
    {
      title: "Chrome Tab Logs",
      description:
        "Return current URL and grouped retained logs for a tab ID from overview. Use afterLogId/beforeLogId to page by raw log IDs.",
      inputSchema: logsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => toTextResult(await chrome.logs(args)),
  );

  server.registerTool(
    "eval",
    {
      title: "Evaluate JavaScript In Chrome Tab",
      description:
        "Evaluate JavaScript in a tab ID from overview, wait for log quiet, then return the eval result and grouped logs. This can mutate the page.",
      inputSchema: evalInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => toTextResult(await chrome.eval(args)),
  );

  server.registerTool(
    "screenshot",
    {
      title: "Capture Chrome Tab Screenshot",
      description:
        "Capture a PNG screenshot for a tab ID from overview. Use this to inspect live UI layout, visual regressions, and overlapping elements.",
      inputSchema: screenshotInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      const result = await chrome.screenshot(args);

      return {
        content: [
          {
            type: "text",
            text: [
              "# Chrome Tab Screenshot",
              "",
              `Tab ID: \`${result.tab.tabId}\``,
              `Current URL: ${result.tab.url || "(unknown)"}`,
              `MIME type: ${result.mimeType}`,
              `Size: ${result.sizeBytes} bytes`,
            ].join("\n"),
          },
          {
            type: "image",
            data: result.data,
            mimeType: result.mimeType,
          },
        ],
        structuredContent: {
          tabId: result.tab.tabId,
          url: result.tab.url,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
        },
      };
    },
  );
}

function toTextResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}
