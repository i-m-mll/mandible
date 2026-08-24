import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate, type Db } from "../src/db.js";

describe("migration v151", () => {
  it("adds named Briefing bundles and ordered membership to a v150 database", () => {
    const db = new Database(":memory:") as Db;
    migrate(db);
    db.exec(`
      DROP TABLE briefing_bundle_members;
      DROP TABLE briefing_bundles;
      UPDATE meta SET value = '150' WHERE key = 'schema_version';
    `);

    migrate(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(155);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "155" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'briefing_bundle%'").all())
      .toEqual([{ name: "briefing_bundles" }, { name: "briefing_bundle_members" }]);
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'briefing_bundle_members'")
      .get() as { sql: string }).sql).toContain("UNIQUE(bundle_id, layout_position, subgroup_position)");
    db.close();
  });
});
