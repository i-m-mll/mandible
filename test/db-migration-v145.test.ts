import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/db.js";
import { createUser } from "../src/users/store.js";

describe("migrations v145-v146: authenticated user settings", () => {
  it("adds user-owned settings without interpreting the global app rail value", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const user = createUser(db, { slug: "owner", kind: "human", display_name: "Owner" });
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('app_rail_order', 'global', 1)").run();
      db.prepare("DELETE FROM user_settings").run();
      db.prepare("DROP TABLE user_settings").run();
      db.prepare("UPDATE meta SET value = '144' WHERE key = 'schema_version'").run();

      migrate(db);

      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "147" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM user_settings").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT value FROM settings WHERE key = 'app_rail_order'").get()).toEqual({ value: "global" });
      expect(() => db.prepare(
        "INSERT INTO user_settings (user_id, key, value, revision, updated_at) VALUES (?, 'app_rail_order', 'x', 1, 1)",
      ).run("missing-user")).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare(
        "INSERT INTO user_settings (user_id, key, value, revision, updated_at) VALUES (?, 'other', 'x', 1, 1)",
      ).run(user.id)).toThrow(/CHECK/);
      expect(() => db.prepare(
        "INSERT INTO user_settings (user_id, key, value, revision, updated_at) VALUES (?, 'ui_font_face', 'system-ui', 1, 1)",
      ).run(user.id)).not.toThrow();
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
