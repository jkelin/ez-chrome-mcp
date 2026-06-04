import { installPlaywrightChromium, runStdioServer } from "./src/server";

await installPlaywrightChromium();
await runStdioServer();
