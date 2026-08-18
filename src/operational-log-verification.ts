import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";

const LEGACY_LOG_SCHEMA = "legacy_ledger";

type LegacyGenerationState = {
  legacy_generation_rowid: number | null;
};

function canonicalExistingPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function attachedLegacySourcePath(db: Db): string | null {
  const row = (db.pragma("database_list") as Array<{ name: string; file: string }>)
    .find((database) => database.name === LEGACY_LOG_SCHEMA);
  return row?.file ? canonicalExistingPath(row.file) : null;
}

function copyStateMatchesLegacy(db: Db, state: LegacyGenerationState): boolean {
  if (state.legacy_generation_rowid === null) return false;
  const row = db.prepare(
    `SELECT COALESCE(MAX(rowid), 0) AS generation_rowid
     FROM ${LEGACY_LOG_SCHEMA}.daemon_log`,
  ).get() as { generation_rowid: number };
  return Number(row.generation_rowid) === state.legacy_generation_rowid;
}

/**
 * Read-only verification shared by the logger and operational-log tooling.
 * Kept outside operational-log-db.ts so daemon initialization does not import
 * the primary DB module through a circular runtime dependency.
 */
export function hasCurrentOperationalLogVerification(db: Db): boolean {
  try {
    const sourcePath = attachedLegacySourcePath(db);
    if (!sourcePath) return false;
    const state = db.prepare(
      `SELECT completed_at, verified_at, legacy_generation_rowid
       FROM operational_log_copy_state WHERE source_path = ?`,
    ).get(sourcePath) as ({ completed_at: number | null; verified_at: number | null } & LegacyGenerationState) | undefined;
    return Boolean(state?.completed_at && state.verified_at && copyStateMatchesLegacy(db, state));
  } catch {
    return false;
  }
}
