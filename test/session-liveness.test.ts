import { SessionExecutionStore } from "../src/session-execution.js";
/**
 * The canonical session-liveness rule and the consumers that act on it.
 *
 * A false "not live" is destructive: the reconciler clears a live holder,
 * archival archives a thread whose agent is still working, and custody lets
 * another agent take its work unit. A check that cannot complete therefore
 * reads "unknown", never "stopped" (issue 8c7eb06).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCodexTaskLivenessCache, parseCodexTaskLockLsof, withFreshCodexTaskLiveness } from "../src/codex-task-liveness.js";
import { setDb, type Db } from "../src/db.js";
import { resolveSessionAlias, sessionAliasLiveness } from "../src/session-liveness.js";
import { classifyHolderLiveness } from "../src/work-unit-custody.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";
import { mapWorkUnitRow } from "../src/work-unit-utils.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { useStubCommand } from "./helpers/event-loop-blocking.js";

const MANDIBLE_SESSION = "sess-coordinator";
const CONSOLE_SESSION = "console-coordinator";
const PROVIDER_THREAD = "01a04e24-a731-7362-bce3-ff7a63a845e2";

function nativeCodexFailure(db: Db, conversationId: string, thread: string): void {
  db.prepare(`INSERT INTO conversation_control_state (conversation_id, provider, provider_session_id, generation, owner_kind, controller_state,
    controller_instance_id, adapter_id, last_authoritative_signal, turn_state, updated_at)
    VALUES (?, 'codex', ?, 1, 'mandible', 'ready', 'controller', 'adapter', 1, 'none', 1)`).run(conversationId, thread);
  expect(new SessionExecutionStore(db).apply({ provider: "codex", provider_session_id: thread, source: "codex_app_server",
    controller_instance_id: "controller", controller_generation: 1, event: "turn/completed", turn_id: "turn",
    state: { kind: "failure", error: { type: "usageLimitExceeded", message: "limit", details: null, data: null } } }).status).toBe("applied");
}

describe("canonical session liveness", () => {
  let db: Db;

  beforeEach(() => {
    db = migratedMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  function seedAgent(sessionStatus: string, consoleStatus: string): void {
    db.prepare("INSERT INTO sessions (id, app, status, last_active) VALUES (?, 'codex', ?, ?)")
      .run(MANDIBLE_SESSION, sessionStatus, "2026-08-29T00:00:00Z");
    db.prepare(
      `INSERT INTO console_sessions
         (id, label, command, status, mandible_session_id, provider_session_id, created_at, updated_at)
       VALUES (?, ?, 'codex', ?, ?, ?, 1, 1)`,
    ).run(CONSOLE_SESSION, CONSOLE_SESSION, consoleStatus, MANDIBLE_SESSION, PROVIDER_THREAD);
  }

  it.each([
    { session: "idle", console: "stopped", liveness: "live" },
    { session: "ended", console: "running", liveness: "live" },
    { session: "ended", console: "stopped", liveness: "stopped" },
  ])("resolves every alias of one agent to $liveness (session $session, console $console)", ({ session, console, liveness }) => {
    seedAgent(session, console);
    db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, block_count, session_id, created_at, updated_at)
      VALUES ('execution-conv', 'codex', '/tmp/execution-thread', 'hash', 1, 'Thread', '2026-01-01', 0, ?, '2026-01-01', '2026-01-01')`).run(PROVIDER_THREAD);
    nativeCodexFailure(db, 'execution-conv', PROVIDER_THREAD);

    for (const alias of [MANDIBLE_SESSION, CONSOLE_SESSION, PROVIDER_THREAD]) {
      expect(resolveSessionAlias(db, alias, { readCodexTaskLiveness: () => ({ status: "not_live" }) })).toMatchObject({
        supplied_id: alias,
        mandible_session_id: MANDIBLE_SESSION,
        console_session_id: CONSOLE_SESSION,
        provider_session_id: PROVIDER_THREAD,
        liveness,
        execution: { state: { kind: "failure", error: { type: "usageLimitExceeded" } } },
      });
      expect(sessionAliasLiveness(db, alias, { readCodexTaskLiveness: () => ({ status: "not_live" }) })).toBe(liveness);
    }
  });

  it("does not resolve an id Mandible has never recorded", () => {
    expect(resolveSessionAlias(db, "never-registered")).toBeNull();
    expect(sessionAliasLiveness(db, "never-registered")).toBe("stopped");
  });
});

describe("Codex Desktop task writer-lock authority", () => {
  it("accepts only exact task locks held by the Codex provider process", () => {
    const lockDir = "/Users/example/.codex/thread-writer-locks";
    const liveTask = "01a072f2-0e05-7a91-abcd-df4dc6a64e62";
    const anotherTask = "01a064d3-fc75-7a51-a5b6-f61237c52ece";
    const snapshot = parseCodexTaskLockLsof([
      "p1712",
      "ccodex",
      "f96",
      `n${lockDir}/${liveTask}.lock`,
      "p1713",
      "cnode",
      "f12",
      `n${lockDir}/${anotherTask}.lock`,
      "p1712",
      "ccodex",
      "f98",
      `n${lockDir}/not-a-task.lock`,
      "",
    ].join("\n"), lockDir);

    expect([...snapshot.entries()]).toEqual([[liveTask, 1712]]);
  });

  it("decides only from a lock scan that started after the decision did", async () => {
    const thread = "01a072f2-0e05-7a91-abcd-df4dc6a64e63";
    const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fresh-scan-"));
    const lockDir = path.join(codexRoot, "thread-writer-locks");
    fs.mkdirSync(lockDir);
    const rollout = path.join(codexRoot, "sessions", "2026", "10", "24", `rollout-${thread}.jsonl`);
    const resumed = path.join(codexRoot, "resumed");
    useStubCommand("lsof", `[ -f ${JSON.stringify(resumed)} ] || exit 1\nprintf 'p4242\\nccodex\\nn%s\\n' ${JSON.stringify(path.join(lockDir, `${thread}.lock`))}`);
    clearCodexTaskLivenessCache();
    try {
      const decide = () => withFreshCodexTaskLiveness((read) => read(rollout, thread).status);
      expect(await decide()).toBe("not_live");
      // The task resumes and takes its lock just after that empty scan.
      fs.writeFileSync(resumed, "");
      expect(await decide()).toBe("live");
    } finally {
      vi.unstubAllEnvs();
      clearCodexTaskLivenessCache();
      fs.rmSync(codexRoot, { recursive: true, force: true });
    }
  });
});

/**
 * The lock check here is the real one, made to fail by putting a file where
 * Codex keeps its lock directory, which makes lsof exit with an error.
 */
describe("a Codex lock check that cannot complete", () => {
  const THREAD = "019a0000-0000-7000-8000-0000000000d1";
  let db: Db;
  let codexRoot: string;
  let lockDir: string;
  let stderr: string[];
  let archived: string[];

  beforeEach(() => {
    clearCodexTaskLivenessCache();
    codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-outage-"));
    lockDir = path.join(codexRoot, "thread-writer-locks");
    const rollout = path.join(codexRoot, "sessions", "2026", "10", "21", `rollout-${THREAD}.jsonl`);
    db = migratedMemoryDb();
    db.prepare("INSERT INTO conversations (id, source, session_id, source_path,source_hash,source_mtime,title,started_at,created_at,updated_at) VALUES ('conv', 'codex', ?, ?,'hash',1,'Chat','2026-01-01','2026-01-01','2026-01-01')")
      .run(THREAD, rollout);
    nativeCodexFailure(db, "conv", THREAD);
    const unit = db.prepare(
      `INSERT INTO work_units (id, issue_id,repo_id,state, provider, assigned_session_id, worker_provider_session_id, auth_request_id,created_at)
       VALUES (?, 'issue-1','fixture',?, 'codex', ?, ?, ?,1)`,
    );
    unit.run("wu-held", "committed", THREAD, null, null);
    unit.run("wu-merged", "resolved", null, THREAD, "auth-1");
    setDb(db);
    stderr = [];
    archived = [];
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

  const reconciler = () => new WorkUnitReconciler(() => undefined);
  const heldUnit = () =>
    mapWorkUnitRow(db.prepare("SELECT * FROM work_units WHERE id = 'wu-held'").get() as Record<string, unknown>);
  const holder = () => db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-held'").get();
  const logged = (event: string) => stderr.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      return entry.event === event ? [entry] : [];
    } catch {
      return [];
    }
  });

  const freshLiveness = () => withFreshCodexTaskLiveness((read) =>
    sessionAliasLiveness(db, THREAD, { readCodexTaskLiveness: read }));
  const freshHolderState = () => withFreshCodexTaskLiveness((read) =>
    classifyHolderLiveness(db, heldUnit(), undefined, read).state);

  it("reads as unknown, so no consumer clears, archives, or takes over the holder", async () => {
    fs.writeFileSync(lockDir, "");

    expect(sessionAliasLiveness(db, THREAD, { readCodexTaskLiveness: () => ({ status: "live" }) })).toBe("live");
    expect(archived).toEqual([]);
    expect(await freshLiveness()).toBe("unknown");
    await reconciler().reconcile();
    expect(holder()).toEqual({ assigned_session_id: THREAD });
    expect(archived).toEqual([]);
    expect(await freshHolderState()).toBe("unknown");
    expect(logged("codex_task_liveness_unavailable")).toEqual([
      expect.objectContaining({ level: "error", target: lockDir }),
    ]);

    // Once the scan completes again and finds no Codex process on the lock,
    // the same thread is provably stopped and every consumer acts on it.
    fs.rmSync(lockDir);
    fs.mkdirSync(lockDir);
    clearCodexTaskLivenessCache();

    expect(await freshLiveness()).toBe("stopped");
    // A display read answers from that scan without waiting for another.
    expect(sessionAliasLiveness(db, THREAD)).toBe("stopped");
    expect(await freshHolderState()).toBe("stopped");
    await reconciler().reconcile();
    expect(holder()).toEqual({ assigned_session_id: null });
    expect(archived).toEqual([]);
  });
});
