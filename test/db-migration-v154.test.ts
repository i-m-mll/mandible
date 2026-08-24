import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { BASELINE_SCHEMA_VERSION } from "../src/db-baseline.js";
import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";

describe("migration v154: explicit work-unit worker ownership", () => {
  it("keeps the fresh baseline and migration head converged", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(BASELINE_SCHEMA_VERSION).toBe(155);
    expect(CURRENT_SCHEMA_VERSION).toBe(155);
    expect(db.prepare("PRAGMA table_info(work_units)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worker_provider_session_id",
          type: "TEXT",
          notnull: 0,
          dflt_value: null,
        }),
      ]),
    );
    db.close();
  });

  it("upgrades v153 idempotently without backfilling ambient identity", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      ALTER TABLE work_units DROP COLUMN worker_provider_session_id;
      INSERT INTO work_units (
        id, issue_id, repo_id, kind, state, provider, provider_session_id, created_at
      ) VALUES (
        'ambient-only', 'issue-a', 'mandible', 'solo', 'resolved', 'codex',
        'coordinator-thread', 1
      );
      UPDATE meta SET value = '153' WHERE key = 'schema_version';
    `);

    migrate(db);
    expect(db.prepare(
      "SELECT provider_session_id, worker_provider_session_id FROM work_units WHERE id = 'ambient-only'",
    ).get()).toEqual({
      provider_session_id: "coordinator-thread",
      worker_provider_session_id: null,
    });
    db.prepare("UPDATE meta SET value = '153' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "155" });
    db.close();
  });
});
