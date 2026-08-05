import { describe, expect, it, vi } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
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

function submitSuccessfulRequest(
  queue: AuthQueue,
  options: SubmitOptions = {},
): string {
  const type = options.type ?? "merge";
  const request = queue.submit({
    type,
    command: type === "merge"
      ? "mandible auth merge feature/x --into main"
      : "mandible auth commit",
    title: "Finalizer test",
    repo: "finalizer-repo",
    base_branch: options.base_branch === undefined ? "main" : options.base_branch ?? undefined,
    head_branch: options.head_branch === undefined ? "feature/x" : options.head_branch ?? undefined,
    merge_head_sha: HEAD_SHA,
    issue_closures: options.issue_closures,
    execution_mode: "remote",
  });
  // Attributed merges must be approved (→ executing) before a remote result is
  // recorded; approve here so setResult on the returned id follows the lifecycle.
  queue.approve(request.id);
  return request.id;
}

/** Insert a resolved-on-merge codex worker work unit so an archive candidate exists. */
function insertCodexWorkUnit(
  db: Db,
  id: string,
  authRequestId: string,
  providerSessionId: string,
): void {
  db.prepare(
    `INSERT INTO work_units (
      id, issue_id, repo_id, branch, kind, state, provider, provider_session_id, created_at, auth_request_id
    ) VALUES (?, ?, 'finalizer-repo', NULL, 'solo', 'committed', 'codex', ?, 0, ?)`
  ).run(id, `issue-${id}`, providerSessionId, authRequestId);
}

function eventsFor(events: SseEvent[], requestId: string, name: string): SseEvent[] {
  return events.filter((event) => {
    if (event.event !== name) return false;
    const data = event.data as { request_id?: string } | undefined;
    return data?.request_id === requestId;
  });
}

describe("auth finalizer queue (Issue 75f52ac)", () => {
  it("emits merged -> resolved -> finalized in order with the right payload shapes", async () => {
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      const id = submitSuccessfulRequest(queue);
      queue.setResult(id, 0, "ok");
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
      const id = submitSuccessfulRequest(queue);
      insertCodexWorkUnit(db, "wu-off-loop", id, "thread-off-loop");

      queue.setResult(id, 0, "ok");
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
      const id = submitSuccessfulRequest(queue);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at, auth_request_id)
         VALUES ('wu-direct', 'issue-direct', 'finalizer-repo', NULL, 'solo', 'committed', 0, ?)`
      ).run(id);

      queue.setResult(id, 0, "ok");
      await queue.drainFinalizers();

      // The direct-match work unit was already resolved at the auth:resolved emit.
      expect(resolvedStates).toEqual(["resolved"]);
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
      const id = submitSuccessfulRequest(queue);

      const sweep = () => (queue as unknown as { sweepSuccessfulMergeFinalizers(): void })
        .sweepSuccessfulMergeFinalizers();

      // Attempt 1 (via setResult) leaves the step retryable, not finalized.
      queue.setResult(id, 0, "ok");
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
      const id = "crash-request";
      db.prepare(
        `INSERT INTO auth_requests (
          id, session_id, type, command, title, repo, base_branch, head_branch,
          merge_head_sha, status, created_at, updated_at, resolved_at, expires_at,
          exit_code, output, execution_mode, files_changed, additions, deletions,
          approval_source, merge_finalizer_state
        ) VALUES (
          ?, NULL, 'merge', 'mandible auth merge feature/x --into main', 'Crash',
          'finalizer-repo', 'main', 'feature/x', ?, 'completed', 100, 100, 100, 100000,
          0, 'ok', 'remote', 0, 0, 0, 'manual', ?
        )`
      ).run(
        id,
        HEAD_SHA,
        JSON.stringify({
          revalidate_pending: { state: "done", attempts: 1, at: 0 },
          auto_dismiss_duplicates: { state: "done", attempts: 1, at: 0 },
          resolve_ancestry_work_units: { state: "done", attempts: 1, at: 0 },
          archive_worker_threads: { state: "pending", attempts: 1, error: "boom", at: 0 },
        }),
      );
      db.prepare(
        `INSERT INTO work_units (
          id, issue_id, repo_id, branch, kind, state, provider, provider_session_id, created_at, resolved_at, auth_request_id
        ) VALUES ('wu-crash', 'issue-crash', 'finalizer-repo', NULL, 'solo', 'resolved', 'codex', 'thread-crash', 0, 100, ?)`
      ).run(id);

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
      const id = submitSuccessfulRequest(queue, { type: "commit", base_branch: null, head_branch: null });
      queue.setResult(id, 0, "ok");
      await queue.drainFinalizers();

      expect(eventsFor(events, id, "auth:merged")).toHaveLength(0);
      expect(eventsFor(events, id, "auth:resolved")).toHaveLength(1);
      expect(eventsFor(events, id, "auth:finalized")).toHaveLength(1);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("finalizes overflow rows through repeated sweeps instead of erroring", async () => {
    const db = createMigratedDb();
    try {
      const queue = new AuthQueue({ db, broadcast: () => undefined });
      try {
        // Seed 40 completed, unfinalized successful merges directly in the DB so
        // a single sweep must enqueue more than the 32-slot bound.
        for (let index = 0; index < 40; index += 1) {
          db.prepare(
            `INSERT INTO auth_requests (
              id, session_id, type, command, title, repo, base_branch, head_branch,
              merge_head_sha, status, created_at, updated_at, resolved_at, expires_at,
              exit_code, output, execution_mode, files_changed, additions, deletions,
              approval_source
            ) VALUES (
              ?, NULL, 'merge', 'mandible auth merge feature/of --into main', 'Overflow',
              'overflow-repo', 'main', ?, ?, 'completed', 100, 100, 100, 100000,
              0, 'ok', 'remote', 0, 0, 0, 'manual'
            )`
          ).run(`overflow-${index}`, `feature/of-${index}`, HEAD_SHA);
        }

        const sweep = () => (queue as unknown as { sweepSuccessfulMergeFinalizers(): void })
          .sweepSuccessfulMergeFinalizers();

        // First sweep enqueues only up to the 32-slot bound; the remaining rows
        // are rejected (not an error) and stay unfinalized.
        sweep();
        await queue.drainFinalizers();
        const afterFirst = (db.prepare(
          "SELECT COUNT(*) AS n FROM auth_requests WHERE merge_finalized_at IS NULL",
        ).get() as { n: number }).n;
        expect(afterFirst).toBeGreaterThan(0);

        // The periodic sweep backstop (called from the idle 30 s tick) re-enqueues
        // the overflow rows on the next pass until every row is finalized.
        for (let pass = 0; pass < 5; pass += 1) {
          sweep();
          await queue.drainFinalizers();
        }

        const unfinalized = (db.prepare(
          "SELECT COUNT(*) AS n FROM auth_requests WHERE merge_finalized_at IS NULL",
        ).get() as { n: number }).n;
        expect(unfinalized).toBe(0);
      } finally {
        queue.dispose();
      }
    } finally {
      db.close();
    }
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
      const id = submitSuccessfulRequest(queue);
      queue.setResult(id, 0, "ok");
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
      const id = submitSuccessfulRequest(queue);
      insertCodexWorkUnit(db, "wu-archive-fail", id, "thread-archive-fail");

      // Attempt 1 (via setResult) leaves the archive step retryable, not finalized.
      queue.setResult(id, 0, "ok");
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
      const id = submitSuccessfulRequest(queue);
      insertCodexWorkUnit(db, "wu-arch", id, "thread-arch");

      // Pass 1: ancestry succeeds (output persisted), archive fails → not finalized.
      queue.setResult(id, 0, "ok");
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
    const id = "replay-request";
    // A completed, unfinalized merge whose steps are all recorded done with their
    // outputs — the state a crash leaves after the last pass wrote step state but
    // before the finalize broadcast/marker.
    db.prepare(
      `INSERT INTO auth_requests (
        id, session_id, type, command, title, repo, base_branch, head_branch,
        merge_head_sha, status, created_at, updated_at, resolved_at, expires_at,
        exit_code, output, execution_mode, files_changed, additions, deletions,
        approval_source, merge_finalizer_state
      ) VALUES (
        ?, NULL, 'merge', 'mandible auth merge feature/x --into main', 'Replay',
        'finalizer-repo', 'main', 'feature/x', ?, 'completed', 100, 100, 100, 100000,
        0, 'ok', 'remote', 0, 0, 0, 'manual', ?
      )`
    ).run(
      id,
      HEAD_SHA,
      JSON.stringify({
        revalidate_pending: { state: "done", attempts: 1, at: 0 },
        auto_dismiss_duplicates: { state: "done", attempts: 1, at: 0 },
        resolve_ancestry_work_units: {
          state: "done",
          attempts: 1,
          at: 0,
          output: { resolved_work_unit_ids: ["wu-x", "wu-y"] },
        },
        archive_worker_threads: {
          state: "done",
          attempts: 2,
          at: 0,
          output: { archived_thread_count: 3 },
        },
      }),
    );

    const recovered = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
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
