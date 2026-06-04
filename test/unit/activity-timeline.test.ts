import { describe, expect, test } from "bun:test";
import {
  ActivityTimeline,
  renderGroupedActivity,
  shouldStoreBodyContent,
} from "../../src/chrome/activity-timeline";

describe("ActivityTimeline", () => {
  test("assigns compact alphanumeric raw IDs", () => {
    const timeline = new ActivityTimeline(10);
    const entry = timeline.add({ kind: "console", level: "log", text: "hello" });

    expect(entry.id).toMatch(/^[0-9a-zA-Z]+$/);
    expect(entry.id).toHaveLength(4);
    timeline.close();
  });

  test("groups only consecutive identical console entries", () => {
    const timeline = new ActivityTimeline(10);
    timeline.add({ kind: "console", level: "warning", text: "repeat", source: "app.js:1" });
    timeline.add({ kind: "console", level: "warning", text: "repeat", source: "app.js:1" });
    timeline.add({ kind: "console", level: "log", text: "separator", source: "app.js:1" });
    timeline.add({ kind: "navigation", level: "info", text: "navigated" });
    timeline.add({ kind: "console", level: "warning", text: "repeat", source: "app.js:1" });

    const grouped = timeline.group(timeline.snapshot({ limit: 10 }));

    expect(grouped).toHaveLength(4);
    expect(grouped[0]?.count).toBe(2);
    expect(grouped[2]?.kind).toBe("navigation");
    expect(grouped[2]?.count).toBe(1);
    timeline.close();
  });

  test("uses inclusive after and exclusive before raw ID cursors before grouping", () => {
    const timeline = new ActivityTimeline(10);
    const first = timeline.add({ kind: "console", level: "log", text: "first" });
    const second = timeline.add({ kind: "console", level: "log", text: "second" });
    const third = timeline.add({ kind: "console", level: "log", text: "third" });

    expect(timeline.snapshot({ limit: 10, afterLogId: first.id }).map((entry) => entry.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(timeline.snapshot({ limit: 10, beforeLogId: third.id }).map((entry) => entry.text)).toEqual([
      "first",
      "second",
    ]);
    expect(timeline.snapshot({ limit: 10, afterLogId: first.id, beforeLogId: third.id })).toEqual([
      first,
      second,
    ]);
    timeline.close();
  });

  test("looks up a retained activity entry by raw ID", () => {
    const timeline = new ActivityTimeline(10);
    const entry = timeline.add({
      kind: "requestFinish",
      level: "info",
      text: "<- 200 POST /api/echo",
      payload: {
        responseBody: '{"ok":true}',
        responseBodyStored: true,
      },
    });

    expect(timeline.getById(entry.id)).toEqual(entry);
    expect(timeline.getById("missing")).toBeUndefined();
    timeline.close();
  });

  test("renders compact request rows without headers or bodies", () => {
    const timeline = new ActivityTimeline(10);
    const largeBody = "y".repeat(12_000);
    timeline.add({
      kind: "requestFinish",
      level: "info",
      text: "<- 200 POST /api/large",
      correlationId: "corr1",
      payload: {
        responseBody: largeBody,
        responseBodyStored: true,
        responseHeaders: { "content-type": "application/json" },
        responseBodySize: largeBody.length,
      },
    });

    const rendered = renderGroupedActivity(timeline.group(timeline.snapshot({ limit: 10 })));

    expect(rendered).toContain("<- 200 POST /api/large");
    expect(rendered).toContain("correlation: corr1");
    expect(rendered).not.toContain("response-body");
    expect(rendered).not.toContain("response-headers");
    expect(rendered).not.toContain(largeBody);
    timeline.close();
  });

  test("links request start and finish with correlation IDs in rendered output", () => {
    const timeline = new ActivityTimeline(10);
    const correlationId = timeline.createCorrelationId();
    timeline.add({
      kind: "requestStart",
      level: "info",
      text: "-> POST /api/echo",
      correlationId,
      payload: {
        method: "POST",
        url: "http://127.0.0.1/api/echo",
        requestBody: '{"client":"fetch"}',
        requestBodyStored: true,
      },
    });
    timeline.add({
      kind: "requestFinish",
      level: "info",
      text: "<- 200 POST /api/echo",
      correlationId,
      payload: {
        method: "POST",
        url: "http://127.0.0.1/api/echo",
        status: 200,
        responseBody: '{"ok":true}',
        responseBodyStored: true,
      },
    });

    const rendered = renderGroupedActivity(timeline.group(timeline.snapshot({ limit: 10 })));

    expect(rendered).toContain("correlation: ");
    expect(rendered).not.toContain("request-body:");
    expect(rendered).not.toContain("response-body:");
    timeline.close();
  });
});

describe("shouldStoreBodyContent", () => {
  test("stores JSON text and skips base64 binary", () => {
    expect(shouldStoreBodyContent("application/json", '{"ok":true}')).toBe(true);
    expect(shouldStoreBodyContent("application/octet-stream", "abc", true)).toBe(false);
    expect(shouldStoreBodyContent("application/octet-stream", "abc", false)).toBe(false);
  });
});
