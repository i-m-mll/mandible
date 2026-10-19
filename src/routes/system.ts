import { DOMAIN_EVENTS } from "../contracts.js";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import { tableExists } from "../db-introspection.js";
import { daemonStderrLogPath } from "../daemon-log.js";
import { visibleDaemonLogSource } from "../operational-log-db.js";
import { broadcast } from "../sse.js";
import type { RequestLike, RouteRegistrar } from "../server.js";
import type { WorkScanner } from "../work-scanner.js";
import { queryNumber, queryString, readBody, sendJson } from "./http.js";
import { parseJsonObject } from "../row-coerce.js";


// Log levels ordered from least to most severe for >= filtering.
const LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

type LogEntry = {
  level: string;
  message: string;
  time?: string;
  [key: string]: unknown;
};

type LogFacetValue = {
  value: string;
  count: number;
};

type LogEntityFacetValue = LogFacetValue & {
  type: "issue" | "auth_request" | "artifact" | "session" | "repo";
};

type LogFacets = {
  subsystems: string[];
  events: string[];
  entity_refs: LogEntityFacetValue[];
  latest_ts: string | null;
};

type LogFilters = {
  levels: string[];
  minLevel: string;
  subsystem: string | null;
  event: string | null;
  q: string | null;
  related: string | null;
  sinceMs: number | null;
  untilMs: number | null;
  limit: number;
  offset: number;
  before: LogCursor | null;
};

type LogCursor = { ts: number; id: string };

type SqlClause = { sql: string; params: unknown[] };

const ENTITY_COLUMNS = [
  ["issue", "issue_id"],
  ["auth_request", "auth_request_id"],
  ["artifact", "artifact_id"],
  ["session", "session_id"],
  ["repo", "repo_id"],
] as const satisfies ReadonlyArray<readonly [LogEntityFacetValue["type"], string]>;
const ENTITY_COLUMN_NAMES = ENTITY_COLUMNS.map(([, column]) => column);

type LogWindowRow = { id: string; ts: number; subsystem: string; event: string; hit: number | null }
  & Record<(typeof ENTITY_COLUMNS)[number][1], string | null>;

/** Rows one request may examine: about 20 ms of SQLite work on a warm cache. */
export const LOG_WINDOW_ROWS = 10_000;

const DEFAULT_TAIL_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_TAIL_BYTES = 64 * 1024 * 1024;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Read up to `tailLines` lines from the end of a file without loading the
 * entire file into memory.
 */
export async function tailFile(
  filePath: string,
  tailLines: number,
  options: { chunkBytes?: number; maxBytes?: number } = {},
): Promise<string> {
  const requestedLines = Math.max(0, Math.floor(tailLines));
  if (requestedLines === 0) {
    return "";
  }

  const stat = await fs.promises.stat(filePath);
  if (stat.size === 0) {
    return "";
  }

  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? DEFAULT_TAIL_CHUNK_BYTES));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_TAIL_BYTES));
  const readLimit = Math.min(maxBytes, stat.size);
  const fd = await fs.promises.open(filePath, "r");
  const chunks: Buffer[] = [];
  let position = stat.size;
  let totalBytesRead = 0;
  let newlineCount = 0;

  try {
    while (position > 0 && totalBytesRead < readLimit) {
      const bytesToRead = Math.min(chunkBytes, position, readLimit - totalBytesRead);
      position -= bytesToRead;

      const buf = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await fd.read(buf, 0, bytesToRead, position);
      if (bytesRead === 0) {
        break;
      }

      chunks.unshift(buf.subarray(0, bytesRead));
      totalBytesRead += bytesRead;
      newlineCount += countNewlines(buf, bytesRead);

      if (newlineCount >= requestedLines + (position > 0 ? 1 : 0)) {
        break;
      }
    }

    return completeTailLines(chunks, position > 0).slice(-requestedLines).join("\n");
  } finally {
    await fd.close();
  }
}

function countNewlines(buffer: Buffer, length: number): number {
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 10) {
      count += 1;
    }
  }
  return count;
}

function completeTailLines(chunks: Buffer[], discardPartialFirstLine: boolean): string[] {
  if (chunks.length === 0) {
    return [];
  }

  const lines = Buffer.concat(chunks).toString("utf8").split("\n");
  if (discardPartialFirstLine && lines.length > 0) {
    lines.shift();
  }
  return lines.filter((line: string) => line.trim());
}

export function registerSystemRoutes(server: RouteRegistrar, workScanner: WorkScanner, db?: Db): void {
  // GET /api/system/logs — query daemon_log when available, with stderr file fallback.
  // Query params:
  //   levels = debug,info | warn | error     (exact level multiselect)
  //   level  = debug | info | warn | error   (legacy minimum level fallback; default: info)
  //   subsystem, event, q, related, since, until
  //   limit  = N                              (max entries to return; default 200, max 1000)
  //   offset = N                              (skip newest N results after filtering; default 0)
  // Bug: af91bdd — logs viewer tab
  server.get("/api/system/logs", async (req, res) => {
    const filters = readLogFilters(req);

    if (db && tableExists(db, "daemon_log")) {
      sendJson(res, 200, queryDaemonLog(db, filters));
      return;
    }

    // Tail more than we need since some lines will be filtered out by level.
    const tailCount = (filters.limit + filters.offset) * 4;

    let rawText: string;
    try {
      rawText = await tailFile(daemonStderrLogPath(), tailCount);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        sendJson(res, 200, { entries: [], log_file: daemonStderrLogPath(), exists: false });
        return;
      }
      sendJson(res, 500, { error: `failed to read log file: ${String(err)}` });
      return;
    }

    const entries: LogEntry[] = [];
    const allowedLevels = filters.levels.length > 0
      ? new Set(filters.levels)
      : new Set(levelsAtOrAbove(filters.minLevel));
    for (const line of rawText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: LogEntry;
      try {
        parsed = JSON.parse(trimmed) as LogEntry;
      } catch {
        // Non-JSON line (e.g., startup errors before structured logging kicks in).
        parsed = { level: "info", message: trimmed };
      }

      if (!allowedLevels.has(parsed.level)) {
        continue;
      }
      if (!matchesFallbackFilters(parsed, filters)) {
        continue;
      }
      entries.push(parsed);
    }

    const total = entries.length;
    const pageEnd = Math.max(0, total - filters.offset);
    const pageStart = Math.max(0, pageEnd - filters.limit);
    const page = entries.slice(pageStart, pageEnd);

    sendJson(res, 200, {
      entries: page,
      limit: filters.limit,
      offset: filters.offset,
      log_file: daemonStderrLogPath(),
      exists: true,
      source: "stderr_file",
    });
  }, { operation: { id: "get:/api/system/logs", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // POST /api/admin/rebuilding — broadcast a mandible:rebuilding SSE event to all
  // connected clients, then return 200. Called by the post-merge hook immediately
  // before initiating a daemon restart so the UI can show a full-page splash.
  // Bug: 326a3e2 — rebuilding/restarting splash on self-merge
  server.post("/api/admin/rebuilding", (_req, res) => {
    broadcast(DOMAIN_EVENTS.MANDIBLE_REBUILDING, {});
    sendJson(res, 200, { ok: true });
  }, { operation: { id: "post:/api/admin/rebuilding", effects: ["auth:protected","maintenance:shared"], requestSchema: null, reportingCategory: "system" }, fileRpc: "deny" });

  server.post("/api/system/open-path", globalCapabilityRoute("open_path", (req, res) => {
    const body = readBody<{ path?: string }>(req);
    if (!body || typeof body.path !== "string" || !body.path.trim()) {
      sendJson(res, 400, { error: "missing or invalid path" });
      return;
    }

    const requestedPath = body.path.trim();

    // Resolve to real path to prevent symlink escapes
    let realPath: string;
    try {
      realPath = fs.realpathSync(requestedPath);
    } catch {
      sendJson(res, 404, { error: "path not found" });
      return;
    }

    // Verify the path is under a known repo root
    const repos = workScanner.getRepos();
    const knownRoots = repos.map((repo) => {
      try {
        return fs.realpathSync(repo.root);
      } catch {
        return repo.root;
      }
    });

    const isUnderKnownRoot = knownRoots.some((root) => {
      const normalizedReal = path.normalize(realPath);
      const normalizedRoot = path.normalize(root);
      return normalizedReal === normalizedRoot || normalizedReal.startsWith(normalizedRoot + path.sep);
    });

    if (!isUnderKnownRoot) {
      sendJson(res, 403, { error: "path is not under a known repo root" });
      return;
    }

    // Open in Finder (macOS)
    exec(`open ${shellQuote(realPath)}`, (error) => {
      if (error) {
        sendJson(res, 500, { error: `failed to open path: ${error.message}` });
        return;
      }
      sendJson(res, 200, { ok: true });
    });
  }), { operation: { id: "post:/api/system/open-path", effects: ["process:external"], requestSchema: null, reportingCategory: "system" }, fileRpc: "deny" });
}

/**
 * Reads at most LOG_WINDOW_ROWS candidates from one index-backed access path,
 * so a request's synchronous cost is bounded by the window, not the table.
 * Remaining filters and the facets are evaluated inside the window; a full
 * window hands its boundary to the client as the older cursor.
 */
function queryDaemonLog(db: Db, filters: LogFilters): {
  entries: LogEntry[];
  limit: number;
  offset: number;
  log_file: string;
  exists: boolean;
  source: "daemon_log";
  facets: LogFacets;
  older_cursor: string | null;
  has_older: boolean;
} {
  const source = visibleDaemonLogSource(db);
  const { access, residual } = buildDaemonLogQuery(filters);
  const candidates = db
    .prepare(
      `${source.cte} SELECT id, ts, subsystem, event, ${ENTITY_COLUMN_NAMES.join(", ")}, ${residual.sql} AS hit
       FROM ${source.table}
       WHERE ${access.sql}
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
    )
    .all(...residual.params, ...access.params, LOG_WINDOW_ROWS) as LogWindowRow[];
  const matches = candidates.filter((row) => row.hit);
  const pageEnd = filters.offset + filters.limit;
  const page = matches.slice(filters.offset, pageEnd);
  const boundary = matches.length > pageEnd
    ? page.at(-1)
    : candidates.length === LOG_WINDOW_ROWS ? candidates.at(-1) : undefined;
  const rows = page.length === 0 ? [] : db
    .prepare(
      `${source.cte} SELECT * FROM ${source.table}
       WHERE id IN (${page.map(() => "?").join(", ")})
       ORDER BY ts ASC, id ASC`,
    )
    .all(...page.map((row) => row.id)) as Array<{
      id: string;
      ts: number;
      level: string;
      event: string;
      subsystem: string;
      fields_json: string;
      issue_id: string | null;
      auth_request_id: string | null;
      artifact_id: string | null;
      session_id: string | null;
      repo_id: string | null;
    }>;
  const entries = rows.map((row) => {
    const fields = parseJsonObject(row.fields_json);
    return {
      ...fields,
      id: row.id,
      level: row.level,
      message: row.event,
      event: row.event,
      subsystem: row.subsystem,
      time: new Date(row.ts).toISOString(),
      issue_id: row.issue_id,
      auth_request_id: row.auth_request_id,
      artifact_id: row.artifact_id,
      session_id: row.session_id,
      repo_id: row.repo_id,
    };
  });
  return {
    entries,
    limit: filters.limit,
    offset: filters.offset,
    log_file: daemonStderrLogPath(),
    exists: true,
    source: "daemon_log",
    facets: logFacets(db, matches),
    older_cursor: boundary ? encodeLogCursor(boundary) : null,
    has_older: boundary !== undefined,
  };
}

function readLogFilters(req: RequestLike): LogFilters {
  const rawLevel = queryString(req, "level") ?? "info";
  return {
    levels: normalizeLevels(queryString(req, "levels")),
    minLevel: LEVEL_ORDER[rawLevel] === undefined ? "info" : rawLevel,
    subsystem: trimmedQuery(req, "subsystem"),
    event: trimmedQuery(req, "event"),
    q: trimmedQuery(req, "q") ?? trimmedQuery(req, "search"),
    related: trimmedQuery(req, "related") ?? trimmedQuery(req, "entity"),
    sinceMs: parseLogTimestamp(trimmedQuery(req, "since")),
    untilMs: parseLogTimestamp(trimmedQuery(req, "until")),
    limit: queryNumber(req, "limit", { defaultValue: 200, min: 1, max: 1000 }),
    offset: queryNumber(req, "offset", { defaultValue: 0, min: 0 }),
    before: decodeLogCursor(trimmedQuery(req, "before")),
  };
}

function encodeLogCursor(value: LogCursor): string {
  return Buffer.from(JSON.stringify({ ts: value.ts, id: value.id }), "utf8").toString("base64url");
}

function decodeLogCursor(raw: string | null): LogCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<LogCursor>;
    return Number.isFinite(parsed.ts) && typeof parsed.id === "string" && parsed.id
      ? { ts: Number(parsed.ts), id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function trimmedQuery(req: RequestLike, key: string): string | null {
  const value = queryString(req, key)?.trim();
  return value ? value : null;
}

function normalizeLevels(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const level = part.trim().toLowerCase();
    if (LEVEL_ORDER[level] !== undefined) {
      seen.add(level);
    }
  }
  return [...seen];
}

function levelsAtOrAbove(rawLevel: string): string[] {
  const minLevelIndex = LEVEL_ORDER[rawLevel] ?? LEVEL_ORDER.info;
  return Object.entries(LEVEL_ORDER)
    .filter(([, index]) => index >= minLevelIndex)
    .map(([level]) => level);
}

function parseLogTimestamp(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The first keyed filter (related, then event, then subsystem) plus the time
 * range is the access path; every key has a `(key, ts DESC)` index, so the
 * window walks only matching rows. Other filters stay residual.
 */
function buildDaemonLogQuery(filters: LogFilters): { access: SqlClause; residual: SqlClause } {
  const keyed: SqlClause[] = [];
  if (filters.related) {
    const related = parseRelatedFilter(filters.related);
    const columns = related.type ? [related.column] : ENTITY_COLUMN_NAMES;
    keyed.push(anyColumn(columns, "= ?", related.value));
  }
  if (filters.event) keyed.push({ sql: "event = ?", params: [filters.event] });
  if (filters.subsystem) keyed.push({ sql: "subsystem = ?", params: [filters.subsystem] });
  const [keyedAccess, ...keyedResidual] = keyed;

  const access = keyedAccess ? [keyedAccess] : [];
  if (filters.sinceMs !== null) access.push({ sql: "ts >= ?", params: [filters.sinceMs] });
  if (filters.untilMs !== null) access.push({ sql: "ts <= ?", params: [filters.untilMs] });
  if (filters.before) {
    const { ts, id } = filters.before;
    access.push({ sql: "ts <= ? AND (ts < ? OR id < ?)", params: [ts, ts, id] });
  }

  const levels = filters.levels.length > 0 ? filters.levels : levelsAtOrAbove(filters.minLevel);
  const residual = [{ sql: `level IN (${levels.map(() => "?").join(", ")})`, params: levels }, ...keyedResidual];
  if (filters.q) {
    const columns = ["event", "subsystem", "fields_json", ...ENTITY_COLUMN_NAMES];
    residual.push(anyColumn(columns, "LIKE ? ESCAPE '\\'", `%${escapeLike(filters.q)}%`));
  }
  return { access: conjunction(access), residual: conjunction(residual) };
}

function anyColumn(columns: readonly string[], predicate: string, value: unknown): SqlClause {
  return {
    sql: `(${columns.map((column) => `${column} ${predicate}`).join(" OR ")})`,
    params: columns.map(() => value),
  };
}

function conjunction(clauses: SqlClause[]): SqlClause {
  return {
    sql: clauses.length > 0 ? clauses.map((clause) => clause.sql).join(" AND ") : "1",
    params: clauses.flatMap((clause) => clause.params),
  };
}

function logFacets(db: Db, matches: LogWindowRow[]): LogFacets {
  const entityRefs = ENTITY_COLUMNS.flatMap(([type, column]) =>
    topValues(matches.map((row) => row[column]), 20).map((facet) => ({ type, ...facet })));
  return {
    subsystems: distinctValues(db, "subsystem"),
    events: distinctValues(db, "event"),
    entity_refs: entityRefs
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type) || a.value.localeCompare(b.value))
      .slice(0, 80),
    latest_ts: matches.length > 0 ? new Date(matches[0].ts).toISOString() : null,
  };
}

/** Every distinct value by skip-scan: one `(column, ts)` index seek per value. */
function distinctValues(db: Db, column: "subsystem" | "event"): string[] {
  return (db
    .prepare(
      `WITH found(value) AS (
         SELECT MIN(${column}) FROM daemon_log
         UNION ALL
         SELECT (SELECT MIN(${column}) FROM daemon_log WHERE ${column} > value) FROM found
         WHERE value IS NOT NULL LIMIT 500
       ) SELECT value FROM found WHERE value IS NOT NULL`,
    )
    .all() as Array<{ value: string }>).map((row) => row.value);
}

function topValues(values: Array<string | null>, limit: number): LogFacetValue[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
    .slice(0, limit);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function parseRelatedFilter(raw: string): {
  type: LogEntityFacetValue["type"] | null;
  column: string;
  value: string;
} {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith("issue:")) {
    return { type: "issue", column: "issue_id", value: value.slice("issue:".length) };
  }
  if (lower.startsWith("auth_request:") || lower.startsWith("auth:")) {
    return { type: "auth_request", column: "auth_request_id", value: value.replace(/^auth(?:_request)?:/i, "") };
  }
  if (lower.startsWith("artifact:") || lower.startsWith("artifact-version:") || lower.startsWith("artifact-blob:")) {
    return { type: "artifact", column: "artifact_id", value };
  }
  if (lower.startsWith("session:")) {
    return { type: "session", column: "session_id", value: value.slice("session:".length) };
  }
  if (lower.startsWith("repo:")) {
    return { type: "repo", column: "repo_id", value: value.slice("repo:".length) };
  }
  return { type: null, column: "", value };
}

function matchesFallbackFilters(entry: LogEntry, filters: LogFilters): boolean {
  if (filters.subsystem && entry.subsystem !== filters.subsystem) {
    return false;
  }
  if (filters.event && entry.event !== filters.event && entry.message !== filters.event) {
    return false;
  }
  const time = parseLogTimestamp(typeof entry.time === "string" ? entry.time : null);
  if (filters.sinceMs !== null && time !== null && time < filters.sinceMs) {
    return false;
  }
  if (filters.untilMs !== null && time !== null && time > filters.untilMs) {
    return false;
  }
  if (filters.related) {
    const related = parseRelatedFilter(filters.related);
    const candidates = [
      entry.issue_id,
      entry.auth_request_id,
      entry.artifact_id,
      entry.session_id,
      entry.repo_id,
    ];
    if (!candidates.includes(related.value)) {
      return false;
    }
  }
  if (filters.q) {
    const haystack = JSON.stringify(entry).toLowerCase();
    if (!haystack.includes(filters.q.toLowerCase())) {
      return false;
    }
  }
  return true;
}

