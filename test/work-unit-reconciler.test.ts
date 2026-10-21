import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDb, type Db } from "../src/db.js";
import { createAuthCheckRepo, git } from "./helpers/auth-queue-fixtures.js";
import type { Logger } from "../src/types.js";
import { resolveSessionAlias, type SessionAliasResolution } from "../src/session-liveness.js";
import { computeWorkUnitLiveness, mapWorkUnitRow, type WorkUnitSessionResolver } from "../src/work-unit-utils.js";
import type { CodexThreadArchiver, WorkerThreadLiveness } from "../src/codex-thread-archive.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";

const recordingArchiver: CodexThreadArchiver = {
  archive: async () => undefined,
  unarchive: async () => undefined,
};

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
      repo_root TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL,
      ahead_default INTEGER DEFAULT 0,
      PRIMARY KEY (repo_root, branch)
    );

    CREATE TABLE worker_thread_archives (
      work_unit_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      archived_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_retry_at INTEGER,
      PRIMARY KEY (work_unit_id, thread_id)
    );

    CREATE TABLE ledger_issue_checkpoints (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  setDb(db);
  logs = [];
});

afterEach(() => {
  db.close();
});

describe("work unit reconciler", () => {
  it("runs a reconciliation sweep immediately on start", async () => {
    db.prepare("INSERT INTO sessions (id, status) VALUES ('session-1', 'dead')").run();
    db.prepare(
      "INSERT INTO work_units (id, state, assigned_session_id) VALUES ('wu-1', 'open', 'session-1')",
    ).run();

    const activeReconciler = reconciler();
    activeReconciler.start();
    await activeReconciler.stop();

    const row = db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-1'")
      .get() as { assigned_session_id: string | null };
    expect(row.assigned_session_id).toBeNull();
  });

  it("clears dead session assignments without changing the work unit state", async () => {
    db.prepare("INSERT INTO sessions (id, status) VALUES (?, ?)").run("sess-dead", "dead");
    db.prepare(
      "INSERT INTO work_units (id, state, assigned_session_id) VALUES (?, ?, ?)",
    ).run("wu-open", "open", "sess-dead");

    await reconciler().reconcile();

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

  it("rolls back a whole dead-session pass if one row fails", async () => {
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

    await reconciler().reconcile();

    const rows = db.prepare(
      "SELECT id, assigned_session_id FROM work_units ORDER BY id",
    ).all() as Array<{ id: string; assigned_session_id: string | null }>;
    expect(rows).toEqual([
      { id: "wu-1", assigned_session_id: "session-1" },
      { id: "wu-2", assigned_session_id: "session-1" },
    ]);
  });

  it("clears a finished Codex thread holder with no session row and keeps one holding its writer lock", async () => {
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL,
        source_path TEXT NOT NULL, cwd TEXT, branch TEXT, updated_at TEXT,
        ended_at TEXT, source_mtime REAL
      );
    `);
    const liveThread = "019a0000-0000-7000-8000-00000000000a";
    const finishedThread = "019a0000-0000-7000-8000-00000000000b";
    const unknownThread = "019a0000-0000-7000-8000-00000000000c";
    const conversation = db.prepare(
      "INSERT INTO conversations (id, source, session_id, source_path) VALUES (?, 'codex', ?, ?)",
    );
    conversation.run("conv-live", liveThread, `/rollouts/${liveThread}.jsonl`);
    conversation.run("conv-finished", finishedThread, `/rollouts/${finishedThread}.jsonl`);
    const unit = db.prepare(
      "INSERT INTO work_units (id, state, provider, assigned_session_id) VALUES (?, 'committed', 'codex', ?)",
    );
    unit.run("wu-live", liveThread);
    unit.run("wu-finished", finishedThread);
    unit.run("wu-unknown", unknownThread);

    await reconciler((database, id) => resolveSessionAlias(database, id, {
      readCodexTaskLiveness: (_sourcePath, threadId) => ({
        status: threadId === liveThread ? "live" : "not_live",
      }),
    })).reconcile();

    expect(db.prepare("SELECT id, state, assigned_session_id FROM work_units ORDER BY id").all()).toEqual([
      { id: "wu-finished", state: "committed", assigned_session_id: null },
      { id: "wu-live", state: "committed", assigned_session_id: liveThread },
      { id: "wu-unknown", state: "committed", assigned_session_id: unknownThread },
    ]);
    expect(logs[0]).toMatchObject({
      event: "work_unit_reconcile",
      data: { dead_sessions_cleared: 1, unknown_holders: 1 },
    });
  });

  it("abandons committed work only when Git confirms its branch is gone", async () => {
    const repo = createAuthCheckRepo();
    git(repo, ["branch", "feature/not-yet-scanned"]);
    const insert = db.prepare(
      "INSERT INTO work_units (id, state, branch, repo_id, auth_request_id) VALUES (?, 'committed', ?, ?, ?)",
    );
    insert.run("wu-gone", "feature/deleted", repo, null);
    insert.run("wu-uncached", "feature/not-yet-scanned", repo, null);
    insert.run("wu-auth", "feature/deleted", repo, "auth-1");
    insert.run("wu-unresolvable", "feature/deleted", "no-such-repo", null);

    await reconciler().reconcile();

    expect(db.prepare("SELECT id, state FROM work_units ORDER BY id").all()).toEqual([
      { id: "wu-auth", state: "committed" },
      { id: "wu-gone", state: "abandoned" },
      { id: "wu-uncached", state: "committed" },
      { id: "wu-unresolvable", state: "committed" },
    ]);
  });

  it("does not abandon a deleted branch while its exact provider task is live", async () => {
    const repo = createAuthCheckRepo();
    db.prepare(
      `INSERT INTO work_units (
        id, state, branch, repo_id, provider, provider_session_id, worker_provider_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wu-live-provider",
      "committed",
      "feature/deleted",
      repo,
      "codex",
      "desktop-task",
      "desktop-task",
    );

    await new WorkUnitReconciler(() => undefined, {
      archiver: recordingArchiver,
      resolveSession: (_database, id) => id === "desktop-task" ? liveCodexResolution(id) : null,
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
    const liveness = computeWorkUnitLiveness(db, workUnit, undefined, (_database, id) => liveCodexResolution(id));

    expect(liveness).toEqual({
      state: "live",
      agent_session_id: "desktop-task",
      agent_status: "active",
      is_processing: false,
      last_activity: Date.parse("2026-09-05T19:01:00Z"),
    });
  });

  it("resolves a deleted branch from a successful same-project auth alias instead of abandoning it", async () => {
    const repo = createAuthCheckRepo();
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
        'checkout-dotfiles', 'project-dotfiles', '.dotfiles', '${repo}',
        '.dotfiles', 'main', '', 1, 1
      );
      INSERT INTO work_units (
        id, issue_id, repo_id, branch, state, created_at
      ) VALUES (
        'wu-delivered', 'dot123', 'dotfiles', 'feature/dot123', 'committed', 10
      );
      INSERT INTO auth_requests VALUES (
        'auth-dotfiles', 'merge', 'feature/dot123', '.dotfiles',
        '${repo}', '${repo}', 'completed', 0, 20, 30, 40
      );
    `);

    await reconciler().reconcile();

    expect(db.prepare(
      "SELECT state, auth_request_id, resolved_at FROM work_units WHERE id = 'wu-delivered'",
    ).get()).toEqual({
      state: "resolved",
      auth_request_id: "auth-dotfiles",
      resolved_at: 30,
    });
  });

  it("auto-commits only the repository whose same-named branch is ahead", async () => {
    db.prepare("INSERT INTO branches (repo_root, branch, ahead_default) VALUES ('repo-b', 'feature/shared', 2)").run();
    const insert = db.prepare("INSERT INTO work_units (id, repo_id, branch, state) VALUES (?, ?, 'feature/shared', 'open')");
    insert.run('open-a', 'repo-a');
    insert.run('open-b', 'repo-b');
    await reconciler().reconcile();
    expect(db.prepare("SELECT id, state FROM work_units ORDER BY id").all()).toEqual([
      { id: 'open-a', state: 'open' }, { id: 'open-b', state: 'committed' },
    ]);
  });

  it("auto-commits open work units whose branch is ahead of default", async () => {
    db.prepare("INSERT INTO branches (branch, ahead_default) VALUES (?, ?)").run("feature/ahead", 2);
    db.prepare("INSERT INTO branches (branch, ahead_default) VALUES (?, ?)").run("feature/even", 0);
    db.prepare(
      "INSERT INTO work_units (id, state, branch) VALUES (?, ?, ?)",
    ).run("wu-ahead", "open", "feature/ahead");
    db.prepare(
      "INSERT INTO work_units (id, state, branch) VALUES (?, ?, ?)",
    ).run("wu-even", "open", "feature/even");

    await reconciler().reconcile();

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

  it("logs and swallows reconciliation failures", async () => {
    db.prepare("DROP TABLE work_units").run();

    await expect(reconciler().reconcile()).resolves.toBeUndefined();
    expect(logs[0]).toMatchObject({
      level: "warn",
      event: "work_unit_reconcile_failed",
    });
  });
});

describe("worker thread archival", () => {
  const archived: string[] = [];
  let now = 0;

  function archivingReconciler(options: {
    liveness?: Record<string, ReturnType<WorkerThreadLiveness>>;
    aliases?: Record<string, string>;
    archive?: (threadId: string) => Promise<void>;
  } = {}): WorkUnitReconciler {
    const logger: Logger = (level, event, data) => {
      logs.push({ level, event, data });
    };
    return new WorkUnitReconciler(logger, {
      archiver: {
        archive: options.archive ?? (async (threadId) => { archived.push(threadId); }),
        unarchive: async () => undefined,
      },
      threadLiveness: (_database, threadId) => options.liveness?.[threadId] ?? "stopped",
      resolveSession: (_database, id) => {
        const provider = options.aliases?.[id];
        return provider ? { ...liveCodexResolution(provider), supplied_id: id, mandible_session_id: id } : null;
      },
      now: () => now,
    });
  }

  function resolvedUnit(id: string, thread: string): void {
    db.prepare(
      "INSERT INTO work_units (id, state, worker_provider_session_id) VALUES (?, 'resolved', ?)",
    ).run(id, thread);
  }

  beforeEach(() => {
    archived.length = 0;
    now = 0;
  });

  it("archives a stopped worker thread once per resolved unit, with or without an auth request", async () => {
    resolvedUnit("wu-a", "thread-1");
    resolvedUnit("wu-b", "thread-1");
    db.prepare("UPDATE work_units SET auth_request_id = 'auth-1' WHERE id = 'wu-a'").run();

    await archivingReconciler().reconcile();
    await archivingReconciler().reconcile();
    expect(archived).toEqual(["thread-1"]);

    resolvedUnit("wu-c", "thread-1");
    await archivingReconciler().reconcile();
    expect(archived).toEqual(["thread-1", "thread-1"]);
  });

  it("leaves live, unknown, parent-role, and still-working threads alone", async () => {
    resolvedUnit("wu-live", "thread-live");
    resolvedUnit("wu-unknown", "thread-unknown");
    resolvedUnit("wu-parent", "thread-parent");
    resolvedUnit("wu-done", "thread-busy");
    db.prepare(
      "INSERT INTO work_units (id, state, assigned_session_id) VALUES ('wu-next', 'committed', 'mandible-session')",
    ).run();
    db.prepare(
      `INSERT INTO ledger_issue_checkpoints (id, kind, payload_json)
       VALUES ('chk', 'parent-role', '{"provider_session_id":"thread-parent"}')`,
    ).run();

    await archivingReconciler({
      liveness: { "thread-live": "live", "thread-unknown": "unknown" },
      aliases: { "mandible-session": "thread-busy" },
    }).reconcile();
    expect(archived).toEqual([]);

    await archivingReconciler({ aliases: { "mandible-session": "thread-busy" } }).reconcile();
    expect(archived).toEqual(["thread-live", "thread-unknown"]);
  });

  it("retries a failed archive with backoff and logs only the first failure and the recovery", async () => {
    resolvedUnit("wu-a", "thread-1");
    let failures = 2;
    const archive = async (threadId: string) => {
      if (failures-- > 0) throw new Error("codex unavailable");
      archived.push(threadId);
    };

    for (const at of [0, 30_000, 60_000, 90_000, 180_000]) {
      now = at;
      await archivingReconciler({ archive }).reconcile();
    }

    expect(archived).toEqual(["thread-1"]);
    expect(logs.filter((entry) => entry.event === "worker_thread_archive_failed").map((entry) => entry.level))
      .toEqual(["error"]);
    expect(logs.find((entry) => entry.event === "worker_thread_archived")?.data)
      .toEqual({ thread_id: "thread-1", recovered_after_attempts: 2 });
  });
});

function reconciler(resolveSession?: WorkUnitSessionResolver): WorkUnitReconciler {
  const logger: Logger = (level, event, data) => {
    logs.push({ level, event, data });
  };
  return new WorkUnitReconciler(logger, { archiver: recordingArchiver, resolveSession });
}

function liveCodexResolution(id: string): SessionAliasResolution {
  return {
    supplied_id: id,
    mandible_session_id: null,
    console_session_id: null,
    provider_session_id: id,
    provider: "codex",
    mandible_status: null,
    console_status: null,
    last_activity: "2026-09-05T19:01:00Z",
    liveness: "live",
  };
}
