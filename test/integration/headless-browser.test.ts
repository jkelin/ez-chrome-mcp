import { describe, expect, test } from "bun:test";
import { startBrowserHarness } from "../support/browser-harness";
import { McpProcessClient } from "../support/mcp-process-client";

type OverviewContent = {
  tabs: Array<{
    tabId: string;
    url: string;
    title: string;
  }>;
};

type OpenTapContent = {
  tab: {
    tabId: string;
    url: string;
  };
  launchedChrome: boolean;
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

      await harness.closeTab(harness.pageUrl);
      const afterClose = await client.callTool("overview", {});
      const afterCloseStructured = afterClose.structuredContent as OverviewContent;

      expect(afterCloseStructured.tabs.every((candidate) => candidate.url !== harness.pageUrl)).toBe(true);

      const opened = await client.callTool("OpenTap", {
        url: harness.pageUrl,
        startNewChromeInstanceIfNotRunning: false,
      });
      const openedContent = opened.structuredContent as OpenTapContent;

      expect(textOf(opened)).toContain("Opened a tab on an existing Chrome debugging endpoint.");
      expect(openedContent.launchedChrome).toBe(false);
      expect(openedContent.tab.tabId).toHaveLength(4);
      expect(openedContent.tab.url).toBe(harness.pageUrl);
    } finally {
      await client.close();
      await harness.close();
    }
  }, 30_000);
});

function textOf(result: Awaited<ReturnType<McpProcessClient["callTool"]>>): string {
  return result.content.map((content) => content.text).join("\n");
}

function rawLogIdsFrom(markdown: string): string[] {
  const logsSection = markdown.split("## Logs").at(1) ?? "";
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
