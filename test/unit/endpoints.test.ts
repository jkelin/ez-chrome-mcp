import { describe, expect, test } from "bun:test";
import { normalizeEndpoints, normalizeEndpoint, tabIdFromWebSocketUrl } from "../../src/chrome/endpoints";

describe("Chrome debugging endpoints", () => {
  test("normalizes browser origins", () => {
    expect(normalizeEndpoint("127.0.0.1:9222")).toEqual({
      kind: "browser",
      origin: "http://127.0.0.1:9222",
    });

    expect(normalizeEndpoint("http://localhost:9223/json/list")).toEqual({
      kind: "browser",
      origin: "http://localhost:9223",
    });
  });

  test("normalizes tab WebSocket URLs", () => {
    expect(normalizeEndpoint("ws://127.0.0.1:9222/devtools/page/ABC")).toEqual({
      kind: "tabWebSocket",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/ABC",
      tabId: "ABC",
    });
  });

  test("deduplicates configured endpoints", () => {
    expect(
      normalizeEndpoints([
        "http://127.0.0.1:9222",
        "127.0.0.1:9222",
        "ws://127.0.0.1:9222/devtools/page/ABC",
      ]),
    ).toHaveLength(2);
  });

  test("extracts target IDs from WebSocket URLs", () => {
    expect(tabIdFromWebSocketUrl("ws://127.0.0.1:9222/devtools/page/ABC")).toBe("ABC");
  });
});
