import { Database } from "bun:sqlite";
import { createShortIdGenerator } from "../ids";

export type ActivityLevel = "log" | "debug" | "info" | "warning" | "error";

export type ActivityKind =
  | "console"
  | "exception"
  | "browserLog"
  | "navigation"
  | "requestStart"
  | "requestFinish";

export type ActivityEntry = {
  id: string;
  seq: number;
  kind: ActivityKind;
  level: ActivityLevel;
  text: string;
  timestamp: string;
  source?: string;
  correlationId?: string;
  payload?: ActivityPayload;
};

export type ActivityPayload = {
  method?: string;
  url?: string;
  status?: number;
  resourceType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  requestBodySize?: number;
  responseBodySize?: number;
  requestBodyStored?: boolean;
  responseBodyStored?: boolean;
  bodyTruncatedForDisplay?: boolean;
  navigationType?: "document" | "sameDocument";
};

export type ActivityCursorOptions = {
  limit: number;
  afterLogId?: string;
  beforeLogId?: string;
};

export type GroupedActivityEntry = {
  firstId: string;
  lastId: string;
  count: number;
  kind: ActivityKind;
  level: ActivityLevel;
  text: string;
  firstTimestamp: string;
  lastTimestamp: string;
  source?: string;
  correlationId?: string;
  payload?: ActivityPayload;
};

type ActivityEntryRow = {
  id: string;
  seq: number;
  kind: ActivityKind;
  level: ActivityLevel;
  text: string;
  timestamp: string;
  source: string | null;
  correlationId: string | null;
  payload: string | null;
};

const generateActivityId = createShortIdGenerator();
const generateCorrelationId = createShortIdGenerator();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS activity_entries (
  id TEXT PRIMARY KEY NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  level TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source TEXT,
  correlation_id TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_seq ON activity_entries(seq);
`;

export class ActivityTimeline {
  private readonly db: Database;
  private seq = 0;
  private version = 0;
  private waiters = new Set<() => void>();

  private readonly insertEntry;
  private readonly selectBySeqRange;
  private readonly selectById;
  private readonly findSeqById;
  private readonly deleteBelowSeq;
  private readonly countEntries;

  constructor(private readonly capacity: number) {
    this.db = new Database(":memory:", { strict: true });
    this.db.run(SCHEMA);

    this.insertEntry = this.db.query(
      `INSERT INTO activity_entries (id, seq, kind, level, text, timestamp, source, correlation_id, payload)
       VALUES ($id, $seq, $kind, $level, $text, $timestamp, $source, $correlationId, $payload)`,
    );
    this.selectBySeqRange = this.db.query(
      `SELECT id, seq, kind, level, text, timestamp, source, correlation_id AS correlationId, payload
       FROM activity_entries
       WHERE seq >= $afterSeq AND ($beforeSeq IS NULL OR seq < $beforeSeq)
       ORDER BY seq ASC`,
    );
    this.selectById = this.db.query(
      `SELECT id, seq, kind, level, text, timestamp, source, correlation_id AS correlationId, payload
       FROM activity_entries
       WHERE id = $id`,
    );
    this.findSeqById = this.db.query(`SELECT seq FROM activity_entries WHERE id = $id`);
    this.deleteBelowSeq = this.db.query(`DELETE FROM activity_entries WHERE seq <= $minSeq`);
    this.countEntries = this.db.query(`SELECT COUNT(*) AS count FROM activity_entries`);
  }

  close(): void {
    this.db.close(false);
  }

  createCorrelationId(): string {
    return generateCorrelationId();
  }

  add(
    entry: Omit<ActivityEntry, "id" | "seq" | "timestamp"> & { timestamp?: string; id?: string },
  ): ActivityEntry {
    const storedEntry: ActivityEntry = {
      id: entry.id ?? generateActivityId(),
      seq: ++this.seq,
      kind: entry.kind,
      level: entry.level,
      text: entry.text,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      source: entry.source,
      correlationId: entry.correlationId,
      payload: entry.payload,
    };

    this.insertEntry.run({
      id: storedEntry.id,
      seq: storedEntry.seq,
      kind: storedEntry.kind,
      level: storedEntry.level,
      text: storedEntry.text,
      timestamp: storedEntry.timestamp,
      source: storedEntry.source ?? null,
      correlationId: storedEntry.correlationId ?? null,
      payload: storedEntry.payload ? JSON.stringify(storedEntry.payload) : null,
    });

    this.enforceCapacity();
    this.bumpVersion();
    return storedEntry;
  }

  snapshot(options: ActivityCursorOptions): ActivityEntry[] {
    const afterSeq = this.findCursorSeq(options.afterLogId, "afterLogId");
    const beforeSeq = this.findCursorSeq(options.beforeLogId, "beforeLogId");

    let rows = this.selectBySeqRange.all({
      afterSeq: afterSeq ?? 1,
      beforeSeq: beforeSeq ?? null,
    }) as ActivityEntryRow[];

    if (options.afterLogId && !options.beforeLogId) {
      rows = rows.slice(0, options.limit);
    } else {
      rows = rows.slice(Math.max(0, rows.length - options.limit));
    }

    return rows.map(rowToEntry);
  }

  getById(id: string): ActivityEntry | undefined {
    const row = this.selectById.get({ id }) as ActivityEntryRow | null;
    return row ? rowToEntry(row) : undefined;
  }

  group(entries: ActivityEntry[]): GroupedActivityEntry[] {
    const grouped: GroupedActivityEntry[] = [];

    for (const entry of entries) {
      if (!isGroupableKind(entry.kind)) {
        grouped.push(toGroupedSingle(entry));
        continue;
      }

      const previous = grouped.at(-1);
      if (
        previous &&
        isGroupableKind(previous.kind) &&
        previous.kind === entry.kind &&
        previous.level === entry.level &&
        previous.text === entry.text &&
        previous.source === entry.source
      ) {
        previous.lastId = entry.id;
        previous.lastTimestamp = entry.timestamp;
        previous.count += 1;
        continue;
      }

      grouped.push(toGroupedSingle(entry));
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

  private enforceCapacity(): void {
    const count = (this.countEntries.get() as { count: number }).count;
    if (count <= this.capacity) {
      return;
    }

    const minSeqToKeep = this.seq - this.capacity;
    this.deleteBelowSeq.run({ minSeq: minSeqToKeep });
  }

  private bumpVersion(): void {
    this.version += 1;
    for (const waiter of this.waiters) {
      waiter();
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

  private findCursorSeq(cursor: string | undefined, name: string): number | undefined {
    if (!cursor) {
      return undefined;
    }

    const row = this.findSeqById.get({ id: cursor }) as { seq: number } | null;
    if (!row) {
      throw new Error(`${name} '${cursor}' was not found in the retained activity buffer.`);
    }

    return row.seq;
  }
}

export function renderGroupedActivity(groupedEntries: GroupedActivityEntry[]): string {
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
      const body = formatActivityBody(entry);

      return `- \`${idRange}\` **${formatKindLabel(entry.kind, entry.level)}**${repeat} ${time}${source}\n  ${body}`;
    })
    .join("\n");
}

function formatKindLabel(kind: ActivityKind, level: ActivityLevel): string {
  switch (kind) {
    case "navigation":
      return "navigation";
    case "requestStart":
      return "request";
    case "requestFinish":
      return "request";
    default:
      return level;
  }
}

function formatActivityBody(entry: GroupedActivityEntry): string {
  if (entry.kind === "navigation") {
    return entry.text;
  }

  if (entry.kind === "requestStart" || entry.kind === "requestFinish") {
    return appendCorrelationLine([entry.text], entry.correlationId);
  }

  return entry.text;
}

export function appendCorrelationLine(lines: string[], correlationId: string | undefined): string {
  if (correlationId) {
    lines.push(`correlation: ${correlationId}`);
  }

  return lines.join("\n  ");
}

function isGroupableKind(kind: ActivityKind): boolean {
  return kind === "console" || kind === "exception" || kind === "browserLog";
}

function toGroupedSingle(entry: ActivityEntry): GroupedActivityEntry {
  return {
    firstId: entry.id,
    lastId: entry.id,
    count: 1,
    kind: entry.kind,
    level: entry.level,
    text: entry.text,
    firstTimestamp: entry.timestamp,
    lastTimestamp: entry.timestamp,
    source: entry.source,
    correlationId: entry.correlationId,
    payload: entry.payload,
  };
}

function rowToEntry(row: ActivityEntryRow): ActivityEntry {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    level: row.level,
    text: row.text,
    timestamp: row.timestamp,
    source: row.source ?? undefined,
    correlationId: row.correlationId ?? undefined,
    payload: row.payload ? (JSON.parse(row.payload) as ActivityPayload) : undefined,
  };
}

export function isTextOrJsonMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }

  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/javascript" ||
    normalized === "application/xml"
  );
}

export function shouldStoreBodyContent(mimeType: string | undefined, body: string | undefined, base64Encoded?: boolean): boolean {
  if (base64Encoded) {
    return false;
  }

  if (!body) {
    return false;
  }

  if (isTextOrJsonMimeType(mimeType)) {
    return true;
  }

  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return true;
  }

  return false;
}

export function normalizeHeaderMap(headers: Record<string, string> | Array<{ name: string; value: string }> | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map((header) => [header.name, header.value]));
  }

  return { ...headers };
}
