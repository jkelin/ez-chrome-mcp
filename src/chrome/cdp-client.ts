import {
  ActivityTimeline,
  normalizeHeaderMap,
  shouldStoreBodyContent,
  type ActivityLevel,
  type ActivityPayload,
} from "./activity-timeline";

type CdpResponse<T> = {
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
};

type CdpEvent<T = unknown> = {
  method: string;
  params: T;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: Timer;
};

type RemoteObject = {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: {
    description?: string;
  };
};

type ConsoleApiCalledParams = {
  type: string;
  args?: RemoteObject[];
  timestamp?: number;
  stackTrace?: {
    callFrames?: Array<{
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
    }>;
  };
};

type ExceptionThrownParams = {
  timestamp?: number;
  exceptionDetails: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    exception?: RemoteObject;
  };
};

type LogEntryAddedParams = {
  entry: {
    source?: string;
    level?: string;
    text?: string;
    url?: string;
    lineNumber?: number;
    timestamp?: number;
  };
};

type RequestWillBeSentParams = {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers?: Record<string, string> | Array<{ name: string; value: string }>;
    postData?: string;
    hasPostData?: boolean;
  };
  type?: string;
};

type ResponseReceivedParams = {
  requestId: string;
  response: {
    url: string;
    status: number;
    mimeType?: string;
    headers?: Record<string, string> | Array<{ name: string; value: string }>;
  };
};

type LoadingFinishedParams = {
  requestId: string;
  encodedDataLength?: number;
};

type FrameNavigatedParams = {
  frame: {
    id: string;
    parentId?: string;
    url: string;
    name?: string;
  };
};

type NavigatedWithinDocumentParams = {
  frameId: string;
  url: string;
};

export type EvalOutcome = {
  value: string;
  isException: boolean;
};

export type ScreenshotOutcome = {
  data: string;
  mimeType: "image/png";
};

export type CdpNetworkBufferConfig = {
  maxTotalBufferSize: number;
  maxPostDataSize: number;
};

type TrackedNetworkRequest = {
  correlationId: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodySize?: number;
  status?: number;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  responseBodySize?: number;
};

export class CdpClient {
  private socket?: WebSocket;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private connected?: Promise<void>;
  private mainFrameId?: string;
  private readonly networkRequests = new Map<string, TrackedNetworkRequest>();

  constructor(
    private readonly webSocketDebuggerUrl: string,
    private readonly timeline: ActivityTimeline,
    private readonly networkBuffer: CdpNetworkBufferConfig,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) {
      return this.connected;
    }

    this.connected = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.webSocketDebuggerUrl);
      this.socket = socket;

      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error(`Failed to connect to ${this.webSocketDebuggerUrl}`)));
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => this.rejectPending("Chrome debugging WebSocket closed."));
    });

    await this.connected;
    await Promise.all([
      this.send("Runtime.enable"),
      this.send("Log.enable"),
      this.send("Page.enable"),
      this.send("Network.enable", {
        maxTotalBufferSize: this.networkBuffer.maxTotalBufferSize,
        maxPostDataSize: this.networkBuffer.maxPostDataSize,
      }),
    ]);
  }

  async close(): Promise<void> {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      return;
    }

    this.socket.close();
  }

  async evaluate(expression: string): Promise<EvalOutcome> {
    await this.connect();

    const response = await this.send<{
      result?: RemoteObject;
      exceptionDetails?: ExceptionThrownParams["exceptionDetails"];
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      generatePreview: true,
      userGesture: true,
    });

    if (response.exceptionDetails) {
      return {
        value: formatExceptionDetails(response.exceptionDetails),
        isException: true,
      };
    }

    return {
      value: formatRemoteObject(response.result),
      isException: false,
    };
  }

  async screenshot(): Promise<ScreenshotOutcome> {
    await this.connect();

    const response = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });

    return {
      data: response.data,
      mimeType: "image/png",
    };
  }

  private send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Chrome debugging WebSocket is not open."));
    }

    const id = this.nextRequestId++;
    const message = JSON.stringify({ id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}.`));
      }, 10_000);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      socket.send(message);
    });
  }

  private handleMessage(data: string | ArrayBuffer | Blob): void {
    if (typeof data !== "string") {
      return;
    }

    const message = JSON.parse(data) as Partial<CdpResponse<unknown>> & Partial<CdpEvent>;

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }

      return;
    }

    if (message.method && message.params) {
      void this.handleEvent(message.method, message.params);
    }
  }

  private async handleEvent(method: string, params: unknown): Promise<void> {
    switch (method) {
      case "Runtime.consoleAPICalled":
        this.timeline.add(normalizeConsoleApiCalled(params as ConsoleApiCalledParams));
        break;
      case "Runtime.exceptionThrown":
        this.timeline.add(normalizeExceptionThrown(params as ExceptionThrownParams));
        break;
      case "Log.entryAdded":
        this.timeline.add(normalizeLogEntryAdded(params as LogEntryAddedParams));
        break;
      case "Page.frameNavigated":
        this.handleFrameNavigated(params as FrameNavigatedParams);
        break;
      case "Page.navigatedWithinDocument":
        this.handleNavigatedWithinDocument(params as NavigatedWithinDocumentParams);
        break;
      case "Network.requestWillBeSent":
        this.handleRequestWillBeSent(params as RequestWillBeSentParams);
        break;
      case "Network.responseReceived":
        this.handleResponseReceived(params as ResponseReceivedParams);
        break;
      case "Network.loadingFinished":
        await this.handleLoadingFinished(params as LoadingFinishedParams);
        break;
    }
  }

  private handleFrameNavigated(params: FrameNavigatedParams): void {
    const frame = params.frame;
    if (frame.parentId) {
      return;
    }

    this.mainFrameId = frame.id;
    this.timeline.add({
      kind: "navigation",
      level: "info",
      text: `Document navigated to ${frame.url}`,
      payload: {
        url: frame.url,
        navigationType: "document",
      },
    });
  }

  private handleNavigatedWithinDocument(params: NavigatedWithinDocumentParams): void {
    if (this.mainFrameId && params.frameId !== this.mainFrameId) {
      return;
    }

    this.timeline.add({
      kind: "navigation",
      level: "info",
      text: `Same-document navigation to ${params.url}`,
      payload: {
        url: params.url,
        navigationType: "sameDocument",
      },
    });
  }

  private handleRequestWillBeSent(params: RequestWillBeSentParams): void {
    const resourceType = params.type ?? "";
    if (!isXhrOrFetch(resourceType)) {
      return;
    }

    const correlationId = this.timeline.createCorrelationId();
    const requestHeaders = normalizeHeaderMap(params.request.headers);
    const requestBody = params.request.postData;
    const tracked: TrackedNetworkRequest = {
      correlationId,
      method: params.request.method,
      url: params.request.url,
      resourceType,
      requestHeaders,
      requestBody,
      requestBodySize: requestBody ? byteLength(requestBody) : params.request.hasPostData ? undefined : 0,
    };

    this.networkRequests.set(params.requestId, tracked);
    this.timeline.add({
      kind: "requestStart",
      level: "info",
      text: `-> ${tracked.method} ${tracked.url}`,
      correlationId,
      payload: buildRequestStartPayload(tracked),
    });
  }

  private handleResponseReceived(params: ResponseReceivedParams): void {
    const tracked = this.networkRequests.get(params.requestId);
    if (!tracked) {
      return;
    }

    tracked.status = params.response.status;
    tracked.mimeType = params.response.mimeType;
    tracked.responseHeaders = normalizeHeaderMap(params.response.headers);
  }

  private async handleLoadingFinished(params: LoadingFinishedParams): Promise<void> {
    const tracked = this.networkRequests.get(params.requestId);
    if (!tracked) {
      return;
    }

    tracked.responseBodySize = params.encodedDataLength;

    if (tracked.requestBody === undefined) {
      const requestPostData = await this.fetchRequestPostData(params.requestId);
      if (requestPostData) {
        tracked.requestBody = requestPostData.postData;
        tracked.requestBodySize = byteLength(requestPostData.postData);
      }
    }

    const responseBody = await this.fetchResponseBody(params.requestId);
    const finishPayload = buildRequestFinishPayload(tracked, responseBody);

    this.timeline.add({
      kind: "requestFinish",
      level: tracked.status && tracked.status >= 400 ? "error" : "info",
      text: `<- ${tracked.status ?? "?"} ${tracked.method} ${tracked.url}`,
      correlationId: tracked.correlationId,
      payload: finishPayload,
    });

    this.networkRequests.delete(params.requestId);
  }

  private async fetchRequestPostData(requestId: string): Promise<{ postData: string } | undefined> {
    try {
      const result = await this.send<{ postData?: string }>("Network.getRequestPostData", { requestId });
      if (!result.postData) {
        return undefined;
      }

      return { postData: result.postData };
    } catch {
      return undefined;
    }
  }

  private async fetchResponseBody(
    requestId: string,
  ): Promise<{ body: string; base64Encoded: boolean } | undefined> {
    try {
      const result = await this.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", {
        requestId,
      });
      return result;
    } catch {
      return undefined;
    }
  }

  private rejectPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}

function buildRequestStartPayload(tracked: TrackedNetworkRequest): ActivityPayload {
  const storeRequestBody = shouldStoreBodyContent(undefined, tracked.requestBody);

  return {
    method: tracked.method,
    url: tracked.url,
    resourceType: tracked.resourceType,
    requestHeaders: tracked.requestHeaders,
    requestBody: storeRequestBody ? tracked.requestBody : undefined,
    requestBodySize: tracked.requestBodySize ?? (tracked.requestBody ? byteLength(tracked.requestBody) : undefined),
    requestBodyStored: storeRequestBody,
    responseBodyStored: false,
  };
}

function buildRequestFinishPayload(
  tracked: TrackedNetworkRequest,
  responseBody: { body: string; base64Encoded: boolean } | undefined,
): ActivityPayload {
  const storeRequestBody = shouldStoreBodyContent(undefined, tracked.requestBody);
  const storeResponseBody = shouldStoreBodyContent(
    tracked.mimeType,
    responseBody?.body,
    responseBody?.base64Encoded,
  );

  return {
    method: tracked.method,
    url: tracked.url,
    status: tracked.status,
    resourceType: tracked.resourceType,
    requestHeaders: tracked.requestHeaders,
    responseHeaders: tracked.responseHeaders,
    requestBody: storeRequestBody ? tracked.requestBody : undefined,
    requestBodySize: tracked.requestBodySize ?? (tracked.requestBody ? byteLength(tracked.requestBody) : undefined),
    requestBodyStored: storeRequestBody,
    responseBody: storeResponseBody ? responseBody?.body : undefined,
    responseBodySize: tracked.responseBodySize ?? (responseBody?.body ? byteLength(responseBody.body) : undefined),
    responseBodyStored: storeResponseBody,
  };
}

function isXhrOrFetch(resourceType: string): boolean {
  const normalized = resourceType.toLowerCase();
  return normalized === "xhr" || normalized === "fetch";
}

function normalizeConsoleApiCalled(params: ConsoleApiCalledParams) {
  const frame = params.stackTrace?.callFrames?.[0];

  return {
    kind: "console" as const,
    level: normalizeLevel(params.type),
    text: (params.args ?? []).map(formatRemoteObject).join(" "),
    timestamp: timestampFromCdp(params.timestamp),
    source: formatSource(frame?.url, frame?.lineNumber, frame?.columnNumber),
  };
}

function normalizeExceptionThrown(params: ExceptionThrownParams) {
  return {
    kind: "exception" as const,
    level: "error" as const,
    text: formatExceptionDetails(params.exceptionDetails),
    timestamp: timestampFromCdp(params.timestamp),
    source: formatSource(
      params.exceptionDetails.url,
      params.exceptionDetails.lineNumber,
      params.exceptionDetails.columnNumber,
    ),
  };
}

function normalizeLogEntryAdded(params: LogEntryAddedParams) {
  return {
    kind: "browserLog" as const,
    level: normalizeLevel(params.entry.level ?? "log"),
    text: params.entry.text ?? "",
    timestamp: timestampFromCdp(params.entry.timestamp),
    source: formatSource(params.entry.url, params.entry.lineNumber),
  };
}

function normalizeLevel(level: string): ActivityLevel {
  switch (level) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warning":
    case "warn":
      return "warning";
    case "error":
    case "assert":
      return "error";
    default:
      return "log";
  }
}

function formatRemoteObject(remoteObject: RemoteObject | undefined): string {
  if (!remoteObject) {
    return "undefined";
  }

  if ("value" in remoteObject) {
    if (typeof remoteObject.value === "string") {
      return remoteObject.value;
    }

    return JSON.stringify(remoteObject.value);
  }

  return (
    remoteObject.unserializableValue ??
    remoteObject.preview?.description ??
    remoteObject.description ??
    remoteObject.type ??
    "undefined"
  );
}

function formatExceptionDetails(exceptionDetails: ExceptionThrownParams["exceptionDetails"]): string {
  const exception = formatRemoteObject(exceptionDetails.exception);
  return [exceptionDetails.text, exception].filter(Boolean).join(": ");
}

function timestampFromCdp(timestamp: number | undefined): string {
  if (!timestamp) {
    return new Date().toISOString();
  }

  return new Date(timestamp).toISOString();
}

function formatSource(url: string | undefined, lineNumber: number | undefined, columnNumber?: number): string | undefined {
  if (!url) {
    return undefined;
  }

  const line = lineNumber === undefined ? undefined : lineNumber + 1;
  const column = columnNumber === undefined ? undefined : columnNumber + 1;

  return [url, line, column].filter((part) => part !== undefined).join(":");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
