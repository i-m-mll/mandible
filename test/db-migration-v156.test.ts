import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate, type Db } from "../src/db.js";

describe("migration v156", () => {
  it("adds an optional bounded description without changing existing Briefings", () => {
    const db = new Database(":memory:") as Db;
    migrate(db);
    db.exec("ALTER TABLE briefings DROP COLUMN description");
    db.prepare("INSERT INTO briefings (id, briefing_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("briefing-1", "existing", "Existing Briefing", 1, 1);
    db.prepare("UPDATE meta SET value = '155' WHERE key = 'schema_version'").run();

    migrate(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(156);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "156" });
    expect(db.prepare("SELECT id, title, description FROM briefings").all()).toEqual([
      { id: "briefing-1", title: "Existing Briefing", description: null },
    ]);
    expect(() => db.prepare("UPDATE briefings SET description = '' WHERE id = ?").run("briefing-1")).toThrow();
    expect(() => db.prepare("UPDATE briefings SET description = ? WHERE id = ?")
      .run("x".repeat(1_001), "briefing-1")).toThrow();
    db.close();
  });
});
