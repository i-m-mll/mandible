import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../db.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import { tableExists } from "../db-introspection.js";
import { broadcast } from "../sse.js";
import type { RequestLike, RouteRegistrar } from "../server.js";
import type { WorkScanner } from "../work-scanner.js";
import { queryNumber, queryString, readBody, sendJson } from "./http.js";

const LOG_FILE_PATH = path.join(os.homedir(), ".cache", "mandible", "launchd-stderr.log");

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
  levels: LogFacetValue[];
  subsystems: LogFacetValue[];
  events: LogFacetValue[];
  entity_refs: LogEntityFacetValue[];
  latest_ts: string | null;
  latest_heartbeat_ts: string | null;
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
};

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
      rawText = await tailFile(LOG_FILE_PATH, tailCount);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        sendJson(res, 200, { entries: [], total: 0, log_file: LOG_FILE_PATH, exists: false });
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
      total,
      limit: filters.limit,
      offset: filters.offset,
      log_file: LOG_FILE_PATH,
      exists: true,
      source: "stderr_file",
    });
  }, { fileRpc: "allow" });

  // POST /api/admin/rebuilding — broadcast a mandible:rebuilding SSE event to all
  // connected clients, then return 200. Called by the post-merge hook immediately
  // before initiating a daemon restart so the UI can show a full-page splash.
  // Bug: 326a3e2 — rebuilding/restarting splash on self-merge
  server.post("/api/admin/rebuilding", (_req, res) => {
    broadcast("mandible:rebuilding", {});
    sendJson(res, 200, { ok: true });
  }, { fileRpc: "deny" });

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
  }), { fileRpc: "deny" });
}

function queryDaemonLog(db: Db, filters: LogFilters): {
  entries: LogEntry[];
  total: number;
  limit: number;
  offset: number;
  log_file: string;
  exists: boolean;
  source: "daemon_log";
  facets: LogFacets;
} {
  const where = buildDaemonLogWhere(filters);
  const total = Number((db
    .prepare(`SELECT COUNT(*) AS count FROM daemon_log ${where.sql}`)
    .get(...where.params) as { count?: number } | undefined)?.count ?? 0);
  const rows = db
    .prepare(
      `SELECT *
       FROM daemon_log
       ${where.sql}
       ORDER BY ts DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.params, filters.limit, filters.offset) as Array<{
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
  const entries = rows.reverse().map((row) => {
    const fields = parseFields(row.fields_json);
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
    total,
    limit: filters.limit,
    offset: filters.offset,
    log_file: LOG_FILE_PATH,
    exists: true,
    source: "daemon_log",
    facets: queryDaemonLogFacets(db, where),
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
  };
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

function buildDaemonLogWhere(filters: LogFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const allowedLevels = filters.levels.length > 0 ? filters.levels : levelsAtOrAbove(filters.minLevel);
  clauses.push(`level IN (${allowedLevels.map(() => "?").join(", ")})`);
  params.push(...allowedLevels);

  if (filters.subsystem) {
    clauses.push("subsystem = ?");
    params.push(filters.subsystem);
  }
  if (filters.event) {
    clauses.push("event = ?");
    params.push(filters.event);
  }
  if (filters.sinceMs !== null) {
    clauses.push("ts >= ?");
    params.push(filters.sinceMs);
  }
  if (filters.untilMs !== null) {
    clauses.push("ts <= ?");
    params.push(filters.untilMs);
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    clauses.push(
      `(event LIKE ? ESCAPE '\\' OR subsystem LIKE ? ESCAPE '\\' OR fields_json LIKE ? ESCAPE '\\'
        OR issue_id LIKE ? ESCAPE '\\' OR auth_request_id LIKE ? ESCAPE '\\'
        OR artifact_id LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\' OR repo_id LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (filters.related) {
    const related = parseRelatedFilter(filters.related);
    if (related.type) {
      clauses.push(`${related.column} = ?`);
      params.push(related.value);
    } else {
      clauses.push(
        "(issue_id = ? OR auth_request_id = ? OR artifact_id = ? OR session_id = ? OR repo_id = ?)",
      );
      params.push(related.value, related.value, related.value, related.value, related.value);
    }
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function queryDaemonLogFacets(
  db: Db,
  where: { sql: string; params: unknown[] },
): LogFacets {
  return {
    levels: queryFacet(db, "level", where, 10),
    subsystems: queryFacet(db, "subsystem", where, 50),
    events: queryFacet(db, "event", where, 80),
    entity_refs: queryEntityFacets(db, where),
    latest_ts: isoFromMs(queryMaxTs(db, where.sql, where.params)),
    latest_heartbeat_ts: isoFromMs(queryMaxTs(
      db,
      `${where.sql ? `${where.sql} AND` : "WHERE"} level = 'debug'
        AND (event LIKE '%tick%' OR event LIKE '%heartbeat%' OR event LIKE '%reconcile%' OR event LIKE '%reaper%')`,
      where.params,
    )),
  };
}

function queryFacet(
  db: Db,
  column: "level" | "subsystem" | "event",
  where: { sql: string; params: unknown[] },
  limit: number,
): LogFacetValue[] {
  return (db
    .prepare(
      `SELECT ${column} AS value, COUNT(*) AS count
       FROM daemon_log
       ${where.sql}
       GROUP BY ${column}
       ORDER BY count DESC, ${column} ASC
       LIMIT ?`,
    )
    .all(...where.params, limit) as Array<{ value: string; count: number }>).map((row) => ({
      value: row.value,
      count: Number(row.count),
    }));
}

function queryEntityFacets(
  db: Db,
  where: { sql: string; params: unknown[] },
): LogEntityFacetValue[] {
  const specs: Array<{ type: LogEntityFacetValue["type"]; column: string }> = [
    { type: "issue", column: "issue_id" },
    { type: "auth_request", column: "auth_request_id" },
    { type: "artifact", column: "artifact_id" },
    { type: "session", column: "session_id" },
    { type: "repo", column: "repo_id" },
  ];
  const values: LogEntityFacetValue[] = [];
  for (const spec of specs) {
    const rows = db
      .prepare(
        `SELECT ${spec.column} AS value, COUNT(*) AS count
         FROM daemon_log
         ${where.sql ? `${where.sql} AND` : "WHERE"} ${spec.column} IS NOT NULL AND ${spec.column} != ''
         GROUP BY ${spec.column}
         ORDER BY count DESC, ${spec.column} ASC
         LIMIT 20`,
      )
      .all(...where.params) as Array<{ value: string; count: number }>;
    values.push(...rows.map((row) => ({
      type: spec.type,
      value: row.value,
      count: Number(row.count),
    })));
  }
  return values.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type) || a.value.localeCompare(b.value)).slice(0, 80);
}

function queryMaxTs(db: Db, whereSql: string, params: unknown[]): number | null {
  const row = db
    .prepare(`SELECT MAX(ts) AS ts FROM daemon_log ${whereSql}`)
    .get(...params) as { ts?: number | null } | undefined;
  return typeof row?.ts === "number" ? row.ts : null;
}

function isoFromMs(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
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

function parseFields(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
