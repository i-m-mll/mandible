import { approvePausedFixtureRequest, completeFixturePublication, createAuthCheckRepo, commitOnBranch, registerWorkRepo, git, createNoopHookManager, insertConsoleSession } from "./helpers/auth-queue-fixtures.js";
import { describe, expect, it, vi } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { archiveFinishedWorkerThreads } from "../src/codex-thread-archive.js";
import type { Db } from "../src/db.js";
import type { SseEvent } from "../src/types.js";
import { createMigratedDb as createSharedMigratedDb } from "./helpers/ledger-fixtures.js";

// Issue 75f52ac — staged auth lifecycle (auth:merged -> auth:resolved ->
// auth:finalized) and the bounded, idempotent, crash-safe background finalizer
// queue. These tests exercise the queue behaviour directly, independent of the
// git-repo integration paths covered in auth-queue.test.ts.

function createMigratedDb(): Db {
  return createSharedMigratedDb({
    // Attribution (main/user-system): submit()/approve() resolve a local operator;
    // seed one so the staged-lifecycle tests can attribute and approve requests.
    operator: { slug: "finalizer-test-operator", display_name: "Finalizer Test Operator" },
    now: 1,
  });
}

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface SubmitOptions {
  type?: "merge" | "commit";
  base_branch?: string | null;
  head_branch?: string | null;
  issue_closures?: string[];
}

async function submitSuccessfulRequest(
  queue: AuthQueue,
  options: SubmitOptions = {},
): Promise<string> {
  const type = options.type ?? "merge";
  const repo = createAuthCheckRepo();
  registerWorkRepo((queue as unknown as { db: Db }).db, repo);
  commitOnBranch(repo, "feature/x", { "finalizer.txt": "reviewed\n" });
  const request = queue.submit({
    type,
    command: type === "merge"
      ? "mandible auth merge feature/x --into main"
      : "mandible auth commit",
    title: "Finalizer test",
    repo: "finalizer-repo",
    cwd: repo,
    base_branch: options.base_branch === undefined ? "main" : options.base_branch ?? undefined,
    head_branch: options.head_branch === undefined ? "feature/x" : options.head_branch ?? undefined,
    merge_head_sha: git(repo, ["rev-parse", "feature/x"]),
    issue_closures: options.issue_closures,
    execution_mode: "daemon",
  });
  // Attributed merges must be approved (→ executing) before a remote result is
  // recorded; approve here so setResult on the returned id follows the lifecycle.
  await approvePausedFixtureRequest(queue, request.id);
  return request.id;
}

/**
 * Insert a codex work unit linked to the request through a stopped console
 * session, so the merge finalizer's archive step has a candidate. Units bound
 * by `activate --worker` are archived by the work-unit reconciler instead.
 */
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
    ) VALUES (?, ?, 'finalizer-repo', NULL, 'solo', ?, ?, 'codex', ?, 0, ?, ?)`
  ).run(id, `issue-${id}`, state, `console-${id}`, providerSessionId,
    state === "resolved" ? 100 : null, authRequestId);
}

function eventsFor(events: SseEvent[], requestId: string, name: string): SseEvent[] {
  return events.filter((event) => {
    if (event.event !== name) return false;
    const data = event.data as { request_id?: string } | undefined;
    return data?.request_id === requestId;
  });
}

describe("auth finalizer queue (Issue 75f52ac)", () => {
  it("leaves worker-bound threads to the reconciler, which archives only explicit worker ownership", async () => {
    const db = createMigratedDb();
    const archived: string[] = [];
    const queue = new AuthQueue({
      db,
      broadcast: () => undefined,
      codexThreadArchiver: {
        archive: async (threadId) => { archived.push(threadId); },
        unarchive: async () => undefined,
      },
    });
    try {
      const id = await submitSuccessfulRequest(queue);
      db.prepare(
        `INSERT INTO work_units (
          id, issue_id, repo_id, branch, kind, state, assigned_session_id,
          provider, provider_session_id, worker_provider_session_id, created_at,
          resolved_at, auth_request_id
        ) VALUES
          (?, '66b3bda', 'finalizer-repo', NULL, 'solo', 'resolved', NULL,
           'codex', ?, NULL, 0, ?, ?),
          ('wu-explicit', 'issue-explicit', 'finalizer-repo', NULL, 'solo', 'resolved', NULL,
           'codex', 'ambient-explicit', 'thread-explicit', 0, ?, ?)`,
      ).run(
        "53ac5b81-f6f2-4898-84b5-02e5b725a84b",
        "01a01b97-bc06-7df0-ae37-2e287fdf4694",
        Date.parse("2026-08-20T13:04:55Z"),
        id,
        Date.parse("2026-08-20T13:04:55Z"),
        id,
      );

      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();
      expect(archived).toEqual([]);

      await archiveFinishedWorkerThreads(db, {
        archiver: { archive: async (threadId) => { archived.push(threadId); }, unarchive: async () => undefined },
        liveness: () => "stopped",
        resolveAlias: () => null,
        now: () => 0,
      });
      expect(archived).toEqual(["thread-explicit"]);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("emits merged -> resolved -> finalized in order with the right payload shapes", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      const id = await submitSuccessfulRequest(queue);
      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();

      const names = events
        .filter((event) => {
          const data = event.data as { request_id?: string } | undefined;
          return data?.request_id === id && typeof event.event === "string" &&
            ["auth:merged", "auth:resolved", "auth:finalized"].includes(event.event);
        })
        .map((event) => event.event);
      expect(names).toEqual(["auth:merged", "auth:resolved", "auth:finalized"]);

      const merged = eventsFor(events, id, "auth:merged")[0]?.data as Record<string, unknown>;
      const resolved = eventsFor(events, id, "auth:resolved")[0]?.data as Record<string, unknown>;
      const finalized = eventsFor(events, id, "auth:finalized")[0]?.data as Record<string, unknown>;

      // merged carries the resolved shape minus action_outcomes.
      expect(merged).not.toHaveProperty("action_outcomes");
      expect(merged.status).toBe("completed");
      expect(resolved).toHaveProperty("action_outcomes");
      // finalized reports per-step outcomes and the terminal marker.
      expect(finalized.merge_finalized_at).toBe(queue.getRequest(id)?.merge_finalized_at);
      expect(Array.isArray(finalized.steps)).toBe(true);
      expect((finalized.steps as Array<{ name: string }>).map((s) => s.name)).toEqual([
        "revalidate_pending",
        "auto_dismiss_duplicates",
        "resolve_ancestry_work_units",
        "archive_worker_threads",
      ]);
      expect(finalized).toHaveProperty("resolved_work_unit_ids");
      expect(finalized).toHaveProperty("archived_thread_count");
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("broadcasts auth:resolved before Stage 3 completes (finalizers run off the critical path)", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    let releaseArchive: (() => void) | null = null;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const queue = new AuthQueue({
      db,
      broadcast: (event) => events.push(event),
      codexThreadArchiver: {
        archive: async () => {
          await archiveGate;
        },
        unarchive: async () => undefined,
      },
    });
    try {
      const id = await submitSuccessfulRequest(queue);
      insertCodexWorkUnit(db, "wu-off-loop", id, "thread-off-loop");

      await completeFixturePublication(queue, id);
      // Let the finalizer queue advance to the (blocked) archive step.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // auth:resolved has fired; auth:finalized has not (archive is blocked).
      expect(eventsFor(events, id, "auth:resolved")).toHaveLength(1);
      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(0);
      expect(queue.getRequest(id)?.merge_finalized_at).toBeNull();

      releaseArchive?.();
      await queue.drainFinalizers();

      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(1);
      const finalized = eventsFor(events, id, "auth:finalized")[0].data as {
        archived_thread_count: number;
      };
      expect(finalized.archived_thread_count).toBe(1);
      expect(queue.getRequest(id)?.merge_finalized_at).not.toBeNull();
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("resolves direct work units in Stage 2 (visible at auth:resolved)", async () => {
    const db = createMigratedDb();
    const resolvedStates: string[] = [];
    const queue = new AuthQueue({
      db,
      broadcast: (event) => {
        if (event.event === "auth:resolved") {
          const row = db.prepare("SELECT state FROM work_units WHERE id = 'wu-direct'").get() as
            | { state: string }
            | undefined;
          if (row) resolvedStates.push(row.state);
        }
      },
    });
    try {
      const id = await submitSuccessfulRequest(queue);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at, auth_request_id)
         VALUES ('wu-direct', 'issue-direct', 'finalizer-repo', NULL, 'solo', 'committed', 0, ?)`
      ).run(id);

      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();

      // The direct-match work unit was already resolved at the auth:resolved emit.
      expect(resolvedStates).toEqual(["resolved"]);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("recovers a same-head work unit abandoned before successful Stage 2 finalization", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      const id = await submitSuccessfulRequest(queue, { issue_closures: ["issue-raced"] });
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-raced', 'issue-raced', 'finalizer-repo', 'feature/x', 'solo', 'abandoned', 0)`,
      ).run();
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-other-repo', 'issue-other', 'other-repo', 'feature/x', 'solo', 'abandoned', 0)`,
      ).run();
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-same-issue-old-branch', 'issue-raced', 'finalizer-repo', 'feature/old', 'solo', 'abandoned', 0)`,
      ).run();

      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();

      expect(db.prepare(
        "SELECT state, auth_request_id, resolved_at FROM work_units WHERE id = 'wu-raced'",
      ).get()).toEqual({
        state: "resolved",
        auth_request_id: id,
        resolved_at: expect.any(Number),
      });
      const finalized = eventsFor(events, id, "auth:finalized")[0].data as {
        resolved_work_unit_ids: string[];
      };
      expect(finalized.resolved_work_unit_ids).toContain("wu-raced");
      expect(db.prepare("SELECT state FROM work_units WHERE id = 'wu-other-repo'").get())
        .toEqual({ state: "abandoned" });
      expect(db.prepare(
        "SELECT state, auth_request_id FROM work_units WHERE id = 'wu-same-issue-old-branch'",
      ).get()).toEqual({ state: "abandoned", auth_request_id: null });
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("retries a failing step up to three attempts, then finalizes with the step marked failed", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    // The archiver swallows its own errors by design, so drive a hard step
    // failure by making the ancestry-resolution step reject.
    vi.spyOn(
      queue as unknown as { resolveAncestryWorkUnitsOnMerge(r: unknown): Promise<string[]> },
      "resolveAncestryWorkUnitsOnMerge",
    ).mockRejectedValue(new Error("ancestry boom"));
    try {
      const id = await submitSuccessfulRequest(queue);

      const sweep = () => (queue as unknown as { sweepSuccessfulMergeFinalizers(): void })
        .sweepSuccessfulMergeFinalizers();

      // Attempt 1 (via setResult) leaves the step retryable, not finalized.
      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();
      expect(queue.getRequest(id)?.merge_finalized_at).toBeNull();
      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(0);

      // Attempts 2 and 3 via the sweep. After the third the step is failed and
      // the request finalizes regardless.
      sweep();
      await queue.drainFinalizers();
      expect(queue.getRequest(id)?.merge_finalized_at).toBeNull();
      sweep();
      await queue.drainFinalizers();

      const finalizedRow = queue.getRequest(id);
      expect(finalizedRow?.merge_finalized_at).not.toBeNull();
      const state = JSON.parse(finalizedRow?.merge_finalizer_state ?? "{}");
      expect(state.resolve_ancestry_work_units.state).toBe("failed");
      expect(state.resolve_ancestry_work_units.attempts).toBe(3);

      const finalized = eventsFor(events, id, "auth:finalized")[0].data as {
        steps: Array<{ name: string; state: string; error?: string }>;
      };
      const failedStep = finalized.steps.find((s) => s.name === "resolve_ancestry_work_units");
      expect(failedStep?.state).toBe("failed");
      expect(failedStep?.error).toContain("ancestry boom");
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("resumes remaining steps from durable state after a crash (fresh queue over a partial row)", async () => {
    const db = createMigratedDb();
    const archived: string[] = [];
    try {
      // Simulate a crash mid-finalizer by writing the DB state directly: a
      // completed, successful, unfinalized merge whose earlier steps are recorded
      // done and only archiving remains pending, with a resolved codex worker unit
      // still awaiting archival.
      const first = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
      const id = await submitSuccessfulRequest(first);
      await completeFixturePublication(first, id);
      await first.drainFinalizers(); first.dispose();
      db.prepare("UPDATE auth_requests SET merge_finalized_at = NULL, merge_finalizer_state = ? WHERE id = ?").run(
        JSON.stringify({
          revalidate_pending: { state: 'done', attempts: 1, at: 0 },
          auto_dismiss_duplicates: { state: 'done', attempts: 1, at: 0 },
          resolve_ancestry_work_units: { state: 'done', attempts: 1, at: 0 },
          archive_worker_threads: { state: 'pending', attempts: 1, error: 'boom', at: 0 },
        }), id);
      insertCodexWorkUnit(db, "wu-crash", id, "thread-crash", "resolved");

      // Fresh queue: the startup sweep resumes only the archive step.
      const recovered = new AuthQueue({
        db,
        broadcast: () => undefined,
        codexThreadArchiver: {
          archive: async (threadId) => { archived.push(threadId); },
          unarchive: async () => undefined,
        },
      });
      try {
        await vi.waitFor(() => expect(recovered.getRequest(id)?.merge_finalized_at).not.toBeNull());
        await recovered.drainFinalizers();
        expect(archived).toEqual(["thread-crash"]);
        const row = recovered.getRequest(id);
        expect(row?.merge_finalized_at).not.toBeNull();
        const state = JSON.parse(row?.merge_finalizer_state ?? "{}");
        expect(state.archive_worker_threads.state).toBe("done");
      } finally {
        recovered.dispose();
      }
    } finally {
      db.close();
    }
  });

  it("does not emit auth:merged for a non-merge success but still stages resolved and finalized", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      const id = await submitSuccessfulRequest(queue, { type: "commit", base_branch: null, head_branch: null });
      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();

      expect(eventsFor(events, id, "auth:merged")).toHaveLength(0);
      expect(eventsFor(events, id, "auth:resolved")).toHaveLength(1);
      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(1);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("bounds finalizer admission and accepts overflow after the first batch drains", async () => {
    const db = createMigratedDb();
    const owner = new AuthQueue({ db, backgroundMaintenance: false });
    try {
      type Queue = { enqueue(id: string): boolean; drain(): Promise<void> };
      const QueueClass = (owner as unknown as { finalizerQueue: { constructor: new (run: (id: string) => Promise<void>) => Queue } }).finalizerQueue.constructor;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const processed: string[] = [];
      const queue = new QueueClass(async id => { await gate; processed.push(id); });
      const overflow: string[] = [];
      for (let n = 0; n < 40; n++) if (!queue.enqueue(String(n))) overflow.push(String(n));
      expect(overflow.length).toBeGreaterThan(0);
      release(); await queue.drain();
      for (const id of overflow) expect(queue.enqueue(id)).toBe(true);
      await queue.drain();
      expect(new Set(processed).size).toBe(40);
      expect(processed).toHaveLength(40);
    } finally { owner.dispose(); db.close(); }
  });

  // Integration reconciliation (issue 75f52ac) — at-least-once auth:finalized.
  it("broadcasts auth:finalized before writing the durable merge_finalized_at marker", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    let markerAtBroadcast: number | null | undefined;
    const queue = new AuthQueue({
      db,
      broadcast: (event) => {
        events.push(event);
        if (event.event === "auth:finalized") {
          // Observe the durable marker at the exact moment the event is emitted.
          // If the event fires before the marker is persisted, the row is still
          // sweep-eligible — so a crash here re-emits (at-least-once) rather than
          // permanently dropping the event.
          const requestId = (event.data as { request_id: string }).request_id;
          const row = db
            .prepare("SELECT merge_finalized_at FROM auth_requests WHERE id = ?")
            .get(requestId) as { merge_finalized_at: number | null } | undefined;
          markerAtBroadcast = row?.merge_finalized_at ?? null;
        }
      },
    });
    try {
      const id = await submitSuccessfulRequest(queue);
      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();

      // The marker was unset when auth:finalized fired...
      expect(markerAtBroadcast).toBeNull();
      // ...and is persisted once the pass completes.
      const persisted = queue.getRequest(id)?.merge_finalized_at;
      expect(persisted).not.toBeNull();
      // The payload carries the timestamp that was persisted (not a stale null).
      const finalized = eventsFor(events, id, "auth:finalized")[0].data as {
        merge_finalized_at: number | null;
      };
      expect(finalized.merge_finalized_at).toBe(persisted);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  // Integration reconciliation (issue 75f52ac) — a codex archive CLI attempt
  // failure must not silently resolve the archive step; it is propagated to the
  // finalizer's bounded retry rather than durably marked done and lost.
  it("retries the archive step when the codex archive attempt fails, then finalizes it failed", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    let archiveCalls = 0;
    const queue = new AuthQueue({
      db,
      broadcast: (event) => events.push(event),
      codexThreadArchiver: {
        archive: async () => {
          archiveCalls += 1;
          throw new Error("codex archive boom");
        },
        unarchive: async () => undefined,
      },
    });
    const sweep = () => (queue as unknown as { sweepSuccessfulMergeFinalizers(): void })
      .sweepSuccessfulMergeFinalizers();
    try {
      const id = await submitSuccessfulRequest(queue);
      insertCodexWorkUnit(db, "wu-archive-fail", id, "thread-archive-fail");

      // Attempt 1 (via setResult) leaves the archive step retryable, not finalized.
      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();
      expect(queue.getRequest(id)?.merge_finalized_at).toBeNull();
      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(0);

      // Attempts 2 and 3 via the sweep. After the third the step is failed@max
      // and the request finalizes regardless.
      sweep();
      await queue.drainFinalizers();
      expect(queue.getRequest(id)?.merge_finalized_at).toBeNull();
      sweep();
      await queue.drainFinalizers();

      const finalizedRow = queue.getRequest(id);
      expect(finalizedRow?.merge_finalized_at).not.toBeNull();
      const state = JSON.parse(finalizedRow?.merge_finalizer_state ?? "{}");
      expect(state.archive_worker_threads.state).toBe("failed");
      expect(state.archive_worker_threads.attempts).toBe(3);
      // The CLI attempt was actually retried each pass, not skipped.
      expect(archiveCalls).toBe(3);

      const finalized = eventsFor(events, id, "auth:finalized")[0].data as {
        steps: Array<{ name: string; state: string }>;
      };
      const archiveStep = finalized.steps.find((s) => s.name === "archive_worker_threads");
      expect(archiveStep?.state).toBe("failed");
    } finally {
      queue.dispose();
      db.close();
    }
  });

  // Integration reconciliation (issue 75f52ac) — per-step outputs are persisted
  // into merge_finalizer_state and the terminal payload is reconstructed from
  // them, so a step's output produced on an earlier pass is not lost when a later
  // pass skips the already-done step.
  it("carries the ancestry pass's resolved_work_unit_ids through an archive retry", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    let archiveCalls = 0;
    const queue = new AuthQueue({
      db,
      broadcast: (event) => events.push(event),
      codexThreadArchiver: {
        archive: async () => {
          archiveCalls += 1;
          if (archiveCalls < 2) throw new Error("codex archive boom");
        },
        unarchive: async () => undefined,
      },
    });
    // Ancestry resolves ids on pass 1; on pass 2 the step is skipped as done, so
    // a process-local accumulator would be empty — only the persisted output
    // preserves the ids.
    vi.spyOn(
      queue as unknown as { resolveAncestryWorkUnitsOnMerge(r: unknown): Promise<string[]> },
      "resolveAncestryWorkUnitsOnMerge",
    ).mockResolvedValue(["wu-a", "wu-b"]);
    const sweep = () => (queue as unknown as { sweepSuccessfulMergeFinalizers(): void })
      .sweepSuccessfulMergeFinalizers();
    try {
      const id = await submitSuccessfulRequest(queue);
      insertCodexWorkUnit(db, "wu-arch", id, "thread-arch");

      // Pass 1: ancestry succeeds (output persisted), archive fails → not finalized.
      await completeFixturePublication(queue, id);
      await queue.drainFinalizers();
      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(0);
      const midState = JSON.parse(queue.getRequest(id)?.merge_finalizer_state ?? "{}");
      expect(midState.resolve_ancestry_work_units.output.resolved_work_unit_ids).toEqual([
        "wu-a",
        "wu-b",
      ]);

      // Pass 2: ancestry skipped (done), archive succeeds → finalize.
      sweep();
      await queue.drainFinalizers();

      const finalized = eventsFor(events, id, "auth:finalized")[0].data as {
        resolved_work_unit_ids: string[];
        archived_thread_count: number;
      };
      // The earlier ancestry pass's ids survive the archive retry.
      expect(finalized.resolved_work_unit_ids).toEqual(["wu-a", "wu-b"]);
      expect(finalized.archived_thread_count).toBe(1);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  // Integration reconciliation (issue 75f52ac) — a crash-replayed finalize
  // reconstructs the payload from persisted per-step outputs rather than emitting
  // empty ids / zero archives.
  it("reconstructs the auth:finalized payload from persisted per-step outputs on replay", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const first = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    const id = await submitSuccessfulRequest(first);
    await completeFixturePublication(first, id); await first.drainFinalizers(); first.dispose();
    db.prepare("UPDATE auth_requests SET merge_finalized_at = NULL, merge_finalizer_state = ? WHERE id = ?").run(
      JSON.stringify({
        revalidate_pending: { state: 'done', attempts: 1, at: 0 },
        auto_dismiss_duplicates: { state: 'done', attempts: 1, at: 0 },
        resolve_ancestry_work_units: { state: 'done', attempts: 1, at: 0, output: { resolved_work_unit_ids: ['wu-x', 'wu-y'] } },
        archive_worker_threads: { state: 'done', attempts: 2, at: 0, output: { archived_thread_count: 3 } },
      }), id);

    const recovered = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      await vi.waitFor(() => expect(recovered.getRequest(id)?.merge_finalized_at).not.toBeNull());
      await recovered.drainFinalizers();
      const finalized = eventsFor(events, id, "auth:finalized")[0].data as {
        resolved_work_unit_ids: string[];
        archived_thread_count: number;
      };
      expect(finalized.resolved_work_unit_ids).toEqual(["wu-x", "wu-y"]);
      expect(finalized.archived_thread_count).toBe(3);
      expect(recovered.getRequest(id)?.merge_finalized_at).not.toBeNull();
    } finally {
      recovered.dispose();
      db.close();
    }
  });
});
