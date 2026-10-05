import SqliteDatabase from "./sqlite.js";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import {
  applyColdStartTuning,
  assertNotProductionDbUnderTest,
  getDefaultDbPath,
  getDbPath,
} from "./db.js";
import { hasCurrentOperationalLogVerification } from "./operational-log-verification.js";
import { getMandibleHome, getUserHome } from "./platform-paths.js";
import type { Logger } from "./types.js";

export { hasCurrentOperationalLogVerification } from "./operational-log-verification.js";

export const OPERATIONAL_LOG_DB_FILENAME = "operational-logs.db";
export const LEGACY_LOG_SCHEMA = "legacy_ledger";
export const OPERATIONAL_LOG_BACKUP_CLASSIFICATION = "excluded-runtime-telemetry" as const;

const DEFAULT_COPY_BATCH_SIZE = 1_000;
const DEFAULT_SCHEDULED_COPY_BATCH_SIZE = 100;
const DEFAULT_COPY_INITIAL_DELAY_MS = 2_000;
const DEFAULT_COPY_CATCH_UP_DELAY_MS = 50;
const DEFAULT_COPY_RECHECK_DELAY_MS = 30_000;
const LOG_COLUMNS = [
  "id",
  "ts",
  "level",
  "event",
  "subsystem",
  "fields_json",
  "issue_id",
  "auth_request_id",
  "artifact_id",
  "session_id",
  "repo_id",
] as const;

const OPERATIONAL_LOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS daemon_log (
    id              TEXT PRIMARY KEY,
    ts              INTEGER NOT NULL,
    level           TEXT NOT NULL CHECK(level IN ('debug','info','warn','error')),
    event           TEXT NOT NULL,
    subsystem       TEXT NOT NULL DEFAULT 'daemon',
    fields_json     TEXT NOT NULL DEFAULT '{}',
    issue_id        TEXT,
    auth_request_id TEXT,
    artifact_id     TEXT,
    session_id      TEXT,
    repo_id         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_daemon_log_ts
    ON daemon_log(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_daemon_log_facets
    ON daemon_log(subsystem, level, event, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_daemon_log_issue
    ON daemon_log(issue_id, ts DESC) WHERE issue_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_daemon_log_auth_request
    ON daemon_log(auth_request_id, ts DESC) WHERE auth_request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_daemon_log_artifact
    ON daemon_log(artifact_id, ts DESC) WHERE artifact_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_daemon_log_session
    ON daemon_log(session_id, ts DESC) WHERE session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_daemon_log_repo
    ON daemon_log(repo_id, ts DESC) WHERE repo_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS operational_log_copy_state (
    source_path  TEXT PRIMARY KEY,
    last_ts      INTEGER,
    last_id      TEXT,
    completed_at INTEGER,
    verified_at  INTEGER,
    verified_legacy_rows INTEGER,
    verified_primary_rows INTEGER,
    legacy_high_water_ts INTEGER,
    legacy_high_water_id TEXT,
    legacy_high_water_rows INTEGER,
    legacy_generation_rowid INTEGER,
    copied_rows  INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL
  );
`;

export interface OperationalLogStore {
  db: Db;
  dbPath: string;
  canonicalDbPath: string;
  legacyAttached: boolean;
  close(): void;
}

export interface OpenOperationalLogStoreOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  readonly?: boolean;
  attachLegacy?: boolean;
}

export interface CopyForwardOptions {
  batchSize?: number;
  maxBatches?: number;
  now?: number;
}

export interface CopyForwardResult {
  sourcePath: string;
  copied: number;
  scanned: number;
  batches: number;
  complete: boolean;
  lastTs: number | null;
  lastId: string | null;
}

export interface CopyVerificationResult {
  sourcePath: string;
  legacyRows: number;
  coveredRows: number;
  missingRows: number;
  mismatchedRows: number;
  visibleRows: number;
  primaryRows: number;
  queryParity: boolean;
  verified: boolean;
  verifiedAt: number | null;
}

export interface ReclaimPlan {
  eligible: boolean;
  productionMutationPerformed: false;
  reason: string;
  sourcePath: string;
  operationalLogPath: string;
  verification: CopyVerificationResult;
  requiredActions: string[];
}

export interface CopySchedulerOptions {
  initialDelayMs?: number;
  catchUpDelayMs?: number;
  batchSize?: number;
  recheckDelayMs?: number;
}

export function getDefaultOperationalLogDbPath(): string {
  return path.join(getMandibleHome(), OPERATIONAL_LOG_DB_FILENAME);
}

export function getOperationalLogDbPath(
  canonicalDbPath: string = getDbPath(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.MANDIBLE_LOG_DB) return path.resolve(expandHome(env.MANDIBLE_LOG_DB));
  if (path.resolve(canonicalDbPath) === path.resolve(getDefaultDbPath())) {
    return getDefaultOperationalLogDbPath();
  }
  const parsed = path.parse(canonicalDbPath);
  const stem = parsed.ext.toLowerCase() === ".db" ? parsed.name : parsed.base;
  return path.join(parsed.dir, `${stem}.operational-logs.db`);
}

export function openOperationalLogStore(
  canonicalDbPath: string,
  options: OpenOperationalLogStoreOptions = {},
): OperationalLogStore | null {
  const dbPath = options.dbPath ?? getOperationalLogDbPath(canonicalDbPath, options.env);
  assertNotProductionDbUnderTest(dbPath);
  const readonly = options.readonly === true;
  if (readonly && !fs.existsSync(dbPath)) return null;
  if (!readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new SqliteDatabase(dbPath, readonly ? { readonly: true, fileMustExist: true } : undefined);
  try {
    if (!readonly) {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 250");
      applyColdStartTuning(db);
      db.exec(OPERATIONAL_LOG_SCHEMA);
      ensureCopyStateColumns(db);
    } else {
      db.pragma("query_only = ON");
    }

    let legacyAttached = false;
    if (options.attachLegacy !== false && fs.existsSync(canonicalDbPath)) {
      // This attachment is used only by SELECT statements. All writes in this
      // module are explicitly qualified to main, keeping canonical ownership
      // with the daemon's existing ledger connection.
      db.prepare(`ATTACH DATABASE ? AS ${LEGACY_LOG_SCHEMA}`).run(canonicalDbPath);
      legacyAttached = schemaTableExists(db, LEGACY_LOG_SCHEMA, "daemon_log");
      if (!legacyAttached) db.exec(`DETACH DATABASE ${LEGACY_LOG_SCHEMA}`);
    }

    return {
      db,
      dbPath,
      canonicalDbPath,
      legacyAttached,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function visibleDaemonLogSource(db: Db): { cte: string; table: string } {
  if (!schemaTableExists(db, LEGACY_LOG_SCHEMA, "daemon_log")) {
    return { cte: "", table: "daemon_log" };
  }
  if (hasCurrentOperationalLogVerification(db)) {
    return { cte: "", table: "daemon_log" };
  }
  return {
    cte: `WITH visible_daemon_log AS (
      SELECT ${LOG_COLUMNS.join(", ")} FROM main.daemon_log
      UNION ALL
      SELECT ${LOG_COLUMNS.map((column) => `legacy.${column}`).join(", ")}
      FROM ${LEGACY_LOG_SCHEMA}.daemon_log AS legacy
      WHERE NOT EXISTS (
        SELECT 1 FROM main.daemon_log AS current WHERE current.id = legacy.id
      )
    )`,
    table: "visible_daemon_log",
  };
}

export function copyForwardLegacyDaemonLogs(
  store: OperationalLogStore,
  options: CopyForwardOptions = {},
): CopyForwardResult {
  if (!store.legacyAttached) {
    return emptyCopyResult(store.canonicalDbPath, true);
  }
  assertWritableStore(store.db);
  const batchSize = boundedInteger(options.batchSize, DEFAULT_COPY_BATCH_SIZE, 1, 10_000);
  const maxBatches = boundedInteger(options.maxBatches, 1, 1, 100);
  const now = finiteInteger(options.now, Date.now());
  const sourcePath = canonicalExistingPath(store.canonicalDbPath);
  coalesceEquivalentCopyState(store.db, sourcePath);
  let state = store.db.prepare(
    `SELECT last_ts, last_id, completed_at, verified_at,
            verified_legacy_rows, verified_primary_rows, copied_rows,
            legacy_high_water_ts, legacy_high_water_id, legacy_high_water_rows,
            legacy_generation_rowid
     FROM operational_log_copy_state WHERE source_path = ?`,
  ).get(sourcePath) as {
    last_ts: number | null;
    last_id: string | null;
    completed_at: number | null;
    verified_at: number | null;
    verified_legacy_rows: number | null;
    verified_primary_rows: number | null;
    copied_rows: number;
    legacy_high_water_ts: number | null;
    legacy_high_water_id: string | null;
    legacy_high_water_rows: number | null;
    legacy_generation_rowid: number | null;
  } | undefined;
  if (state?.completed_at) {
    if (state.legacy_generation_rowid === null) {
      state = {
        ...state,
        legacy_generation_rowid: bootstrapCompletedLegacyGeneration(
          store.db,
          sourcePath,
          state,
          now,
        ),
      };
    }
    if (copyStateMatchesLegacyGeneration(store.db, state)) {
      return {
        sourcePath,
        copied: 0,
        scanned: 0,
        batches: 0,
        complete: true,
        lastTs: state.last_ts,
        lastId: state.last_id,
      };
    }
    store.db.prepare(
      `UPDATE operational_log_copy_state
       SET last_ts = NULL, last_id = NULL, completed_at = NULL, verified_at = NULL,
           verified_legacy_rows = NULL, verified_primary_rows = NULL,
           legacy_high_water_ts = NULL, legacy_high_water_id = NULL,
           legacy_high_water_rows = NULL, legacy_generation_rowid = NULL,
           updated_at = ?
       WHERE source_path = ?`,
    ).run(now, sourcePath);
    state = { ...state, last_ts: null, last_id: null, completed_at: null,
      legacy_high_water_ts: null, legacy_high_water_id: null, legacy_high_water_rows: null,
      legacy_generation_rowid: null };
  }

  const selectInitialRows = store.db.prepare(
    `SELECT ${LOG_COLUMNS.join(", ")}
     FROM ${LEGACY_LOG_SCHEMA}.daemon_log
     ORDER BY ts ASC, id ASC
     LIMIT ?`,
  );
  const selectRowsAfterCursor = store.db.prepare(
    `SELECT ${LOG_COLUMNS.join(", ")}
     FROM ${LEGACY_LOG_SCHEMA}.daemon_log
     WHERE (ts, id) > (?, ?)
     ORDER BY ts ASC, id ASC
     LIMIT ?`,
  );
  const insert = store.db.prepare(
    `INSERT INTO main.daemon_log (${LOG_COLUMNS.join(", ")})
     VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT(id) DO NOTHING`,
  );
  const persistState = store.db.prepare(
    `INSERT INTO operational_log_copy_state
       (source_path, last_ts, last_id, completed_at, verified_at,
        verified_legacy_rows, verified_primary_rows, legacy_high_water_ts,
        legacy_high_water_id, legacy_high_water_rows, legacy_generation_rowid,
        copied_rows, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       last_ts = excluded.last_ts,
       last_id = excluded.last_id,
       completed_at = excluded.completed_at,
       verified_at = NULL,
       verified_legacy_rows = NULL,
       verified_primary_rows = NULL,
       legacy_high_water_ts = excluded.legacy_high_water_ts,
       legacy_high_water_id = excluded.legacy_high_water_id,
       legacy_high_water_rows = excluded.legacy_high_water_rows,
       legacy_generation_rowid = excluded.legacy_generation_rowid,
       copied_rows = operational_log_copy_state.copied_rows + excluded.copied_rows,
       updated_at = excluded.updated_at`,
  );
  const applyBatch = store.db.transaction((
    rows: DaemonLogRow[],
    cursorTs: number | null,
    cursorId: string | null,
    complete: boolean,
    legacySnapshot: LegacyCompletionSnapshot,
  ): number => {
    let copied = 0;
    for (const row of rows) {
      const result = insert.run(...LOG_COLUMNS.map((column) => row[column]));
      copied += result.changes;
    }
    persistState.run(
      sourcePath,
      cursorTs,
      cursorId,
      complete ? now : null,
      complete ? legacySnapshot.ts : null,
      complete ? legacySnapshot.id : null,
      complete ? legacySnapshot.generationRowid : null,
      copied,
      now,
    );
    return copied;
  });

  let cursorTs = state?.last_ts ?? null;
  let cursorId = state?.last_id ?? null;
  let copied = 0;
  let scanned = 0;
  let batches = 0;
  let complete = false;
  for (let index = 0; index < maxBatches; index += 1) {
    // Keep the nullable initial case out of the cursor predicate. A single
    // `? IS NULL OR ...` statement makes SQLite scan from the beginning of a
    // multi-million-row legacy log on every batch instead of seeking into the
    // timestamp index.
    const rows = (cursorTs === null
      ? selectInitialRows.all(batchSize)
      : selectRowsAfterCursor.all(cursorTs, cursorId ?? "", batchSize)) as DaemonLogRow[];
    complete = rows.length < batchSize;
    // Completion uses only indexed high-water and append-generation lookups.
    // Full coverage counts belong to explicit operator verification, never
    // the daemon's scheduled copy-forward path.
    const legacySnapshot = complete
      ? currentLegacyCompletionSnapshot(store.db)
      : { ts: null, id: null, generationRowid: null };
    const last = rows.at(-1);
    if (last) {
      cursorTs = last.ts;
      cursorId = last.id;
    }
    copied += applyBatch(rows, cursorTs, cursorId, complete, legacySnapshot);
    scanned += rows.length;
    batches += 1;
    if (complete) break;
  }
  return { sourcePath, copied, scanned, batches, complete, lastTs: cursorTs, lastId: cursorId };
}

export function verifyLegacyDaemonLogCopy(
  store: OperationalLogStore,
  options: { record?: boolean; now?: number } = {},
): CopyVerificationResult {
  if (!store.legacyAttached) {
    const primaryRows = countRows(store.db, "main.daemon_log");
    return {
      sourcePath: canonicalExistingPath(store.canonicalDbPath),
      legacyRows: 0,
      coveredRows: 0,
      missingRows: 0,
      mismatchedRows: 0,
      visibleRows: primaryRows,
      primaryRows,
      queryParity: true,
      verified: true,
      verifiedAt: null,
    };
  }
  const verify = store.db.transaction((): CopyVerificationResult => {
    const sourcePath = canonicalExistingPath(store.canonicalDbPath);
    if (options.record !== false) invalidateStaleCopyState(store.db, sourcePath, finiteInteger(options.now, Date.now()));
    const generationBefore = currentLegacyGeneration(store.db);
    const legacyRows = countRows(store.db, `${LEGACY_LOG_SCHEMA}.daemon_log`);
    const primaryRows = countRows(store.db, "main.daemon_log");
    const coveredRows = numberResult(store.db.prepare(
    `SELECT COUNT(*) AS count
     FROM ${LEGACY_LOG_SCHEMA}.daemon_log legacy
     JOIN main.daemon_log current ON current.id = legacy.id`,
    ).get());
    const mismatchedRows = numberResult(store.db.prepare(
    `SELECT COUNT(*) AS count
     FROM ${LEGACY_LOG_SCHEMA}.daemon_log legacy
     JOIN main.daemon_log current ON current.id = legacy.id
     WHERE ${LOG_COLUMNS.filter((column) => column !== "id")
       .map((column) => `current.${column} IS NOT legacy.${column}`)
       .join(" OR ")}`,
    ).get());
    const visible = visibleDaemonLogSource(store.db);
    const visibleRows = numberResult(store.db.prepare(
    `${visible.cte} SELECT COUNT(*) AS count FROM ${visible.table}`,
    ).get());
    const missingRows = legacyRows - coveredRows;
    const legacySnapshot = currentLegacyCompletionSnapshot(store.db);
    const generationStable = generationBefore === legacySnapshot.generationRowid;
    const copyComplete = hasCurrentCompletedCopy(store.db, sourcePath);
    const queryParity = visibleRows === primaryRows && missingRows === 0 && mismatchedRows === 0;
    const verified = copyComplete && queryParity && generationStable;
    let verifiedAt: number | null = null;
    if (verified && options.record !== false) {
      assertWritableStore(store.db);
      verifiedAt = finiteInteger(options.now, Date.now());
      store.db.prepare(
      `UPDATE operational_log_copy_state
       SET verified_at = ?, verified_legacy_rows = ?, verified_primary_rows = ?,
           legacy_high_water_ts = ?, legacy_high_water_id = ?,
           legacy_high_water_rows = ?, legacy_generation_rowid = ?, updated_at = ?
       WHERE source_path = ? AND completed_at IS NOT NULL`,
    ).run(
      verifiedAt,
      legacyRows,
      primaryRows,
      legacySnapshot.ts,
      legacySnapshot.id,
      legacyRows,
      legacySnapshot.generationRowid,
      verifiedAt,
      sourcePath,
      );
    }
    return {
      sourcePath,
      legacyRows,
      coveredRows,
      missingRows,
      mismatchedRows,
      visibleRows,
      primaryRows,
      queryParity,
      verified,
      verifiedAt,
    };
  });
  // Recording reserves the operational DB writer before the long parity scan,
  // so retention cannot make the verifier compare counts from different
  // moments. Read-only planning still gets one coherent deferred snapshot.
  return options.record === false ? verify.deferred() : verify.immediate();
}

export function planLegacyDaemonLogReclaim(store: OperationalLogStore): ReclaimPlan {
  const verification = verifyLegacyDaemonLogCopy(store, { record: false });
  const state = store.db.prepare(
    `SELECT completed_at, verified_at, verified_legacy_rows, verified_primary_rows,
            legacy_high_water_ts, legacy_high_water_id, legacy_high_water_rows,
            legacy_generation_rowid
     FROM operational_log_copy_state WHERE source_path = ?`,
  ).get(canonicalExistingPath(store.canonicalDbPath)) as {
    completed_at: number | null;
    verified_at: number | null;
    verified_legacy_rows: number | null;
    verified_primary_rows: number | null;
    legacy_high_water_ts: number | null;
    legacy_high_water_id: string | null;
    legacy_high_water_rows: number | null;
    legacy_generation_rowid: number | null;
  } | undefined;
  // Retention is allowed to remove expired primary rows after verification.
  // Reclaim eligibility therefore rests on the recorded verifier snapshot,
  // not on re-proving historical coverage after policy-driven expiry.
  const eligible = Boolean(
    state
    && state.completed_at
    && state.verified_at
    && state.verified_legacy_rows !== null
    && state.verified_primary_rows !== null
    && copyStateMatchesLegacy(store.db, state),
  );
  return {
    eligible,
    productionMutationPerformed: false,
    reason: eligible
      ? "copy-forward is complete and a recorded verifier pass covers every legacy row"
      : "reclaim remains blocked until copy-forward completes and an explicit verifier pass is recorded",
    sourcePath: store.canonicalDbPath,
    operationalLogPath: store.dbPath,
    verification,
    requiredActions: [
      "stop the daemon and take a verified canonical database backup",
      "run a separately reviewed reclaim tool that drops only legacy daemon_log indexes and table",
      "restart and verify operational-log queries against the dedicated database",
      "consider VACUUM only as a separate explicitly acknowledged blocking maintenance action",
    ],
  };
}

export function startOperationalLogCopyForward(
  store: OperationalLogStore,
  logger: Logger,
  options: CopySchedulerOptions = {},
): { stop(): void } {
  const initialDelayMs = boundedInteger(options.initialDelayMs, DEFAULT_COPY_INITIAL_DELAY_MS, 0, 60_000);
  const catchUpDelayMs = boundedInteger(options.catchUpDelayMs, DEFAULT_COPY_CATCH_UP_DELAY_MS, 0, 60_000);
  const recheckDelayMs = boundedInteger(options.recheckDelayMs, DEFAULT_COPY_RECHECK_DELAY_MS, 1, 300_000);
  const batchSize = boundedInteger(options.batchSize, DEFAULT_SCHEDULED_COPY_BATCH_SIZE, 1, 10_000);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(run, delayMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  };
  const run = (): void => {
    try {
      const result = copyForwardLegacyDaemonLogs(store, { batchSize, maxBatches: 1 });
      if (result.scanned > 0 || result.complete) {
        logger("info", "operational_log_copy_forward", {
          scanned: result.scanned,
          copied: result.copied,
          complete: result.complete,
        });
      }
      schedule(result.complete ? recheckDelayMs : catchUpDelayMs);
    } catch (error) {
      logger("warn", "operational_log_copy_forward_failed", { error: String(error) });
      schedule(Math.max(catchUpDelayMs, 1_000));
    }
  };
  schedule(initialDelayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

type DaemonLogRow = {
  [K in (typeof LOG_COLUMNS)[number]]: K extends "ts" ? number : string | null;
};

function schemaTableExists(db: Db, schema: string, table: string): boolean {
  try {
    return Boolean(db.prepare(
      `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table));
  } catch {
    return false;
  }
}

function ensureCopyStateColumns(db: Db): void {
  const columns = new Set((db.prepare("PRAGMA table_info(operational_log_copy_state)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has("verified_legacy_rows")) {
    db.exec("ALTER TABLE operational_log_copy_state ADD COLUMN verified_legacy_rows INTEGER");
  }
  if (!columns.has("verified_primary_rows")) {
    db.exec("ALTER TABLE operational_log_copy_state ADD COLUMN verified_primary_rows INTEGER");
  }
  if (!columns.has("legacy_high_water_ts")) {
    db.exec("ALTER TABLE operational_log_copy_state ADD COLUMN legacy_high_water_ts INTEGER");
  }
  if (!columns.has("legacy_high_water_id")) {
    db.exec("ALTER TABLE operational_log_copy_state ADD COLUMN legacy_high_water_id TEXT");
  }
  if (!columns.has("legacy_high_water_rows")) {
    db.exec("ALTER TABLE operational_log_copy_state ADD COLUMN legacy_high_water_rows INTEGER");
  }
  if (!columns.has("legacy_generation_rowid")) {
    db.exec("ALTER TABLE operational_log_copy_state ADD COLUMN legacy_generation_rowid INTEGER");
  }
}

type LegacyHighWater = { ts: number | null; id: string | null; rows: number };
type LegacyCompletionSnapshot = {
  ts: number | null;
  id: string | null;
  generationRowid: number | null;
};

type OperationalLogCopyState = {
  source_path: string;
  last_ts: number | null;
  last_id: string | null;
  completed_at: number | null;
  verified_at: number | null;
  verified_legacy_rows: number | null;
  verified_primary_rows: number | null;
  legacy_high_water_ts: number | null;
  legacy_high_water_id: string | null;
  legacy_high_water_rows: number | null;
  legacy_generation_rowid: number | null;
  copied_rows: number;
  updated_at: number;
};

function currentLegacyHighWater(db: Db): LegacyHighWater {
  const row = currentLegacyMaxTuple(db);
  return {
    ts: row.ts,
    id: row.id,
    rows: countRows(db, `${LEGACY_LOG_SCHEMA}.daemon_log`),
  };
}

function currentLegacyMaxTuple(db: Db): { ts: number | null; id: string | null } {
  const timestamp = db.prepare(
    `SELECT MAX(ts) AS ts
     FROM ${LEGACY_LOG_SCHEMA}.daemon_log INDEXED BY idx_daemon_log_ts`,
  ).get() as { ts: number | null };
  if (timestamp.ts === null) return { ts: null, id: null };
  const row = db.prepare(
    `SELECT MAX(id) AS id
     FROM ${LEGACY_LOG_SCHEMA}.daemon_log INDEXED BY idx_daemon_log_ts
     WHERE ts = ?`,
  ).get(timestamp.ts) as { id: string };
  return { ts: timestamp.ts, id: row.id };
}

function currentLegacyGeneration(db: Db): number {
  const row = db.prepare(
    `SELECT COALESCE(MAX(rowid), 0) AS generation_rowid
     FROM ${LEGACY_LOG_SCHEMA}.daemon_log`,
  ).get() as { generation_rowid: number };
  return Number(row.generation_rowid);
}

function currentLegacyCompletionSnapshot(db: Db): LegacyCompletionSnapshot {
  const row = currentLegacyMaxTuple(db);
  return {
    ts: row.ts,
    id: row.id,
    generationRowid: currentLegacyGeneration(db),
  };
}

function bootstrapCompletedLegacyGeneration(
  db: Db,
  sourcePath: string,
  state: Pick<OperationalLogCopyState,
  "last_ts" | "last_id" | "completed_at" | "verified_at"
  | "verified_legacy_rows" | "verified_primary_rows" | "legacy_high_water_ts"
  | "legacy_high_water_id" | "legacy_high_water_rows" | "copied_rows">,
  now: number,
): number | null {
  if (state.completed_at === null
    || state.legacy_high_water_rows === null
    || state.legacy_high_water_rows < 0
    || state.copied_rows < 0
    || (state.verified_at !== null
      && (state.verified_legacy_rows === null || state.verified_primary_rows === null))) return null;

  const emptyCompletion = state.legacy_high_water_rows === 0
    && state.last_ts === null
    && state.last_id === null
    && state.legacy_high_water_ts === null
    && state.legacy_high_water_id === null;
  const nonemptyCompletion = state.legacy_high_water_rows > 0
    && state.last_ts !== null
    && state.last_id !== null
    && state.last_ts === state.legacy_high_water_ts
    && state.last_id === state.legacy_high_water_id;
  if (!emptyCompletion && !nonemptyCompletion) return null;

  const current = currentLegacyCompletionSnapshot(db);
  if (current.ts !== state.legacy_high_water_ts
    || current.id !== state.legacy_high_water_id
    || current.generationRowid === null) return null;
  db.prepare(
    `UPDATE operational_log_copy_state
     SET legacy_generation_rowid = ?, updated_at = ?
     WHERE source_path = ? AND completed_at IS NOT NULL
       AND legacy_generation_rowid IS NULL`,
  ).run(current.generationRowid, now, sourcePath);
  return current.generationRowid;
}

function copyStateMatchesLegacyGeneration(
  db: Db,
  state: { legacy_generation_rowid: number | null },
): boolean {
  return state.legacy_generation_rowid !== null
    && currentLegacyGeneration(db) === state.legacy_generation_rowid;
}

function copyStateMatchesLegacy(db: Db, state: {
  legacy_high_water_ts: number | null;
  legacy_high_water_id: string | null;
  legacy_high_water_rows: number | null;
  legacy_generation_rowid: number | null;
}): boolean {
  if (state.legacy_high_water_rows === null || state.legacy_generation_rowid === null) return false;
  const current = currentLegacyHighWater(db);
  return copyStateMatchesHighWater(state, current)
    && currentLegacyGeneration(db) === state.legacy_generation_rowid;
}

function copyStateMatchesHighWater(
  state: Pick<OperationalLogCopyState,
  "legacy_high_water_ts" | "legacy_high_water_id" | "legacy_high_water_rows">,
  current: LegacyHighWater,
): boolean {
  return state.legacy_high_water_rows !== null
    && current.ts === state.legacy_high_water_ts
    && current.id === state.legacy_high_water_id
    && current.rows === state.legacy_high_water_rows;
}

function coalesceEquivalentCopyState(db: Db, sourcePath: string): void {
  const rows = db.prepare(
    `SELECT source_path, last_ts, last_id, completed_at, verified_at,
            verified_legacy_rows, verified_primary_rows, legacy_high_water_ts,
            legacy_high_water_id, legacy_high_water_rows, legacy_generation_rowid,
            copied_rows, updated_at
     FROM operational_log_copy_state`,
  ).all() as OperationalLogCopyState[];
  const equivalent = rows.filter((row) => canonicalExistingPath(row.source_path) === sourcePath);
  if (equivalent.length === 0
    || (equivalent.length === 1 && equivalent[0]?.source_path === sourcePath)) return;

  const completed = equivalent.filter((row) => row.completed_at !== null);
  const currentGeneration = completed.length > 0 ? currentLegacyGeneration(db) : null;
  const currentCompleted = currentGeneration === null ? [] : completed.filter(
    (row) => row.legacy_generation_rowid !== null
      && row.legacy_generation_rowid === currentGeneration,
  );
  const candidates = currentCompleted.length > 0 ? currentCompleted
    : completed.length > 0 ? completed
      : equivalent;
  const winner = [...candidates].sort((left, right) => {
    if (currentCompleted.length > 0) {
      const verificationOrder = Number(right.verified_at !== null) - Number(left.verified_at !== null);
      if (verificationOrder !== 0) return verificationOrder;
    }
    const timestampOrder = (right.last_ts ?? Number.MIN_SAFE_INTEGER)
      - (left.last_ts ?? Number.MIN_SAFE_INTEGER);
    if (timestampOrder !== 0) return timestampOrder;
    const idOrder = (right.last_id ?? "").localeCompare(left.last_id ?? "");
    if (idOrder !== 0) return idOrder;
    return right.updated_at - left.updated_at;
  })[0];
  if (!winner) return;

  const copiedRows = Math.max(...equivalent.map((row) => row.copied_rows));
  const updatedAt = Math.max(...equivalent.map((row) => row.updated_at));
  db.transaction(() => {
    db.prepare(
      `INSERT INTO operational_log_copy_state
         (source_path, last_ts, last_id, completed_at, verified_at,
          verified_legacy_rows, verified_primary_rows, legacy_high_water_ts,
          legacy_high_water_id, legacy_high_water_rows, legacy_generation_rowid,
          copied_rows, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_path) DO UPDATE SET
         last_ts = excluded.last_ts,
         last_id = excluded.last_id,
         completed_at = excluded.completed_at,
         verified_at = excluded.verified_at,
         verified_legacy_rows = excluded.verified_legacy_rows,
         verified_primary_rows = excluded.verified_primary_rows,
         legacy_high_water_ts = excluded.legacy_high_water_ts,
         legacy_high_water_id = excluded.legacy_high_water_id,
         legacy_high_water_rows = excluded.legacy_high_water_rows,
         legacy_generation_rowid = excluded.legacy_generation_rowid,
         copied_rows = excluded.copied_rows,
         updated_at = excluded.updated_at`,
    ).run(
      sourcePath,
      winner.last_ts,
      winner.last_id,
      winner.completed_at,
      winner.verified_at,
      winner.verified_legacy_rows,
      winner.verified_primary_rows,
      winner.legacy_high_water_ts,
      winner.legacy_high_water_id,
      winner.legacy_high_water_rows,
      winner.legacy_generation_rowid,
      copiedRows,
      updatedAt,
    );
    const removeAlias = db.prepare(
      "DELETE FROM operational_log_copy_state WHERE source_path = ?",
    );
    for (const row of equivalent) {
      if (row.source_path !== sourcePath) removeAlias.run(row.source_path);
    }
  })();
}

function hasCurrentCompletedCopy(db: Db, sourcePath: string): boolean {
  try {
    const state = db.prepare(
      `SELECT completed_at, legacy_generation_rowid
       FROM operational_log_copy_state WHERE source_path = ?`,
    ).get(sourcePath) as {
      completed_at: number | null;
      legacy_generation_rowid: number | null;
    } | undefined;
    return Boolean(state?.completed_at && copyStateMatchesLegacyGeneration(db, state));
  } catch {
    return false;
  }
}

function invalidateStaleCopyState(db: Db, sourcePath: string, now: number): void {
  let state = db.prepare(
    `SELECT last_ts, last_id, completed_at, verified_at,
            verified_legacy_rows, verified_primary_rows, copied_rows,
            legacy_high_water_ts, legacy_high_water_id, legacy_high_water_rows,
            legacy_generation_rowid
     FROM operational_log_copy_state WHERE source_path = ?`,
  ).get(sourcePath) as {
    last_ts: number | null;
    last_id: string | null;
    completed_at: number | null;
    verified_at: number | null;
    verified_legacy_rows: number | null;
    verified_primary_rows: number | null;
    copied_rows: number;
    legacy_high_water_ts: number | null;
    legacy_high_water_id: string | null;
    legacy_high_water_rows: number | null;
    legacy_generation_rowid: number | null;
  } | undefined;
  if (state?.completed_at && state.legacy_generation_rowid === null) {
    state = {
      ...state,
      legacy_generation_rowid: bootstrapCompletedLegacyGeneration(
        db,
        sourcePath,
        state,
        now,
      ),
    };
  }
  if (!state?.completed_at || copyStateMatchesLegacyGeneration(db, state)) return;
  db.prepare(
    `UPDATE operational_log_copy_state
     SET last_ts = NULL, last_id = NULL, completed_at = NULL, verified_at = NULL,
         verified_legacy_rows = NULL, verified_primary_rows = NULL,
         legacy_high_water_ts = NULL, legacy_high_water_id = NULL,
         legacy_high_water_rows = NULL, legacy_generation_rowid = NULL,
         updated_at = ?
     WHERE source_path = ?`,
  ).run(now, sourcePath);
}

function assertWritableStore(db: Db): void {
  const queryOnly = Number((db.pragma("query_only", { simple: true }) as number | undefined) ?? 0);
  if (queryOnly !== 0) throw new Error("operational-log store is read-only");
}

function countRows(db: Db, table: string): number {
  return numberResult(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
}

function numberResult(value: unknown): number {
  const count = (value as { count?: unknown } | undefined)?.count;
  return typeof count === "bigint" ? Number(count) : Number(count ?? 0);
}

function emptyCopyResult(sourcePath: string, complete: boolean): CopyForwardResult {
  return {
    sourcePath: path.resolve(sourcePath),
    copied: 0,
    scanned: 0,
    batches: 0,
    complete,
    lastTs: null,
    lastId: null,
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function finiteInteger(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value as number) : fallback;
}

function expandHome(value: string): string {
  if (value === "~") return getUserHome();
  if (value.startsWith("~/")) return path.join(getUserHome(), value.slice(2));
  return value;
}

function canonicalExistingPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}
