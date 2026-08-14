import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";

describe("migration v131 managed reminder occurrence acknowledgement", () => {
  it("replays safely when current-baseline columns already exist on a v130 rewind", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      db.exec(`
        DROP INDEX idx_managed_task_occurrences_inbox;
        UPDATE meta SET value = '130' WHERE key = 'schema_version';
      `);

      expect(() => migrate(db)).not.toThrow();
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toEqual({ value: String(CURRENT_SCHEMA_VERSION) });
      const columns = db.pragma("table_info(managed_task_occurrences)") as Array<{ name: string }>;
      expect(columns.filter((column) => column.name === "acknowledged_by")).toHaveLength(1);
      expect(columns.filter((column) => column.name === "acknowledged_at")).toHaveLength(1);
      expect(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get("idx_managed_task_occurrences_inbox")).toEqual({
        name: "idx_managed_task_occurrences_inbox",
      });
    } finally {
      db.close();
    }
  });
});
