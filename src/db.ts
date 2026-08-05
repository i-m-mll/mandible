import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertMigrationSequence,
  CURRENT_SCHEMA_VERSION,
  migrate,
} from "./db-migrations.js";
import type { Migration } from "./db-migrations.js";

export type Db = Database.Database;
export { assertMigrationSequence, CURRENT_SCHEMA_VERSION, migrate };
export type { Migration };

export const SQLITE_COLD_START_TUNING = Object.freeze({
  // better-sqlite3's bundled SQLite caps mmap just below 2 GiB.
  mmapSizeBytes: (2 * 1024 * 1024 * 1024) - (64 * 1024),
  cacheSizeKib: 256 * 1024,
  tempStore: "MEMORY",
});

export interface OpenDbOptions {
  busyTimeoutMs?: number;
}

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "mandible");
const DEFAULT_DB_PATH = path.join(DEFAULT_CACHE_DIR, "mandible.db");

export function getDbPath(): string {
  return process.env.MANDIBLE_DB ?? DEFAULT_DB_PATH;
}

// The guard anchors the production path on the REAL system home
// (os.userInfo().homedir, read from the password database) rather than
// os.homedir(), which honors a $HOME override. Tests routinely isolate by
// pointing HOME (and MANDIBLE_DB) at a throwaway temp home; that temp DB is not
// production and must be allowed, while the real user's ~/.cache database stays
// guarded regardless of $HOME. Falls back to os.homedir() only if userInfo is
// unavailable.
function realSystemHomeDir(): string {
  try {
    const info = os.userInfo();
    if (info && typeof info.homedir === "string" && info.homedir.length > 0) {
      return info.homedir;
    }
  } catch {
    // userInfo can throw on exotic platforms; fall back below.
  }
  return os.homedir();
}

export const PRODUCTION_DB_PATH = path.join(
  realSystemHomeDir(),
  ".cache",
  "mandible",
  "mandible.db",
);

// Issue 07edc0d — structural isolation guard. On 2026-07-23 an unmerged
// feature branch's schema migration executed against the live production
// database because a test-invoked code path opened the default DB path
// (inheriting the real HOME) instead of a fixture/temp path. This guard sits
// at the single DB-open chokepoint so no future test can repeat the leak
// regardless of which helper resolves the path: under the vitest test runner,
// opening the real production database path is refused. The daemon and normal
// CLI never run under vitest, so they are unaffected. The MANDIBLE_ALLOW_REAL_DB
// opt-out exists only as a deliberate escape hatch; no test sets it.
// This TypeScript guard is mirrored by a dependency-free CommonJS twin at
// cli/production-db-guard.cjs, which the bash-embedded node helper in
// cli/instructions.sh and the standalone .mjs maintenance scripts share so
// that every direct production-DB open bypassing openDb() applies the same
// refusal. Keep the two implementations in sync.
function isUnderTestRunner(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_WORKER_ID !== undefined ||
    process.env.NODE_ENV === "test"
  );
}

// Canonicalize to the real on-disk path so a symlink, relative segment, or
// case-insensitive alias cannot smuggle the production path past a string
// compare. Falls back to a resolved (non-real) path when the file does not
// exist yet.
function canonicalizePath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

// Same-file check by device+inode, which catches hard links and case-alias
// entries that resolve to the production bytes even when their canonical path
// strings differ. Returns false when either side is absent.
function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * True when `dbPath` refers to the production database file, whether by
 * canonical path equality or by pointing at the same on-disk bytes (symlink,
 * hard link, or case-insensitive alias). Exported for regression testing.
 */
export function resolvesToProductionDbPath(
  dbPath: string,
  productionPath: string = PRODUCTION_DB_PATH,
): boolean {
  if (canonicalizePath(dbPath) === canonicalizePath(productionPath)) return true;
  return sameFile(dbPath, productionPath);
}

export function assertNotProductionDbUnderTest(dbPath: string): void {
  if (process.env.MANDIBLE_ALLOW_REAL_DB === "1") return;
  if (!isUnderTestRunner()) return;
  if (resolvesToProductionDbPath(dbPath)) {
    throw new Error(
      `Refusing to open the production Mandible database under the test runner: ${canonicalizePath(PRODUCTION_DB_PATH)}. ` +
        `Tests must open an explicit temp/fixture path or an in-memory database, never the real DB. ` +
        `This guard prevents a test or test-invoked tool from executing schema migrations or writes ` +
        `against live data (issue 07edc0d). To deliberately override, set MANDIBLE_ALLOW_REAL_DB=1.`,
    );
  }
}

export function openDb(dbPath: string = getDbPath(), options: OpenDbOptions = {}): Db {
  assertNotProductionDbUnderTest(dbPath);
  // Bug: 727a44b — one-time migration from control-plane to mandible cache dir.
  // If the mandible DB doesn't exist yet but the old control-plane DB does, copy it.
  const shouldAttemptLegacyCopy = !process.env.MANDIBLE_DB && dbPath === DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath) && shouldAttemptLegacyCopy) {
    const oldPath = path.join(os.homedir(), ".cache", "control-plane", "control-plane.db");
    if (fs.existsSync(oldPath)) {
      ensureDir(path.dirname(dbPath));
      try {
        fs.copyFileSync(oldPath, dbPath);
        // Also copy WAL/SHM if present (preserves in-progress transactions)
        for (const ext of ["-wal", "-shm"]) {
          if (fs.existsSync(oldPath + ext)) {
            fs.copyFileSync(oldPath + ext, dbPath + ext);
          }
        }
      } catch {
        // Non-fatal: if copy fails, start fresh
      }
    }
  }

  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
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
