import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  CodexCliThreadArchiver,
  listCompletedWorkerThreadArchiveCandidates,
  safeArchiveCodexThread,
} from "../src/codex-thread-archive.js";
import type { AuthRequest } from "../src/types.js";

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

function requestWithoutClosures(): AuthRequest {
  return {
    id: "auth-1",
    type: "merge",
    issues: [],
    issue_closures: [],
  } as AuthRequest;
}

function createWorkUnitsOnlyDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE work_units (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      ledger_issue_id TEXT,
      state TEXT NOT NULL,
      assigned_session_id TEXT,
      provider TEXT,
      provider_session_id TEXT,
      auth_request_id TEXT
    )
  `);
  return db;
}

function appServerFrame(message: Record<string, unknown>): Buffer {
  const body = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`, "utf8");
}

function createMockExec(response: string | Buffer = appServerFrame({ id: 1, result: {} })) {
  const calls: ExecCall[] = [];
  const exec = ((file: string, args: string[], options: ExecCall["options"]) => {
    calls.push({ file, args: [...args], options });
    return response;
  }) as unknown as typeof import("node:child_process").execFileSync;
  return { exec, calls };
}

function decodeAppServerInput(input: string | Buffer | undefined): Record<string, unknown> {
  expect(input).toBeDefined();
  const raw = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  const match = raw.match(/^Content-Length: (\d+)\r\n\r\n([\s\S]*)$/);
  expect(match).not.toBeNull();
  const [, contentLength, body] = match as RegExpMatchArray;
  expect(Buffer.byteLength(body, "utf8")).toBe(Number(contentLength));
  return JSON.parse(body) as Record<string, unknown>;
}

describe("Codex CLI thread archiver", () => {
  it("archives through the Codex app-server proxy", () => {
    const { exec, calls } = createMockExec();
    const archiver = new CodexCliThreadArchiver(exec);

    archiver.archive("thread-123");

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("codex");
    expect(calls[0].args).toEqual(["app-server", "proxy"]);
    expect(calls[0].args).not.toEqual(["archive", "thread-123"]);
    expect(calls[0].options.stdio).toBe("pipe");
    expect(calls[0].options.timeout).toBe(15_000);
    expect(decodeAppServerInput(calls[0].options.input)).toEqual({
      id: 1,
      method: "thread/archive",
      params: { threadId: "thread-123" },
    });
  });

  it("unarchives through the Codex app-server proxy", () => {
    const { exec, calls } = createMockExec();
    const archiver = new CodexCliThreadArchiver(exec);

    archiver.unarchive("thread-456");

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("codex");
    expect(calls[0].args).toEqual(["app-server", "proxy"]);
    expect(calls[0].args).not.toEqual(["unarchive", "thread-456"]);
    expect(decodeAppServerInput(calls[0].options.input)).toEqual({
      id: 1,
      method: "thread/unarchive",
      params: { threadId: "thread-456" },
    });
  });

  it("keeps archive failures behind the safe wrapper", () => {
    const { exec } = createMockExec(appServerFrame({
      id: 1,
      error: { code: 1, message: "missing app-server socket" },
    }));
    const logs: string[] = [];

    expect(safeArchiveCodexThread(
      new CodexCliThreadArchiver(exec),
      "thread-789",
      (message) => logs.push(message),
    )).toBe(false);

    expect(logs).toEqual([
      "[codex-thread-archive] failed to archive thread-789: codex app-server thread/archive failed: missing app-server socket",
    ]);
  });
});

describe("codex thread archive candidates", () => {
  it("uses resolved Codex work-unit provider identity without console_sessions", () => {
    const db = createWorkUnitsOnlyDb();
    try {
      db.prepare(
        `INSERT INTO work_units (id, issue_id, state, provider, provider_session_id)
         VALUES ('wu-direct', 'done123', 'resolved', 'codex', 'thread-direct')`,
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestFor("done123"))).toEqual([
        {
          provider_session_id: "thread-direct",
          console_session_id: null,
          mandible_session_id: null,
          issue_id: "done123",
          work_unit_id: "wu-direct",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("uses resolved request-linked Codex work units even when issues stay open", () => {
    const db = createWorkUnitsOnlyDb();
    try {
      db.prepare(
        `INSERT INTO work_units (id, issue_id, state, provider, provider_session_id, auth_request_id)
         VALUES ('wu-open', 'open123', 'resolved', 'codex', 'thread-open', 'auth-1')`,
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestWithoutClosures())).toEqual([
        {
          provider_session_id: "thread-open",
          console_session_id: null,
          mandible_session_id: null,
          issue_id: "open123",
          work_unit_id: "wu-open",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps legacy session_issues plus console_sessions compatibility", () => {
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
        CREATE TABLE session_issues (
          session_id TEXT,
          issue_id TEXT
        );
      `);
      db.prepare(
        `INSERT INTO console_sessions (id, provider_session_id, command, status)
         VALUES ('console-worker', 'thread-worker', 'codex', 'stopped')`,
      ).run();
      db.prepare("INSERT INTO session_issues (session_id, issue_id) VALUES ('console-worker', 'done123')").run();

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
        `INSERT INTO work_units (id, issue_id, state, provider, provider_session_id)
         VALUES ('wu-live', 'done123', 'resolved', 'codex', 'thread-live')`,
      ).run();
      db.prepare(
        `INSERT INTO work_units (id, issue_id, state, provider, provider_session_id)
         VALUES ('wu-parent', 'done123', 'resolved', 'codex', 'thread-parent')`,
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestFor("done123"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not use ledger_session_issue_links as an archive candidate source", () => {
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
          issue_id TEXT
        );
      `);
      db.prepare("INSERT INTO sessions (id, status) VALUES ('ledger-session', 'ended')").run();
      db.prepare(
        `INSERT INTO console_sessions (id, provider_session_id, mandible_session_id, command, status)
         VALUES ('console-ledger', 'thread-ledger', 'ledger-session', 'codex', 'stopped')`,
      ).run();
      db.prepare(
        "INSERT INTO ledger_session_issue_links (session_id, issue_id) VALUES ('ledger-session', 'done123')",
      ).run();

      expect(listCompletedWorkerThreadArchiveCandidates(db, requestFor("done123"))).toEqual([]);
    } finally {
      db.close();
    }
  });
});
