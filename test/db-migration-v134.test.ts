import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";

describe("migration v134: console session run options", () => {
  it("hydrates existing rows with an empty object without changing other bytes", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      INSERT INTO console_sessions
        (id, label, command, args_json, env_json, created_at, updated_at)
      VALUES ('old', 'unchanged', 'claude', '[]', '{}', 1, 1);
      ALTER TABLE console_sessions DROP COLUMN run_options_json;
      UPDATE meta SET value = '133' WHERE key = 'schema_version';
    `);
    migrate(db);
    expect(db.prepare("SELECT id, label, run_options_json FROM console_sessions").get()).toEqual({
      id: "old", label: "unchanged", run_options_json: "{}",
    });
    db.close();
  });

  it("includes the constrained column in fresh databases", () => {
    const db = new Database(":memory:");
    migrate(db);
    const columns = db.prepare("PRAGMA table_info(console_sessions)").all() as Array<{ name: string; dflt_value: string }>;
    expect(columns.find((column) => column.name === "run_options_json")?.dflt_value).toBe("'{}'");
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='console_sessions'").get() as { sql: string }).sql;
    expect(sql).toContain("json_type(run_options_json) = 'object'");
  });
});
