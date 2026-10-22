import { AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * The merge finalizer pipeline: staged lifecycle events (auth:merged ->
 * auth:resolved -> auth:finalized), bounded crash-safe finalizer steps,
 * ancestry work-unit resolution, and Codex worker-thread archival.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import {
  archiveFinishedWorkerThreads,
  CodexCliThreadArchiver,
  listCompletedWorkerThreadArchiveCandidates,
  safeArchiveCodexThread,
} from "../src/codex-thread-archive.js";
import type { Db } from "../src/db.js";
import { LedgerStore } from "../src/ledger/store.js";
import SqliteDatabase from "../src/sqlite.ts";
import type { AuthRequest, SseEvent } from "../src/types.js";
import {
  approveFixtureRequest,
  approvePausedFixtureRequest,
  commitOnBranch,
  completeFixturePublication,
  createAuthCheckRepo,
  createLedgerIssue,
  createLedgerProject,
  createMigratedDb,
  createNoopHookManager,
  git,
  insertConsoleSession,
  insertMandibleSession,
  insertWorkUnit,
  publishFixtureExecution,
  registerWorkRepo,
  waitForStatus,
  writeFile,
} from "./helpers/auth-queue-fixtures.js";
import { SYSTEM_ACTOR } from "./helpers/ledger-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";

type Archiver = NonNullable<ConstructorParameters<typeof AuthQueue>[0]["codexThreadArchiver"]>;

function recordingArchiver(archived: string[]): Archiver {
  return {
    archive: async (threadId) => { archived.push(threadId); },
    unarchive: async () => undefined,
  };
}

function sweep(queue: AuthQueue): void {
  (queue as unknown as { sweepSuccessfulMergeFinalizers(): void }).sweepSuccessfulMergeFinalizers();
}

function resolveAncestry(queue: AuthQueue, request: unknown): Promise<string[]> {
  return (queue as unknown as { resolveAncestryWorkUnitsOnMerge(r: unknown): Promise<string[]> })
    .resolveAncestryWorkUnitsOnMerge(request);
}

/** A merge (or commit) request approved through operator proof and paused at execution. */
async function submitSuccessfulRequest(
  queue: AuthQueue,
  options: { type?: "merge" | "commit"; issue_closures?: string[] } = {},
): Promise<string> {
  const type = options.type ?? "merge";
  const repo = createAuthCheckRepo();
  registerWorkRepo((queue as unknown as { db: Db }).db, repo);
  commitOnBranch(repo, "feature/x", { "finalizer.txt": "reviewed\n" });
  const request = (await queue.submit({ ...(type === "merge" ? AUTH_MERGE_REVIEW : AUTH_COMMAND_REVIEW),
    type,
    command: type === "merge" ? "mandible auth merge feature/x --into main" : "mandible auth commit",
    title: "Finalizer test",
    repo: "finalizer-repo",
    cwd: repo,
    base_branch: type === "merge" ? "main" : undefined,
    head_branch: type === "merge" ? "feature/x" : undefined,
    merge_head_sha: git(repo, ["rev-parse", "feature/x"]),
    issue_closures: options.issue_closures,
    execution_mode: "daemon",
  }));
  await approvePausedFixtureRequest(queue, request.id);
  return request.id;
}

/** A codex work unit linked to the request through a stopped console session. */
function insertCodexWorkUnit(
  db: Db,
  id: string,
  authRequestId: string,
  providerSessionId: string,
  state: "committed" | "resolved" = "committed",
): void {
  insertConsoleSession(db, { id: `console-${id}`, providerSessionId });
  db.prepare(
    `INSERT INTO work_units (
      id, issue_id, repo_id, branch, kind, state, assigned_session_id, provider,
      provider_session_id, created_at, resolved_at, auth_request_id
    ) VALUES (?, ?, 'finalizer-repo', NULL, 'solo', ?, ?, 'codex', ?, 0, ?, ?)`,
  ).run(id, `issue-${id}`, state, `console-${id}`, providerSessionId,
    state === "resolved" ? 100 : null, authRequestId);
}

function eventsFor(events: SseEvent[], requestId: string, name: string): SseEvent[] {
  return events.filter((event) => (
    event.event === name && (event.data as { request_id?: string } | undefined)?.request_id === requestId
  ));
}

describe("staged finalizer lifecycle", () => {
  it("emits merged, resolved and finalized in order, with finalizers off the critical path", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    let directStateAtResolved: string | undefined;
    let markerAtFinalized: number | null | undefined;
    let archiveStarted = false;
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
    const queue = new AuthQueue({
      db,
      broadcast: (event) => {
        events.push(event);
        const requestId = (event.data as { request_id?: string } | undefined)?.request_id;
        if (event.event === "auth:resolved") {
          directStateAtResolved = (db.prepare("SELECT state FROM work_units WHERE id = 'wu-direct'")
            .get() as { state: string } | undefined)?.state;
        }
        if (event.event === "auth:finalized") {
          markerAtFinalized = (db.prepare("SELECT merge_finalized_at FROM auth_requests WHERE id = ?")
            .get(requestId) as { merge_finalized_at: number | null }).merge_finalized_at;
        }
      },
      codexThreadArchiver: {
        archive: async () => { archiveStarted = true; await archiveGate; },
        unarchive: async () => undefined,
      },
    });
    try {
      const id = await submitSuccessfulRequest(queue);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at, auth_request_id)
         VALUES ('wu-direct', 'issue-direct', 'finalizer-repo', NULL, 'solo', 'committed', 0, ?)`,
      ).run(id);
      insertCodexWorkUnit(db, "wu-off-loop", id, "thread-off-loop");

      await completeFixturePublication(queue, id);
      await waitUntil(() => archiveStarted, "the archive step to start");

      // Direct work units resolve in Stage 2; the blocked archive step holds Stage 3.
      expect(directStateAtResolved).toBe("resolved");
      expect(eventsFor(events, id, "auth:resolved")).toHaveLength(1);
      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(0);
      expect((await queue.getRequest(id))?.merge_finalized_at).toBeNull();

      releaseArchive();
      await queue.drainFinalizers();

      expect(events
        .filter((event) => ["auth:merged", "auth:resolved", "auth:finalized"].includes(String(event.event)))
        .map((event) => event.event)).toEqual(["auth:merged", "auth:resolved", "auth:finalized"]);
      // At-least-once: the event fires before the durable marker, so a crash
      // between them re-emits rather than drops it.
      expect(markerAtFinalized).toBeNull();
      const persisted = (await queue.getRequest(id))?.merge_finalized_at;
      expect(persisted).not.toBeNull();
      expect(eventsFor(events, id, "auth:finalized")[0].data).toMatchObject({
        merge_finalized_at: persisted,
        archived_thread_count: 1,
      });
    } finally {
      (await queue.dispose());
      db.close();
    }
  });

  it("does not emit auth:merged for a non-merge success but still stages resolved and finalized", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      const id = await submitSuccessfulRequest(queue, { type: "commit" });
      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();

      expect(eventsFor(events, id, "auth:merged")).toHaveLength(0);
      expect(eventsFor(events, id, "auth:resolved")).toHaveLength(1);
      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(1);
    } finally {
      (await queue.dispose());
      db.close();
    }
  });

  it("retries a failing archive step up to three attempts, then finalizes with the step marked failed", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    let archiveCalls = 0;
    const queue = new AuthQueue({
      db,
      broadcast: (event) => events.push(event),
      codexThreadArchiver: {
        archive: async () => { archiveCalls += 1; throw new Error("codex archive boom"); },
        unarchive: async () => undefined,
      },
    });
    try {
      const id = await submitSuccessfulRequest(queue);
      insertCodexWorkUnit(db, "wu-archive-fail", id, "thread-archive-fail");

      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();
      expect((await queue.getRequest(id))?.merge_finalized_at).toBeNull();
      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(0);

      sweep(queue);
      await queue.drainFinalizers();
      expect((await queue.getRequest(id))?.merge_finalized_at).toBeNull();
      sweep(queue);
      await queue.drainFinalizers();

      const finalizedRow = (await queue.getRequest(id));
      expect(finalizedRow?.merge_finalized_at).not.toBeNull();
      expect(JSON.parse(finalizedRow?.merge_finalizer_state ?? "{}").archive_worker_threads)
        .toMatchObject({ state: "failed", attempts: 3 });
      expect(archiveCalls).toBe(3);
      const finalized = eventsFor(events, id, "auth:finalized")[0].data as {
        steps: Array<{ name: string; state: string; error?: string }>;
      };
      expect(finalized.steps.find((step) => step.name === "archive_worker_threads"))
        .toMatchObject({ state: "failed" });
    } finally {
      (await queue.dispose());
      db.close();
    }
  });

  it("resumes only the unfinished steps after a crash and rebuilds the payload from persisted outputs", async () => {
    const db = createMigratedDb();
    const archived: string[] = [];
    const events: SseEvent[] = [];
    const first = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    const id = await submitSuccessfulRequest(first);
    await completeFixturePublication(first, id);
    await first.drainFinalizers();
    (await first.dispose());
    db.prepare("UPDATE auth_requests SET merge_finalized_at = NULL, merge_finalizer_state = ? WHERE id = ?").run(
      JSON.stringify({
        revalidate_pending: { state: "done", attempts: 1, at: 0 },
        auto_dismiss_duplicates: { state: "done", attempts: 1, at: 0 },
        resolve_ancestry_work_units: {
          state: "done", attempts: 1, at: 0, output: { resolved_work_unit_ids: ["wu-x", "wu-y"] },
        },
        archive_worker_threads: { state: "pending", attempts: 1, error: "boom", at: 0 },
      }),
      id,
    );
    insertCodexWorkUnit(db, "wu-crash", id, "thread-crash", "resolved");

    const recovered = new AuthQueue({
      db,
      broadcast: (event) => events.push(event),
      codexThreadArchiver: recordingArchiver(archived),
    });
    try {
      await waitUntil(async () => (await recovered.getRequest(id))?.merge_finalized_at, "the startup sweep to finalize");
      await recovered.drainFinalizers();
      expect(archived).toEqual(["thread-crash"]);
      expect(JSON.parse((await recovered.getRequest(id))?.merge_finalizer_state ?? "{}").archive_worker_threads.state)
        .toBe("done");
      expect(eventsFor(events, id, "auth:finalized")[0].data).toMatchObject({
        resolved_work_unit_ids: ["wu-x", "wu-y"],
        archived_thread_count: 1,
      });
    } finally {
      (await recovered.dispose());
      db.close();
    }
  });

  it("bounds finalizer admission and accepts overflow after the first batch drains", async () => {
    const db = createMigratedDb();
    const owner = new AuthQueue({ db, backgroundMaintenance: false });
    try {
      type Queue = { enqueue(id: string): boolean; drain(): Promise<void> };
      const QueueClass = (owner as unknown as {
        finalizerQueue: { constructor: new (run: (id: string) => Promise<void>) => Queue };
      }).finalizerQueue.constructor;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const processed: string[] = [];
      const queue = new QueueClass(async (id) => { await gate; processed.push(id); });
      const overflow: string[] = [];
      for (let n = 0; n < 40; n++) if (!queue.enqueue(String(n))) overflow.push(String(n));
      expect(overflow.length).toBeGreaterThan(0);
      release();
      await queue.drain();
      for (const id of overflow) expect(queue.enqueue(id)).toBe(true);
      await queue.drain();
      expect(processed).toHaveLength(40);
      expect(new Set(processed).size).toBe(40);
    } finally {
      (await owner.dispose());
      db.close();
    }
  });
});

describe("work-unit resolution on merge", () => {
  it("resolves exactly contained work units without per-unit ancestry processes", async () => {
    const now = 10_000;
    const archived: string[] = [];
    const repo = createAuthCheckRepo();
    const rp = fs.realpathSync(repo);
    const repoId = path.basename(repo);
    const db = createMigratedDb();
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-git-trace-"));
    const traceLog = path.join(traceDir, "git-calls.log");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      path.join(traceDir, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(traceLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o755 },
    );
    const prevPath = process.env.PATH;
    try {
      const project = createLedgerProject(db, repo);
      const closedIssue = createLedgerIssue(db, project.project.id, "closed1", "Closed child");
      registerWorkRepo(db, repo);

      // Children the integration branch lands. Only feature/child keeps its
      // branch; the rest prove containment through the recorded tip snapshot.
      const landed = ["child", "snap-child", "abandoned-child", "closed-child", "order-child", "excluded-child"];
      const tips: Record<string, string> = {};
      for (const name of landed) {
        commitOnBranch(repo, `feature/${name}`, { [`${name}.txt`]: `${name}\n` });
        tips[name] = git(repo, ["rev-parse", `feature/${name}`]);
      }
      git(repo, ["checkout", "-b", "integration/batch", "main"]);
      for (const name of landed) git(repo, ["merge", "--no-ff", `feature/${name}`, "-m", `merge ${name}`]);
      const integrationHead = git(repo, ["rev-parse", "integration/batch"]);
      git(repo, ["checkout", "main"]);
      for (const name of landed.slice(1)) git(repo, ["branch", "-D", `feature/${name}`]);

      // Already in the base before this merge: not landed by it.
      commitOnBranch(repo, "feature/stale-abandoned", { "stale.txt": "stale\n" });
      tips["stale-abandoned"] = git(repo, ["rev-parse", "feature/stale-abandoned"]);
      git(repo, ["merge", "--no-ff", "feature/stale-abandoned", "-m", "merge stale work"]);
      git(repo, ["branch", "-D", "feature/stale-abandoned"]);
      // Squash-merged: the original tip is reachable from nothing.
      commitOnBranch(repo, "feature/squash-child", { "squash.txt": "squash\n" });
      tips["squash-child"] = git(repo, ["rev-parse", "feature/squash-child"]);
      git(repo, ["merge", "--squash", "feature/squash-child"]);
      git(repo, ["commit", "-m", "squash child work"]);
      git(repo, ["branch", "-D", "feature/squash-child"]);

      const insertBranch = db.prepare("INSERT INTO branches (repo_root, branch, last_commit_hash) VALUES (?, ?, ?)");
      for (const [name, tip] of Object.entries(tips)) insertBranch.run(rp, `feature/${name}`, tip);
      const insertUnit = db.prepare(
        `INSERT INTO work_units (
          id, issue_id, ledger_issue_id, repo_id, branch, kind, state, provider, provider_session_id,
          worker_provider_session_id, created_at, merge_scan_retired_at
        ) VALUES (?, ?, ?, ?, ?, 'partition', ?, ?, ?, ?, ?, ?)`,
      );
      const unit = (
        id: string,
        branch: string,
        state: "committed" | "abandoned",
        createdAt: number,
        extra: { ledgerIssue?: string; thread?: string; worker?: string; retiredAt?: number } = {},
      ) => insertUnit.run(id, `${id}-issue`, extra.ledgerIssue ?? null, repoId, branch, state,
        extra.thread ? "codex" : null, extra.thread ?? null, extra.worker ?? null, createdAt, extra.retiredAt ?? null);
      unit("wu-child", "feature/child", "committed", now);
      unit("wu-snap", "feature/snap-child", "committed", now);
      unit("wu-abandoned", "feature/abandoned-child", "abandoned", now, { thread: "thread-abandoned" });
      unit("wu-closed", "feature/closed-child", "abandoned", now, {
        ledgerIssue: closedIssue.id, thread: "thread-closed", worker: "thread-closed",
      });
      unit("wu-order", "feature/order-child", "abandoned", 0);
      unit("wu-excluded", "feature/excluded-child", "abandoned", 0, { retiredAt: 5 });
      unit("wu-stale-base", "feature/stale-abandoned", "abandoned", now);
      unit("wu-squash", "feature/squash-child", "committed", now);
      unit("wu-stale-retire", "feature/retire-stale", "abandoned", 0);
      unit("wu-fresh-retire", "feature/retire-fresh", "abandoned", now);
      // Fifty unresolvable candidates: the batch probes targets and tips once, not per row.
      for (let i = 0; i < 50; i += 1) {
        insertBranch.run(rp, `feature/budget-${i}`, i.toString(16).padStart(40, "0"));
        unit(`wu-budget-${i}`, `feature/budget-${i}`, "committed", now);
      }

      const queue = new AuthQueue({
        executor: async (options) => publishFixtureExecution(queue, options),
        db,
        now: () => now,
        workUnitAbandonedScanRetentionMs: 1000,
        codexThreadArchiver: recordingArchiver(archived),
      });
      const request = queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge integration/batch --into main",
        title: "Merge integration",
        repo: repoId,
        cwd: rp,
        target_repo_root: rp,
        base_branch: "main",
        head_branch: "integration/batch",
        merge_head_sha: integrationHead,
        issue_closures: [closedIssue.id],
        execution_mode: "daemon",
      });

      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      const rows = Object.fromEntries((db.prepare(
        "SELECT id, state, resolved_at, auth_request_id, merge_scan_retired_at FROM work_units WHERE id NOT LIKE 'wu-budget-%'",
      ).all() as Array<{ id: string }>).map(({ id, ...row }) => [id, row]));
      const resolved = { state: "resolved", resolved_at: now, merge_scan_retired_at: null };
      expect(rows).toEqual({
        "wu-child": { ...resolved, auth_request_id: null },
        "wu-snap": { ...resolved, auth_request_id: null },
        // Abandoned work the merge contains is recovered...
        "wu-abandoned": { ...resolved, auth_request_id: null },
        // ...and linked to the request when it matches an explicit closure.
        "wu-closed": { ...resolved, auth_request_id: request.id },
        // A stale row the merge contains resolves before the retirement sweep.
        "wu-order": { ...resolved, auth_request_id: null },
        "wu-excluded": { state: "abandoned", resolved_at: null, auth_request_id: null, merge_scan_retired_at: 5 },
        "wu-stale-base": { state: "abandoned", resolved_at: null, auth_request_id: null, merge_scan_retired_at: null },
        "wu-squash": { state: "committed", resolved_at: null, auth_request_id: null, merge_scan_retired_at: null },
        // Retired from future scans, never deleted; fresh rows are spared.
        "wu-stale-retire": { state: "abandoned", resolved_at: null, auth_request_id: null, merge_scan_retired_at: now },
        "wu-fresh-retire": { state: "abandoned", resolved_at: null, auth_request_id: null, merge_scan_retired_at: null },
      });
      // Worker archival of recovered units belongs to the work-unit reconciler.
      expect(archived).toEqual([]);

      const completed = queue.getRequest(request.id)!;
      const ancestry = queue as unknown as {
        resolveAncestryWorkUnitsOnMerge(request: AuthRequest): Promise<string[]>;
      };
      const scan = async () => {
        fs.writeFileSync(traceLog, "");
        const resolved = await ancestry.resolveAncestryWorkUnitsOnMerge(completed);
        const calls = fs.readFileSync(traceLog, "utf8").split("\n").filter(Boolean);
        return { resolved, processes: calls.length };
      };
      process.env.PATH = `${traceDir}${path.delimiter}${prevPath ?? ""}`;
      try {
        unit("wu-probe-fifty", "feature/snap-child", "committed", now);
        const fifty = await scan();
        expect(fifty.resolved).toContain("wu-probe-fifty");
        expect(fifty.processes).toBeGreaterThan(0);
        for (let i = 50; i < 100; i += 1) {
          insertBranch.run(rp, `feature/budget-${i}`, i.toString(16).padStart(40, "0"));
          unit(`wu-budget-${i}`, `feature/budget-${i}`, "committed", now);
        }
        unit("wu-probe-hundred", "feature/snap-child", "committed", now);
        const hundred = await scan();
        expect(hundred.resolved).toContain("wu-probe-hundred");
        const probes = db.prepare("SELECT state FROM work_units WHERE id IN ('wu-probe-fifty', 'wu-probe-hundred')").all() as Array<{ state: string }>;
        expect(probes.map(row => row.state)).toEqual(["resolved", "resolved"]);
        expect(hundred.processes).toBe(fifty.processes);
      } finally {
        process.env.PATH = prevPath;
      }
      queue.dispose();
    } finally {
      process.env.PATH = prevPath;
      db.close();
      fs.rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it("skips the retirement sweep when the ancestry batch build fails, then retires once it succeeds", async () => {
    const now = 10_000;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/live-candidate", { "live.txt": "live\n" });
      commitOnBranch(repo, "integration/bf-batch", { "bf.txt": "bf\n" });
      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-live', 'live123', ?, 'feature/live-candidate', 'partition', 'committed', ?)`,
      ).run(path.basename(repo), now);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-stale-bf', 'stale-bf', ?, 'feature/stale-bf', 'partition', 'abandoned', 0)`,
      ).run(path.basename(repo));

      const queue = new AuthQueue({ db, now: () => now, workUnitAbandonedScanRetentionMs: 1000, backgroundMaintenance: false });
      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge integration/bf-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/bf-batch",
        merge_head_sha: git(repo, ["rev-parse", "integration/bf-batch"]),
        execution_mode: "daemon",
      }));

      // A nonexistent target makes the batch build fail: a transient git
      // failure must not cost the stale row its scan eligibility.
      await resolveAncestry(queue, { ...request, merge_head_sha: "b".repeat(40) });
      expect(db.prepare("SELECT merge_scan_retired_at FROM work_units WHERE id = 'wu-stale-bf'").get())
        .toEqual({ merge_scan_retired_at: null });

      await resolveAncestry(queue, (await queue.getRequest(request.id)));
      expect(db.prepare("SELECT state, merge_scan_retired_at FROM work_units WHERE id = 'wu-stale-bf'").get())
        .toEqual({ state: "abandoned", merge_scan_retired_at: now });
      (await queue.dispose());
    } finally {
      db.close();
    }
  });

  it("recovers a same-head work unit abandoned before successful Stage 2 finalization", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      const id = await submitSuccessfulRequest(queue, { issue_closures: ["issue-raced"] });
      const insert = db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES (?, ?, ?, ?, 'solo', 'abandoned', 0)`,
      );
      insert.run("wu-raced", "issue-raced", "finalizer-repo", "feature/x");
      insert.run("wu-other-repo", "issue-other", "other-repo", "feature/x");
      insert.run("wu-same-issue-old-branch", "issue-raced", "finalizer-repo", "feature/old");

      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();

      expect(db.prepare("SELECT state, auth_request_id, resolved_at FROM work_units WHERE id = 'wu-raced'").get())
        .toEqual({ state: "resolved", auth_request_id: id, resolved_at: expect.any(Number) });
      expect((eventsFor(events, id, "auth:finalized")[0].data as { resolved_work_unit_ids: string[] })
        .resolved_work_unit_ids).toContain("wu-raced");
      expect(db.prepare("SELECT state FROM work_units WHERE id = 'wu-other-repo'").get())
        .toEqual({ state: "abandoned" });
      expect(db.prepare("SELECT state, auth_request_id FROM work_units WHERE id = 'wu-same-issue-old-branch'").get())
        .toEqual({ state: "abandoned", auth_request_id: null });
    } finally {
      (await queue.dispose());
      db.close();
    }
  });

  it("does not replay finalized same-branch merge finalizers against newer pending requests on restart", async () => {
    let now = 1000;
    const db = createMigratedDb();
    const repo = createAuthCheckRepo();
    commitOnBranch(repo, "integration/reused", { "first.txt": "first\n" });
    registerWorkRepo(db, repo);
    const submitWave = async (queue: AuthQueue, title: string) => (await queue.submit({ ...AUTH_MERGE_REVIEW,
      type: "merge",
      command: "mandible auth merge integration/reused --into main",
      title,
      repo: path.basename(repo),
      cwd: repo,
      base_branch: "main",
      head_branch: "integration/reused",
      merge_head_sha: git(repo, ["rev-parse", "integration/reused"]),
      execution_mode: "daemon",
    }));
    const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
    const completed = (await submitWave(queue, "First wave"));
    await approveFixtureRequest(queue, completed.id);
    await waitForStatus(queue, completed.id, "completed");
    await queue.drainFinalizers();
    queue.dispose();

    git(repo, ["checkout", "integration/reused"]);
    writeFile(repo, "second.txt", "second\n");
    git(repo, ["add", "second.txt"]);
    git(repo, ["commit", "-m", "second wave"]);
    git(repo, ["checkout", "main"]);
    now = 2000;
    const secondQueue = new AuthQueue({ db, now: () => now });
    const pending = (await submitWave(secondQueue, "Second wave"));
    (await secondQueue.dispose());

    now = 3000;
    const restarted = new AuthQueue({ db, now: () => now });
    try {
      expect((await restarted.getRequest(completed.id))?.merge_finalized_at).toBe(1000);
      expect((await restarted.getRequest(pending.id))).toMatchObject({ status: "pending", error: null });
    } finally {
      (await restarted.dispose());
      db.close();
    }
  });

  it.each(["same", "different"] as const)(
    "leaves unverified historical completion and its %s-head pending sibling unchanged",
    async (headKind) => {
      const db = createMigratedDb();
      const oldHead = "a".repeat(40);
      const pendingHead = headKind === "same" ? oldHead : "b".repeat(40);
      db.prepare(`INSERT INTO auth_requests (
        id, type, command, title, repo, base_branch, head_branch, merge_head_sha,
        status, created_at, updated_at, resolved_at, expires_at, exit_code, output,
        execution_mode, files_changed, additions, deletions, approval_source
      ) VALUES ('history', 'merge', 'mandible auth merge feature/reused --into main',
        'Historical completion', 'repo', 'main', 'feature/reused', ?,
        'completed', 100, 1000, 1000, 10000, 0, 'ok', 'remote', 0, 0, 0, 'manual')`).run(oldHead);
      db.prepare(`INSERT INTO auth_requests (
        id, type, command, title, repo, base_branch, head_branch, merge_head_sha,
        status, created_at, updated_at, expires_at, output, execution_mode,
        files_changed, additions, deletions, approval_source
      ) VALUES ('pending', 'merge', 'mandible auth merge feature/reused --into main',
        'Pending sibling', 'repo', 'main', 'feature/reused', ?,
        'pending', 900, 900, 10000, '', 'remote', 0, 0, 0, 'manual')`).run(pendingHead);
      const queue = new AuthQueue({ db, now: () => 2000 });
      try {
        await queue.drainFinalizers();
        expect((await queue.getRequest("history"))).toMatchObject({ status: "completed", merge_finalized_at: null });
        expect((await queue.getRequest("pending")))
          .toMatchObject({ status: "pending", error: null, superseded_by_request_id: null });
      } finally {
        (await queue.dispose());
        db.close();
      }
    },
  );
});

describe("worker thread archival", () => {
  it("archives only reliably linked terminal Codex worker threads, and replays archival without rerunning finalizers", async () => {
    const archived: string[] = [];
    const db = createMigratedDb();
    const repoRoot = createAuthCheckRepo();
    commitOnBranch(repoRoot, "feature/archive-worker", { "worker.txt": "delivered\n" });
    registerWorkRepo(db, repoRoot);
    const project = createLedgerProject(db, repoRoot);
    const issue = createLedgerIssue(db, project.project.id, "done123", "Done issue");
    const parent = createLedgerIssue(db, project.project.id, "parent1", "Parent issue");
    const queue = new AuthQueue({
      executor: async (options) => publishFixtureExecution(queue, options),
      db,
      codexThreadArchiver: recordingArchiver(archived),
    });
    try {
      insertMandibleSession(db, "mandible-worker", "ended");
      insertMandibleSession(db, "parent-thread", "active");
      insertConsoleSession(db, { id: "console-worker", providerSessionId: "thread-worker", mandibleSessionId: "mandible-worker" });
      insertConsoleSession(db, { id: "console-parent", providerSessionId: "parent-thread", mandibleSessionId: "parent-thread" });
      insertConsoleSession(db, { id: "console-running", providerSessionId: "thread-running", status: "running" });
      new LedgerStore(db).addIssueCheckpoint(parent.id, {
        ...SYSTEM_ACTOR,
        kind: "parent-role",
        payload: { session_id: "parent-thread", mechanism: "thread", assumed_at: Date.now() },
        actor_type: "mandible_user",
        source: "mandible",
        created_at: Date.now(),
      });

      const request = queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/archive-worker --into main",
        title: "Archive workers",
        repo: project.checkout.root,
        cwd: repoRoot,
        merge_head_sha: git(repoRoot, ["rev-parse", "feature/archive-worker"]),
        base_branch: "main",
        head_branch: "feature/archive-worker",
        issue_closures: ["done123"],
        execution_mode: "daemon",
      });
      for (const [id, session] of [["wu-worker", "console-worker"], ["wu-parent", "console-parent"], ["wu-running", "console-running"]]) {
        insertWorkUnit(db, {
          id,
          issueShortId: "done123",
          ledgerIssueId: issue.id,
          repoId: project.checkout.root,
          assignedSessionId: session,
          authRequestId: request.id,
        });
      }

      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      expect(archived).toEqual(["thread-worker"]);
      expect(db.prepare("SELECT state FROM work_units WHERE id = 'wu-worker'").get()).toEqual({ state: "resolved" });
      expect(new LedgerStore(db).getIssue(issue.id)).toMatchObject({ status: "closed", resolution: "delivered" });

      const finalizedAt = queue.getRequest(request.id)?.merge_finalized_at;
      const replay = await queue.replayCodexThreadArchives(request.id);
      expect(archived).toEqual(["thread-worker", "thread-worker"]);
      expect(replay).toMatchObject({
        request_id: request.id,
        archived: 1,
        candidates: [{ provider_session_id: "thread-worker", issue_id: issue.id, work_unit_id: "wu-worker", archived: true }],
      });
      expect(queue.getRequest(request.id)?.merge_finalized_at).toBe(finalizedAt);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("leaves worker-bound threads to the reconciler, which archives only explicit worker ownership", async () => {
    const db = createMigratedDb();
    const archived: string[] = [];
    const queue = new AuthQueue({ db, broadcast: () => undefined, codexThreadArchiver: recordingArchiver(archived) });
    try {
      const id = await submitSuccessfulRequest(queue);
      const resolvedAt = Date.parse("2026-08-20T13:04:55Z");
      // The ambient-only coordinator incident (issue 66b3bda): an ambient
      // provider id is never worker ownership.
      db.prepare(
        `INSERT INTO work_units (
          id, issue_id, repo_id, branch, kind, state, assigned_session_id,
          provider, provider_session_id, worker_provider_session_id, created_at,
          resolved_at, auth_request_id
        ) VALUES
          ('wu-ambient', '66b3bda', 'finalizer-repo', NULL, 'solo', 'resolved', NULL,
           'codex', 'ambient-coordinator', NULL, 0, ?, ?),
          ('wu-explicit', 'issue-explicit', 'finalizer-repo', NULL, 'solo', 'resolved', NULL,
           'codex', 'ambient-explicit', 'thread-explicit', 0, ?, ?)`,
      ).run(resolvedAt, id, resolvedAt, id);

      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();
      expect(archived).toEqual([]);

      await archiveFinishedWorkerThreads(db, {
        archiver: recordingArchiver(archived),
        liveness: () => "stopped",
        resolveAlias: () => null,
        now: () => 0,
      });
      expect(archived).toEqual(["thread-explicit"]);
    } finally {
      (await queue.dispose());
      db.close();
    }
  });

  it("drives the top-level Codex CLI idempotently and keeps its failures behind the safe wrapper", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec = ((file: string, args: string[]) => {
      calls.push({ file, args: [...args] });
      return "";
    }) as unknown as typeof import("node:child_process").execFile;
    const archiver = new CodexCliThreadArchiver(exec);
    await archiver.archive("thread-123");
    await archiver.unarchive("thread-456");
    expect(calls).toEqual([
      { file: "codex", args: ["archive", "thread-123"] },
      { file: "codex", args: ["unarchive", "thread-456"] },
    ]);

    const throwing = (() => { throw new Error("codex archive failed"); }) as unknown as typeof import("node:child_process").execFile;
    const logs: string[] = [];
    expect(await safeArchiveCodexThread(new CodexCliThreadArchiver(throwing), "thread-789", (message) => logs.push(message)))
      .toBe(false);
    expect(logs).toEqual(["[codex-thread-archive] failed to archive thread-789: codex archive failed"]);

    // A failed command counts as done only when the thread already sits in the requested state.
    const failing = (() => { throw new Error("Error: failed to archive session"); }) as unknown as typeof import("node:child_process").execFile;
    await expect(new CodexCliThreadArchiver(failing, () => true).archive("thread-1")).resolves.toBeUndefined();
    await expect(new CodexCliThreadArchiver(failing, () => false).unarchive("thread-1")).resolves.toBeUndefined();
    await expect(new CodexCliThreadArchiver(failing, () => false).archive("thread-1")).rejects.toThrow("failed to archive");
    await expect(new CodexCliThreadArchiver(failing, () => null).archive("thread-1")).rejects.toThrow("failed to archive");
  });

  describe("archive candidates", () => {
    const request = { id: "auth-1", type: "merge", issues: [], issue_closures: ["done123"] } as unknown as AuthRequest;

    function candidateDb(setup: (db: InstanceType<typeof SqliteDatabase>) => void) {
      const db = new SqliteDatabase(":memory:");
      db.exec(`
        CREATE TABLE work_units (
          id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, ledger_issue_id TEXT, state TEXT NOT NULL,
          assigned_session_id TEXT, provider TEXT, provider_session_id TEXT,
          worker_provider_session_id TEXT, auth_request_id TEXT
        );
        CREATE TABLE console_sessions (
          id TEXT PRIMARY KEY, provider_session_id TEXT, mandible_session_id TEXT, command TEXT, status TEXT
        );
        CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE ledger_issue_checkpoints (kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE ledger_session_issue_links (session_id TEXT, issue_id TEXT, created_at INTEGER);
      `);
      setup(db);
      try {
        return listCompletedWorkerThreadArchiveCandidates(db, request);
      } finally {
        db.close();
      }
    }

    const parentRole = (db: InstanceType<typeof SqliteDatabase>, session: string) => db.prepare(
      "INSERT INTO ledger_issue_checkpoints (kind, payload_json, created_at) VALUES ('parent-role', ?, 1)",
    ).run(JSON.stringify({ session_id: session }));
    const stoppedConsole = (db: InstanceType<typeof SqliteDatabase>, id: string, thread: string) => db.prepare(
      "INSERT INTO console_sessions (id, provider_session_id, command, status) VALUES (?, ?, 'codex', 'stopped')",
    ).run(id, thread);

    it.each([
      ["a resolved unit with no link to this request", (db: InstanceType<typeof SqliteDatabase>) => {
        db.prepare(`INSERT INTO work_units (id, issue_id, state, provider, provider_session_id)
          VALUES ('wu-stale', 'done123', 'resolved', 'codex', 'thread-stale')`).run();
      }],
      ["live direct sessions and active parent-role holders", (db: InstanceType<typeof SqliteDatabase>) => {
        db.prepare("INSERT INTO sessions (id, status) VALUES ('thread-live', 'active'), ('thread-parent', 'idle')").run();
        parentRole(db, "thread-parent");
        db.prepare(`INSERT INTO work_units (id, issue_id, state, provider, provider_session_id, worker_provider_session_id)
          VALUES ('wu-live', 'done123', 'resolved', 'codex', 'thread-live', 'thread-live'),
                 ('wu-parent', 'done123', 'resolved', 'codex', 'thread-parent', 'thread-parent')`).run();
      }],
      ["a stopped session that once held a parent role", (db: InstanceType<typeof SqliteDatabase>) => {
        db.prepare("INSERT INTO sessions (id, status) VALUES ('thread-parent', 'ended')").run();
        parentRole(db, "thread-parent");
        db.prepare(`INSERT INTO work_units (id, issue_id, state, provider, provider_session_id, worker_provider_session_id, auth_request_id)
          VALUES ('wu-parent', 'done123', 'resolved', 'codex', 'thread-parent', 'thread-parent', 'auth-1')`).run();
      }],
    ])("excludes %s", (_label, setup) => {
      expect(candidateDb(setup)).toEqual([]);
    });

    it.each([
      ["a console session linked to the closure issue through the ledger", (db: InstanceType<typeof SqliteDatabase>) => {
        stoppedConsole(db, "console-worker", "thread-worker");
        db.prepare("INSERT INTO ledger_session_issue_links (session_id, issue_id, created_at) VALUES ('thread-worker', 'done123', 1)").run();
      }, { provider_session_id: "thread-worker", console_session_id: "console-worker", mandible_session_id: null, issue_id: "done123", work_unit_id: null }],
      ["the assigned worker session instead of a parent provider id", (db: InstanceType<typeof SqliteDatabase>) => {
        parentRole(db, "thread-parent");
        stoppedConsole(db, "console-worker", "thread-worker");
        db.prepare(`INSERT INTO work_units (id, issue_id, state, assigned_session_id, provider, provider_session_id, auth_request_id)
          VALUES ('wu-child', 'done123', 'resolved', 'console-worker', 'codex', 'thread-parent', 'auth-1')`).run();
      }, { provider_session_id: "thread-worker", console_session_id: "console-worker", mandible_session_id: null, issue_id: "done123", work_unit_id: "wu-child" }],
      ["one best candidate per declared closure issue", (db: InstanceType<typeof SqliteDatabase>) => {
        stoppedConsole(db, "console-worker-a", "thread-worker-a");
        stoppedConsole(db, "console-worker-b", "thread-worker-b");
        db.prepare(`INSERT INTO work_units (id, issue_id, state, assigned_session_id, provider, provider_session_id, auth_request_id)
          VALUES ('wu-b', 'done123', 'resolved', 'console-worker-b', 'codex', 'thread-direct-b', 'auth-1'),
                 ('wu-a', 'done123', 'resolved', 'console-worker-a', 'codex', 'thread-direct-a', 'auth-1')`).run();
      }, { provider_session_id: "thread-worker-a", console_session_id: "console-worker-a", mandible_session_id: null, issue_id: "done123", work_unit_id: "wu-a" }],
    ])("selects %s", (_label, setup, expected) => {
      expect(candidateDb(setup)).toEqual([expected]);
    });
  });
});
