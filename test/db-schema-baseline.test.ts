import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, openDb, type Db } from "../src/db.js";
import { startDaemon } from "../src/index.js";
import { checkHealth } from "../src/lifecycle.js";

const V1_FIXTURE = fs.readFileSync(
  path.join(process.cwd(), "test", "fixtures", "schema-v1.sql"),
  "utf8",
);

interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-schema-baseline-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createV1Database(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(V1_FIXTURE);
  } finally {
    db.close();
  }
}

function schemaVersion(db: Db): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined)?.value;
}

function normalizeSql(sql: string | null): string | null {
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

  return result.trim();
}

function sqliteMaster(db: Db): SqliteMasterRow[] {
  return (db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name, tbl_name`,
  ).all() as SqliteMasterRow[]).map((row) => ({
    ...row,
    sql: normalizeSql(row.sql),
  }));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableInfo(db: Db): Array<{ table: string; columns: TableInfoRow[] }> {
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

function settings(db: Db): Array<{ key: string; value: string }> {
  return db.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{
    key: string;
    value: string;
  }>;
}

function completedPostMigrations(db: Db): Array<{ key: string; value: string }> {
  return db.prepare(
    "SELECT key, value FROM meta WHERE key LIKE 'post_migration.%' ORDER BY key",
  ).all() as Array<{ key: string; value: string }>;
}

function builtinAuthHooks(db: Db): Array<Record<string, string | number>> {
  return db.prepare(
    `SELECT id, repo_pattern, auth_type, command, label, enabled, builtin, position
       FROM auth_hooks
      WHERE builtin = 1
      ORDER BY id`,
  ).all() as Array<Record<string, string | number>>;
}

function assertHealthyDatabase(db: Db): void {
  expect(CURRENT_SCHEMA_VERSION).toBe(150);
  expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
}

describe.sequential("fresh schema baseline", () => {
  it("matches a frozen v1 fixture after the complete supported migration replay", () => {
    const baselinePath = path.join(tempDir, "baseline.db");
    const migratedPath = path.join(tempDir, "migrated.db");
    createV1Database(migratedPath);

    const baseline = openDb(baselinePath);
    const migrated = openDb(migratedPath);
    try {
      assertHealthyDatabase(baseline);
      assertHealthyDatabase(migrated);
      expect(sqliteMaster(migrated)).toEqual(sqliteMaster(baseline));
      expect(tableInfo(migrated)).toEqual(tableInfo(baseline));
      expect(completedPostMigrations(migrated)).toEqual(completedPostMigrations(baseline));
      expect(settings(migrated)).toEqual(settings(baseline));
      expect(builtinAuthHooks(migrated)).toEqual(builtinAuthHooks(baseline));

      // The single seeded `system` user must be byte-identical on both paths,
      // across every column.
      const seededUsers = (db: Db) =>
        db.prepare(
          `SELECT id, slug, kind, display_name, email, status,
                  created_at, updated_at, metadata_json
             FROM users ORDER BY id`,
        ).all();
      expect(seededUsers(migrated)).toEqual(seededUsers(baseline));
      expect(seededUsers(baseline)).toEqual([
        {
          id: "00000000000000000000000000",
          slug: "system",
          kind: "system",
          display_name: "System",
          email: null,
          status: "active",
          created_at: 0,
          updated_at: 0,
          metadata_json: "{}",
        },
      ]);

      expect(migrated.prepare("SELECT app, status, task FROM sessions WHERE id = ?").get(
        "fixture-session-v1",
      )).toMatchObject({
        app: "codex",
        status: "ended",
        task: "Exercise historical schema replay",
      });
      expect(migrated.prepare(
        "SELECT session_id, title, status FROM auth_requests WHERE id = ?",
      ).get("fixture-auth-v1")).toEqual({
        session_id: "fixture-session-v1",
        title: "Fixture auth request",
        status: "dismissed",
      });
      expect(migrated.prepare(
        "SELECT branch, is_current, is_dirty FROM branches WHERE repo_root = ?",
      ).get("/tmp/mandible-fixture")).toEqual({
        branch: "main",
        is_current: 1,
        is_dirty: 0,
      });
    } finally {
      migrated.close();
      baseline.close();
    }
  });

  it("boots the daemon against fresh and production-shaped migrated databases", async () => {
    const cases = [
      { name: "fresh", dbPath: path.join(tempDir, "daemon-fresh.db"), fixture: false },
      { name: "migrated", dbPath: path.join(tempDir, "daemon-migrated.db"), fixture: true },
    ];

    for (const bootCase of cases) {
      if (bootCase.fixture) createV1Database(bootCase.dbPath);
      const daemon = await startDaemon({
        port: 0,
        dbPath: bootCase.dbPath,
        pidFilePath: path.join(tempDir, `${bootCase.name}.pid`),
        handleSignals: false,
      });
      try {
        expect(await checkHealth(daemon.port)).toMatchObject({ status: "ok", ready: true });
        assertHealthyDatabase(daemon.db);
        if (bootCase.fixture) {
          expect(daemon.db.prepare("SELECT status FROM sessions WHERE id = ?").get(
            "fixture-session-v1",
          )).toEqual({ status: "ended" });
        }
      } finally {
        await daemon.close();
      }
    }
  });
});
