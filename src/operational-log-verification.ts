import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";

const LEGACY_LOG_SCHEMA = "legacy_ledger";

type LegacyHighWaterState = {
  legacy_high_water_ts: number | null;
  legacy_high_water_id: string | null;
  legacy_high_water_rows: number | null;
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

function copyStateMatchesLegacy(db: Db, state: LegacyHighWaterState): boolean {
  if (state.legacy_high_water_rows === null) return false;
  const row = db.prepare(
    `SELECT ts, id FROM ${LEGACY_LOG_SCHEMA}.daemon_log ORDER BY ts DESC, id DESC LIMIT 1`,
  ).get() as { ts: number; id: string } | undefined;
  const count = db.prepare(
    `SELECT COUNT(*) AS count FROM ${LEGACY_LOG_SCHEMA}.daemon_log`,
  ).get() as { count: number };
  return (row?.ts ?? null) === state.legacy_high_water_ts
    && (row?.id ?? null) === state.legacy_high_water_id
    && count.count === state.legacy_high_water_rows;
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
      `SELECT completed_at, verified_at, legacy_high_water_ts, legacy_high_water_id, legacy_high_water_rows
       FROM operational_log_copy_state WHERE source_path = ?`,
    ).get(sourcePath) as ({ completed_at: number | null; verified_at: number | null } & LegacyHighWaterState) | undefined;
    return Boolean(state?.completed_at && state.verified_at && copyStateMatchesLegacy(db, state));
  } catch {
    return false;
  }
}
