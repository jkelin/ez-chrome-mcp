import { isAbsolute } from "node:path";
import type { ChromeMcpConfig } from "../config";
import { createShortIdGenerator } from "../ids";
import { CdpClient, type EvalOutcome, type ScreenshotOutcome } from "./cdp-client";
import {
  browserEndpointFromWebSocket,
  discoverBrowserTabs,
  normalizeEndpoints,
  openBrowserTab,
  type BrowserDebuggingEndpoint,
  type ChromeDebuggingEndpoint,
  type DiscoveredTab,
} from "./endpoints";
import { launchChromeWithRemoteDebugging } from "./launcher";
import {
  ActivityTimeline,
  renderGroupedActivity,
  type ActivityCursorOptions,
} from "./activity-timeline";

type TabState = {
  tab: DiscoveredTab;
  timeline: ActivityTimeline;
  client?: CdpClient;
};

export type LogsRequest = {
  tabId: string;
  limit?: number;
  afterLogId?: string;
  beforeLogId?: string;
};

export type LogDetailRequest = {
  tabId: string;
  logId: string;
  absolute_path?: string;
};

export type LogDetailResult = {
  text: string;
  structuredContent: {
    tabId: string;
    logId: string;
    truncated: boolean;
    sizeBytes: number;
    savedTo?: string;
  };
};

export type EvalRequest = LogsRequest & {
  script: string;
  waitMs?: number;
};

export type OpenTabRequest = {
  url?: string;
  startNewChromeInstanceIfNotRunning?: boolean;
};

export type ScreenshotRequest = {
  tabId: string;
};

export type ScreenshotResult = ScreenshotOutcome & {
  tab: DiscoveredTab;
  sizeBytes: number;
};

export class ChromeDebugService {
  private readonly endpoints: ChromeDebuggingEndpoint[];
  private readonly tabs = new Map<string, TabState>();
  private readonly tabAliases = new Map<string, string>();
  private readonly nextTabAlias = createShortIdGenerator();

  constructor(private readonly config: ChromeMcpConfig) {
    this.endpoints = normalizeEndpoints(config.endpoints);
  }

  async overview(): Promise<DiscoveredTab[]> {
    const visibleTabIds = new Set<string>();

    for (const endpoint of this.endpoints) {
      if (endpoint.kind === "browser") {
        try {
          for (const tab of await discoverBrowserTabs(endpoint)) {
            const publicTab = this.toPublicTab(tab);
            this.upsertTab(publicTab);
            visibleTabIds.add(publicTab.tabId);
          }
        } catch {
          // Unreachable default/configured Chrome ports should not make overview unusable.
        }

        continue;
      }

      const state = await this.ensureTabWebSocketState(endpoint.webSocketDebuggerUrl, endpoint.tabId);
      this.upsertTab(state.tab);
      visibleTabIds.add(state.tab.tabId);
    }

    await this.removeStaleTabs(visibleTabIds);

    return [...this.tabs.values()].map((state) => state.tab);
  }

  async logs(request: LogsRequest): Promise<string> {
    const state = await this.ensureAttached(request.tabId);
    return this.renderLogs(state, request);
  }

  async logDetail(request: LogDetailRequest): Promise<LogDetailResult> {
    const state = await this.ensureAttached(request.tabId);
    const entry = state.timeline.getById(request.logId);
    if (!entry) {
      throw new Error(`No retained activity entry with ID '${request.logId}' was found for tab '${request.tabId}'.`);
    }

    const detail = JSON.stringify(entry, null, 2);
    const savedTo = request.absolute_path ? await writeAbsolutePath(request.absolute_path, detail) : undefined;
    const { text, truncated, sizeBytes } = truncateUtf8(detail, LOG_DETAIL_MAX_BYTES);

    return {
      text,
      structuredContent: {
        tabId: state.tab.tabId,
        logId: entry.id,
        truncated,
        sizeBytes,
        savedTo,
      },
    };
  }

  async eval(request: EvalRequest): Promise<string> {
    const state = await this.ensureAttached(request.tabId);
    const waitMs = clamp(request.waitMs ?? this.config.defaultQuietMs, 0, this.config.maxQuietMs);
    const outcome = await state.client!.evaluate(request.script);

    if (waitMs > 0) {
      await state.timeline.waitForQuiet(waitMs, this.config.hardWaitCapMs);
    }

    return this.renderLogs(state, request, outcome);
  }

  async openTab(request: OpenTabRequest): Promise<{ text: string; tab: DiscoveredTab; launchedChrome: boolean }> {
    const url = request.url?.trim() || "about:blank";
    const existingEndpoint = await this.findReachableBrowserEndpoint();

    if (existingEndpoint) {
      const tab = await openBrowserTab(existingEndpoint, url);
      const publicTab = this.toPublicTab(tab);
      this.upsertTab(publicTab);
      return {
        tab: publicTab,
        launchedChrome: false,
        text: renderOpenedTab(publicTab, false),
      };
    }

    if (!request.startNewChromeInstanceIfNotRunning) {
      throw new Error(
        "No Chrome debugging endpoint is available. Set startNewChromeInstanceIfNotRunning to true to launch Chrome with remote debugging.",
      );
    }

    const launchedChrome = await launchChromeWithRemoteDebugging({
      port: this.config.launchDebuggingPort,
      url,
    });
    this.endpoints.push(launchedChrome.endpoint);

    const tab = await this.findTabByUrl(launchedChrome.endpoint, url);
    const publicTab = this.toPublicTab(tab);
    this.upsertTab(publicTab);

    return {
      tab: publicTab,
      launchedChrome: true,
      text: renderOpenedTab(publicTab, true),
    };
  }

  async screenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
    const state = await this.ensureAttached(request.tabId);
    const screenshot = await state.client!.screenshot();

    return {
      ...screenshot,
      tab: state.tab,
      sizeBytes: base64SizeBytes(screenshot.data),
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.tabs.values()].map((state) => state.client?.close()));
    for (const state of this.tabs.values()) {
      state.timeline.close();
    }
  }

  private async findReachableBrowserEndpoint(): Promise<BrowserDebuggingEndpoint | undefined> {
    for (const endpoint of this.endpoints) {
      const browserEndpoint =
        endpoint.kind === "browser" ? endpoint : browserEndpointFromWebSocket(endpoint.webSocketDebuggerUrl);

      try {
        const response = await fetch(`${browserEndpoint.origin}/json/version`);
        if (response.ok) {
          return browserEndpoint;
        }
      } catch {
        // Try the next configured endpoint.
      }
    }

    return undefined;
  }

  private async findTabByUrl(endpoint: BrowserDebuggingEndpoint, url: string): Promise<DiscoveredTab> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 10_000) {
      const tabs = await discoverBrowserTabs(endpoint);
      const tab = tabs.find((candidate) => candidate.url === url) ?? tabs.at(-1);
      if (tab) {
        return tab;
      }

      await Bun.sleep(100);
    }

    throw new Error(`Timed out waiting for Chrome to open ${url}.`);
  }

  private async ensureAttached(tabId: string): Promise<TabState> {
    await this.overview();

    const state = this.tabs.get(tabId);
    if (!state) {
      throw new Error(`No Chrome tab with ID '${tabId}' was found. Call overview to refresh available tabs.`);
    }

    if (!state.client) {
      state.client = new CdpClient(state.tab.webSocketDebuggerUrl, state.timeline, {
        maxTotalBufferSize: this.config.cdpMaxTotalBufferSize,
        maxPostDataSize: this.config.cdpMaxPostDataSize,
      });
      await state.client.connect();
    }

    return state;
  }

  private async ensureTabWebSocketState(webSocketDebuggerUrl: string, tabId: string): Promise<TabState> {
    const tab = this.toPublicTab({
      tabId,
      title: "",
      url: "",
      webSocketDebuggerUrl,
      source: "configured tab WebSocket",
    });
    const state = this.upsertTab(tab);

    if (!state.client) {
      state.client = new CdpClient(webSocketDebuggerUrl, state.timeline, {
        maxTotalBufferSize: this.config.cdpMaxTotalBufferSize,
        maxPostDataSize: this.config.cdpMaxPostDataSize,
      });
      await state.client.connect();
    }

    const metadata = await state.client.evaluate("({ url: location.href, title: document.title })");
    const parsed = parseJsonObject(metadata.value);
    state.tab = {
      ...state.tab,
      title: typeof parsed.title === "string" ? parsed.title : state.tab.title,
      url: typeof parsed.url === "string" ? parsed.url : state.tab.url,
    };

    return state;
  }

  private toPublicTab(tab: DiscoveredTab): DiscoveredTab {
    const publicTabId = this.tabAliases.get(tab.tabId) ?? this.nextTabAlias();
    this.tabAliases.set(tab.tabId, publicTabId);

    return {
      ...tab,
      tabId: publicTabId,
    };
  }

  private upsertTab(tab: DiscoveredTab): TabState {
    const existing = this.tabs.get(tab.tabId);
    if (existing) {
      existing.tab = tab;
      return existing;
    }

    const state: TabState = {
      tab,
      timeline: new ActivityTimeline(this.config.logBufferSize),
    };
    this.tabs.set(tab.tabId, state);
    return state;
  }

  private async removeStaleTabs(visibleTabIds: Set<string>): Promise<void> {
    for (const [tabId, state] of this.tabs) {
      if (visibleTabIds.has(tabId)) {
        continue;
      }

      await state.client?.close().catch(() => undefined);
      this.tabs.delete(tabId);
    }
  }

  private renderLogs(state: TabState, request: LogsRequest, outcome?: EvalOutcome): string {
    const options: ActivityCursorOptions = {
      limit: clamp(request.limit ?? this.config.defaultLogLimit, 1, this.config.maxLogLimit),
      afterLogId: request.afterLogId,
      beforeLogId: request.beforeLogId,
    };
    const entries = state.timeline.snapshot(options);
    const grouped = state.timeline.group(entries);
    const cursorLine = entries.length
      ? `Raw log IDs: \`${entries[0]!.id}\` to \`${entries.at(-1)!.id}\``
      : "Raw log IDs: none";
    const evalSection = outcome
      ? `\n## Eval Result\n\n${outcome.isException ? "**JavaScript exception**\n\n" : ""}\`\`\`text\n${outcome.value}\n\`\`\`\n`
      : "";

    return [
      `# Chrome Tab Logs`,
      ``,
      `Tab ID: \`${state.tab.tabId}\``,
      `Current URL: ${state.tab.url || "(unknown)"}`,
      cursorLine,
      evalSection.trimEnd(),
      `## Logs`,
      ``,
      renderGroupedActivity(grouped),
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }
}

function renderOpenedTab(tab: DiscoveredTab, launchedChrome: boolean): string {
  return [
    "# open-tab",
    "",
    launchedChrome ? "Started a new Chrome instance with remote debugging." : "Opened a tab on an existing Chrome debugging endpoint.",
    "",
    `Tab ID: \`${tab.tabId}\``,
    `URL: ${tab.url || "(unknown)"}`,
    `Title: ${tab.title || "(untitled)"}`,
    `Source: ${tab.source}`,
  ].join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function base64SizeBytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

const LOG_DETAIL_MAX_BYTES = 64 * 1024;

async function writeAbsolutePath(path: string, contents: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error("absolute_path must be an absolute file path.");
  }

  await Bun.write(path, contents);
  return path;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean; sizeBytes: number } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) {
    return {
      text: value,
      truncated: false,
      sizeBytes: encoded.length,
    };
  }

  return {
    text: new TextDecoder().decode(encoded.slice(0, maxBytes)),
    truncated: true,
    sizeBytes: encoded.length,
  };
}

