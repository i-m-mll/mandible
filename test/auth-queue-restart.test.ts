import { waitUntil } from "./helpers/wait-until.js";
import { approveFixtureRequest, publishFixtureExecution } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * Self-rebuild event ordering, history projection, and self-merge restart drain.
 *
 * Split out of the former 6,122-line `test/auth-queue.test.ts` (issue 9e40a31).
 * Vitest parallelises across files and never within one, so that single file was
 * 98.9% of the default gate's wall clock. Test names and assertions are
 * unchanged; the shared helpers live in `test/helpers/auth-queue-fixtures.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import type { SseEvent } from "../src/types.js";
import { commitOnBranch, createAuthCheckRepo, createMigratedDb, git, registerWorkRepo, waitForStatus } from "./helpers/auth-queue-fixtures.js";

function admittedRebuildHooks(db: ReturnType<typeof createMigratedDb>, beforeRun?: () => void | Promise<void>): AuthHookManager {
  const hooks = new AuthHookManager(db);
  db.prepare('UPDATE auth_hooks SET command = ?, repo_pattern = ? WHERE id = ?').run(`printf 'MANDIBLE_RUNTIME_HANDOFF_PENDING:${'a'.repeat(64)}\\n'; exit 75`, '*', 'builtin-mandible-rebuild');
  vi.spyOn(hooks, 'admittedDrainIdentity').mockImplementation(async requestId => hooks.getRun(requestId, 'builtin-mandible-rebuild')?.exit_code === 75 ? 'private-current-admission' : null);
  const execute = hooks.executeHooks.bind(hooks);
  hooks.executeHooks = async (...args) => { await beforeRun?.(); return execute(...args); };
  return hooks;
}

describe("auth queue", () => {
  describe("self-rebuild event ordering", () => {
    it("broadcasts auth:resolved before scheduling self-rebuild exit", async () => {
      const events: SseEvent[] = [];
      let exitScheduled = false;
      let resolvedBeforeExit = false;
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;

      // Mock setTimeout to detect when process.exit is scheduled
      const originalSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = (fn: (...args: unknown[]) => void, ms?: number) => {
        // The self-rebuild uses a 2000ms timeout for process.exit
        if (ms === 2000) {
          exitScheduled = true;
          // Don't actually call process.exit — just record it
          return originalSetTimeout(() => {}, 0);
        }
        return originalSetTimeout(fn, ms);
      };
      globalThis.setTimeout = setTimeoutSpy as typeof globalThis.setTimeout;

      try {
        commitOnBranch(repo, "feature/self-fix", { "self.txt": "fix\n" });
        registerWorkRepo(db, repo);
        queue = new AuthQueue({
          db,
          hookManager: admittedRebuildHooks(db),
          broadcast: (event) => {
            events.push(event);
            if (event.event === "auth:resolved") {
              // At the moment auth:resolved fires, exit should NOT yet be scheduled
              resolvedBeforeExit = !exitScheduled;
            }
          },
          executor: async (options) => publishFixtureExecution(queue!, options)
        });

        const request = queue.submit({
          command: "mandible auth merge feature/self-fix --into main",
          title: "Self-merge",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/self-fix",
          merge_head_sha: git(repo, ["rev-parse", "feature/self-fix"]),
          cwd: repo,
          execution_mode: "daemon"
        });

        await approveFixtureRequest(queue, request.id);
        await waitForStatus(queue, request.id, "completed");
        // Give the post-execution code time to run (setTimeout scheduling)
        await new Promise((resolve) => originalSetTimeout(resolve, 100));

        // Verify auth:resolved was broadcast
        expect(events.some((e) => e.event === "auth:resolved")).toBe(true);
        // Verify it fired before the exit was scheduled
        expect(resolvedBeforeExit).toBe(true);
        // Verify exit WAS scheduled (the self-rebuild detection works)
        expect(exitScheduled).toBe(true);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        queue?.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it.each([0, 3])('keeps the healthy daemon running without exact admission after hook exit %i', async exitCode => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;
      const restart = vi.fn();
      const hooks = admittedRebuildHooks(db);
      db.prepare('UPDATE auth_hooks SET command = ? WHERE id = ?').run(`exit ${exitCode}`, 'builtin-mandible-rebuild');
      try {
        commitOnBranch(repo, 'feature/build-failure', { 'failed.txt': 'reviewed change\n' });
        registerWorkRepo(db, repo);
        queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, restartFn: restart,
          executor: async options => publishFixtureExecution(queue!, options) });
        const request = queue.submit({ type: 'merge', command: 'mandible auth merge feature/build-failure --into main',
          title: 'Failed runtime build', repo: 'mandible', cwd: repo, base_branch: 'main', head_branch: 'feature/build-failure',
          merge_head_sha: git(repo, ['rev-parse', 'feature/build-failure']), execution_mode: 'daemon' });
        await approveFixtureRequest(queue, request.id);
        await waitForStatus(queue, request.id, 'completed');
        await vi.waitFor(() => expect(queue!.isRebuilding).toBe(false));
        expect(hooks.getRun(request.id, 'builtin-mandible-rebuild')).toMatchObject({ state: exitCode === 0 ? 'complete' : 'pending', exit_code: exitCode });
        expect(restart).not.toHaveBeenCalled();
        expect(db.prepare('SELECT value FROM meta WHERE key = ?').get('auth_self_merge_shutdown_at')).toBeUndefined();
      } finally { queue?.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
    });

    // Bug: 645f8a8 — the readiness gate relies on mandible:rebuilding being
    // broadcast BEFORE the post-merge hooks run (so the splash is up during the
    // build), and on auth:resolved remaining ordered after it. This locks that
    // ordering in even as readiness wiring evolves.
    it("broadcasts mandible:rebuilding before hooks run and before auth:resolved", async () => {
      const events: SseEvent[] = [];
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;

      // Prevent the real self-rebuild process.exit(0) from killing the test run.
      const originalSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = (fn: (...args: unknown[]) => void, ms?: number) => {
        if (ms === 2000) {
          return originalSetTimeout(() => {}, 0);
        }
        return originalSetTimeout(fn, ms);
      };
      globalThis.setTimeout = setTimeoutSpy as typeof globalThis.setTimeout;

      // A hook manager that records, in the same event stream, the moment hooks
      // run — so we can assert mandible:rebuilding fired strictly before it.
      const hookManager = admittedRebuildHooks(db, () => {
        events.push({ event: "test:hooks-ran", data: {} });
      });

      try {
        commitOnBranch(repo, "feature/order-fix", { "order.txt": "fix\n" });
        registerWorkRepo(db, repo);
        queue = new AuthQueue({
          db,
          hookManager,
          broadcast: (event) => events.push(event),
          executor: async (options) => publishFixtureExecution(queue!, options)
        });

        const request = queue.submit({
          command: "mandible auth merge feature/order-fix --into main",
          title: "Self-merge ordering",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/order-fix",
          merge_head_sha: git(repo, ["rev-parse", "feature/order-fix"]),
          cwd: repo,
          execution_mode: "daemon"
        });

        await approveFixtureRequest(queue, request.id);
        await waitForStatus(queue, request.id, "completed");
        await new Promise((resolve) => originalSetTimeout(resolve, 50));

        const indexOf = (name: string) => events.findIndex((e) => e.event === name);
        const rebuildingIdx = indexOf("mandible:rebuilding");
        const hooksIdx = indexOf("test:hooks-ran");
        const resolvedIdx = indexOf("auth:resolved");

        expect(rebuildingIdx).toBeGreaterThanOrEqual(0);
        expect(hooksIdx).toBeGreaterThanOrEqual(0);
        expect(resolvedIdx).toBeGreaterThanOrEqual(0);
        // rebuilding strictly before hooks, and before auth:resolved.
        expect(hooksIdx).toBeGreaterThan(rebuildingIdx);
        expect(resolvedIdx).toBeGreaterThan(rebuildingIdx);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        queue?.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it("uses a 2-second delay for self-rebuild exit to allow event delivery", async () => {
      let exitDelayMs: number | undefined;
      const lifecycleEvents: string[] = [];
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;

      const originalSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = (fn: (...args: unknown[]) => void, ms?: number) => {
        // Capture the delay used for the self-rebuild exit
        if (ms === 2000) {
          exitDelayMs = ms;
          return originalSetTimeout(fn, 0);
        }
        return originalSetTimeout(fn, ms);
      };
      globalThis.setTimeout = setTimeoutSpy as typeof globalThis.setTimeout;

      try {
        commitOnBranch(repo, "feature/delay-test", { "delay.txt": "fix\n" });
        registerWorkRepo(db, repo);
        queue = new AuthQueue({
          db,
          hookManager: admittedRebuildHooks(db, () => { lifecycleEvents.push("hooks"); }),
          restartAvailability: {
            markRebuildStarted: (generationId) => {
              lifecycleEvents.push(`rebuild:${generationId}`);
              return generationId ?? null;
            },
            markShutdownStarted: (generationId) => {
              lifecycleEvents.push(`shutdown:${generationId}`);
              return true;
            },
            markRebuildFailed: () => true,
          },
          restartFn: () => lifecycleEvents.push("restart"),
          executor: async (options) => publishFixtureExecution(queue!, options)
        });

        const request = queue.submit({
          command: "mandible auth merge feature/delay-test --into main",
          title: "Self-merge delay test",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/delay-test",
          merge_head_sha: git(repo, ["rev-parse", "feature/delay-test"]),
          cwd: repo,
          execution_mode: "daemon"
        });

        await approveFixtureRequest(queue, request.id);
        await waitForStatus(queue, request.id, "completed");
        const restartDeadline = Date.now() + 2_000;
        while (!lifecycleEvents.includes("restart") && Date.now() < restartDeadline) {
          await new Promise((resolve) => originalSetTimeout(resolve, 10));
        }

        // Bug: 03d6cb0 — the delay must be >= 2000ms to give the channel
        // server time to receive and process the auth:resolved event.
        expect(exitDelayMs).toBe(2000);
        expect(lifecycleEvents).toEqual([
          `rebuild:${request.id}`,
          "hooks",
          `shutdown:${request.id}`,
          "restart",
        ]);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        queue?.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  describe("self-merge restart drain", () => {
    it("parks a newly-approved execution while a self-merge restart is pending", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;
      const executed: string[] = [];

      const originalSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = (fn: (...args: unknown[]) => void, ms?: number) => {
        // Neutralize the self-rebuild process.exit so the test keeps running.
        if (ms === 2000) {
          return originalSetTimeout(() => {}, 0);
        }
        return originalSetTimeout(fn, ms);
      };
      globalThis.setTimeout = setTimeoutSpy as typeof globalThis.setTimeout;

      let releaseHook: (() => void) | null = null;
      const hookGate = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      // Hold the self-merge in its hook phase, keeping admission closed while we
      // approve a second request.
      const hookManager = admittedRebuildHooks(db, async () => { await hookGate; });

      try {
        commitOnBranch(repo, "feature/self-park", { "park.txt": "fix\n" });
        registerWorkRepo(db, repo);
        queue = new AuthQueue({
          db,
          hookManager,
          executor: async (options) => {
            executed.push(options.request_id);
            return publishFixtureExecution(queue!, options);
          },
        });

        const selfMerge = queue.submit({
          command: "mandible auth merge feature/self-park --into main",
          title: "Self-merge",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/self-park",
          merge_head_sha: git(repo, ["rev-parse", "feature/self-park"]),
          cwd: repo,
          execution_mode: "daemon",
        });
        await approveFixtureRequest(queue, selfMerge.id);

        // Wait for the self-merge to enter its hook phase (admission closed).
        await waitUntil(() => queue.isRebuilding, "the self-merge hook phase");

        // A request approved during the rebuild window must be parked, not run.
        const other = queue.submit({ type: "commit",
          command: "echo other",
          title: "Other",
          execution_mode: "daemon",
        });
        await approveFixtureRequest(queue, other.id);
        expect(queue.getRequest(other.id)?.status).toBe("pending");

        releaseHook?.();
        await waitForStatus(queue, selfMerge.id, "completed");
        await new Promise((resolve) => originalSetTimeout(resolve, 50));

        // Parked request stayed pending and never reached the executor.
        expect(queue.getRequest(other.id)?.status).toBe("pending");
        expect(executed).toEqual([selfMerge.id]);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        queue?.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it("fast-recovers an execution orphaned by a recorded self-merge shutdown", async () => {
      const db = createMigratedDb();
      const now = 5_000_000;
      const q1 = new AuthQueue({ db, now: () => now });
      const req = q1.submit({ type: "commit",
        command: "echo work",
        title: "Interrupted",
        execution_mode: "daemon",
      });
      q1.dispose();

      // Approved ~10 s before the daemon exited to rebuild, killed mid-execution
      // (executing, no exit code). Recent enough that the 5-minute threshold path
      // would NOT recover it.
      db.prepare(
        "UPDATE auth_requests SET status = 'executing', approved_at = ?, last_executed_at = ?, exit_code = NULL WHERE id = ?"
      ).run(now - 10_000, now - 9_000, req.id);
      // Durable marker recorded by the self-merge just before exit.
      db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run("auth_self_merge_shutdown_at", String(now - 5_000));

      const events: SseEvent[] = [];
      const q2 = new AuthQueue({ db, now: () => now, broadcast: (event) => events.push(event) });

      const recovered = await waitForStatus(q2, req.id, "completed");
      // A non-merge execution cannot be repository-recovered → completed as failed.
      expect(recovered?.status).toBe("completed");
      expect(recovered?.exit_code).toBe(1);
      // Marker is consumed (one-shot).
      const marker = db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get("auth_self_merge_shutdown_at");
      expect(marker).toBeUndefined();
      expect(events.some((event) => event.event === "auth:resolved")).toBe(true);

      q2.dispose();
      db.close();
    });

    it("does not fast-recover a recent stuck execution without a shutdown marker", () => {
      const db = createMigratedDb();
      const now = 5_000_000;
      const q1 = new AuthQueue({ db, now: () => now });
      const req = q1.submit({ type: "commit",
        command: "echo work",
        title: "Recent",
        execution_mode: "daemon",
      });
      q1.dispose();

      db.prepare(
        "UPDATE auth_requests SET status = 'executing', approved_at = ?, exit_code = NULL WHERE id = ?"
      ).run(now - 10_000, req.id);
      // No shutdown marker recorded.

      const q2 = new AuthQueue({ db, now: () => now });
      // Recent (< 5 min) with no marker → left executing for the threshold path.
      expect(q2.getRequest(req.id)?.status).toBe("executing");

      q2.dispose();
      db.close();
    });
  });
});
