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
const PERSIST_MIN_INDEX = LEVELS.indexOf("info");
const DEFAULT_LOG_RETENTION_DAYS = 7;
const MAX_LOG_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_BATCH_SIZE = 1_000;
const DEFAULT_RETENTION_MAX_BATCHES = 4;
const DEFAULT_RETENTION_YIELD_MS = 25;
const DEFAULT_RETENTION_INITIAL_DELAY_MS = 10_000;
const DEFAULT_RETENTION_CATCH_UP_DELAY_MS = 250;
const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

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

export interface DaemonLogRetentionOptions {
  now?: number;
  batchSize?: number;
  maxBatches?: number;
  yieldMs?: number;
}

export interface DaemonLogRetentionResult {
  retentionDays: number;
  cutoff: number;
  deleted: number;
  batches: number;
  hasMore: boolean;
}

export interface DaemonLogRetentionSchedulerOptions extends DaemonLogRetentionOptions {
  initialDelayMs?: number;
  catchUpDelayMs?: number;
  intervalMs?: number;
}

export interface DaemonLogMaintenanceOptions {
  checkpoint?: boolean;
  vacuum?: boolean;
  allowBlockingVacuum?: boolean;
}

export interface DaemonLogMaintenanceResult {
  checkpoint: Array<Record<string, unknown>> | null;
  vacuumed: boolean;
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

    if (this.insert && LEVELS.indexOf(normalizedLevel) >= PERSIST_MIN_INDEX) {
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

/**
 * Delete expired persisted daemon logs in small batches, yielding between
 * batches. Each call is bounded; callers can resume while `hasMore` is true.
 */
export async function pruneDaemonLogs(
  db: Db,
  options: DaemonLogRetentionOptions = {},
): Promise<DaemonLogRetentionResult> {
  const retentionDays = readRetentionDays(db);
  const now = Number.isFinite(options.now) ? Math.floor(options.now as number) : Date.now();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
  const batchSize = parseBoundedInteger(options.batchSize, DEFAULT_RETENTION_BATCH_SIZE, 1, 10_000);
  const maxBatches = parseBoundedInteger(options.maxBatches, DEFAULT_RETENTION_MAX_BATCHES, 1, 100);
  const yieldMs = parseBoundedInteger(options.yieldMs, DEFAULT_RETENTION_YIELD_MS, 0, 10_000);
  const removeBatch = db.prepare(
    `DELETE FROM daemon_log
     WHERE id IN (
       SELECT id FROM daemon_log
       WHERE ts < ?
       ORDER BY ts ASC
       LIMIT ?
     )`,
  );

  let deleted = 0;
  let batches = 0;
  for (let index = 0; index < maxBatches; index += 1) {
    const result = removeBatch.run(cutoff, batchSize);
    deleted += result.changes;
    batches += 1;
    if (result.changes < batchSize) {
      break;
    }
    if (index + 1 < maxBatches) {
      await delay(yieldMs);
    }
  }

  const hasMore = Boolean(db
    .prepare("SELECT 1 FROM daemon_log WHERE ts < ? LIMIT 1")
    .get(cutoff));
  return { retentionDays, cutoff, deleted, batches, hasMore };
}

/**
 * Pace bounded retention passes in the background. Catch-up work is scheduled
 * as separate timer turns so a large backlog cannot monopolize startup or the
 * event loop.
 */
export function startDaemonLogRetention(
  db: Db,
  logger: Logger,
  options: DaemonLogRetentionSchedulerOptions = {},
): { stop: () => void } {
  const initialDelayMs = parseBoundedInteger(
    options.initialDelayMs,
    DEFAULT_RETENTION_INITIAL_DELAY_MS,
    0,
    DEFAULT_RETENTION_INTERVAL_MS,
  );
  const catchUpDelayMs = parseBoundedInteger(
    options.catchUpDelayMs,
    DEFAULT_RETENTION_CATCH_UP_DELAY_MS,
    0,
    DEFAULT_RETENTION_INTERVAL_MS,
  );
  const intervalMs = parseBoundedInteger(
    options.intervalMs,
    DEFAULT_RETENTION_INTERVAL_MS,
    1_000,
    7 * 24 * 60 * 60 * 1_000,
  );
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void run();
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  };
  const run = async (): Promise<void> => {
    try {
      // One batch per scheduled turn is the scheduler default. Explicit
      // pruneDaemonLogs callers may request multiple cooperatively-yielding
      // batches, but background catch-up always returns to the timer queue.
      const result = await pruneDaemonLogs(db, {
        ...options,
        maxBatches: options.maxBatches ?? 1,
      });
      if (result.deleted > 0) {
        logger("info", "daemon_log_retention", {
          deleted: result.deleted,
          retention_days: result.retentionDays,
          cutoff: result.cutoff,
          has_more: result.hasMore,
        });
      }
      schedule(result.hasMore ? catchUpDelayMs : intervalMs);
    } catch (error) {
      logger("warn", "daemon_log_retention_failed", { error: String(error) });
      schedule(intervalMs);
    }
  };

  schedule(initialDelayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Explicit operator maintenance for reclaiming disk space after pruning.
 * Checkpoint truncation is safe to request directly. VACUUM is blocking and
 * must be separately acknowledged; it is never invoked by startup retention.
 */
export function runDaemonLogMaintenance(
  db: Db,
  options: DaemonLogMaintenanceOptions = {},
): DaemonLogMaintenanceResult {
  if (options.vacuum && options.allowBlockingVacuum !== true) {
    throw new Error("VACUUM is blocking; set allowBlockingVacuum to run it explicitly");
  }
  const checkpoint = options.checkpoint === false
    ? null
    : db.pragma("wal_checkpoint(TRUNCATE)") as Array<Record<string, unknown>>;
  if (options.vacuum) {
    db.exec("VACUUM");
  }
  return { checkpoint, vacuumed: options.vacuum === true };
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

function readRetentionDays(db: Db): number {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'log_retention_days'")
      .get() as { value?: string } | undefined;
    return parseBoundedInteger(row?.value, DEFAULT_LOG_RETENTION_DAYS, 1, MAX_LOG_RETENTION_DAYS);
  } catch {
    return DEFAULT_LOG_RETENTION_DAYS;
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

function parseBoundedInteger(
  value: string | number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? Math.floor(parsed)
    : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
