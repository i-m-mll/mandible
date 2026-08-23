import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate, type Db } from "../src/db.js";

describe("migration v150", () => {
  it("adds the optional exact Briefing comparison-base identity to a v149 database", () => {
    const db = new Database(":memory:") as Db;
    migrate(db);
    db.exec(`DROP INDEX idx_briefing_rounds_comparison_base`);
    db.exec(`ALTER TABLE briefing_rounds DROP COLUMN comparison_base_artifact_version_id`);
    db.prepare("UPDATE meta SET value = '149' WHERE key = 'schema_version'").run();

    migrate(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(154);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "154" });
    expect(db.prepare("PRAGMA table_info(briefing_rounds)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "comparison_base_artifact_version_id", notnull: 0 }),
    ]));
    expect(db.prepare("PRAGMA index_list(briefing_rounds)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_briefing_rounds_comparison_base" }),
    ]));
    db.close();
  });
});
