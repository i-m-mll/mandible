import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";

describe("migration v158: Briefing group promotion history", () => {
  it("adds disposition custody and the declarative auth action kind", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(CURRENT_SCHEMA_VERSION).toBe(158);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "158" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("briefing_group_dispositions")).toEqual({ name: "briefing_group_dispositions" });
    const actionSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_request_actions'",
    ).get() as { sql: string }).sql;
    expect(actionSql).toContain("briefing_group_promote");
    db.close();
  });
});
