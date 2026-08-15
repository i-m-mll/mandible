import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS } from "../src/db-migrations.js";
import { migrate, type Db } from "../src/db.js";

let db: Db;

function definitions(target: Db): Array<{ type: string; name: string; sql: string }> {
  return target.prepare(
    `SELECT type, name, sql FROM sqlite_master
      WHERE (name LIKE 'task_command_%' OR name LIKE '%task_command_events%')
        AND sql IS NOT NULL
      ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string; sql: string }>;
}

function rewindToV127(target: Db): void {
  target.exec(`
    DROP TABLE IF EXISTS task_command_events;
    DROP TABLE IF EXISTS task_command_requests;
    UPDATE meta SET value = '127' WHERE key = 'schema_version';
  `);
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

afterEach(() => db.close());

describe("migration 128 task disable command protocol", () => {
  it("upgrades v127 with immutable requests, append-only event storage, and no expiry", () => {
    expect(MIGRATIONS.find((entry) => entry.version === 128)?.name)
      .toBe("task_disable_command_protocol");
    rewindToV127(db);
    migrate(db);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "133" });

    const requestColumns = (db.prepare("PRAGMA table_info(task_command_requests)").all() as
      Array<{ name: string }>).map((column) => column.name);
    expect(requestColumns).toContain("request_digest");
    expect(requestColumns).toContain("requested_by_user_id");
    expect(requestColumns).not.toContain("state");
    expect(requestColumns).not.toContain("expires_at");

    const eventColumns = (db.prepare("PRAGMA table_info(task_command_events)").all() as
      Array<{ name: string }>).map((column) => column.name);
    expect(eventColumns).toContain("event_digest");
    expect(eventColumns).toContain("no_op");
    expect(eventColumns).toContain("rejection_reason");
    expect(eventColumns).toContain("actor_user_id");
  });

  it("matches the fresh baseline after a v127-to-v128 migration", () => {
    const baseline = definitions(db).map((row) => ({
      ...row,
      sql: row.sql.replace(/\s+/g, " ").trim(),
    }));
    rewindToV127(db);
    migrate(db);
    expect(definitions(db).map((row) => ({
      ...row,
      sql: row.sql.replace(/\s+/g, " ").trim(),
    }))).toEqual(baseline);
  });

  it("converges when migration 128 is replayed over existing tables", () => {
    db.prepare("UPDATE meta SET value = '127' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "133" });
  });
});
