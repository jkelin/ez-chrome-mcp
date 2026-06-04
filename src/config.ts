export type ChromeMcpConfig = {
  endpoints: string[];
  launchDebuggingPort: number;
  defaultQuietMs: number;
  maxQuietMs: number;
  hardWaitCapMs: number;
  logBufferSize: number;
  defaultLogLimit: number;
  maxLogLimit: number;
  cdpMaxTotalBufferSize: number;
  cdpMaxPostDataSize: number;
};

const DEFAULT_DEBUGGING_ORIGIN = "http://127.0.0.1:9222";

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ChromeMcpConfig {
  const configuredEndpoints = [
    ...parseList(env.CHROME_DEBUGGING_URLS),
    ...parseList(env.CHROME_DEBUGGING_URL),
  ];

  return {
    endpoints: [DEFAULT_DEBUGGING_ORIGIN, ...configuredEndpoints],
    launchDebuggingPort: parsePositiveInt(env.EZ_CHROME_MCP_LAUNCH_DEBUGGING_PORT, 9222),
    defaultQuietMs: parsePositiveInt(env.EZ_CHROME_MCP_DEFAULT_QUIET_MS, 250),
    maxQuietMs: parsePositiveInt(env.EZ_CHROME_MCP_MAX_QUIET_MS, 5_000),
    hardWaitCapMs: parsePositiveInt(env.EZ_CHROME_MCP_HARD_WAIT_CAP_MS, 10_000),
    logBufferSize: parsePositiveInt(env.EZ_CHROME_MCP_LOG_BUFFER_SIZE, 5_000),
    defaultLogLimit: parsePositiveInt(env.EZ_CHROME_MCP_DEFAULT_LOG_LIMIT, 200),
    maxLogLimit: parsePositiveInt(env.EZ_CHROME_MCP_MAX_LOG_LIMIT, 1_000),
    cdpMaxTotalBufferSize: parsePositiveInt(env.EZ_CHROME_MCP_CDP_MAX_TOTAL_BUFFER_SIZE, 64 * 1024 * 1024),
    cdpMaxPostDataSize: parsePositiveInt(env.EZ_CHROME_MCP_CDP_MAX_POST_DATA_SIZE, 64 * 1024 * 1024),
  };
}
