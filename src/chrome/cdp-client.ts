import { LogBuffer, type LogEntry, type LogLevel } from "./log-buffer";

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

export type EvalOutcome = {
  value: string;
  isException: boolean;
};

export type ScreenshotOutcome = {
  data: string;
  mimeType: "image/png";
};

export class CdpClient {
  private socket?: WebSocket;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private connected?: Promise<void>;

  constructor(
    private readonly webSocketDebuggerUrl: string,
    private readonly logBuffer: LogBuffer,
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
    await Promise.all([this.send("Runtime.enable"), this.send("Log.enable")]);
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
      this.handleEvent(message.method, message.params);
    }
  }

  private handleEvent(method: string, params: unknown): void {
    switch (method) {
      case "Runtime.consoleAPICalled":
        this.logBuffer.add(normalizeConsoleApiCalled(params as ConsoleApiCalledParams));
        break;
      case "Runtime.exceptionThrown":
        this.logBuffer.add(normalizeExceptionThrown(params as ExceptionThrownParams));
        break;
      case "Log.entryAdded":
        this.logBuffer.add(normalizeLogEntryAdded(params as LogEntryAddedParams));
        break;
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

function normalizeConsoleApiCalled(params: ConsoleApiCalledParams): Omit<LogEntry, "id"> {
  const frame = params.stackTrace?.callFrames?.[0];

  return {
    level: normalizeLevel(params.type),
    text: (params.args ?? []).map(formatRemoteObject).join(" "),
    timestamp: timestampFromCdp(params.timestamp),
    source: formatSource(frame?.url, frame?.lineNumber, frame?.columnNumber),
  };
}

function normalizeExceptionThrown(params: ExceptionThrownParams): Omit<LogEntry, "id"> {
  return {
    level: "error",
    text: formatExceptionDetails(params.exceptionDetails),
    timestamp: timestampFromCdp(params.timestamp),
    source: formatSource(
      params.exceptionDetails.url,
      params.exceptionDetails.lineNumber,
      params.exceptionDetails.columnNumber,
    ),
  };
}

function normalizeLogEntryAdded(params: LogEntryAddedParams): Omit<LogEntry, "id"> {
  return {
    level: normalizeLevel(params.entry.level ?? "log"),
    text: params.entry.text ?? "",
    timestamp: timestampFromCdp(params.entry.timestamp),
    source: formatSource(params.entry.url, params.entry.lineNumber),
  };
}

function normalizeLevel(level: string): LogLevel {
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
