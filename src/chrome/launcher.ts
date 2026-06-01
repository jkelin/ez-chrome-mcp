import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { BrowserDebuggingEndpoint } from "./endpoints";

export type LaunchedChrome = {
  endpoint: BrowserDebuggingEndpoint;
};

export async function launchChromeWithRemoteDebugging(options: {
  port: number;
  url: string;
}): Promise<LaunchedChrome> {
  const executablePath = chromium.executablePath();
  const userDataDir = await mkdtemp(join(tmpdir(), "ez-chrome-mcp-open-tap-"));
  const endpoint = {
    kind: "browser" as const,
    origin: `http://127.0.0.1:${options.port}`,
  };
  const browserProcess = Bun.spawn(
    [
      executablePath,
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${options.port}`,
      "--remote-allow-origins=*",
      options.url,
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // Keep Chrome alive after the MCP server exits.
      detached: true,
    },
  );
  browserProcess.unref();

  await waitForDebuggingEndpoint(endpoint);

  return {
    endpoint,
  };
}

async function waitForDebuggingEndpoint(endpoint: BrowserDebuggingEndpoint): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(`${endpoint.origin}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Chrome needs a moment to expose the debugging HTTP endpoint after launch.
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for Chrome debugging endpoint ${endpoint.origin}.`);
}
