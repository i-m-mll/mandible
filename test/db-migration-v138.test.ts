import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { BASELINE_SCHEMA_VERSION } from "../src/db-baseline.js";
import { migrate } from "../src/db.js";

describe("migration v138: durable conversation tags", () => {
  it("upgrades an actual v137 conversation table, migrates the legacy value, and retires label", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      ALTER TABLE conversations DROP COLUMN tags;
      ALTER TABLE conversations ADD COLUMN label TEXT;
      UPDATE meta SET value = '137' WHERE key = 'schema_version';
      INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        session_id, label, created_at, updated_at
      ) VALUES
        ('legacy-tagged', 'codex', '/tmp/tagged', 'a', 1, 'Provider title', '2026-08-16',
         'session-tagged', '  legacy star  ', '2026-08-16', '2026-08-16'),
        ('legacy-empty', 'claude_code', '/tmp/empty', 'b', 1, 'Other title', '2026-08-16',
         'session-empty', '   ', '2026-08-16', '2026-08-16');
    `);

    migrate(db);

    expect(BASELINE_SCHEMA_VERSION).toBe(141);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "141" });
    const columns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("tags");
    expect(columns.map((column) => column.name)).not.toContain("label");
    expect(db.prepare("SELECT id, tags FROM conversations ORDER BY id").all()).toEqual([
      { id: "legacy-empty", tags: "[]" },
      { id: "legacy-tagged", tags: '["legacy star"]' },
    ]);
    expect(() => db.prepare("UPDATE conversations SET tags = ? WHERE id = ?")
      .run("not-json", "legacy-tagged")).toThrow();
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    db.close();
  });

  it("fails closed when a rewound database already has a divergent tags column", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      ALTER TABLE conversations DROP COLUMN tags;
      ALTER TABLE conversations ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
      UPDATE meta SET value = '137' WHERE key = 'schema_version';
    `);

    expect(() => migrate(db)).toThrow(
      "migration 138 precondition: conversations.tags has a divergent definition",
    );
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "137" });
    db.close();
  });
});
