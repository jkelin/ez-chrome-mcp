import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { ChromeDebugService } from "./chrome/service";
import { readConfig, type ChromeMcpConfig } from "./config";
import { registerChromeTools } from "./tools";

export function createChromeMcpServer(config: ChromeMcpConfig = readConfig()): {
  server: McpServer;
  chrome: ChromeDebugService;
} {
  const chrome = new ChromeDebugService(config);
  const server = new McpServer(
    { name: "ez-chrome-mcp", version: "0.1.0" },
    {
      instructions:
        "Use overview to find a Chrome tab ID before logs or eval. Prefer logs before eval. Eval runs arbitrary JavaScript in the user's browser tab and can mutate page state.",
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
