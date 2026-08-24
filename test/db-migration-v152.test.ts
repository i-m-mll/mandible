import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate, type Db } from "../src/db.js";

describe("migration v152", () => {
  it("migrates flat bundle members into direct canonical layout entries and adds stable groups", () => {
    const db = new Database(":memory:") as Db;
    migrate(db);
    db.exec(`
      DROP TABLE briefing_group_updates;
      DROP TABLE briefing_groups;
      ALTER TABLE briefing_bundle_members RENAME TO briefing_bundle_members_v152;
      CREATE TABLE briefing_bundle_members (
        bundle_id TEXT NOT NULL REFERENCES briefing_bundles(id) ON DELETE RESTRICT,
        briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK(position >= 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(bundle_id, briefing_id),
        UNIQUE(bundle_id, position)
      );
      DROP TABLE briefing_bundle_members_v152;
      UPDATE meta SET value = '151' WHERE key = 'schema_version';
    `);
    db.prepare("INSERT INTO briefings (id, briefing_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("briefing-a", "a", "A", 1, 1);
    db.prepare("INSERT INTO briefing_bundles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("bundle-a", "Bundle", 1, 1);
    db.prepare("INSERT INTO briefing_bundle_members (bundle_id, briefing_id, position, created_at) VALUES (?, ?, ?, ?)")
      .run("bundle-a", "briefing-a", 0, 1);

    migrate(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(156);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "156" });
    expect(db.prepare(`SELECT briefing_id, layout_position, entry_kind, subgroup_name, subgroup_position
      FROM briefing_bundle_members`).get()).toEqual({
      briefing_id: "briefing-a", layout_position: 0, entry_kind: "briefing", subgroup_name: null,
      subgroup_position: 0,
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'briefing_group%'").all())
      .toEqual([{ name: "briefing_groups" }, { name: "briefing_group_updates" }]);
    db.close();
  });
});
