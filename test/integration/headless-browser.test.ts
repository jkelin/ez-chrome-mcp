import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrowserHarness } from "../support/browser-harness";
import { McpProcessClient } from "../support/mcp-process-client";

type OverviewContent = {
  tabs: Array<{
    tabId: string;
    url: string;
    title: string;
  }>;
};

type OpenTabContent = {
  tab: {
    tabId: string;
    url: string;
  };
  launchedChrome: boolean;
};

type ScreenshotContent = {
  tabId: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
};

describe("headless Chrome MCP integration", () => {
  test("discovers a tab, captures logs, evaluates scripts, and pages with raw log IDs", async () => {
    const harness = await startBrowserHarness();
    const client = new McpProcessClient({ CHROME_DEBUGGING_URLS: harness.debuggingUrl });

    try {
      await client.initialize();
      const overview = await client.callTool("overview", {});
      const structured = overview.structuredContent as OverviewContent;
      const tab = structured.tabs.find((candidate) => candidate.url === harness.pageUrl);

      expect(tab).toBeDefined();
      expect(tab?.tabId).toHaveLength(4);
      expect(tab?.title).toBe("EZ Chrome MCP Fixture");

      const repeated = textOf(
        await client.callTool("eval", {
          tabId: tab!.tabId,
          script: "logRepeated()",
          waitMs: 100,
        }),
      );

      expect(repeated).toContain("logged repeated warnings");
      expect(repeated).toContain("fixture repeat");
      expect(repeated).toContain("x3");

      const repeatedIds = rawLogIdsFrom(repeated);
      const lastRepeatedId = repeatedIds.at(-1);
      expect(lastRepeatedId).toBeDefined();
      expect(lastRepeatedId).toHaveLength(4);

      const levels = textOf(
        await client.callTool("eval", {
          tabId: tab!.tabId,
          script: "logLevels()",
          waitMs: 100,
          afterLogId: lastRepeatedId,
        }),
      );

      expect(levels).toContain('"ok":true');
      expect(levels).toContain("fixture repeat");
      expect(levels).toContain("fixture log");
      expect(levels).toContain("fixture info");
      expect(levels).toContain("fixture error");

      const firstLevelId = rawLogIdsFrom(levels)[0];
      expect(firstLevelId).toBeDefined();

      const beforeLevel = textOf(
        await client.callTool("logs", {
          tabId: tab!.tabId,
          beforeLogId: firstLevelId,
          limit: 10,
        }),
      );
      expect(beforeLevel).toContain("fixture repeat");

      const thrown = textOf(
        await client.callTool("eval", {
          tabId: tab!.tabId,
          script: "throwSync()",
          waitMs: 100,
        }),
      );
      expect(thrown).toContain("JavaScript exception");
      expect(thrown).toContain("fixture sync failure");

      const asyncThrown = textOf(
        await client.callTool("eval", {
          tabId: tab!.tabId,
          script: "throwAsync()",
          waitMs: 100,
        }),
      );
      expect(asyncThrown).toContain("scheduled async failure");
      expect(asyncThrown).toContain("fixture async failure");

      const screenshot = await client.callTool("screenshot", {
        tabId: tab!.tabId,
      });
      const screenshotContent = screenshot.structuredContent as ScreenshotContent;
      const image = screenshot.content.find((content) => content.type === "image");

      expect(textOf(screenshot)).toContain("Chrome Tab Screenshot");
      expect(screenshotContent.tabId).toBe(tab!.tabId);
      expect(screenshotContent.url).toBe(harness.pageUrl);
      expect(screenshotContent.mimeType).toBe("image/png");
      expect(screenshotContent.sizeBytes).toBeGreaterThan(0);
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toStartWith("iVBORw0KGgo");

      await harness.closeTab(harness.pageUrl);
      const afterClose = await client.callTool("overview", {});
      const afterCloseStructured = afterClose.structuredContent as OverviewContent;

      expect(afterCloseStructured.tabs.every((candidate) => candidate.url !== harness.pageUrl)).toBe(true);

      const opened = await client.callTool("open-tab", {
        url: harness.pageUrl,
        startNewChromeInstanceIfNotRunning: false,
      });
      const openedContent = opened.structuredContent as OpenTabContent;

      expect(textOf(opened)).toContain("Opened a tab on an existing Chrome debugging endpoint.");
      expect(openedContent.launchedChrome).toBe(false);
      expect(openedContent.tab.tabId).toHaveLength(4);
      expect(openedContent.tab.url).toBe(harness.pageUrl);
    } finally {
      await client.close();
      await harness.close();
    }
  }, 30_000);

  test("captures fetch and xhr json bodies, navigations, and chronological activity", async () => {
    const harness = await startBrowserHarness();
    const client = new McpProcessClient({ CHROME_DEBUGGING_URLS: harness.debuggingUrl });
    let tempDir: string | undefined;

    try {
      await client.initialize();
      const overview = await client.callTool("overview", {});
      const structured = overview.structuredContent as OverviewContent;
      const tab = structured.tabs.find((candidate) => candidate.url === harness.pageUrl);
      expect(tab).toBeDefined();

      const fetchResult = textOf(
        await client.callTool("eval", {
          tabId: tab!.tabId,
          script: `(async () => {
            console.log("fixture before network");
            const result = await fetchJsonApi();
            await new Promise((resolve) => setTimeout(resolve, 100));
            console.log("fixture after network");
            return result;
          })()`,
          waitMs: 600,
        }),
      );

      const fetchLogs = logsSectionOf(fetchResult);
      expect(fetchResult).toContain("fixture before network");
      expect(fetchLogs).toContain("-> POST");
      expect(fetchLogs).toContain("<- 200");
      expect(fetchResult).toContain("fetch json done");
      expect(fetchResult).toContain("fixture after network");
      expect(fetchLogs).toContain("correlation:");
      expect(fetchLogs).not.toContain('"client":"fetch"');
      expect(fetchLogs).not.toContain("request-body:");
      expect(fetchLogs).not.toContain("response-body:");
      expect(fetchLogs).not.toContain("request-headers:");
      expect(fetchLogs).not.toContain("response-headers:");

      const fetchIndex = fetchResult.indexOf("-> POST");
      const finishIndex = fetchResult.indexOf("<- 200");
      const beforeIndex = fetchResult.indexOf("fixture before network");
      const afterIndex = fetchResult.indexOf("fixture after network");
      expect(beforeIndex).toBeGreaterThan(-1);
      expect(fetchIndex).toBeGreaterThan(beforeIndex);
      expect(finishIndex).toBeGreaterThan(fetchIndex);
      expect(afterIndex).toBeGreaterThan(finishIndex);

      const xhrResult = textOf(
        await client.callTool("eval", {
          tabId: tab!.tabId,
          script: "xhrJsonApi()",
          waitMs: 500,
        }),
      );

      const xhrLogs = logsSectionOf(xhrResult);
      expect(xhrLogs).toContain("-> POST");
      expect(xhrLogs).toContain("<- 200");
      expect(xhrResult).toContain("xhr json done");
      expect(xhrLogs).not.toContain('"client":"xhr"');
      expect(xhrLogs).not.toContain("request-body:");
      expect(xhrLogs).not.toContain("response-body:");

      const binaryResult = textOf(
        await client.callTool("eval", {
          tabId: tab!.tabId,
          script: "fetchBinaryApi()",
          waitMs: 500,
        }),
      );

      const binaryLogs = logsSectionOf(binaryResult);
      expect(binaryLogs).toContain("-> GET");
      expect(binaryResult).toContain("application/octet-stream");
      expect(binaryLogs).not.toContain("response-body-size:");

      const largeResult = textOf(
        await client.callTool("eval", {
          tabId: tab!.tabId,
          script: "fetchLargeJsonApi()",
          waitMs: 500,
        }),
      );

      const largeLogs = logsSectionOf(largeResult);
      expect(largeLogs).toContain("<- 200 GET");
      expect(largeLogs).not.toContain("display truncated");
      expect(largeLogs).not.toContain("response-body:");

      tempDir = await mkdtemp(join(tmpdir(), "ez-chrome-mcp-log-detail-"));
      const detailPath = join(tempDir, "large-detail.json");
      const largeDetailId = rawLogIdForLine(largeResult, "<- 200 GET", "/api/large-json");
      const detail = await client.callTool("log_detail", {
        tabId: tab!.tabId,
        logId: largeDetailId,
        absolute_path: detailPath,
      });
      const detailText = textOf(detail);
      const detailJson = JSON.parse(detailText) as {
        id: string;
        kind: string;
        payload?: {
          responseBody?: string;
        };
      };
      const savedJson = JSON.parse(await readFile(detailPath, "utf8")) as typeof detailJson;

      expect(detail.structuredContent).toMatchObject({
        tabId: tab!.tabId,
        logId: largeDetailId,
        truncated: false,
        savedTo: detailPath,
      });
      expect(detailJson.id).toBe(largeDetailId);
      expect(detailJson.kind).toBe("requestFinish");
      expect(detailJson.payload?.responseBody).toContain("fixture-large-json");
      expect(detailJson.payload?.responseBody).toContain("x".repeat(12_000));
      expect(savedJson).toEqual(detailJson);

      const fetchDetailId = rawLogIdForLine(fetchResult, "<- 200 POST", "/api/echo");
      const fetchDetail = JSON.parse(
        textOf(
          await client.callTool("log_detail", {
            tabId: tab!.tabId,
            logId: fetchDetailId,
          }),
        ),
      ) as {
        payload?: {
          requestBody?: string;
          responseBody?: string;
          requestHeaders?: Record<string, string>;
          responseHeaders?: Record<string, string>;
        };
      };
      expect(fetchDetail.payload?.requestBody).toContain('"client":"fetch"');
      expect(fetchDetail.payload?.responseBody).toContain('"client":"fetch"');
      expect(fetchDetail.payload?.requestHeaders).toBeDefined();
      expect(fetchDetail.payload?.responseHeaders).toBeDefined();

      const spaResult = textOf(
        await client.callTool("eval", {
          tabId: tab!.tabId,
          script: "navigateSpa()",
          waitMs: 200,
        }),
      );

      expect(spaResult).toContain("Same-document navigation");
      expect(spaResult).toContain("#spa");
    } finally {
      await client.close();
      await harness.close();
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }, 45_000);
});

function textOf(result: Awaited<ReturnType<McpProcessClient["callTool"]>>): string {
  return result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function rawLogIdsFrom(markdown: string): string[] {
  const logsSection = logsSectionOf(markdown);
  const ids: string[] = [];
  const pattern = /`([0-9a-zA-Z]+)(?:\.\.([0-9a-zA-Z]+))?`/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(logsSection))) {
    ids.push(match[1]!);
    if (match[2]) {
      ids.push(match[2]);
    }
  }

  return ids;
}

function logsSectionOf(markdown: string): string {
  return markdown.split("## Logs").at(1) ?? "";
}

function rawLogIdForLine(markdown: string, ...needles: string[]): string {
  const lines = markdown.split("\n");
  const index = lines.findIndex((candidate) => needles.every((needle) => candidate.includes(needle)));
  const line = index === -1 ? undefined : lines[index];
  expect(line).toBeDefined();

  const idLine = lines
    .slice(0, index + 1)
    .reverse()
    .find((candidate) => candidate.includes("`"));
  const match = idLine?.match(/`([0-9a-zA-Z]+)(?:\.\.[0-9a-zA-Z]+)?`/);
  expect(match?.[1]).toBeDefined();
  return match![1]!;
}
