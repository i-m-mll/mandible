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
import { getMandibleHome, getUserHome } from "./platform-paths.js";

export const OPERATIONAL_LOG_DB_FILENAME = "operational-logs.db";
export const OPERATIONAL_LOG_BACKUP_CLASSIFICATION = "excluded-runtime-telemetry" as const;

const OPERATIONAL_LOG_SCHEMA = `
  DROP TABLE IF EXISTS operational_log_copy_state;
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
  DROP INDEX IF EXISTS idx_daemon_log_facets;
  CREATE INDEX IF NOT EXISTS idx_daemon_log_subsystem
    ON daemon_log(subsystem, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_daemon_log_event
    ON daemon_log(event, ts DESC);
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
`;

export interface OperationalLogStore {
  db: Db;
  dbPath: string;
  close(): void;
}

export interface OpenOperationalLogStoreOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  readonly?: boolean;
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
    } else {
      db.pragma("query_only = ON");
    }

    return {
      db,
      dbPath,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function expandHome(value: string): string {
  if (value === "~") return getUserHome();
  if (value.startsWith("~/")) return path.join(getUserHome(), value.slice(2));
  return value;
}
