import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import packageJson from "../package.json" with { type: "json" };
import { ChromeDebugService } from "./chrome/service";
import { readConfig, type ChromeMcpConfig } from "./config";
import { registerChromeTools } from "./tools";

export async function installPlaywrightChromium(): Promise<void> {
  await Bun.$`bunx playwright install --with-deps chromium`;
}

export function createChromeMcpServer(config: ChromeMcpConfig = readConfig()): {
  server: McpServer;
  chrome: ChromeDebugService;
} {
  const chrome = new ChromeDebugService(config);
  const server = new McpServer(
    { name: "ez-chrome-mcp", version: packageJson.version },
    {
      instructions:
        "Use overview to find a Chrome tab ID before logs, eval, or screenshot. Prefer logs and screenshot before eval. Eval runs arbitrary JavaScript in the user's browser tab and can mutate page state.",
    },
  );

  registerChromeTools(server, chrome);

  return { server, chrome };
}

export async function runStdioServer(
  config: ChromeMcpConfig = readConfig(),
): Promise<void> {
  const { server, chrome } = createChromeMcpServer(config);
  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    await chrome.close();
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);
}
