import { assertNotProductionDbUnderTest } from "../cli/production-db-guard.cjs";
import SqliteDatabase from "./sqlite.js";
import fs from "node:fs";
import path from "node:path";
import {
  assertMigrationSequence,
  CURRENT_SCHEMA_VERSION,
  migrate,
  MINIMUM_SUPPORTED_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
} from "./db-migrations.js";
import type { Migration } from "./db-migrations.js";
import { getMandibleHome, getUserHome } from "./platform-paths.js";

export type Db = SqliteDatabase;
export {
  assertMigrationSequence,
  CURRENT_SCHEMA_VERSION,
  migrate,
  MINIMUM_SUPPORTED_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
};
export type { Migration };

export const SQLITE_COLD_START_TUNING = Object.freeze({
  mmapSizeBytes: (2 * 1024 * 1024 * 1024) - (64 * 1024),
  cacheSizeKib: 256 * 1024,
  tempStore: "MEMORY",
});

export interface OpenDbOptions {
  busyTimeoutMs?: number;
}

/** SQLite writes these next to the database file; they travel with it. */
export const DB_SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm"] as const);

/**
 * The ledger database lives under the durable root (issue 24f0316), not under
 * `~/.cache`. `getMandibleHome()` owns the root and honors `MANDIBLE_HOME`, so
 * this is resolved per call rather than frozen at module load.
 */
export function getDefaultDbPath(): string {
  return path.join(getMandibleHome(), "mandible.db");
}

/**
 * Where the ledger database lived before the durable/cache split: directly
 * under the disposable cache root. Still read at startup so an existing install
 * is copied forward exactly once; never written to after that.
 */
export function getLegacyCacheDbPath(home: string = getUserHome()): string {
  return path.join(home, ".cache", "mandible", "mandible.db");
}

export function getDbPath(): string {
  return process.env.MANDIBLE_DB ?? getDefaultDbPath();
}

export {
  PRODUCTION_DB_PATH,
  LEGACY_PRODUCTION_DB_PATH,
  PRODUCTION_OPERATIONAL_LOG_DB_PATH,
  PRODUCTION_DB_PATHS,
  resolvesToProductionDbPath,
  resolvesToAnyProductionDbPath,
  assertNotProductionDbUnderTest,
} from "../cli/production-db-guard.cjs";

// --- Startup copy-forward: ~/.cache/mandible → ~/.mandible (issue 24f0316) ---

/** Written beside the destination while a copy is in flight. */
const COPY_FORWARD_MARKER_SUFFIX = ".copy-forward-in-progress";
/** Written beside the source once the copy is verified. The source is kept. */
const COPY_FORWARD_RECEIPT_SUFFIX = ".moved-to-mandible-home";
/** Free space demanded on top of the bytes being copied. */
const COPY_FORWARD_HEADROOM_MARGIN_BYTES = 512 * 1024 * 1024;

export type CopyForwardAction =
  /** A database already exists at the durable path; nothing to do. */
  | "target-present"
  /** No legacy database to copy; this is a fresh install. */
  | "no-legacy"
  /** The legacy database was copied and verified at the durable path. */
  | "copied"
  /** The copy could not be completed; the legacy path stays authoritative. */
  | "kept-legacy";

export interface CopyForwardOutcome {
  /** The path the caller should actually open. */
  dbPath: string;
  action: CopyForwardAction;
  reason?: string;
  /** Files written under the durable root, in copy order. */
  copied?: string[];
}

export interface CopyForwardOptions {
  /** Defaults to stderr. Every non-trivial outcome logs exactly one line. */
  log?: (message: string) => void;
  headroomMarginBytes?: number;
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of ["", ...DB_SIDECAR_SUFFIXES]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
}

function fileSizeOrZero(target: string): number {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}

/**
 * Free bytes on the filesystem that would hold `dir`, or null when the platform
 * cannot answer. `dir` need not exist yet — the nearest existing ancestor is on
 * the same filesystem for every case that matters here.
 */
function availableBytes(dir: string): number | null {
  const statfsSync = (fs as unknown as {
    statfsSync?: (target: string) => { bsize: number; bavail: number };
  }).statfsSync;
  if (typeof statfsSync !== "function") return null;
  try {
    let probe = path.resolve(dir);
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const stats = statfsSync(probe);
    if (!stats || !Number.isFinite(stats.bsize) || !Number.isFinite(stats.bavail)) return null;
    return stats.bsize * stats.bavail;
  } catch {
    return null;
  }
}

/** Open the copy the way the daemon will and read its schema catalog. */
function assertDbOpenable(dbPath: string): number {
  const probe = new SqliteDatabase(dbPath, { fileMustExist: true });
  try {
    const row = probe.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number };
    return row.n;
  } finally {
    probe.close();
  }
}

/**
 * One-time relocation of the ledger database from the disposable cache root to
 * the durable root (issue 24f0316), run at daemon startup before the database
 * is opened.
 *
 * Design constraints, in the order they bind:
 *
 *  1. **Never destructive.** The legacy `.db`/`-wal`/`-shm` files are left
 *     exactly as found, whatever happens. A verified copy leaves a receipt file
 *     beside them naming the new location; reclaiming the ~7.5 GB is a separate,
 *     explicitly authorized act.
 *  2. **Never half-done.** A marker file is written before the first byte and
 *     removed only after verification. If the process dies mid-copy, the next
 *     startup sees the marker, discards the unverified destination files, and
 *     starts over — rather than adopting a truncated database as authoritative.
 *  3. **Fails to the old path, not to an empty one.** Insufficient headroom, a
 *     copy error, a size mismatch, or a destination SQLite refuses to open all
 *     produce the same result: partial output is removed, one loud line is
 *     logged, and the caller keeps using the legacy database. Starting fresh on
 *     a machine that has a 7.5 GB ledger would look exactly like data loss.
 *  4. **Sidecars travel with the database.** `-wal` holds committed frames that
 *     are not yet in the main file, so copying `.db` alone can silently drop the
 *     most recent transactions.
 *
 * The daemon is by construction not running when this executes (it runs during
 * its own startup, after the previous process exited), so the legacy files are
 * quiescent.
 */
export function copyForwardLegacyDb(
  targetPath: string,
  legacyPath: string,
  options: CopyForwardOptions = {},
): CopyForwardOutcome {
  const log = options.log ?? ((message: string) => console.error(message));
  const marker = targetPath + COPY_FORWARD_MARKER_SUFFIX;

  if (fs.existsSync(marker)) {
    log(
      `[mandible] discarding an unverified partial database copy at ${targetPath}: ` +
        `a previous copy-forward attempt did not finish (issue 24f0316).`,
    );
    removeDbFiles(targetPath);
    fs.rmSync(marker, { force: true });
  }

  if (fs.existsSync(targetPath)) {
    if (fs.existsSync(legacyPath)) {
      let invalidReason: string | null = null;
      const targetSize = fileSizeOrZero(targetPath);
      if (targetSize === 0) {
        invalidReason = "the durable database is zero bytes";
      } else {
        try {
          if (assertDbOpenable(targetPath) === 0) {
            invalidReason = "the durable database has no SQLite schema";
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          invalidReason = `the durable database is not openable (${detail})`;
        }
      }
      if (invalidReason) {
        const legacySize = fileSizeOrZero(legacyPath);
        log(
          `[mandible] REFUSING to adopt ${targetPath}: ${invalidReason}, while the ` +
            `legacy database at ${legacyPath} is ${legacySize} bytes. Continuing to use ` +
            `the legacy database; remove or repair the invalid durable file before ` +
            `restarting to complete the move (issue 24f0316).`,
        );
        return {
          dbPath: legacyPath,
          action: "kept-legacy",
          reason: `invalid-target: ${invalidReason}`,
        };
      }
    }
    return { dbPath: targetPath, action: "target-present" };
  }
  if (!fs.existsSync(legacyPath)) {
    return { dbPath: targetPath, action: "no-legacy" };
  }

  // Reading the real production database is exactly what the isolation guard
  // exists to stop, and a 7.5 GB copy is the worst possible way to discover a
  // test resolved the live path.
  assertNotProductionDbUnderTest(legacyPath);

  const sourceFiles = ["", ...DB_SIDECAR_SUFFIXES]
    .map((suffix) => ({ suffix, source: legacyPath + suffix }))
    .filter((entry) => fs.existsSync(entry.source));
  const requiredBytes =
    sourceFiles.reduce((total, entry) => total + fileSizeOrZero(entry.source), 0) +
    (options.headroomMarginBytes ?? COPY_FORWARD_HEADROOM_MARGIN_BYTES);

  const free = availableBytes(path.dirname(targetPath));
  if (free !== null && free < requiredBytes) {
    log(
      `[mandible] NOT relocating the ledger database to ${targetPath}: needs ` +
        `${requiredBytes} bytes free, filesystem has ${free}. Continuing to use ` +
        `${legacyPath}. Free space and restart to complete the move (issue 24f0316).`,
    );
    return {
      dbPath: legacyPath,
      action: "kept-legacy",
      reason: `insufficient-space: need ${requiredBytes}, have ${free}`,
    };
  }

  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(
    marker,
    `copy-forward started ${new Date().toISOString()} from ${legacyPath} (issue 24f0316)\n`,
    "utf8",
  );

  const copied: string[] = [];
  try {
    for (const entry of sourceFiles) {
      const destination = targetPath + entry.suffix;
      fs.copyFileSync(entry.source, destination);
      copied.push(destination);
      const sourceSize = fileSizeOrZero(entry.source);
      const destinationSize = fileSizeOrZero(destination);
      if (destinationSize !== sourceSize) {
        throw new Error(
          `size mismatch for ${destination}: copied ${destinationSize} of ${sourceSize} bytes`,
        );
      }
    }
    assertDbOpenable(targetPath);
  } catch (error) {
    removeDbFiles(targetPath);
    fs.rmSync(marker, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    log(
      `[mandible] failed to relocate the ledger database to ${targetPath}: ${detail}. ` +
        `Partial copies removed; continuing to use ${legacyPath} (issue 24f0316).`,
    );
    return { dbPath: legacyPath, action: "kept-legacy", reason: `copy-failed: ${detail}` };
  }

  fs.rmSync(marker, { force: true });

  // The source is retained on purpose. The receipt is the only thing written
  // back to the cache root, and it exists so a human who finds a 7.5 GB file
  // there knows it is a superseded copy rather than the live ledger.
  try {
    fs.writeFileSync(
      legacyPath + COPY_FORWARD_RECEIPT_SUFFIX,
      `This database was copied to ${targetPath} on ${new Date().toISOString()}.\n` +
        `Mandible now reads and writes the copy under the durable root (issue 24f0316).\n` +
        `These files are retained deliberately and are safe to delete once the new\n` +
        `location has been confirmed good.\n`,
      "utf8",
    );
  } catch {
    // A receipt we cannot write is not a reason to reject a verified copy.
  }

  log(
    `[mandible] relocated the ledger database from ${legacyPath} to ${targetPath} ` +
      `(${copied.length} file(s); originals retained, see ${legacyPath}${COPY_FORWARD_RECEIPT_SUFFIX}).`,
  );
  return { dbPath: targetPath, action: "copied", copied };
}

export function openDb(dbPath: string = getDbPath(), options: OpenDbOptions = {}): Db {
  assertNotProductionDbUnderTest(dbPath);

  // Legacy relocation runs only for the unconfigured default path. An explicit
  // MANDIBLE_DB (or any caller-supplied path) means the caller already decided
  // where the database lives, and moving bytes underneath that decision would
  // be a surprise.
  let effectivePath = dbPath;
  if (!process.env.MANDIBLE_DB && dbPath === getDefaultDbPath()) {
    effectivePath = copyForwardLegacyDb(dbPath, getLegacyCacheDbPath()).dbPath;
    if (effectivePath !== dbPath) {
      assertNotProductionDbUnderTest(effectivePath);
    }

    // Bug: 727a44b — one-time migration from the control-plane cache dir. Only
    // reachable when neither the durable nor the pre-split location has a
    // database, i.e. an install that predates both.
    if (!fs.existsSync(effectivePath)) {
      const oldPath = path.join(getUserHome(), ".cache", "control-plane", "control-plane.db");
      if (fs.existsSync(oldPath)) {
        assertNotProductionDbUnderTest(oldPath);
        ensureDir(path.dirname(effectivePath));
        try {
          fs.copyFileSync(oldPath, effectivePath);
          // Also copy WAL/SHM if present (preserves in-progress transactions)
          for (const ext of DB_SIDECAR_SUFFIXES) {
            if (fs.existsSync(oldPath + ext)) {
              fs.copyFileSync(oldPath + ext, effectivePath + ext);
            }
          }
        } catch {
          // Non-fatal: if copy fails, start fresh
        }
      }
    }
  }

  ensureDir(path.dirname(effectivePath));
  const db = new SqliteDatabase(effectivePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  applyColdStartTuning(db);
  migrate(db);
  return db;
}

/** Apply optional connection-local performance settings without weakening startup safety. */
export function applyColdStartTuning(db: Db): void {
  const pragmas = [
    `mmap_size = ${SQLITE_COLD_START_TUNING.mmapSizeBytes}`,
    `cache_size = -${SQLITE_COLD_START_TUNING.cacheSizeKib}`,
    `temp_store = ${SQLITE_COLD_START_TUNING.tempStore}`,
  ];
  for (const pragma of pragmas) {
    try {
      db.pragma(pragma);
    } catch {
      // These performance hints are optional across SQLite builds and filesystems.
    }
  }
}

// --- Singleton accessor for partition code ---

/**
 * How the current singleton binding was installed.
 * - `"opened"`: `getDb()` lazily opened the real database (the production path).
 * - `"set"`: a caller injected a database with `setDb()` (in practice, a test).
 */
export type DbBindingSource = "opened" | "set";

export interface DbBinding {
  db: Db | null;
  source: DbBindingSource | null;
  /** Non-null when the singleton was reset and any further `getDb()` must fail. */
  poisonReason: string | null;
}

let _db: Db | null = null;
let _dbSource: DbBindingSource | null = null;
let _dbPoisonReason: string | null = null;

export function getDb(dbPath?: string): Db {
  if (_dbPoisonReason) {
    throw new Error(
      `Mandible database singleton is unavailable: ${_dbPoisonReason}. ` +
        "A test reached the database after its lifecycle scope ended. Install a database " +
        "for this test with setDb()/withTestDb() instead of relying on a previous test's binding.",
    );
  }
  if (!_db) {
    _db = openDb(dbPath);
    _dbSource = "opened";
  }
  return _db;
}

export function setDb(db: Db): void {
  _db = db;
  _dbSource = "set";
  _dbPoisonReason = null;
}

/** Read the current singleton binding without installing or opening anything. */
export function inspectDbBinding(): DbBinding {
  return { db: _db, source: _dbSource, poisonReason: _dbPoisonReason };
}

/**
 * Test-only. Drop the singleton binding and, by default, leave a poisoned
 * sentinel behind so a later `getDb()` fails loudly instead of silently
 * opening the real database. `setDb()` clears the sentinel.
 *
 * This never closes the database — connection ownership stays with whoever
 * created it.
 */
export function resetDb(
  options: { reason?: string; poison?: boolean } = {},
): { cleared: boolean; source: DbBindingSource | null } {
  const cleared = _db !== null;
  const source = _dbSource;
  _db = null;
  _dbSource = null;
  _dbPoisonReason = options.poison === false
    ? null
    : options.reason ?? "the singleton was reset by the test harness";
  return { cleared, source };
}

/**
 * Test harness bridge. Vitest's setup file needs to reset the singleton after
 * every test without importing this module (and its native SQLite binding)
 * into test files that never touch a database. Publishing the hooks on
 * `globalThis` under VITEST keeps that backstop free for pure UI test files.
 */
if (process.env.VITEST) {
  (globalThis as Record<string, unknown>).__mandibleDbTestHooks = {
    inspectDbBinding,
    resetDb,
    setDb,
  };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Bug: caa157e — UUID prefix matching for CLI operations
export type PrefixResult =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "ambiguous"; count: number };

const PREFIX_IDENTIFIER_ALLOWLIST = new Set(["auth_requests.id", "sessions.id"]);

function requirePrefixIdentifier(table: string, idColumn: string): void {
  const key = `${table}.${idColumn}`;
  if (!PREFIX_IDENTIFIER_ALLOWLIST.has(key)) {
    throw new Error(`Unsupported prefix lookup identifier: ${key}`);
  }
}

/**
 * Resolve a UUID prefix to a full ID. If the prefix is already a full UUID
 * (36 chars), does an exact match. Otherwise, does a prefix match with LIKE.
 *
 * Returns the resolved full ID, or an error indicating not_found / ambiguous.
 */
export function resolvePrefix(
  db: Db,
  table: string,
  idColumn: string,
  prefix: string,
): PrefixResult {
  requirePrefixIdentifier(table, idColumn);
  // Full UUID: exact match (current behavior)
  if (prefix.length >= 36) {
    const row = db
      .prepare(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} = ?`)
      .get(prefix) as Record<string, unknown> | undefined;
    return row ? { ok: true, id: String(row[idColumn]) } : { ok: false, error: "not_found" };
  }

  // Prefix match: require at least 4 characters to avoid overly broad matches
  if (prefix.length < 4) {
    // Still try exact match for very short strings (unlikely to be a UUID but harmless)
    const row = db
      .prepare(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} = ?`)
      .get(prefix) as Record<string, unknown> | undefined;
    return row ? { ok: true, id: String(row[idColumn]) } : { ok: false, error: "not_found" };
  }

  // Escape any LIKE wildcards in the prefix
  const escaped = prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const rows = db
    .prepare(
      `SELECT ${idColumn} FROM ${table} WHERE ${idColumn} LIKE ? ESCAPE '\\' LIMIT 2`,
    )
    .all(`${escaped}%`) as Record<string, unknown>[];

  if (rows.length === 0) {
    return { ok: false, error: "not_found" };
  }
  if (rows.length > 1) {
    // Count the actual number of matches for the error message
    const countRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE ${idColumn} LIKE ? ESCAPE '\\'`,
      )
      .get(`${escaped}%`) as { cnt: number };
    return { ok: false, error: "ambiguous", count: countRow.cnt };
  }
  return { ok: true, id: String(rows[0][idColumn]) };
}
