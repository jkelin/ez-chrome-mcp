import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

type BrowserHarness = {
  pageUrl: string;
  debuggingUrl: string;
  closeTab: (url: string) => Promise<void>;
  close: () => Promise<void>;
};

export async function startBrowserHarness(): Promise<BrowserHarness> {
  const fixtureServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/sample-page.html") {
        return new Response(Bun.file("test/fixtures/sample-page.html"), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
  const debuggingPort = await getFreePort();
  const pageUrl = `http://127.0.0.1:${fixtureServer.port}/sample-page.html`;
  const userDataDir = await mkdtemp(join(tmpdir(), "ez-chrome-mcp-"));
  const browserProcess = Bun.spawn(
    [
      chromium.executablePath(),
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${debuggingPort}`,
      "--remote-allow-origins=*",
      pageUrl,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  try {
    await waitForDebuggingTarget(`http://127.0.0.1:${debuggingPort}`, pageUrl);
  } catch (error) {
    browserProcess.kill();
    await browserProcess.exited.catch(() => undefined);
    fixtureServer.stop(true);
    await removeDirectoryWithRetry(userDataDir);
    throw error;
  }

  return {
    pageUrl,
    debuggingUrl: `http://127.0.0.1:${debuggingPort}`,
    closeTab: async (url) => {
      await closeDebuggingTarget(`http://127.0.0.1:${debuggingPort}`, url);
    },
    close: async () => {
      browserProcess.kill();
      await browserProcess.exited.catch(() => undefined);
      fixtureServer.stop(true);
      await removeDirectoryWithRetry(userDataDir);
    },
  };
}

async function closeDebuggingTarget(debuggingUrl: string, targetUrl: string): Promise<void> {
  const response = await fetch(`${debuggingUrl}/json/list`);
  const targets = (await response.json()) as Array<{ id?: string; url?: string }>;
  const matchingTargets = targets.filter((candidate) => candidate.url === targetUrl && candidate.id);

  if (matchingTargets.length === 0) {
    throw new Error(`No debugging target found for ${targetUrl}.`);
  }

  for (const target of matchingTargets) {
    await fetch(`${debuggingUrl}/json/close/${target.id}`);
  }

  await waitForDebuggingTargetsToClose(debuggingUrl, targetUrl);
}

async function waitForDebuggingTargetsToClose(debuggingUrl: string, targetUrl: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    const response = await fetch(`${debuggingUrl}/json/list`);
    const targets = (await response.json()) as Array<{ url?: string }>;
    if (targets.every((target) => target.url !== targetUrl)) {
      return;
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for debugging targets to close for ${targetUrl}.`);
}

async function waitForDebuggingTarget(debuggingUrl: string, pageUrl: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(`${debuggingUrl}/json/list`);
      const targets = (await response.json()) as Array<{ title?: string; url?: string }>;
      if (
        targets.some((target) => target.url === pageUrl && target.title === "EZ Chrome MCP Fixture")
      ) {
        return;
      }
    } catch {
      // Chrome may need a moment before the debugging HTTP endpoint is ready.
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for Chrome debugging target ${pageUrl}.`);
}

async function removeDirectoryWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }

      await Bun.sleep(100);
    }
  }
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = server.port;
  server.stop(true);

  if (port === undefined) {
    throw new Error("Bun did not allocate a fixture port.");
  }

  return port;
}
