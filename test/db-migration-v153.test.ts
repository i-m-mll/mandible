import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate, type Db } from "../src/db.js";

describe("migration v153", () => {
  it("adds nullable Briefing archive and group-current state without reinterpreting proposals", () => {
    const db = new Database(":memory:") as Db;
    migrate(db);
    db.exec(`
      DROP INDEX idx_briefing_groups_current_bundle;
      ALTER TABLE briefing_groups DROP COLUMN current_bundle_id;
      ALTER TABLE briefings DROP COLUMN archived_at;
      UPDATE meta SET value = '152' WHERE key = 'schema_version';
    `);
    db.prepare("INSERT INTO briefing_bundles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("proposal", "Proposal", 1, 1);
    db.prepare("INSERT INTO briefing_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("legacy-group", "Legacy", 1, 1);
    db.prepare(`INSERT INTO briefing_group_updates
      (group_id, bundle_id, position, created_at) VALUES (?, ?, ?, ?)`)
      .run("legacy-group", "proposal", 0, 1);

    migrate(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(158);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "158" });
    expect(db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = 'legacy-group'").get())
      .toEqual({ current_bundle_id: null });
    expect(db.prepare("SELECT bundle_id, position FROM briefing_group_updates WHERE group_id = 'legacy-group'").all())
      .toEqual([{ bundle_id: "proposal", position: 0 }]);
    expect(db.prepare("PRAGMA table_info(briefings)").all()).toContainEqual(expect.objectContaining({
      name: "archived_at", notnull: 0,
    }));
    db.close();
  });
});
