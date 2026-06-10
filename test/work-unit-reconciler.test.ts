import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDb } from "../src/db.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";
import type { Logger } from "../src/types.js";

let db: InstanceType<typeof Database>;
let logs: Array<{ level: string; event: string; data: Record<string, unknown> | undefined }>;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );

    CREATE TABLE work_units (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      assigned_session_id TEXT,
      branch TEXT,
      repo_id TEXT,
      auth_request_id TEXT,
      activated_at INTEGER
    );

    CREATE TABLE branches (
      branch TEXT PRIMARY KEY,
      ahead_default INTEGER DEFAULT 0
    );
  `);
  setDb(db);
  logs = [];
});

afterEach(() => {
  db.close();
});

describe("WorkUnitReconciler", () => {
  it("clears dead session assignments without changing the work unit state", () => {
    db.prepare("INSERT INTO sessions (id, status) VALUES (?, ?)").run("sess-dead", "dead");
    db.prepare(
      "INSERT INTO work_units (id, state, assigned_session_id) VALUES (?, ?, ?)"
    ).run("wu-open", "open", "sess-dead");

    reconciler().reconcile();

    expect(db.prepare("SELECT state, assigned_session_id FROM work_units WHERE id = ?").get("wu-open")).toEqual({
      state: "open",
      assigned_session_id: null,
    });
    expect(logs[0]).toMatchObject({
      level: "info",
      event: "work_unit_reconcile",
      data: { dead_sessions_cleared: 1 },
    });
  });

  it("marks committed work abandoned only when it is not in the auth pipeline", () => {
    db.prepare(
      "INSERT INTO work_units (id, state, branch, repo_id, auth_request_id) VALUES (?, ?, ?, ?, ?)"
    ).run("wu-stale", "committed", "feature/deleted", "repo", null);
    db.prepare(
      "INSERT INTO work_units (id, state, branch, repo_id, auth_request_id) VALUES (?, ?, ?, ?, ?)"
    ).run("wu-auth", "committed", "feature/auth", "repo", "auth-1");

    reconciler().reconcile();

    expect(db.prepare("SELECT state FROM work_units WHERE id = ?").get("wu-stale")).toEqual({
      state: "abandoned",
    });
    expect(db.prepare("SELECT state FROM work_units WHERE id = ?").get("wu-auth")).toEqual({
      state: "committed",
    });
  });

  it("auto-commits open work units whose branch is ahead of default", () => {
    db.prepare("INSERT INTO branches (branch, ahead_default) VALUES (?, ?)").run("feature/ahead", 2);
    db.prepare("INSERT INTO branches (branch, ahead_default) VALUES (?, ?)").run("feature/even", 0);
    db.prepare(
      "INSERT INTO work_units (id, state, branch) VALUES (?, ?, ?)"
    ).run("wu-ahead", "open", "feature/ahead");
    db.prepare(
      "INSERT INTO work_units (id, state, branch) VALUES (?, ?, ?)"
    ).run("wu-even", "open", "feature/even");

    reconciler().reconcile();

    expect(db.prepare("SELECT state, activated_at FROM work_units WHERE id = ?").get("wu-ahead")).toEqual({
      state: "committed",
      activated_at: expect.any(Number),
    });
    expect(db.prepare("SELECT state, activated_at FROM work_units WHERE id = ?").get("wu-even")).toEqual({
      state: "open",
      activated_at: null,
    });
  });

  it("logs and swallows reconciliation failures", () => {
    db.prepare("DROP TABLE work_units").run();

    expect(() => reconciler().reconcile()).not.toThrow();
    expect(logs[0]).toMatchObject({
      level: "warn",
      event: "work_unit_reconcile_failed",
    });
  });
});

function reconciler(): WorkUnitReconciler {
  const logger: Logger = (level, event, data) => {
    logs.push({ level, event, data });
  };
  return new WorkUnitReconciler(logger);
}
