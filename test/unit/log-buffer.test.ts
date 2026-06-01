import { describe, expect, test } from "bun:test";
import { LogBuffer, renderGroupedLogs } from "../../src/chrome/log-buffer";

describe("LogBuffer", () => {
  test("assigns compact alphanumeric raw IDs", () => {
    const buffer = new LogBuffer(10);
    const entry = buffer.add({ level: "log", text: "hello" });

    expect(entry.id).toMatch(/^[0-9a-zA-Z]+$/);
    expect(entry.id).toHaveLength(4);
  });

  test("groups only consecutive identical entries", () => {
    const buffer = new LogBuffer(10);
    buffer.add({ level: "warning", text: "repeat", source: "app.js:1" });
    buffer.add({ level: "warning", text: "repeat", source: "app.js:1" });
    buffer.add({ level: "log", text: "separator", source: "app.js:1" });
    buffer.add({ level: "warning", text: "repeat", source: "app.js:1" });

    const grouped = buffer.group(buffer.snapshot({ limit: 10 }));

    expect(grouped).toHaveLength(3);
    expect(grouped[0]?.count).toBe(2);
    expect(grouped[2]?.count).toBe(1);
  });

  test("uses raw IDs for before and after cursors before grouping", () => {
    const buffer = new LogBuffer(10);
    const first = buffer.add({ level: "log", text: "first" });
    const second = buffer.add({ level: "log", text: "second" });
    const third = buffer.add({ level: "log", text: "third" });

    expect(buffer.snapshot({ limit: 10, afterLogId: first.id }).map((entry) => entry.text)).toEqual([
      "second",
      "third",
    ]);
    expect(buffer.snapshot({ limit: 10, beforeLogId: third.id }).map((entry) => entry.text)).toEqual([
      "first",
      "second",
    ]);
    expect(buffer.snapshot({ limit: 10, afterLogId: first.id, beforeLogId: third.id })).toEqual([second]);
  });

  test("renders grouped ID spans", () => {
    const buffer = new LogBuffer(10);
    buffer.add({ level: "log", text: "repeat" });
    buffer.add({ level: "log", text: "repeat" });

    const rendered = renderGroupedLogs(buffer.group(buffer.snapshot({ limit: 10 })));

    expect(rendered).toContain("..");
    expect(rendered).toContain("x2");
  });
});
