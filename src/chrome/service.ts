import type { ChromeMcpConfig } from "../config";
import { createShortIdGenerator } from "../ids";
import { CdpClient, type EvalOutcome } from "./cdp-client";
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
import { LogBuffer, renderGroupedLogs, type LogCursorOptions } from "./log-buffer";

type TabState = {
  tab: DiscoveredTab;
  logs: LogBuffer;
  client?: CdpClient;
};

export type LogsRequest = {
  tabId: string;
  limit?: number;
  afterLogId?: string;
  beforeLogId?: string;
};

export type EvalRequest = LogsRequest & {
  script: string;
  waitMs?: number;
};

export type OpenTapRequest = {
  url?: string;
  startNewChromeInstanceIfNotRunning?: boolean;
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

  async eval(request: EvalRequest): Promise<string> {
    const state = await this.ensureAttached(request.tabId);
    const waitMs = clamp(request.waitMs ?? this.config.defaultQuietMs, 0, this.config.maxQuietMs);
    const outcome = await state.client!.evaluate(request.script);

    if (waitMs > 0) {
      await state.logs.waitForQuiet(waitMs, this.config.hardWaitCapMs);
    }

    return this.renderLogs(state, request, outcome);
  }

  async openTap(request: OpenTapRequest): Promise<{ text: string; tab: DiscoveredTab; launchedChrome: boolean }> {
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

  async close(): Promise<void> {
    await Promise.all([...this.tabs.values()].map((state) => state.client?.close()));
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
      state.client = new CdpClient(state.tab.webSocketDebuggerUrl, state.logs);
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
      state.client = new CdpClient(webSocketDebuggerUrl, state.logs);
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
      logs: new LogBuffer(this.config.logBufferSize),
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
    const options: LogCursorOptions = {
      limit: clamp(request.limit ?? this.config.defaultLogLimit, 1, this.config.maxLogLimit),
      afterLogId: request.afterLogId,
      beforeLogId: request.beforeLogId,
    };
    const entries = state.logs.snapshot(options);
    const grouped = state.logs.group(entries);
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
      renderGroupedLogs(grouped),
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }
}

function renderOpenedTab(tab: DiscoveredTab, launchedChrome: boolean): string {
  return [
    "# OpenTap",
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

