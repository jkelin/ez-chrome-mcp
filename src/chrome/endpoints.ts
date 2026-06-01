export type BrowserDebuggingEndpoint = {
  kind: "browser";
  origin: string;
};

export type TabWebSocketEndpoint = {
  kind: "tabWebSocket";
  webSocketDebuggerUrl: string;
  tabId: string;
};

export type ChromeDebuggingEndpoint = BrowserDebuggingEndpoint | TabWebSocketEndpoint;

export type DiscoveredTab = {
  tabId: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  source: string;
};

type ChromeJsonTarget = {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

export function normalizeEndpoint(rawEndpoint: string): ChromeDebuggingEndpoint {
  const trimmed = rawEndpoint.trim();
  if (!trimmed) {
    throw new Error("Chrome debugging endpoint cannot be empty.");
  }

  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return {
      kind: "tabWebSocket",
      webSocketDebuggerUrl: trimmed,
      tabId: tabIdFromWebSocketUrl(trimmed),
    };
  }

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);
  return {
    kind: "browser",
    origin: url.origin,
  };
}

export function normalizeEndpoints(rawEndpoints: string[]): ChromeDebuggingEndpoint[] {
  const seen = new Set<string>();
  const endpoints: ChromeDebuggingEndpoint[] = [];

  for (const rawEndpoint of rawEndpoints) {
    const endpoint = normalizeEndpoint(rawEndpoint);
    const key = endpoint.kind === "browser" ? endpoint.origin : endpoint.webSocketDebuggerUrl;
    if (!seen.has(key)) {
      seen.add(key);
      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

export function tabIdFromWebSocketUrl(webSocketDebuggerUrl: string): string {
  const url = new URL(webSocketDebuggerUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts.at(-1);

  if (!id) {
    throw new Error(`Unable to infer tab ID from WebSocket URL: ${webSocketDebuggerUrl}`);
  }

  return id;
}

export async function discoverBrowserTabs(
  endpoint: BrowserDebuggingEndpoint,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredTab[]> {
  const response = await fetchImpl(`${endpoint.origin}/json/list`);
  if (!response.ok) {
    throw new Error(`Chrome endpoint ${endpoint.origin} returned HTTP ${response.status}.`);
  }

  const targets = (await response.json()) as ChromeJsonTarget[];

  return targets
    .filter((target) => target.type === "page")
    .filter((target) => target.id && target.webSocketDebuggerUrl)
    .map((target) => ({
      tabId: target.id ?? "",
      title: target.title ?? "",
      url: target.url ?? "",
      webSocketDebuggerUrl: target.webSocketDebuggerUrl ?? "",
      source: endpoint.origin,
    }));
}

export async function openBrowserTab(
  endpoint: BrowserDebuggingEndpoint,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredTab> {
  const response = await fetchImpl(`${endpoint.origin}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });

  if (!response.ok) {
    throw new Error(`Chrome endpoint ${endpoint.origin} could not open a tab: HTTP ${response.status}.`);
  }

  const target = (await response.json()) as ChromeJsonTarget;
  if (!target.id || !target.webSocketDebuggerUrl) {
    throw new Error(`Chrome endpoint ${endpoint.origin} opened a target without a debuggable tab ID.`);
  }

  return {
    tabId: target.id,
    title: target.title ?? "",
    url: target.url ?? url,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    source: endpoint.origin,
  };
}

export function browserEndpointFromWebSocket(webSocketDebuggerUrl: string): BrowserDebuggingEndpoint {
  const url = new URL(webSocketDebuggerUrl);
  const protocol = url.protocol === "wss:" ? "https:" : "http:";

  return {
    kind: "browser",
    origin: `${protocol}//${url.host}`,
  };
}
