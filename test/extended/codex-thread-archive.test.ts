import SqliteDatabase from "../../src/sqlite.ts";
import { describe, expect, it } from "vitest";

import {
  CodexCliThreadArchiver,
  listCompletedWorkerThreadArchiveCandidates,
  safeArchiveCodexThread,
} from "../../src/codex-thread-archive.js";
import type { AuthRequest } from "../../src/types.js";

interface ExecCall {
  file: string;
  args: string[];
  options: {
    input?: string | Buffer;
    stdio?: unknown;
    timeout?: number;
  };
}

function requestFor(issueRef: string): AuthRequest {
  return {
    id: "auth-1",
    type: "merge",
    issues: [],
    issue_closures: [issueRef],
  } as AuthRequest;
}

function createWorkUnitsOnlyDb(): InstanceType<typeof SqliteDatabase> {
  const db = new SqliteDatabase(":memory:");
  db.exec(`
    CREATE TABLE work_units (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      ledger_issue_id TEXT,
      state TEXT NOT NULL,
      assigned_session_id TEXT,
      provider TEXT,
      provider_session_id TEXT,
      worker_provider_session_id TEXT,
      auth_request_id TEXT
    )
  `);
  return db;
}

function createMockExec(response: string | Buffer = "") {
  const calls: ExecCall[] = [];
  const exec = ((file: string, args: string[], options: ExecCall["options"]) => {
    calls.push({ file, args: [...args], options });
    return response;
  }) as unknown as typeof import("node:child_process").execFile;
  return { exec, calls };
}

describe("Codex CLI thread archiver", () => {
  it("archives through the top-level Codex CLI command", async () => {
    const { exec, calls } = createMockExec();
    const archiver = new CodexCliThreadArchiver(exec);

    await archiver.archive("thread-123");

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("codex");
    expect(calls[0].args).toEqual(["archive", "thread-123"]);
    expect(calls[0].args).not.toEqual(["app-server", "proxy"]);
    expect(calls[0].options.input).toBeUndefined();
    // Issue 75f52ac moved archiving to promisified execFile; it passes only a
    // timeout and no longer sets stdio: "pipe" (that was an execFileSync option).
    expect(calls[0].options.stdio).toBeUndefined();
    expect(calls[0].options.timeout).toBe(15_000);
  });

  it("unarchives through the top-level Codex CLI command", async () => {
    const { exec, calls } = createMockExec();
    const archiver = new CodexCliThreadArchiver(exec);

    await archiver.unarchive("thread-456");

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("codex");
    expect(calls[0].args).toEqual(["unarchive", "thread-456"]);
    expect(calls[0].args).not.toEqual(["app-server", "proxy"]);
    expect(calls[0].options.input).toBeUndefined();
  });

  it("keeps archive failures behind the safe wrapper", async () => {
    const exec = (() => {
      throw new Error("codex archive failed");
    }) as unknown as typeof import("node:child_process").execFile;
    const logs: string[] = [];

    expect(await safeArchiveCodexThread(
      new CodexCliThreadArchiver(exec),
      "thread-789",
      (message) => logs.push(message),
    )).toBe(false);

    expect(logs).toEqual([
      "[codex-thread-archive] failed to archive thread-789: codex archive failed",
    ]);
  });
});

describe("Codex CLI thread archiver idempotency", () => {
  const failingExec = (() => {
    throw new Error("Error: failed to archive session");
  }) as unknown as typeof import("node:child_process").execFile;

  it("treats a failed command as done when the thread already sits in the requested state", async () => {
    await expect(new CodexCliThreadArchiver(failingExec, () => true).archive("thread-1")).resolves.toBeUndefined();
    await expect(new CodexCliThreadArchiver(failingExec, () => false).unarchive("thread-1")).resolves.toBeUndefined();
  });

  it("surfaces the failure when the thread is not in the requested state or its state is unreadable", async () => {
    await expect(new CodexCliThreadArchiver(failingExec, () => false).archive("thread-1")).rejects.toThrow("failed to archive");
    await expect(new CodexCliThreadArchiver(failingExec, () => null).archive("thread-1")).rejects.toThrow("failed to archive");
  });
});

describe("codex thread archive candidates", () => {
  it("does not archive the exact ambient-only coordinator incident before later guards exist", () => {
    const db = createWorkUnitsOnlyDb();
    try {
      db.prepare(
        `INSERT INTO work_units (
           id, issue_id, state, assigned_session_id, provider, provider_session_id,
           worker_provider_session_id, auth_request_id
         ) VALUES (?, '66b3bda', 'resolved', NULL, 'codex', ?, NULL, ?)`,
      ).run(
        "53ac5b81-f6f2-4898-84b5-02e5b725a84b",
        "01a01b97-bc06-7df0-ae37-2e287fdf4694",
        "951e0926-c937-4de9-a165-3f6f381929b2",
      );

      expect(listCompletedWorkerThreadArchiveCandidates(db, {
        id: "951e0926-c937-4de9-a165-3f6f381929b2",
        type: "merge",
        issues: [],
        issue_closures: ["66b3bda"],
        resolved_at: Date.parse("2026-08-20T13:04:55Z"),
      } as AuthRequest)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not select stale resolved work units solely because an issue is declared closed", () => {
    const db = createWorkUnitsOnlyDb();
    try {
      db.prepare(
        `INSERT INTO work_units (id, issue_id, state, provider, provider_session_id)
         VALUES ('wu-stale', 'done123', 'resolved', 'codex', 'thread-stale')`,
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestFor("done123"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("finds console sessions through ledger session issue links", () => {
    const db = createWorkUnitsOnlyDb();
    try {
      db.exec(`
        CREATE TABLE console_sessions (
          id TEXT PRIMARY KEY,
          provider_session_id TEXT,
          mandible_session_id TEXT,
          command TEXT,
          status TEXT
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          status TEXT
        );
        CREATE TABLE ledger_session_issue_links (
          session_id TEXT,
          issue_id TEXT,
          created_at INTEGER
        );
      `);
      db.prepare(
        `INSERT INTO console_sessions (id, provider_session_id, command, status)
         VALUES ('console-worker', 'thread-worker', 'codex', 'stopped')`,
      ).run();
      db.prepare(
        "INSERT INTO ledger_session_issue_links (session_id, issue_id, created_at) VALUES ('thread-worker', 'done123', 1)",
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestFor("done123"))).toMatchObject([
        {
          provider_session_id: "thread-worker",
          console_session_id: "console-worker",
          issue_id: "done123",
          work_unit_id: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("excludes live direct sessions and active parent-role holders", () => {
    const db = createWorkUnitsOnlyDb();
    try {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          status TEXT
        );
        CREATE TABLE ledger_issue_checkpoints (
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare("INSERT INTO sessions (id, status) VALUES ('thread-live', 'active')").run();
      db.prepare("INSERT INTO sessions (id, status) VALUES ('thread-parent', 'idle')").run();
      db.prepare(
        `INSERT INTO ledger_issue_checkpoints (kind, payload_json, created_at)
         VALUES ('parent-role', ?, 1)`,
      ).run(JSON.stringify({ session_id: "thread-parent" }));
      db.prepare(
        `INSERT INTO work_units (
           id, issue_id, state, provider, provider_session_id, worker_provider_session_id
         ) VALUES ('wu-live', 'done123', 'resolved', 'codex', 'thread-live', 'thread-live')`,
      ).run();
      db.prepare(
        `INSERT INTO work_units (
           id, issue_id, state, provider, provider_session_id, worker_provider_session_id
         ) VALUES ('wu-parent', 'done123', 'resolved', 'codex', 'thread-parent', 'thread-parent')`,
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestFor("done123"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("excludes stale parent-role provider sessions", () => {
    const db = createWorkUnitsOnlyDb();
    try {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          status TEXT
        );
        CREATE TABLE ledger_issue_checkpoints (
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare("INSERT INTO sessions (id, status) VALUES ('thread-parent', 'ended')").run();
      db.prepare(
        `INSERT INTO ledger_issue_checkpoints (kind, payload_json, created_at)
         VALUES ('parent-role', ?, 1)`,
      ).run(JSON.stringify({ session_id: "thread-parent" }));
      db.prepare(
        `INSERT INTO work_units (
           id, issue_id, state, provider, provider_session_id,
           worker_provider_session_id, auth_request_id
         ) VALUES (
           'wu-parent', 'done123', 'resolved', 'codex', 'thread-parent',
           'thread-parent', 'auth-1'
         )`,
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestFor("done123"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("recovers worker assigned sessions instead of archiving a parent provider id", () => {
    const db = createWorkUnitsOnlyDb();
    try {
      db.exec(`
        CREATE TABLE console_sessions (
          id TEXT PRIMARY KEY,
          provider_session_id TEXT,
          mandible_session_id TEXT,
          command TEXT,
          status TEXT
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          status TEXT
        );
        CREATE TABLE ledger_issue_checkpoints (
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO ledger_issue_checkpoints (kind, payload_json, created_at)
         VALUES ('parent-role', ?, 1)`,
      ).run(JSON.stringify({ session_id: "thread-parent" }));
      db.prepare(
        `INSERT INTO console_sessions (id, provider_session_id, command, status)
         VALUES ('console-worker', 'thread-worker', 'codex', 'stopped')`,
      ).run();
      db.prepare(
        `INSERT INTO work_units (
           id, issue_id, state, assigned_session_id, provider, provider_session_id, auth_request_id
         ) VALUES (
           'wu-child', 'done123', 'resolved', 'console-worker', 'codex', 'thread-parent', 'auth-1'
         )`,
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestFor("done123"))).toEqual([
        {
          provider_session_id: "thread-worker",
          console_session_id: "console-worker",
          mandible_session_id: null,
          issue_id: "done123",
          work_unit_id: "wu-child",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps one best archive candidate per declared closure issue", () => {
    const db = createWorkUnitsOnlyDb();
    try {
      db.exec(`
        CREATE TABLE console_sessions (
          id TEXT PRIMARY KEY,
          provider_session_id TEXT,
          mandible_session_id TEXT,
          command TEXT,
          status TEXT
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          status TEXT
        );
      `);
      db.prepare(
        `INSERT INTO console_sessions (id, provider_session_id, command, status)
         VALUES ('console-worker-a', 'thread-worker-a', 'codex', 'stopped')`,
      ).run();
      db.prepare(
        `INSERT INTO console_sessions (id, provider_session_id, command, status)
         VALUES ('console-worker-b', 'thread-worker-b', 'codex', 'stopped')`,
      ).run();
      db.prepare(
        `INSERT INTO work_units (id, issue_id, state, assigned_session_id, provider, provider_session_id, auth_request_id)
         VALUES ('wu-b', 'done123', 'resolved', 'console-worker-b', 'codex', 'thread-direct-b', 'auth-1')`,
      ).run();
      db.prepare(
        `INSERT INTO work_units (id, issue_id, state, assigned_session_id, provider, provider_session_id, auth_request_id)
         VALUES ('wu-a', 'done123', 'resolved', 'console-worker-a', 'codex', 'thread-direct-a', 'auth-1')`,
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestFor("done123"))).toEqual([
        {
          provider_session_id: "thread-worker-a",
          console_session_id: "console-worker-a",
          mandible_session_id: null,
          issue_id: "done123",
          work_unit_id: "wu-a",
        },
      ]);
    } finally {
      db.close();
    }
  });
});
