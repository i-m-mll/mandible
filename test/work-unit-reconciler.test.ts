import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDb, type Db } from "../src/db.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE work_units (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL DEFAULT '',
      repo_id TEXT NOT NULL DEFAULT '',
      branch TEXT,
      state TEXT NOT NULL,
      assigned_session_id TEXT,
      activated_at INTEGER,
      auth_request_id TEXT
    );
    CREATE TABLE branches (
      branch TEXT PRIMARY KEY,
      ahead_default INTEGER DEFAULT 0
    );
  `);
  setDb(db);
});

afterEach(() => {
  db.close();
});

describe("work unit reconciler", () => {
  it("runs a reconciliation sweep immediately on start", () => {
    db.prepare("INSERT INTO sessions (id, status) VALUES ('session-1', 'dead')").run();
    db.prepare(
      "INSERT INTO work_units (id, state, assigned_session_id) VALUES ('wu-1', 'open', 'session-1')",
    ).run();

    const reconciler = new WorkUnitReconciler(() => undefined);
    reconciler.start();
    reconciler.stop();

    const row = db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-1'")
      .get() as { assigned_session_id: string | null };
    expect(row.assigned_session_id).toBeNull();
  });

  it("rolls back a whole dead-session pass if one row fails", () => {
    db.prepare("INSERT INTO sessions (id, status) VALUES ('session-1', 'dead')").run();
    db.prepare(
      "INSERT INTO work_units (id, state, assigned_session_id) VALUES ('wu-1', 'open', 'session-1')",
    ).run();
    db.prepare(
      "INSERT INTO work_units (id, state, assigned_session_id) VALUES ('wu-2', 'open', 'session-1')",
    ).run();
    db.exec(`
      CREATE TRIGGER abort_wu_2_dead_session_clear
      BEFORE UPDATE OF assigned_session_id ON work_units
      WHEN OLD.id = 'wu-2'
      BEGIN
        SELECT RAISE(ABORT, 'simulated crash');
      END;
    `);

    const reconciler = new WorkUnitReconciler(() => undefined);
    reconciler.reconcile();

    const rows = db.prepare(
      "SELECT id, assigned_session_id FROM work_units ORDER BY id",
    ).all() as Array<{ id: string; assigned_session_id: string | null }>;
    expect(rows).toEqual([
      { id: "wu-1", assigned_session_id: "session-1" },
      { id: "wu-2", assigned_session_id: "session-1" },
    ]);
  });
});
