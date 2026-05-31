import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Read up to `tailLines` lines from the end of a file without loading the
 * entire file into memory.
 */
async function tailFile(filePath: string, tailLines: number): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size === 0) {
    return "";
  }

  // Read the last chunk. Each NDJSON line is typically 100–500 bytes; use a
  // generous estimate of 2 KB per line to cover verbose entries.
  const chunkSize = Math.min(tailLines * 2048, stat.size);
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(chunkSize);
    const { bytesRead } = await fd.read(buf, 0, chunkSize, stat.size - chunkSize);
    const text = buf.slice(0, bytesRead).toString("utf8");

    const lines = text.split("\n");
    if (stat.size > chunkSize && lines.length > 0) {
      lines.shift(); // discard potentially-partial first line
    }
    const nonEmpty = lines.filter((l: string) => l.trim());

    if (nonEmpty.length >= tailLines) {
      return nonEmpty.slice(-tailLines).join("\n");
    }

    // Not enough lines in the chunk — read a larger slice from the end,
    // but cap at 8 MB to avoid reading enormous log files into memory.
    const FALLBACK_CAP = 8 * 1024 * 1024; // 8 MB
    const fallbackSize = Math.min(FALLBACK_CAP, stat.size);
    const fd2 = await fs.promises.open(filePath, "r");
    try {
      const buf2 = Buffer.alloc(fallbackSize);
      const { bytesRead: bytesRead2 } = await fd2.read(buf2, 0, fallbackSize, stat.size - fallbackSize);
      const text2 = buf2.slice(0, bytesRead2).toString("utf8");
      const lines2 = text2.split("\n");
      if (stat.size > fallbackSize && lines2.length > 0) {
        lines2.shift(); // discard potentially-partial first line
      }
      return lines2
        .filter((l: string) => l.trim())
        .slice(-tailLines)
        .join("\n");
    } finally {
      await fd2.close();
    }
  } finally {
    await fd.close();
  }
}

export function registerSystemRoutes(server: RouteRegistrar, workScanner: WorkScanner): void {
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
    const page = entries.slice(offset, offset + limit);

    sendJson(res, 200, {
      entries: page,
      total,
      limit,
      offset,
      log_file: LOG_FILE_PATH,
      exists: true,
    });
  });

  // POST /api/admin/rebuilding — broadcast a mandible:rebuilding SSE event to all
  // connected clients, then return 200. Called by the post-merge hook immediately
  // before initiating a daemon restart so the UI can show a full-page splash.
  // Bug: 326a3e2 — rebuilding/restarting splash on self-merge
  server.post("/api/admin/rebuilding", (_req, res) => {
    broadcast("mandible:rebuilding", {});
    sendJson(res, 200, { ok: true });
  });

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
  });
}
