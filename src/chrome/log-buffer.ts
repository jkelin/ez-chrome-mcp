import { createShortIdGenerator } from "../ids";

export type LogLevel = "log" | "debug" | "info" | "warning" | "error";

export type LogEntry = {
  id: string;
  level: LogLevel;
  text: string;
  timestamp: string;
  source?: string;
};

export type LogCursorOptions = {
  limit: number;
  afterLogId?: string;
  beforeLogId?: string;
};

export type GroupedLogEntry = {
  firstId: string;
  lastId: string;
  count: number;
  level: LogLevel;
  text: string;
  firstTimestamp: string;
  lastTimestamp: string;
  source?: string;
};

const generateLogId = createShortIdGenerator();

export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private version = 0;
  private waiters = new Set<() => void>();

  constructor(private readonly capacity: number) {}

  add(entry: Omit<LogEntry, "id" | "timestamp"> & { timestamp?: string }): LogEntry {
    const storedEntry: LogEntry = {
      id: generateLogId(),
      timestamp: entry.timestamp ?? new Date().toISOString(),
      level: entry.level,
      text: entry.text,
      source: entry.source,
    };

    this.entries.push(storedEntry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }

    this.version += 1;
    for (const waiter of this.waiters) {
      waiter();
    }

    return storedEntry;
  }

  snapshot(options: LogCursorOptions): LogEntry[] {
    const afterIndex = this.findCursorIndex(options.afterLogId, "afterLogId");
    const beforeIndex = this.findCursorIndex(options.beforeLogId, "beforeLogId");

    let start = afterIndex === undefined ? 0 : afterIndex + 1;
    let end = beforeIndex === undefined ? this.entries.length : beforeIndex;

    if (start > end) {
      [start, end] = [end, start];
    }

    const filtered = this.entries.slice(start, end);

    if (options.afterLogId && !options.beforeLogId) {
      return filtered.slice(0, options.limit);
    }

    return filtered.slice(Math.max(0, filtered.length - options.limit));
  }

  group(entries: LogEntry[]): GroupedLogEntry[] {
    const grouped: GroupedLogEntry[] = [];

    for (const entry of entries) {
      const previous = grouped.at(-1);
      if (
        previous &&
        previous.level === entry.level &&
        previous.text === entry.text &&
        previous.source === entry.source
      ) {
        previous.lastId = entry.id;
        previous.lastTimestamp = entry.timestamp;
        previous.count += 1;
        continue;
      }

      grouped.push({
        firstId: entry.id,
        lastId: entry.id,
        count: 1,
        level: entry.level,
        text: entry.text,
        firstTimestamp: entry.timestamp,
        lastTimestamp: entry.timestamp,
        source: entry.source,
      });
    }

    return grouped;
  }

  async waitForQuiet(quietMs: number, hardCapMs: number): Promise<void> {
    const startedAt = Date.now();
    let observedVersion = this.version;

    while (Date.now() - startedAt < hardCapMs) {
      const remaining = hardCapMs - (Date.now() - startedAt);
      const waitMs = Math.min(quietMs, remaining);
      const changed = await this.waitForChange(waitMs, observedVersion);

      if (!changed) {
        return;
      }

      observedVersion = this.version;
    }
  }

  private waitForChange(timeoutMs: number, observedVersion: number): Promise<boolean> {
    if (this.version !== observedVersion) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(onChange);
        resolve(false);
      }, timeoutMs);

      const onChange = () => {
        clearTimeout(timeout);
        this.waiters.delete(onChange);
        resolve(true);
      };

      this.waiters.add(onChange);
    });
  }

  private findCursorIndex(cursor: string | undefined, name: string): number | undefined {
    if (!cursor) {
      return undefined;
    }

    const index = this.entries.findIndex((entry) => entry.id === cursor);
    if (index === -1) {
      throw new Error(`${name} '${cursor}' was not found in the retained log buffer.`);
    }

    return index;
  }
}

export function renderGroupedLogs(groupedEntries: GroupedLogEntry[]): string {
  if (groupedEntries.length === 0) {
    return "_No retained logs matched this request._";
  }

  return groupedEntries
    .map((entry) => {
      const idRange = entry.firstId === entry.lastId ? entry.firstId : `${entry.firstId}..${entry.lastId}`;
      const repeat = entry.count > 1 ? ` x${entry.count}` : "";
      const source = entry.source ? ` ${entry.source}` : "";
      const time =
        entry.firstTimestamp === entry.lastTimestamp
          ? entry.firstTimestamp
          : `${entry.firstTimestamp}..${entry.lastTimestamp}`;

      return `- \`${idRange}\` **${entry.level}**${repeat} ${time}${source}\n  ${entry.text}`;
    })
    .join("\n");
}
