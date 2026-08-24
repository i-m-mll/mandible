import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";

describe("migration v157: delegated signer runtime reconnect", () => {
  it("adds an empty local-only reconnect binding table", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      DROP INDEX idx_delegated_signing_runtime_owner;
      DROP TABLE delegated_signing_runtime_bindings;
      UPDATE meta SET value = '156' WHERE key = 'schema_version';
    `);

    migrate(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(157);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "157" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegated_signing_runtime_bindings'",
    ).get()).toEqual({ name: "delegated_signing_runtime_bindings" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM delegated_signing_runtime_bindings").get())
      .toEqual({ count: 0 });
    db.close();
  });
});
