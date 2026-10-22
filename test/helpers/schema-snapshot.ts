import fs from "node:fs";
import path from "node:path";
import { MINIMUM_SUPPORTED_SCHEMA_VERSION, migrate, type Db } from "../../src/db.js";
import SqliteDatabase from "../../src/sqlite.ts";

/**
 * Comparable views of a database's schema and seeded rows, shared by the
 * fresh-baseline and floor-fixture convergence checks.
 */

export interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * Collapse insignificant whitespace outside string, identifier, and bracket
 * quoting, so DDL written across several lines compares equal to the same DDL
 * on one line.
 */
export function normalizeSql(sql: string | null): string | null {
  if (sql === null) return null;

  let result = "";
  let pendingWhitespace = false;
  let quote: "'" | '"' | "`" | "]" | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote !== null) {
      result += char;
      if (char === quote) {
        if (quote !== "]" && sql[index + 1] === quote) {
          result += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (/\s/.test(char)) {
      pendingWhitespace = true;
      continue;
    }

    if (pendingWhitespace && result.length > 0) result += " ";
    pendingWhitespace = false;
    result += char;
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") quote = "]";
  }

  // SQLite quotes a simple table name after ALTER TABLE RENAME. The table
  // identity is also checked independently; this spelling has no DDL meaning.
  return result.trim().replace(/^(CREATE TABLE(?: IF NOT EXISTS)? )"([A-Za-z_][A-Za-z0-9_]*)"/, "$1$2");
}

export function sqliteMaster(db: Db): SqliteMasterRow[] {
  return (db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name, tbl_name`,
  ).all() as SqliteMasterRow[]).map((row) => ({ ...row, sql: normalizeSql(row.sql) }));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function tableInfo(db: Db): Array<{ table: string; columns: TableInfoRow[] }> {
  const tables = db.prepare(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  ).all() as Array<{ name: string }>;

  return tables.map(({ name }) => ({
    table: name,
    columns: db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as TableInfoRow[],
  }));
}

export function metaRows(db: Db): Array<{ key: string; value: string }> {
  return db.prepare("SELECT key, value FROM meta ORDER BY key").all() as Array<{
    key: string;
    value: string;
  }>;
}

export function settingsRows(db: Db): Array<{ key: string; value: string }> {
  return db.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{
    key: string;
    value: string;
  }>;
}

export function builtinAuthHooks(db: Db): Array<Record<string, string | number>> {
  return db.prepare(
    `SELECT id, repo_pattern, auth_type, command, label, enabled, builtin, position
       FROM auth_hooks
      WHERE builtin = 1
      ORDER BY id`,
  ).all() as Array<Record<string, string | number>>;
}

export function seededUsers(db: Db): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT id, slug, kind, display_name, email, status, created_at, updated_at, metadata_json
       FROM users ORDER BY id`,
  ).all() as Array<Record<string, unknown>>;
}

export function schemaVersion(db: Db): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined)?.value;
}

export const FLOOR_FIXTURE = fs.readFileSync(
  path.join(process.cwd(), "test", "fixtures", `schema-v${MINIMUM_SUPPORTED_SCHEMA_VERSION}.sql`),
  "utf8",
);

const fixtureSnapshots = new Map<number, Buffer>();

/**
 * A private in-memory database at `version`: the floor fixture moved forward by
 * the production runner. Each version is built once per test process from the
 * nearest one already built, so a caller pays only for the migrations it adds.
 * Migration tests live in test/db-migration-convergence.test.ts.
 */
export function migrateFixtureThrough(version: number): Db {
  if (version === MINIMUM_SUPPORTED_SCHEMA_VERSION) return new SqliteDatabase(":memory:").exec(FLOOR_FIXTURE);
  const nearest = Math.max(MINIMUM_SUPPORTED_SCHEMA_VERSION, ...[...fixtureSnapshots.keys()].filter((built) => built <= version));
  const db = nearest === MINIMUM_SUPPORTED_SCHEMA_VERSION
    ? new SqliteDatabase(":memory:").exec(FLOOR_FIXTURE)
    : SqliteDatabase.fromSnapshot(fixtureSnapshots.get(nearest)!);
  migrate(db, version);
  if (!fixtureSnapshots.has(version)) fixtureSnapshots.set(version, db.serialize());
  return db;
}
