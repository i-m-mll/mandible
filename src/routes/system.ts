import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../db.js";
import { broadcast } from "../sse.js";
import type { RouteRegistrar } from "../server.js";
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
  // GET /api/system/logs — tail the structured NDJSON daemon log.
  // Query params:
  //   level  = debug | info | warn | error  (minimum level to include; default: info)
  //   limit  = N                             (max entries to return; default 200, max 1000)
  //   offset = N                             (skip first N results after filtering; default 0)
  // Bug: af91bdd — logs viewer tab
  server.get("/api/system/logs", async (req, res) => {
    const rawLevel = queryString(req, "level") ?? "info";

    const minLevelIndex = LEVEL_ORDER[rawLevel] ?? LEVEL_ORDER.info;
    const limit = queryNumber(req, "limit", { defaultValue: 200, min: 1, max: 1000 });
    const offset = queryNumber(req, "offset", { defaultValue: 0, min: 0 });

    if (db && tableExists(db, "daemon_log")) {
      sendJson(res, 200, queryDaemonLog(db, rawLevel, limit, offset));
      return;
    }

    // Tail more than we need since some lines will be filtered out by level.
    const tailCount = (limit + offset) * 4;

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

      const levelIndex = LEVEL_ORDER[parsed.level] ?? LEVEL_ORDER.info;
      if (levelIndex < minLevelIndex) {
        continue;
      }
      entries.push(parsed);
    }

    const total = entries.length;
    const pageEnd = Math.max(0, total - offset);
    const pageStart = Math.max(0, pageEnd - limit);
    const page = entries.slice(pageStart, pageEnd);

    sendJson(res, 200, {
      entries: page,
      total,
      limit,
      offset,
      log_file: LOG_FILE_PATH,
      exists: true,
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

  server.post("/api/system/open-path", (req, res) => {
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
  }, { fileRpc: "deny" });
}

function queryDaemonLog(db: Db, rawLevel: string, limit: number, offset: number): {
  entries: LogEntry[];
  total: number;
  limit: number;
  offset: number;
  log_file: string;
  exists: boolean;
  source: "daemon_log";
} {
  const minLevelIndex = LEVEL_ORDER[rawLevel] ?? LEVEL_ORDER.info;
  const allowedLevels = Object.entries(LEVEL_ORDER)
    .filter(([, index]) => index >= minLevelIndex)
    .map(([level]) => level);
  const placeholders = allowedLevels.map(() => "?").join(", ");
  const total = Number((db
    .prepare(`SELECT COUNT(*) AS count FROM daemon_log WHERE level IN (${placeholders})`)
    .get(...allowedLevels) as { count?: number } | undefined)?.count ?? 0);
  const rows = db
    .prepare(
      `SELECT *
       FROM daemon_log
       WHERE level IN (${placeholders})
       ORDER BY ts DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...allowedLevels, limit, offset) as Array<{
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
    limit,
    offset,
    log_file: LOG_FILE_PATH,
    exists: true,
    source: "daemon_log",
  };
}

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
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
