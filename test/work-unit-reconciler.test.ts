import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDb, type Db } from "../src/db.js";
import type { Logger } from "../src/types.js";
import { computeWorkUnitLiveness, mapWorkUnitRow } from "../src/work-unit-utils.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";

let db: Db;
let logs: Array<{ level: string; event: string; data: Record<string, unknown> | undefined }>;

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
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
      provider TEXT,
      provider_session_id TEXT,
      worker_provider_session_id TEXT,
      activated_at INTEGER,
      auth_request_id TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0
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

describe("work unit reconciler", () => {
  it("runs a reconciliation sweep immediately on start", () => {
    db.prepare("INSERT INTO sessions (id, status) VALUES ('session-1', 'dead')").run();
    db.prepare(
      "INSERT INTO work_units (id, state, assigned_session_id) VALUES ('wu-1', 'open', 'session-1')",
    ).run();

    const activeReconciler = reconciler();
    activeReconciler.start();
    activeReconciler.stop();

    const row = db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-1'")
      .get() as { assigned_session_id: string | null };
    expect(row.assigned_session_id).toBeNull();
  });

  it("clears dead session assignments without changing the work unit state", () => {
    db.prepare("INSERT INTO sessions (id, status) VALUES (?, ?)").run("sess-dead", "dead");
    db.prepare(
      "INSERT INTO work_units (id, state, assigned_session_id) VALUES (?, ?, ?)",
    ).run("wu-open", "open", "sess-dead");

    reconciler().reconcile();

    expect(db.prepare("SELECT state, assigned_session_id FROM work_units WHERE id = ?").get("wu-open"))
      .toEqual({
        state: "open",
        assigned_session_id: null,
      });
    expect(logs[0]).toMatchObject({
      level: "info",
      event: "work_unit_reconcile",
      data: { dead_sessions_cleared: 1 },
    });
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

    reconciler().reconcile();

    const rows = db.prepare(
      "SELECT id, assigned_session_id FROM work_units ORDER BY id",
    ).all() as Array<{ id: string; assigned_session_id: string | null }>;
    expect(rows).toEqual([
      { id: "wu-1", assigned_session_id: "session-1" },
      { id: "wu-2", assigned_session_id: "session-1" },
    ]);
  });

  it("marks committed work abandoned only when it is not in the auth pipeline", () => {
    db.prepare(
      "INSERT INTO work_units (id, state, branch, repo_id, auth_request_id) VALUES (?, ?, ?, ?, ?)",
    ).run("wu-stale", "committed", "feature/deleted", "repo", null);
    db.prepare(
      "INSERT INTO work_units (id, state, branch, repo_id, auth_request_id) VALUES (?, ?, ?, ?, ?)",
    ).run("wu-auth", "committed", "feature/auth", "repo", "auth-1");

    reconciler().reconcile();

    expect(db.prepare("SELECT state FROM work_units WHERE id = ?").get("wu-stale")).toEqual({
      state: "abandoned",
    });
    expect(db.prepare("SELECT state FROM work_units WHERE id = ?").get("wu-auth")).toEqual({
      state: "committed",
    });
  });

  it("does not abandon a missing branch while its exact provider task is live", () => {
    db.prepare(
      `INSERT INTO work_units (
        id, state, branch, repo_id, provider, provider_session_id, worker_provider_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wu-live-provider",
      "committed",
      "feature/not-yet-scanned",
      "repo",
      "codex",
      "desktop-task",
      "desktop-task",
    );

    new WorkUnitReconciler(() => undefined, {
      sessionIsLive: (_database, id) => id === "desktop-task",
    }).reconcile();

    expect(db.prepare("SELECT state FROM work_units WHERE id = ?").get("wu-live-provider"))
      .toEqual({ state: "committed" });
  });

  it("projects work-unit liveness from the same exact provider identity", () => {
    const workUnit = mapWorkUnitRow({
      id: "wu-live-provider",
      issue_id: "issue",
      repo_id: "repo",
      branch: "feature/provider",
      kind: "solo",
      state: "committed",
      provider: "codex",
      provider_session_id: "desktop-task",
      worker_provider_session_id: "desktop-task",
    });
    const liveness = computeWorkUnitLiveness(db, workUnit, undefined, (_database, id) => ({
      supplied_id: id,
      mandible_session_id: null,
      console_session_id: null,
      provider_session_id: id,
      provider: "codex",
      mandible_status: null,
      console_status: null,
      last_activity: "2026-09-05T19:01:00Z",
      has_live_agent: true,
    }));

    expect(liveness).toEqual({
      has_live_agent: true,
      agent_session_id: "desktop-task",
      agent_status: "active",
      is_processing: false,
      last_activity: Date.parse("2026-09-05T19:01:00Z"),
    });
  });

  it("resolves a deleted branch from a successful same-project auth alias instead of abandoning it", () => {
    db.exec(`
      CREATE TABLE ledger_projects (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL, display_name TEXT NOT NULL,
        remote_identity TEXT NOT NULL, upstream_identity TEXT NOT NULL,
        namespace_policy TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE ledger_project_checkouts (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_repo_id TEXT,
        root TEXT NOT NULL, name TEXT NOT NULL, default_branch TEXT NOT NULL,
        remote_url TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE ledger_issues (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL,
        deleted_at INTEGER
      );
      CREATE TABLE auth_requests (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, head_branch TEXT,
        repo TEXT, cwd TEXT, target_repo_root TEXT, status TEXT NOT NULL,
        exit_code INTEGER, created_at INTEGER NOT NULL, resolved_at INTEGER,
        merge_finalized_at INTEGER
      );
      INSERT INTO ledger_projects VALUES (
        'project-dotfiles', 'dotfiles', 'dotfiles', 'example/dotfiles', '',
        'remote', 1, 1
      );
      INSERT INTO ledger_project_checkouts VALUES (
        'checkout-dotfiles', 'project-dotfiles', '.dotfiles', '/registered/dotfiles',
        '.dotfiles', 'main', '', 1, 1
      );
      INSERT INTO work_units (
        id, issue_id, repo_id, branch, state, created_at
      ) VALUES (
        'wu-delivered', 'dot123', 'dotfiles', 'feature/dot123', 'committed', 10
      );
      INSERT INTO auth_requests VALUES (
        'auth-dotfiles', 'merge', 'feature/dot123', '.dotfiles',
        '/registered/dotfiles', '/registered/dotfiles', 'completed', 0, 20, 30, 40
      );
    `);

    reconciler().reconcile();

    expect(db.prepare(
      "SELECT state, auth_request_id, resolved_at FROM work_units WHERE id = 'wu-delivered'",
    ).get()).toEqual({
      state: "resolved",
      auth_request_id: "auth-dotfiles",
      resolved_at: 30,
    });
  });

  it("auto-commits open work units whose branch is ahead of default", () => {
    db.prepare("INSERT INTO branches (branch, ahead_default) VALUES (?, ?)").run("feature/ahead", 2);
    db.prepare("INSERT INTO branches (branch, ahead_default) VALUES (?, ?)").run("feature/even", 0);
    db.prepare(
      "INSERT INTO work_units (id, state, branch) VALUES (?, ?, ?)",
    ).run("wu-ahead", "open", "feature/ahead");
    db.prepare(
      "INSERT INTO work_units (id, state, branch) VALUES (?, ?, ?)",
    ).run("wu-even", "open", "feature/even");

    reconciler().reconcile();

    expect(db.prepare("SELECT state, activated_at FROM work_units WHERE id = ?").get("wu-ahead"))
      .toEqual({
        state: "committed",
        activated_at: expect.any(Number),
      });
    expect(db.prepare("SELECT state, activated_at FROM work_units WHERE id = ?").get("wu-even"))
      .toEqual({
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
