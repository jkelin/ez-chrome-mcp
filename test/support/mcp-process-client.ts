type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export class McpProcessClient {
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();
  private nextId = 1;
  private stdoutBuffer = "";
  private readLoop: Promise<void>;
  private stderrLoop: Promise<void>;
  private stderr = "";

  constructor(env: Record<string, string>) {
    this.process = Bun.spawn(["bun", "run", "index.ts"], {
      cwd: "F:/Projects/ez-chrome-mcp",
      env: { ...process.env, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.readLoop = this.readStdout();
    this.stderrLoop = this.readStderr();
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ez-chrome-mcp-test", version: "0.1.0" },
    });
    await this.notify("notifications/initialized", {});
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return (await this.request("tools/call", { name, arguments: args })) as McpToolResult;
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    this.process.kill();
    await this.process.exited.catch(() => undefined);
    await this.readLoop.catch(() => undefined);
    await this.stderrLoop.catch(() => undefined);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const responsePromise = new Promise<JsonRpcResponse>((resolve) => this.pending.set(id, resolve));
    await this.write({ jsonrpc: "2.0", id, method, params });

    const response = await withTimeout(responsePromise, 10_000, () => {
      this.pending.delete(id);
      return `Timed out waiting for MCP response to ${method}. Stderr:\n${this.stderr}`;
    });
    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.result;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.write({ jsonrpc: "2.0", method, params });
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    this.process.stdin.write(this.encoder.encode(`${JSON.stringify(message)}\n`));
    this.process.stdin.flush();
  }

  private async readStdout(): Promise<void> {
    const reader = this.process.stdout.getReader();

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }

      this.stdoutBuffer += this.decoder.decode(value, { stream: true });
      let newlineIndex = this.stdoutBuffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

        if (line) {
          const response = JSON.parse(line) as JsonRpcResponse;
          if (typeof response.id === "number") {
            const resolve = this.pending.get(response.id);
            this.pending.delete(response.id);
            resolve?.(response);
          }
        }

        newlineIndex = this.stdoutBuffer.indexOf("\n");
      }
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }

      this.stderr += this.decoder.decode(value, { stream: true });
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message())), timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
