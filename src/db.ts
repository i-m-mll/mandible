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

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "mandible");
const DEFAULT_DB_PATH = path.join(DEFAULT_CACHE_DIR, "mandible.db");

export function getDbPath(): string {
  return process.env.MANDIBLE_DB ?? DEFAULT_DB_PATH;
}

export function openDb(dbPath: string = getDbPath()): Db {
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
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

// --- Singleton accessor for partition code ---

let _db: Db | null = null;

export function getDb(dbPath?: string): Db {
  if (!_db) {
    _db = openDb(dbPath);
  }
  return _db;
}

export function setDb(db: Db): void {
  _db = db;
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
