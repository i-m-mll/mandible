import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { BASELINE_SCHEMA_VERSION } from "../src/db-baseline.js";
import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";
import { METADATA_BACKUP_TABLES } from "../src/ledger/backup.js";

describe("migration v155: scoped protected-merge clearances", () => {
  it("converges the baseline, migration, and backup contract", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(BASELINE_SCHEMA_VERSION).toBe(156);
    expect(CURRENT_SCHEMA_VERSION).toBe(156);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "156" });
    expect(db.prepare("PRAGMA table_info(auth_requests)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "requester_evidence_method", type: "TEXT" }),
      expect.objectContaining({ name: "requester_credential_id", type: "TEXT" }),
      expect.objectContaining({ name: "clearance_use_id", type: "TEXT" }),
    ]));
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('auth_clearances','auth_clearance_uses') ORDER BY name",
    ).all()).toEqual([{ name: "auth_clearance_uses" }, { name: "auth_clearances" }]);
    expect(db.prepare("PRAGMA table_info(auth_clearances)").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "consumed_uses" })]));
    expect(METADATA_BACKUP_TABLES).toEqual(expect.arrayContaining(["auth_clearances", "auth_clearance_uses"]));
    expect(METADATA_BACKUP_TABLES.indexOf("auth_clearances"))
      .toBeLessThan(METADATA_BACKUP_TABLES.indexOf("auth_clearance_uses"));
    expect(METADATA_BACKUP_TABLES).not.toContain("delegated_signing_runtime_bindings");
    db.close();
  });

  it("upgrades v154 idempotently without backfilling provenance or grants", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      DROP TRIGGER auth_requests_clearance_review_frozen;
      ALTER TABLE auth_requests DROP COLUMN clearance_use_id;
      ALTER TABLE auth_requests DROP COLUMN requester_credential_id;
      ALTER TABLE auth_requests DROP COLUMN requester_evidence_method;
      DROP TRIGGER auth_clearance_uses_immutable;
      DROP TRIGGER auth_clearances_scope_immutable;
      DROP TABLE auth_clearance_uses;
      DROP TABLE auth_clearances;
      UPDATE meta SET value = '154' WHERE key = 'schema_version';
    `);
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM auth_clearances").get()).toEqual({ count: 0 });
    db.prepare("UPDATE meta SET value = '154' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "156" });
    db.close();
  });

  it("upgrades v155 with an empty local-only reconnect binding table", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      DROP INDEX idx_delegated_signing_runtime_owner;
      DROP TABLE delegated_signing_runtime_bindings;
      UPDATE meta SET value = '155' WHERE key = 'schema_version';
    `);
    migrate(db);
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegated_signing_runtime_bindings'",
    ).get()).toEqual({ name: "delegated_signing_runtime_bindings" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM delegated_signing_runtime_bindings").get())
      .toEqual({ count: 0 });
    db.close();
  });
});
