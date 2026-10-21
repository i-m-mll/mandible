/**
 * Issue 8c7eb06: a Codex thread-writer lock scan that cannot complete used to
 * read as "not live", so during an lsof outage the reconciler cleared live
 * Codex holders, archival archived live threads, and custody saw them stopped.
 *
 * The lock check here is the real one, made to fail by putting a file where
 * Codex keeps its lock directory, which makes lsof exit with an error. Every
 * consumer must leave the holder alone until the check completes again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCodexTaskLivenessCache } from "../src/codex-task-liveness.js";
import { listCompletedWorkerThreadArchiveCandidates } from "../src/codex-thread-archive.js";
import { setDb, type Db } from "../src/db.js";
import { sessionAliasLiveness } from "../src/session-liveness.js";
import type { AuthRequest } from "../src/types.js";
import { classifyHolderLiveness } from "../src/work-unit-custody.js";
import { mapWorkUnitRow } from "../src/work-unit-utils.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";

const THREAD = "019a0000-0000-7000-8000-0000000000d1";
const request = { id: "auth-1", type: "merge", issues: [], issue_closures: [] } as unknown as AuthRequest;

let db: Db;
let codexRoot: string;
let lockDir: string;
let stderr: string[];

beforeEach(() => {
  clearCodexTaskLivenessCache();
  codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-outage-"));
  lockDir = path.join(codexRoot, "thread-writer-locks");
  const rollout = path.join(codexRoot, "sessions", "2026", "10", "21", `rollout-${THREAD}.jsonl`);
  db = new SqliteDatabase(":memory:");
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL,
      source_path TEXT NOT NULL, cwd TEXT, branch TEXT, updated_at TEXT,
      ended_at TEXT, source_mtime REAL
    );
    CREATE TABLE work_units (
      id TEXT PRIMARY KEY, issue_id TEXT NOT NULL DEFAULT 'issue-1', ledger_issue_id TEXT,
      repo_id TEXT NOT NULL DEFAULT '', branch TEXT, state TEXT NOT NULL,
      assigned_session_id TEXT, provider TEXT, provider_session_id TEXT,
      worker_provider_session_id TEXT, activated_at INTEGER, auth_request_id TEXT,
      resolved_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE branches (
      repo_root TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL,
      ahead_default INTEGER DEFAULT 0, PRIMARY KEY (repo_root, branch)
    );
  `);
  db.prepare("INSERT INTO conversations (id, source, session_id, source_path) VALUES ('conv', 'codex', ?, ?)")
    .run(THREAD, rollout);
  const unit = db.prepare(
    `INSERT INTO work_units (id, state, provider, assigned_session_id, worker_provider_session_id, auth_request_id)
     VALUES (?, ?, 'codex', ?, ?, ?)`,
  );
  unit.run("wu-held", "committed", THREAD, null, null);
  unit.run("wu-merged", "resolved", null, THREAD, "auth-1");
  setDb(db);
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(codexRoot, { recursive: true, force: true });
  clearCodexTaskLivenessCache();
});

function heldUnit() {
  return mapWorkUnitRow(db.prepare("SELECT * FROM work_units WHERE id = 'wu-held'").get() as Record<string, unknown>);
}

function logged(event: string): Array<Record<string, unknown>> {
  return stderr.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      return entry.event === event ? [entry] : [];
    } catch {
      return [];
    }
  });
}

describe("a Codex lock check that cannot complete", () => {
  it("reads as unknown, so no consumer clears, archives, or takes over the holder", async () => {
    fs.writeFileSync(lockDir, "");

    expect(sessionAliasLiveness(db, THREAD)).toBe("unknown");
    await new WorkUnitReconciler(() => undefined).reconcile();
    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-held'").get())
      .toEqual({ assigned_session_id: THREAD });
    expect(listCompletedWorkerThreadArchiveCandidates(db, request)).toEqual([]);
    expect(classifyHolderLiveness(db, heldUnit()).state).toBe("unknown");
    expect(logged("codex_task_liveness_unavailable")).toEqual([
      expect.objectContaining({ level: "error", target: lockDir }),
    ]);

    // Once the scan completes again and finds no Codex process on the lock,
    // the same thread is provably stopped and every consumer acts on it.
    fs.rmSync(lockDir);
    fs.mkdirSync(lockDir);
    clearCodexTaskLivenessCache();

    expect(sessionAliasLiveness(db, THREAD)).toBe("stopped");
    expect(classifyHolderLiveness(db, heldUnit()).state).toBe("stopped");
    expect(listCompletedWorkerThreadArchiveCandidates(db, request).map((c) => c.provider_session_id))
      .toEqual([THREAD]);
    await new WorkUnitReconciler(() => undefined).reconcile();
    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-held'").get())
      .toEqual({ assigned_session_id: null });
  });
});
