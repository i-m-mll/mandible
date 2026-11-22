import { configureSigningCredential, createInstalledServiceHookManager, AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";
import { approveFixtureRequest, publishFixtureExecution } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * Self-rebuild event ordering and self-merge restart drain.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import type { AuthHookManager } from "../src/auth-hooks.js";
import { collectAuthMergeReview } from "../src/auth-change-report.js";
import type { SseEvent } from "../src/types.js";
import { getAttributionEvidence, revokeCredential } from "../src/users/store.js";
import { fixtureOperatorSigning, SoftwareOperatorSigner } from "./helpers/operator-signing-fixtures.js";
import { commitOnBranch, createAuthCheckRepo, createMigratedDb, git, registerWorkRepo, waitForStatus } from "./helpers/auth-queue-fixtures.js";

function admittedRebuildHooks(db: ReturnType<typeof createMigratedDb>, beforeRun?: () => void | Promise<void>): AuthHookManager {
  const hooks = createInstalledServiceHookManager(db);
  db.prepare('UPDATE auth_hooks SET command = ?, repo_pattern = ? WHERE id = ?').run(`printf 'MANDIBLE_RUNTIME_HANDOFF_PENDING:${'a'.repeat(64)}\\n'; exit 75`, '*', 'builtin-mandible-rebuild');
  vi.spyOn(hooks, 'admittedDrainIdentity').mockImplementation(async requestId => hooks.getRun(requestId, 'builtin-mandible-rebuild')?.exit_code === 75 ? 'private-current-admission' : null);
  const execute = hooks.executeHooks.bind(hooks);
  hooks.executeHooks = async (...args) => { await beforeRun?.(); return execute(...args); };
  return hooks;
}

describe("auth queue", () => {
  describe("self-rebuild event ordering", () => {
    it("merges documentation without acceptance, a rebuild hook, or restart signals while retaining other hooks", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;
      try {
        commitOnBranch(repo, "feature/docs", { "README.md": "# Mandible\n", "docs/images/screenshot.png": "image" });
        registerWorkRepo(db, repo);
        const base = git(repo, ["rev-parse", "main"]);
        const head = git(repo, ["rev-parse", "feature/docs"]);
        const review = await collectAuthMergeReview(repo, { base_sha: base, head_sha: head, merge_base_sha: base });
        if (!review.ok) throw new Error(review.error.message);
        const hooks = createInstalledServiceHookManager(db);
        db.prepare("UPDATE auth_hooks SET command = 'printf unexpected-rebuild' WHERE id = 'builtin-mandible-rebuild'").run();
        const other = hooks.create({ repo_pattern: "mandible", auth_type: "merge", command: "printf documentation-hook", label: "Other hook" });
        const events: SseEvent[] = [];
        const restart = vi.fn();
        const acceptance = vi.fn(async () => ({ status: "passed" as const, result: null, error: null }));
        queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false,
          broadcast: event => events.push(event), restartFn: restart, candidateAcceptanceExecutor: acceptance,
          executor: async options => publishFixtureExecution(queue!, options) });
        const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", title: "Documentation",
          command: "mandible auth merge feature/docs --into main", repo: "mandible", cwd: repo,
          base_branch: "main", head_branch: "feature/docs", merge_head_sha: head,
          change_report: review.value.report, execution_mode: "daemon" });
        await approveFixtureRequest(queue, request.id);
        await waitForStatus(queue, request.id, "completed");
        await queue.dispose();
        expect(acceptance).not.toHaveBeenCalled();
        expect(hooks.getRun(request.id, "builtin-mandible-rebuild")).toBeNull();
        expect(hooks.getRun(request.id, other.id)).toMatchObject({ state: "complete", output: "documentation-hook" });
        expect(events.filter(event => event.event.startsWith("mandible:"))).toEqual([]);
        expect(queue.isUpdateAdmissionClosed).toBe(false);
        expect(queue.rebuildFailure).toBeNull();
        expect(restart).not.toHaveBeenCalled();
      } finally {
        await queue?.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it("announces unavailability only after hooks and result publication", async () => {
      const events: SseEvent[] = [];
      const lifecycle: string[] = [];
      let resolvedBeforeShutdown = false;
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;
      try {
        commitOnBranch(repo, "feature/self-fix", { "self.txt": "fix\n" });
        registerWorkRepo(db, repo);
        queue = new AuthQueue({
          db,
          startupEpoch: "predecessor-epoch",
          hookManager: admittedRebuildHooks(db, () => {
            lifecycle.push("hooks");
            expect(queue!.isShuttingDown).toBe(false);
          }),
          broadcast: (event) => events.push(event),
          restartAvailability: {
            markRebuildStarted: (generationId) => {
              lifecycle.push(`rebuild:${generationId}`);
              return generationId ?? null;
            },
            markShutdownStarted: (generationId) => {
              resolvedBeforeShutdown = events.some((event) => event.event === "auth:resolved");
              lifecycle.push(`shutdown:${generationId}`);
              return true;
            },
            markRebuildFailed: () => true,
          },
          restartFn: () => lifecycle.push("restart"),
          executor: async (options) => publishFixtureExecution(queue!, options),
        });

        const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
          command: "mandible auth merge feature/self-fix --into main",
          title: "Self-merge",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/self-fix",
          merge_head_sha: git(repo, ["rev-parse", "feature/self-fix"]),
          cwd: repo,
          execution_mode: "daemon",
        }));

        await approveFixtureRequest(queue, request.id);
        await waitForStatus(queue, request.id, "completed");
        await waitUntil(() => lifecycle.includes("restart"), "the self-merge restart");

        const indexOf = (name: string) => events.findIndex((event) => event.event === name);
        expect(indexOf("mandible:rebuilding")).toBe(-1);
        expect(indexOf("auth:resolved")).toBeGreaterThanOrEqual(0);
        expect(indexOf("mandible:shutting-down")).toBeGreaterThan(indexOf("auth:resolved"));
        expect(events[indexOf("mandible:shutting-down")]).toMatchObject({ data: { request_id: request.id, startup_epoch: "predecessor-epoch" } });
        expect(resolvedBeforeShutdown).toBe(true);
        expect(lifecycle).toEqual(["hooks", `rebuild:${request.id}`, `shutdown:${request.id}`, "restart"]);
      } finally {
        (await queue?.dispose());
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
        const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: 'merge', command: 'mandible auth merge feature/build-failure --into main',
          title: 'Failed runtime build', repo: 'mandible', cwd: repo, base_branch: 'main', head_branch: 'feature/build-failure',
          merge_head_sha: git(repo, ['rev-parse', 'feature/build-failure']), execution_mode: 'daemon' }));
        await approveFixtureRequest(queue, request.id);
        await waitForStatus(queue, request.id, 'completed');
        await waitUntil(() => !queue!.isUpdateAdmissionClosed, "update admission to reopen");
        expect(hooks.getRun(request.id, 'builtin-mandible-rebuild')).toMatchObject({ state: exitCode === 0 ? 'complete' : 'pending', exit_code: exitCode });
        expect(restart).not.toHaveBeenCalled();
        expect(db.prepare('SELECT value FROM meta WHERE key = ?').get('auth_self_merge_shutdown_at')).toBeUndefined();
      } finally { (await queue?.dispose()); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
    });

  });

  describe("self-merge restart drain", () => {
    it.each(["verified receipt", "failed update", "changed base", "revoked key", "withdrawal"] as const)(
      "holds an exact signed approval from the first self-merge instruction through %s", async outcome => {
      const repo = createAuthCheckRepo();
      const foreignRepo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;
      const executed: Array<{ id: string; signedMerge: string | undefined }> = [];
      let restarted = false;
      let releaseSelf!: () => void;
      let acknowledgeSelfStarted!: () => void;
      const holdSelf = new Promise<void>(resolve => { releaseSelf = resolve; });
      const selfStarted = new Promise<void>(resolve => { acknowledgeSelfStarted = resolve; });
      const signer = new SoftwareOperatorSigner();
      const authority = fixtureOperatorSigning(db, signer);
      const hookManager = admittedRebuildHooks(db);
      if (outcome === "failed update") {
        db.prepare("UPDATE auth_hooks SET command = 'exit 1' WHERE id = 'builtin-mandible-rebuild'").run();
      }

      try {
        commitOnBranch(repo, "feature/self-park", { "park.txt": "fix\n" });
        commitOnBranch(foreignRepo, "feature/other", { "README.md": "# Reviewed docs\n" });
        registerWorkRepo(db, repo);
        registerWorkRepo(db, foreignRepo);
        const { operatorId, credentialId } = configureSigningCredential(db, repo);
        configureSigningCredential(db, foreignRepo);
        queue = new AuthQueue({
          db,
          hookManager,
          backgroundMaintenance: false,
          operatorSigning: authority,
          restartFn: () => { restarted = true; },
          executor: async (options) => {
            executed.push({ id: options.request_id, signedMerge: options.env?.MANDIBLE_AUTH_SIGNED_MERGE_SHA });
            acknowledgeSelfStarted();
            await holdSelf;
            return publishFixtureExecution(queue!, options);
          },
        });

        const selfMerge = (await queue.submit({ ...AUTH_MERGE_REVIEW,
          command: "mandible auth merge feature/self-park --into main",
          title: "Self-merge",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/self-park",
          merge_head_sha: git(repo, ["rev-parse", "feature/self-park"]),
          cwd: repo,
          execution_mode: "daemon",
        }));
        await approveFixtureRequest(queue, selfMerge.id);
        await selfStarted;
        expect(queue.isUpdateAdmissionClosed).toBe(true);
        expect(queue.isShuttingDown).toBe(false);
        expect(hookManager.getRun(selfMerge.id, "builtin-mandible-rebuild")).toMatchObject({ state: "pending", attempts: 0 });

        const other = (await queue.submit({ ...AUTH_MERGE_REVIEW,
          command: "mandible auth merge feature/other --into main", title: "Other",
          repo: path.basename(foreignRepo), cwd: foreignRepo, base_branch: "main", head_branch: "feature/other",
          merge_head_sha: git(foreignRepo, ["rev-parse", "feature/other"]),
          execution_mode: "daemon",
        }));
        const held = await approveFixtureRequest(queue, other.id);
        expect(held).toMatchObject({ status: "approved", last_executed_at: null });
        const exactSignedCommit = getAttributionEvidence(db, held.execution_evidence_id!)!.details.signed_commit_sha;
        const starts = () => executed.map(run => run.id);
        expect(starts()).toEqual([selfMerge.id]);

        releaseSelf();
        await waitForStatus(queue, selfMerge.id, "completed");
        if (outcome === "failed update") {
          await waitForStatus(queue, other.id, "completed");
          expect(queue.isUpdateAdmissionClosed).toBe(false);
          expect(restarted).toBe(false);
          expect(starts()).toEqual([selfMerge.id, other.id]);
          expect(executed[1]?.signedMerge).toBe(exactSignedCommit);
          expect(git(foreignRepo, ["rev-parse", "main"])).toBe(exactSignedCommit);
          return;
        }
        await waitUntil(() => restarted, "the self-merge restart");
        await queue.dispose();

        const resumedHooks = createInstalledServiceHookManager(db);
        db.prepare("UPDATE auth_hook_executions SET state = 'complete' WHERE auth_request_id = ?").run(selfMerge.id);
        const receipt = vi.spyOn(resumedHooks, "runtimeReceiptAccepted").mockResolvedValue(false);
        queue = new AuthQueue({ db, hookManager: resumedHooks, backgroundMaintenance: false, operatorSigning: authority,
          executor: async options => {
            executed.push({ id: options.request_id, signedMerge: options.env?.MANDIBLE_AUTH_SIGNED_MERGE_SHA });
            return publishFixtureExecution(queue!, options);
          },
        });
        await queue.resumeHookConvergence();
        expect(receipt).toHaveBeenCalledWith(selfMerge.id);
        expect((await queue.getRequest(other.id))?.status).toBe("approved");
        expect(starts()).toEqual([selfMerge.id]);
        const touches = signer.touches.length;
        if (outcome === "changed base") git(foreignRepo, ["commit", "--allow-empty", "-m", "Advance protected base in fixture"]);
        if (outcome === "revoked key") revokeCredential(db, credentialId);
        if (outcome === "withdrawal") await queue.withdraw(other.id, "Withdraw deferred approval", { user_id: operatorId, evidence_method: "local_default", authority_path: "operator" },
          queue.lifecycleRevision(other.id)!, queue.requestResponsibility(held).custody_generation);
        receipt.mockResolvedValue(true);
        await queue.resumeHookConvergence();

        if (outcome === "verified receipt") {
          await waitForStatus(queue, other.id, "completed");
          expect(starts()).toEqual([selfMerge.id, other.id]);
          expect(executed[1]?.signedMerge).toBe(exactSignedCommit);
          expect(git(foreignRepo, ["rev-parse", "main"])).toBe(exactSignedCommit);
        } else if (outcome === "changed base" || outcome === "revoked key") {
          expect(await waitForStatus(queue, other.id, "pending")).toMatchObject({
            approved_by_user_id: null, execution_evidence_id: null,
            error: expect.stringContaining(outcome === "changed base" ? "reviewed merge candidate" : "merge signature"),
          });
          expect(starts()).toEqual([selfMerge.id]);
        } else {
          expect((await queue.getRequest(other.id))?.status).toBe("withdrawn");
          expect(starts()).toEqual([selfMerge.id]);
        }
        expect(signer.touches).toHaveLength(touches);
      } finally {
        releaseSelf();
        (await queue?.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(foreignRepo, { recursive: true, force: true });
      }
    });

    it("fast-recovers an execution orphaned by a recorded self-merge shutdown", async () => {
      const db = createMigratedDb();
      const now = 5_000_000;
      const q1 = new AuthQueue({ db, now: () => now });
      const req = (await q1.submit({ ...AUTH_COMMAND_REVIEW,  type: "config-change",
        command: "echo work",
        title: "Interrupted",
        execution_mode: "daemon",
      }));
      (await q1.dispose());

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

      const recovered = await waitForStatus(q2, req.id, "failed");
      // A non-merge execution cannot be repository-recovered, so it failed.
      expect(recovered?.status).toBe("failed");
      expect(recovered?.exit_code).toBe(1);
      // Marker is consumed (one-shot).
      const marker = db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get("auth_self_merge_shutdown_at");
      expect(marker).toBeUndefined();
      expect(events.some((event) => event.event === "auth:resolved")).toBe(true);

      (await q2.dispose());
      db.close();
    });

    it("does not fast-recover a recent stuck execution without a shutdown marker", async () => {
      const db = createMigratedDb();
      const now = 5_000_000;
      const q1 = new AuthQueue({ db, now: () => now });
      const req = (await q1.submit({ ...AUTH_COMMAND_REVIEW,  type: "config-change",
        command: "echo work",
        title: "Recent",
        execution_mode: "daemon",
      }));
      (await q1.dispose());

      db.prepare(
        "UPDATE auth_requests SET status = 'executing', approved_at = ?, exit_code = NULL WHERE id = ?"
      ).run(now - 10_000, req.id);
      // No shutdown marker recorded.

      const q2 = new AuthQueue({ db, now: () => now });
      // Recent (< 5 min) with no marker → left executing for the threshold path.
      expect((await q2.getRequest(req.id))?.status).toBe("executing");

      (await q2.dispose());
      db.close();
    });
  });
});
