import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Db } from "./db.js";
import type { Logger, LogLevel } from "./types.js";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const DEFAULT_LOG_FILE_PATH = path.join(os.homedir(), ".cache", "mandible", "launchd-stderr.log");
const DEFAULT_STDERR_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_STDERR_KEEP_SEGMENTS = 5;

type InsertStatement = Database.Statement<[
  string,
  number,
  LogLevel,
  string,
  string,
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
]>;

export interface StderrRotationConfig {
  filePath?: string;
  maxBytes?: number;
  keepSegments?: number;
}

interface ExtractedRefs {
  issue_id: string | null;
  auth_request_id: string | null;
  artifact_id: string | null;
  session_id: string | null;
  repo_id: string | null;
}

class DaemonLogger {
  private db: Db | null = null;
  private insert: InsertStatement | null = null;
  private readonly stderrMinIndex: number;
  private stderrRotation: Required<StderrRotationConfig>;
  private reportedDbFailure = false;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const level = normalizeLevel(env.LOG_LEVEL) ?? "info";
    this.stderrMinIndex = LEVELS.indexOf(level);
    this.stderrRotation = {
      filePath: env.MANDIBLE_STDERR_LOG_PATH || DEFAULT_LOG_FILE_PATH,
      maxBytes: parsePositiveInteger(env.MANDIBLE_STDERR_ROTATION_MAX_BYTES, DEFAULT_STDERR_MAX_BYTES),
      keepSegments: parsePositiveInteger(env.MANDIBLE_STDERR_ROTATION_KEEP_SEGMENTS, DEFAULT_STDERR_KEEP_SEGMENTS),
    };
  }

  configure(db: Db): void {
    this.db = db;
    this.insert = db.prepare(
      `INSERT INTO daemon_log (
        id, ts, level, event, subsystem, fields_json,
        issue_id, auth_request_id, artifact_id, session_id, repo_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ) as InsertStatement;
    this.stderrRotation = {
      ...this.stderrRotation,
      filePath: process.env.MANDIBLE_STDERR_LOG_PATH || this.stderrRotation.filePath,
      ...readRotationSettings(db),
    };
    rotateStderrLogSegments(this.stderrRotation);
  }

  log: Logger = (level, event, fields = {}) => {
    const normalizedLevel = normalizeLevel(level) ?? "info";
    const ts = Date.now();
    const subsystem = stringField(fields.subsystem) ?? "daemon";
    const refs = extractRefs(fields);
    const fieldsJson = safeJson(fields);

    if (this.insert) {
      try {
        this.insert.run(
          randomUUID(),
          ts,
          normalizedLevel,
          event,
          subsystem,
          fieldsJson,
          refs.issue_id,
          refs.auth_request_id,
          refs.artifact_id,
          refs.session_id,
          refs.repo_id,
        );
      } catch (error) {
        this.reportDbFailure(error);
      }
    }

    this.writeStderrMirror(normalizedLevel, event, fields, ts);
  };

  private writeStderrMirror(level: LogLevel, event: string, fields: Record<string, unknown>, ts: number): void {
    if (LEVELS.indexOf(level) < this.stderrMinIndex) {
      return;
    }
    rotateStderrLogSegments(this.stderrRotation);
    const payload = {
      level,
      message: event,
      event,
      time: new Date(ts).toISOString(),
      ...fields,
    };
    process.stderr.write(`${safeJson(payload)}\n`);
  }

  private reportDbFailure(error: unknown): void {
    if (this.reportedDbFailure) {
      return;
    }
    this.reportedDbFailure = true;
    const payload = {
      level: "error",
      message: "daemon_log_write_failed",
      event: "daemon_log_write_failed",
      time: new Date().toISOString(),
      error: String(error),
    };
    process.stderr.write(`${safeJson(payload)}\n`);
  }
}

const singleton = new DaemonLogger();

export function getDaemonLogger(): Logger {
  return singleton.log;
}

export function configureDaemonLogger(db: Db): Logger {
  singleton.configure(db);
  return singleton.log;
}

export function rotateStderrLogSegments(config: StderrRotationConfig = {}): void {
  const filePath = config.filePath ?? DEFAULT_LOG_FILE_PATH;
  const maxBytes = Math.max(1, Math.floor(config.maxBytes ?? DEFAULT_STDERR_MAX_BYTES));
  const keepSegments = Math.max(0, Math.floor(config.keepSegments ?? DEFAULT_STDERR_KEEP_SEGMENTS));

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  if (stat.size < maxBytes) {
    return;
  }

  if (keepSegments === 0) {
    fs.rmSync(filePath, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  for (let index = keepSegments; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const target = `${filePath}.${index}`;
    if (!fs.existsSync(source)) {
      continue;
    }
    if (index === keepSegments) {
      fs.rmSync(target, { force: true });
    }
    fs.renameSync(source, target);
  }
}

function readRotationSettings(db: Db): Required<Pick<StderrRotationConfig, "maxBytes" | "keepSegments">> {
  try {
    const rows = db
      .prepare("SELECT key, value FROM settings WHERE key IN ('stderr_rotation_max_bytes', 'stderr_rotation_keep_segments')")
      .all() as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      maxBytes: parsePositiveInteger(values.get("stderr_rotation_max_bytes"), DEFAULT_STDERR_MAX_BYTES),
      keepSegments: parsePositiveInteger(values.get("stderr_rotation_keep_segments"), DEFAULT_STDERR_KEEP_SEGMENTS),
    };
  } catch {
    return {
      maxBytes: DEFAULT_STDERR_MAX_BYTES,
      keepSegments: DEFAULT_STDERR_KEEP_SEGMENTS,
    };
  }
}

function extractRefs(fields: Record<string, unknown>): ExtractedRefs {
  const pathname = stringField(fields.pathname) ?? stringField(fields.path) ?? "";
  return {
    issue_id:
      stringField(fields.issue_id)
      ?? stringField(fields.issueId)
      ?? matchPath(pathname, /^\/api\/ledger\/issues\/([^/?#]+)/)
      ?? matchPath(pathname, /^\/api\/issues\/([^/?#]+)/),
    auth_request_id:
      stringField(fields.auth_request_id)
      ?? stringField(fields.authRequestId)
      ?? matchPath(pathname, /^\/api\/auth\/request\/([^/?#]+)/),
    artifact_id: stringField(fields.artifact_id) ?? stringField(fields.artifactId),
    session_id:
      stringField(fields.session_id)
      ?? stringField(fields.sessionId)
      ?? matchPath(pathname, /^\/api\/sessions\/([^/?#]+)/),
    repo_id: stringField(fields.repo_id) ?? stringField(fields.repoId),
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function matchPath(pathname: string, pattern: RegExp): string | null {
  const match = pathname.match(pattern);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function normalizeLevel(value: unknown): LogLevel | null {
  return typeof value === "string" && LEVELS.includes(value as LogLevel)
    ? value as LogLevel
    : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "json_stringify_failed" });
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
