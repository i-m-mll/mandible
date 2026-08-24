import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";
import { METADATA_BACKUP_TABLES } from "../src/ledger/backup.js";

describe("migration v130-v131 managed reminder core and Inbox acknowledgement", () => {
  it("installs the constrained immutable reminder schema in the fresh baseline", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
expect(CURRENT_SCHEMA_VERSION).toBe(156);
      const tables = db.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'managed_task%'
          ORDER BY name`,
      ).pluck().all();
      expect(tables).toEqual([
        "managed_task_create_requests",
        "managed_task_events",
        "managed_task_occurrences",
        "managed_task_revisions",
        "managed_tasks",
      ]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(METADATA_BACKUP_TABLES).toEqual(expect.arrayContaining([
        "auth_request_merge_succeeded_facts",
        "managed_tasks",
        "managed_task_revisions",
        "managed_task_create_requests",
        "managed_task_occurrences",
        "managed_task_events",
      ]));
      const backupIndex = (table: string) => METADATA_BACKUP_TABLES.indexOf(table as never);
      expect(backupIndex("auth_request_merge_succeeded_facts"))
        .toBeGreaterThan(backupIndex("ledger_projects"));
      expect(backupIndex("managed_tasks"))
        .toBeGreaterThan(backupIndex("auth_request_merge_succeeded_facts"));
      expect(db.pragma("table_info(managed_task_occurrences)")).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "acknowledged_by", type: "TEXT" }),
        expect.objectContaining({ name: "acknowledged_at", type: "INTEGER" }),
      ]));
    } finally {
      db.close();
    }
  });

  it("migrates an existing v129 database to the same table contract", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const objectSql = () => db.prepare(
        `SELECT type, name, tbl_name, replace(replace(replace(sql, char(10), ' '), char(13), ' '), char(9), ' ') AS sql
           FROM sqlite_master
          WHERE (name LIKE 'managed_task%' OR name LIKE 'trg_managed_task%')
            AND sql IS NOT NULL
          ORDER BY type, name`,
      ).all();
      const baseline = objectSql();
      db.exec(`
        DROP TRIGGER trg_managed_task_active_revision_immutable;
        DROP TRIGGER trg_managed_task_revision_matches_task;
        DROP TRIGGER trg_managed_task_revisions_immutable_delete;
        DROP TRIGGER trg_managed_task_revisions_immutable_update;
        DROP TABLE managed_task_events;
        DROP TABLE managed_task_occurrences;
        DROP TABLE managed_task_create_requests;
        DROP TABLE managed_task_revisions;
        DROP TABLE managed_tasks;
        UPDATE meta SET value = '129' WHERE key = 'schema_version';
      `);
      migrate(db);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
.toEqual({ value: "156" });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'managed_task%'",
      ).get()).toEqual({ count: 5 });
      expect(objectSql()).toEqual(baseline);
    } finally {
      db.close();
    }
  });
});
