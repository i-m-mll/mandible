import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SqliteStatement } from "./sqlite.js";
import type { Db } from "./db.js";
import type { Logger, LogLevel } from "./types.js";
import { hasCurrentOperationalLogVerification } from "./operational-log-verification.js";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const DEFAULT_LOG_FILE_PATH = path.join(os.homedir(), ".cache", "mandible", "launchd-stderr.log");
const DEFAULT_STDERR_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_STDERR_KEEP_SEGMENTS = 5;
const PERSIST_MIN_INDEX = LEVELS.indexOf("info");
// Persisted rows are queued in memory and flushed as one bounded transaction on
// a short timer instead of running a synchronous INSERT (11 columns, up to 8
// index updates) on every request turn. This keeps the write off the request
// path and coalesces WAL fsyncs that otherwise contend with the ingestion
// worker under the 250 ms busy_timeout. Issue: 0d81726.
const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_MAX_QUEUE = 1_000;
// Rotation of the stderr mirror file used to run a statSync on every log line.
// It now runs on its own timer so the request path never touches the filesystem
// for a size check.
const DEFAULT_ROTATION_CHECK_MS = 5_000;
const DEFAULT_LOG_RETENTION_DAYS = 7;
const MAX_LOG_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_BATCH_SIZE = 1_000;
const DEFAULT_RETENTION_MAX_BATCHES = 4;
const DEFAULT_RETENTION_YIELD_MS = 25;
const DEFAULT_RETENTION_INITIAL_DELAY_MS = 10_000;
const DEFAULT_RETENTION_CATCH_UP_DELAY_MS = 250;
const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

type LogInsertParams = [
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
];

type InsertStatement = SqliteStatement<LogInsertParams>;

export interface StderrRotationConfig {
  filePath?: string;
  maxBytes?: number;
  keepSegments?: number;
}

export interface DaemonLoggerConfig {
  persist?: boolean;
  /** Canonical settings remain configuration; persisted rows belong to db. */
  settingsDb?: Db;
}

export interface DaemonLogRetentionOptions {
  now?: number;
  batchSize?: number;
  maxBatches?: number;
  yieldMs?: number;
  /** Read log_retention_days from this DB while pruning only the log DB. */
  settingsDb?: Db;
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
  private insert: InsertStatement | null = null;
  private insertMany: ((rows: LogInsertParams[]) => void) | null = null;
  private readonly stderrMinIndex: number;
  private stderrRotation: Required<StderrRotationConfig>;
  private reportedDbFailure = false;
  private queue: LogInsertParams[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly maxQueue: number;
  private readonly rotationCheckMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const level = normalizeLevel(env.LOG_LEVEL) ?? "info";
    this.stderrMinIndex = LEVELS.indexOf(level);
    this.stderrRotation = {
      filePath: daemonStderrLogPath(env),
      maxBytes: parsePositiveInteger(env.MANDIBLE_STDERR_ROTATION_MAX_BYTES, DEFAULT_STDERR_MAX_BYTES),
      keepSegments: parsePositiveInteger(env.MANDIBLE_STDERR_ROTATION_KEEP_SEGMENTS, DEFAULT_STDERR_KEEP_SEGMENTS),
    };
    this.flushIntervalMs = parsePositiveInteger(env.MANDIBLE_DAEMON_LOG_FLUSH_MS, DEFAULT_FLUSH_INTERVAL_MS);
    this.maxQueue = parsePositiveInteger(env.MANDIBLE_DAEMON_LOG_MAX_QUEUE, DEFAULT_MAX_QUEUE);
    this.rotationCheckMs = parsePositiveInteger(env.MANDIBLE_STDERR_ROTATION_CHECK_MS, DEFAULT_ROTATION_CHECK_MS);
  }

  configure(db: Db, config: DaemonLoggerConfig = {}): void {
    // A re-configure (fresh startup, or a new DB in tests) abandons any rows
    // still queued against the previous connection and restarts both timers.
    this.stopTimers();
    this.queue = [];
    this.reportedDbFailure = false;
    this.insert = config.persist === false
      ? null
      : db.prepare(
        `INSERT INTO main.daemon_log (
          id, ts, level, event, subsystem, fields_json,
          issue_id, auth_request_id, artifact_id, session_id, repo_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ) as InsertStatement;
    const insert = this.insert;
    this.insertMany = insert
      ? db.transaction((rows: LogInsertParams[]) => {
        for (const row of rows) {
          insert.run(...row);
        }
      })
      : null;
    this.stderrRotation = {
      ...this.stderrRotation,
      filePath: daemonStderrLogPath(),
      ...readRotationSettings(config.settingsDb ?? db),
    };
    this.rotateOwnedLogs();
    this.startTimers();
  }

  log: Logger = (level, event, fields = {}) => {
    const normalizedLevel = normalizeLevel(level) ?? "info";
    const ts = Date.now();
    const subsystem = stringField(fields.subsystem) ?? "daemon";
    const refs = extractRefs(fields);
    const fieldsJson = safeJson(fields);

    if (this.insertMany && LEVELS.indexOf(normalizedLevel) >= PERSIST_MIN_INDEX) {
      this.queue.push([
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
      ]);
      // Bound memory under a burst; a full queue is flushed as one transaction
      // rather than being allowed to grow unbounded between timer turns.
      if (this.queue.length >= this.maxQueue) {
        this.flush();
      }
    }

    this.writeStderrMirror(normalizedLevel, event, fields, ts);
  };

  /** Persist all queued rows in a single transaction. Safe to call when idle. */
  flush(): void {
    if (!this.insertMany || this.queue.length === 0) {
      return;
    }
    const rows = this.queue;
    this.queue = [];
    try {
      this.insertMany(rows);
    } catch (error) {
      this.reportDbFailure(error);
    }
  }

  /** Detach persistence before its owning DB closes; later logs remain stderr-only. */
  shutdown(): void {
    this.flush();
    this.stopTimers();
    this.queue = [];
    this.insert = null;
    this.insertMany = null;
  }

  private startTimers(): void {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      this.flushTimer.unref();
    }
    this.rotationTimer = setInterval(() => {
      this.rotateOwnedLogs();
    }, this.rotationCheckMs);
    if (typeof this.rotationTimer === "object" && "unref" in this.rotationTimer) {
      this.rotationTimer.unref();
    }
  }

  private rotateOwnedLogs(): void {
    if (process.env.MANDIBLE_INSTANCE_ROLE === "preview") {
      const root = process.env.MANDIBLE_PREVIEW_ROOT;
      if (!root || path.dirname(path.resolve(this.stderrRotation.filePath)) !== path.resolve(root)) throw new Error("Preview stderr must belong to its exact preview root");
    }
    rotateStderrLogSegments(this.stderrRotation);
    const stdout = process.env.MANDIBLE_STDOUT_LOG_PATH?.trim();
    if (stdout && process.env.MANDIBLE_INSTANCE_ROLE === "preview") {
      const root = process.env.MANDIBLE_PREVIEW_ROOT;
      if (!root || path.dirname(path.resolve(stdout)) !== path.resolve(root)) throw new Error("Preview stdout must belong to its exact preview root");
      rotateStderrLogSegments({ ...this.stderrRotation, filePath: path.resolve(stdout) });
    }
  }

  private stopTimers(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  private writeStderrMirror(level: LogLevel, event: string, fields: Record<string, unknown>, ts: number): void {
    if (LEVELS.indexOf(level) < this.stderrMinIndex) {
      return;
    }
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

export function configureDaemonLogger(db: Db, config: DaemonLoggerConfig = {}): Logger {
  singleton.configure(db, config);
  return singleton.log;
}

/**
 * Synchronously persist any queued daemon_log rows. Call before shutting the
 * database so the final batch is not lost, and in tests that read rows back
 * immediately after logging.
 */
export function flushDaemonLogger(): void {
  singleton.flush();
}

export function stopDaemonLogger(): void {
  singleton.shutdown();
}

/**
 * The file this process's stderr is expected to be redirected to.
 *
 * This is the single source of truth for that path. The daemon never opens it —
 * it writes to its own stderr and its spawner decides where that goes — so the
 * rotation timer and every reader (the system-logs route, the preview launcher)
 * must agree on it through this function rather than by separately re-deriving
 * the same default. An instance that is pointed at its own database must be
 * pointed at its own log too, or it rotates and serves someone else's.
 */
export function daemonStderrLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MANDIBLE_STDERR_LOG_PATH?.trim();
  return configured ? path.resolve(configured) : DEFAULT_LOG_FILE_PATH;
}

export function rotateStderrLogSegments(config: StderrRotationConfig = {}): void {
  const filePath = config.filePath ?? DEFAULT_LOG_FILE_PATH;
  const maxBytes = Math.max(1, Math.floor(config.maxBytes ?? DEFAULT_STDERR_MAX_BYTES));
  const keepSegments = Math.max(0, Math.floor(config.keepSegments ?? DEFAULT_STDERR_KEEP_SEGMENTS));

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Log rotation requires an owned regular file: ${filePath}`);
  for (let index = 1; index <= keepSegments; index++) {
    const segment = `${filePath}.${index}`;
    try {
      if (fs.lstatSync(segment).isSymbolicLink()) throw new Error(`Log segment is a symlink: ${segment}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (stat.size < maxBytes) {
    return;
  }

  if (keepSegments > 0) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Shift the already-rotated segments down. Nothing holds these open, so a
    // rename is both correct and free. The loop stops at .1 because the live
    // file is handled separately below.
    for (let index = keepSegments; index >= 2; index -= 1) {
      const source = `${filePath}.${index - 1}`;
      const target = `${filePath}.${index}`;
      if (!fs.existsSync(source)) {
        continue;
      }
      if (index === keepSegments) {
        fs.rmSync(target, { force: true });
      }
      fs.renameSync(source, target);
    }
    fs.copyFileSync(filePath, `${filePath}.1`);
  }

  // Copy-then-truncate rather than rename-or-unlink. This process does not own
  // the file descriptor writing this file: the daemon logs to its own stderr,
  // and whoever spawned it (launchd, the desktop launcher, the preview run
  // script) redirected that stderr here and still holds the descriptor open.
  // Renaming or unlinking the file leaves that descriptor pointing at the moved
  // or unlinked inode, so every later line lands in a rotated segment — or in
  // no reachable file at all — until the process restarts and its spawner
  // reopens the path. Truncating in place keeps the inode, and every writer is
  // opened O_APPEND, so the next write resumes at offset 0.
  //
  // Lines written between the copy and the truncate are lost. That window is
  // one file copy wide and is the deliberate price of not invalidating a
  // descriptor this process cannot reopen.
  fs.truncateSync(filePath, 0);
}

/**
 * Delete expired persisted daemon logs in small batches, yielding between
 * batches. Each call is bounded; callers can resume while `hasMore` is true.
 */
export async function pruneDaemonLogs(
  db: Db,
  options: DaemonLogRetentionOptions = {},
): Promise<DaemonLogRetentionResult> {
  const retentionDays = readRetentionDays(options.settingsDb ?? db);
  const now = Number.isFinite(options.now) ? Math.floor(options.now as number) : Date.now();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
  const batchSize = parseBoundedInteger(options.batchSize, DEFAULT_RETENTION_BATCH_SIZE, 1, 10_000);
  const maxBatches = parseBoundedInteger(options.maxBatches, DEFAULT_RETENTION_MAX_BATCHES, 1, 100);
  const yieldMs = parseBoundedInteger(options.yieldMs, DEFAULT_RETENTION_YIELD_MS, 0, 10_000);
  const legacyProtection = unverifiedLegacyRetentionProtection(db);
  const removeBatch = db.prepare(
    `DELETE FROM main.daemon_log
     WHERE id IN (
       SELECT id FROM main.daemon_log
       WHERE ts < ?
       ${legacyProtection}
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
    .prepare(`SELECT 1 FROM main.daemon_log WHERE ts < ? ${legacyProtection} LIMIT 1`)
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
): { stop: () => Promise<void> } {
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
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      inFlight = run().finally(() => { inFlight = null; });
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
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight;
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

function unverifiedLegacyRetentionProtection(db: Db): string {
  try {
    const attached = (db.pragma("database_list") as Array<{ name: string }>).some(
      (entry) => entry.name === "legacy_ledger",
    );
    if (!attached) return "";
    const verified = hasCurrentOperationalLogVerification(db);
    return verified
      ? ""
      : "AND id NOT IN (SELECT id FROM legacy_ledger.daemon_log)";
  } catch (error) {
    throw new Error("Operational log legacy verification failed; retention is blocked", { cause: error });
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
