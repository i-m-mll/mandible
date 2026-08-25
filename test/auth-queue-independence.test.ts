/**
 * @vitest-environment node
 *
 * Merge independence, reconciliation, and sibling re-pinning.
 *
 * Split out of the former 6,122-line `test/auth-queue.test.ts` (issue 9e40a31).
 * Vitest parallelises across files and never within one, so that single file was
 * 98.9% of the default gate's wall clock. Test names and assertions are
 * unchanged; the shared helpers live in `test/helpers/auth-queue-fixtures.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import type { SseEvent } from "../src/types.js";
import { getOperator } from "../src/users/store.js";
import { commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb, createNoopHookManager, createQueue, git, insertSiblingMergeRequest, mergeResultOutput, registerWorkRepo, signedMergeIntoMain, uniqueMissingPath, waitForStatus, writeFile } from "./helpers/auth-queue-fixtures.js";

describe("auth queue", () => {
  it("accepts pairwise-independent pending merge requests", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "b.txt": "b\n" });

      const first = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Merge feature/a",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/a",
        cwd: repo,
      });
      const check = queue.checkMergeIndependence({
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });
      expect(check.status).toBe("clean");
      expect(check.checked_requests).toBe(1);

      const second = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });

      expect(queue.getRequest(first.id)?.status).toBe("pending");
      expect(queue.getRequest(second.id)?.status).toBe("pending");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a pending merge request that conflicts with the queued simulation", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/a", { "shared.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "shared.txt": "b\n" });

      const first = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Merge feature/a",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/a",
        cwd: repo,
      });

      const check = queue.checkMergeIndependence({
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });
      expect(check.status).toBe("conflict");
      expect(check.conflicts[0]?.request_id).toBe(first.id);
      expect(check.conflicts[0]?.files).toContain("shared.txt");

      expect(() => queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      })).toThrow(AuthQueueError);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports merge check infrastructure failures as errors, not conflicts", () => {
    const queue = createQueue();
    const missingCwd = uniqueMissingPath("mandible-missing-auth-check-cwd");

    const check = queue.checkMergeIndependence({
      repo: "repo",
      base_branch: "main",
      head_branch: "feature/demo",
      cwd: missingCwd,
    });

    expect(check.status).toBe("error");
    expect(check.conflicts).toEqual([]);
    expect(check.reason).toContain("ENOENT");
  });

  it("reports tracked dirty worktree state as a merge preflight error", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/demo", { "feature.txt": "feature\n" });
      writeFile(repo, "shared.txt", "dirty\n");

      const check = queue.checkMergeIndependence({
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/demo",
        cwd: repo,
      });

      expect(check.status).toBe("error");
      expect(check.reason).toContain("tracked worktree changes are present");
      expect(check.reason).toContain("shared.txt");
      expect(check.conflicts).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects merge request submission when shared preflight reports an error", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/demo", { "feature.txt": "feature\n" });
      writeFile(repo, "shared.txt", "dirty\n");

      expect(() => queue.submit({
        type: "merge",
        command: "mandible auth merge feature/demo --into main",
        title: "Merge feature/demo",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/demo",
        cwd: repo,
      })).toThrow(/merge preflight failed/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("classifies a queued request whose head branch was torn down as stale, not a conflict (fbf2a58)", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/gone", { "gone.txt": "gone\n" });
      commitOnBranch(repo, "feature/live", { "live.txt": "live\n" });

      const queued = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/gone --into main",
        title: "Merge feature/gone",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/gone",
        cwd: repo,
      });

      // Simulate the incident: the merge landed and the head branch was torn
      // down, but the queue row was never finalized.
      git(repo, ["branch", "-D", "feature/gone"]);

      const check = queue.checkMergeIndependence({
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/live",
        cwd: repo,
      });

      expect(check.status).toBe("stale_request");
      expect(check.conflicts).toEqual([]);
      expect(check.stale_requests).toHaveLength(1);
      expect(check.stale_requests?.[0]?.request_id).toBe(queued.id);
      expect(check.stale_requests?.[0]?.head_branch).toBe("feature/gone");
      expect(check.stale_requests?.[0]?.message).toContain(queued.id);
      expect(check.reason).toContain("no longer exists");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reconciles a pending merge whose head is already an ancestor of target at startup (fbf2a58)", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/landed", { "landed.txt": "landed\n" });
      const headSha = git(repo, ["rev-parse", "feature/landed"]);

      const queue = new AuthQueue({ db });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/landed --into main",
        title: "Merge feature/landed",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/landed",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
      });
      expect(queue.getRequest(request.id)?.status).toBe("pending");

      // The merge lands out-of-band (terminal auth-merge) but finalization is
      // lost; the request stays pending until the next daemon startup.
      git(repo, ["checkout", "main"]);
      git(repo, ["merge", "--no-ff", "feature/landed", "-m", "merge feature/landed"]);
      queue.dispose();

      const events: SseEvent[] = [];
      const restarted = new AuthQueue({ db, broadcast: (event) => events.push(event) });
      try {
        const reconciled = restarted.getRequest(request.id);
        expect(reconciled?.status).toBe("completed");
        expect(reconciled?.exit_code).toBe(0);
        // fbf2a58 round 2 — this merge is attributed but landed out-of-band with
        // no daemon approval record, so it is terminalized from repository
        // evidence alone. merge_finalized_at deliberately stays NULL so finalizer
        // sweeps keep revisiting it and can converge to full finalization once
        // approval attribution appears (see the convergence test below); setting
        // it here would permanently strand the deferred closures/work-units.
        expect(reconciled?.merge_finalized_at ?? null).toBeNull();
        expect(events.some((event) => event.event === "auth:merged")).toBe(true);
        expect(events.some((event) => event.event === "auth:resolved")).toBe(true);
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reconciles a pending merge via recorded merge_head_sha when the head branch was deleted (fbf2a58)", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/torn", { "torn.txt": "torn\n" });
      const headSha = git(repo, ["rev-parse", "feature/torn"]);

      const queue = new AuthQueue({ db });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/torn --into main",
        title: "Merge feature/torn",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/torn",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
      });

      // Merge lands and the branch is torn down (post-merge cleanup), matching
      // the reported incident. The head branch ref is gone; only the recorded
      // merge_head_sha remains checkable.
      git(repo, ["checkout", "main"]);
      git(repo, ["merge", "--no-ff", "feature/torn", "-m", "merge feature/torn"]);
      git(repo, ["branch", "-D", "feature/torn"]);
      queue.dispose();

      const restarted = new AuthQueue({ db });
      try {
        const reconciled = restarted.getRequest(request.id);
        expect(reconciled?.status).toBe("completed");
        expect(reconciled?.exit_code).toBe(0);
        // fbf2a58 round 2 — attributed, out-of-band, no approval record: the row
        // is terminal for the queue/UI (completed) but merge_finalized_at stays
        // NULL so later sweeps can converge once attribution appears.
        expect(reconciled?.merge_finalized_at ?? null).toBeNull();
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("leaves a pending merge whose head is not yet in target untouched (fbf2a58)", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/unmerged", { "unmerged.txt": "unmerged\n" });
      const headSha = git(repo, ["rev-parse", "feature/unmerged"]);

      const queue = new AuthQueue({ db });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/unmerged --into main",
        title: "Merge feature/unmerged",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/unmerged",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
      });
      queue.dispose();

      // Nothing landed: the head is genuinely absent from main.
      const restarted = new AuthQueue({ db });
      try {
        const untouched = restarted.getRequest(request.id);
        expect(untouched?.status).toBe("pending");
        expect(untouched?.exit_code).toBeNull();
        expect(untouched?.merge_finalized_at ?? null).toBeNull();
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does NOT reconcile when the head branch was recreated at the target sha, disagreeing with the recorded merge_head_sha (fbf2a58 round 2)", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      // The original head branch commit (A). This is the sha that would have been
      // recorded on the request when it was submitted, and it is NOT merged.
      commitOnBranch(repo, "feature/recreated", { "recreated.txt": "orig\n" });
      const originalHeadSha = git(repo, ["rev-parse", "feature/recreated"]);
      const targetSha = git(repo, ["rev-parse", "main"]);
      expect(originalHeadSha).not.toBe(targetSha);

      const queue = new AuthQueue({ db });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/recreated --into main",
        title: "Merge feature/recreated",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/recreated",
        merge_head_sha: originalHeadSha,
        cwd: repo,
        target_repo_root: repo,
      });
      expect(queue.getRequest(request.id)?.status).toBe("pending");

      // The branch is force-recreated at the target tip (T). The unmerged work at
      // A is now abandoned; the live ref points at T. A naive proof taken from the
      // live ref ("T is an ancestor of T") would falsely complete the request.
      git(repo, ["branch", "-f", "feature/recreated", "main"]);
      expect(git(repo, ["rev-parse", "feature/recreated"])).toBe(targetSha);
      queue.dispose();

      const restarted = new AuthQueue({ db });
      try {
        const row = restarted.getRequest(request.id);
        // Recorded sha is authoritative and disagrees with the live ref: the
        // request is NOT reconcilable and stays pending.
        expect(row?.status).toBe("pending");
        expect(row?.exit_code ?? null).toBeNull();
        expect(row?.merge_finalized_at ?? null).toBeNull();
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fully drops approval attribution and execution evidence when parking a self-merge execution (fbf2a58 round 2)", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const queue = new AuthQueue({ db });
    try {
      commitOnBranch(repo, "feature/parked", { "parked.txt": "p\n" });
      const operator = getOperator(db)!;
      // A real attribution_evidence row so the execution_evidence_id FK is
      // satisfied while we stage an in-flight, approved execution.
      db.prepare(
        "INSERT INTO attribution_evidence (id, evidence_method, verified_at, details_json) VALUES (?, ?, ?, '{}')"
      ).run("evidence-parked-1", "credential_signature", Date.now());

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/parked --into main",
        title: "Merge feature/parked",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/parked",
        cwd: repo,
        target_repo_root: repo,
      });
      // Stage the row exactly as it would look mid-execution: executing, with the
      // approver and execution evidence attached.
      db.prepare(
        "UPDATE auth_requests SET status = 'executing', approved_at = ?, approved_by_user_id = ?, execution_evidence_id = ? WHERE id = ?"
      ).run(Date.now(), operator.id, "evidence-parked-1", request.id);

      (queue as unknown as { parkExecutionForRestart(r: unknown): void }).parkExecutionForRestart(
        queue.getRequest(request.id)!,
      );

      const parked = queue.getRequest(request.id);
      expect(parked?.status).toBe("pending");
      expect(parked?.approved_at ?? null).toBeNull();
      // The fix: stale approval attribution and evidence are fully cleared so a
      // later evidence-driven finalizer cannot mistake them for a live approval.
      expect(parked?.approved_by_user_id ?? null).toBeNull();
      expect(parked?.execution_evidence_id ?? null).toBeNull();
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("evidence-only terminalized merge stays sweep-visible and converges once approval attribution appears (fbf2a58 round 2)", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/oob", { "oob.txt": "oob\n" });
      const headSha = git(repo, ["rev-parse", "feature/oob"]);
      const operator = getOperator(db)!;

      const queue = new AuthQueue({ db });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/oob --into main",
        title: "Merge feature/oob",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/oob",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
      });
      // Attributed merge (has a requester) but NO daemon approval record: this is
      // the out-of-band terminal-merge case that must terminalize from repository
      // evidence alone.
      db.prepare(
        "UPDATE auth_requests SET requested_by_user_id = ?, approved_by_user_id = NULL, execution_evidence_id = NULL WHERE id = ?"
      ).run(operator.id, request.id);

      // The merge lands out-of-band; finalization is lost.
      git(repo, ["checkout", "main"]);
      git(repo, ["merge", "--no-ff", "feature/oob", "-m", "merge feature/oob"]);
      queue.dispose();

      const events: SseEvent[] = [];
      const restarted = new AuthQueue({ db, broadcast: (event) => events.push(event) });
      try {
        // Startup reconciliation terminalizes it for the queue/UI (completed), but
        // must NOT set merge_finalized_at — otherwise the sweep would exclude it
        // forever and the skipped closures/work-units would never converge.
        const partial = restarted.getRequest(request.id);
        expect(partial?.status).toBe("completed");
        expect(partial?.exit_code).toBe(0);
        expect(partial?.merge_finalized_at ?? null).toBeNull();
        expect(events.some((event) => event.event === "auth:merged")).toBe(true);
        expect(events.some((event) => event.event === "auth:resolved")).toBe(true);

        // A later sweep with attribution still absent is idempotent: it revisits
        // the row (merge_finalized_at is still NULL) but does not re-broadcast or
        // finalize.
        const before = events.length;
        (restarted as unknown as { sweepSuccessfulMergeFinalizers(): void }).sweepSuccessfulMergeFinalizers();
        await restarted.drainFinalizers();
        expect(restarted.getRequest(request.id)?.merge_finalized_at ?? null).toBeNull();
        expect(events.length).toBe(before);

        // Approval attribution now appears (e.g. retroactive approval record).
        db.prepare("UPDATE auth_requests SET approved_by_user_id = ? WHERE id = ?").run(
          operator.id,
          request.id,
        );

        // The next sweep converges: full finalization runs and merge_finalized_at
        // is finally set.
        (restarted as unknown as { sweepSuccessfulMergeFinalizers(): void }).sweepSuccessfulMergeFinalizers();
        await restarted.drainFinalizers();
        const converged = restarted.getRequest(request.id);
        expect(converged?.status).toBe("completed");
        expect(converged?.merge_finalized_at ?? null).not.toBeNull();
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("marks pending merge requests needs_rebase after post-merge revalidation", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      commitOnBranch(repo, "feature/a", { "shared.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "shared.txt": "b\n" });

      const pending = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });
      const now = 100;
      db.prepare(
        `INSERT INTO auth_requests (
          id, session_id, type, command, title, cwd, repo, base_branch, head_branch,
          status, created_at, updated_at, expires_at, output, execution_mode,
          files_changed, additions, deletions, approval_source
        ) VALUES (
          'merge-a', NULL, 'merge', 'mandible auth merge feature/a --into main',
          'Merge feature/a', ?, 'repo', 'main', 'feature/a',
          'executing', ?, ?, ?, '', 'daemon', 0, 0, 0, 'manual'
        )`
      ).run(repo, now, now, now + 1000);

      git(repo, ["checkout", "main"]);
      git(repo, ["merge", "--no-ff", "feature/a", "-m", "merge feature/a"]);
      queue.setResult("merge-a", 0, "ok");
      await queue.drainFinalizers();

      const invalidated = queue.getRequest(pending.id);
      expect(invalidated?.status).toBe("needs_rebase");
      expect(invalidated?.error).toContain("Needs rebase");
      expect(events.some((event) => event.event === "auth:needs_rebase")).toBe(true);
      expect(events.some((event) => {
        const data = event.data as Record<string, unknown>;
        return event.event === "auth:resolved" && data.request_id === pending.id;
      })).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("re-pins pending siblings after a sibling merge and broadcasts auth:updated", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const queue = new AuthQueue({
      db,
      broadcast: (event) => events.push(event),
      executor: async (options) => {
        envs.push(options.env);
        return {
          exit_code: 1,
          signal: null,
          stdout: "",
          stderr: "fixture stop\n",
          output: "fixture stop\n",
          started_at: Date.now(),
          finished_at: Date.now(),
        };
      },
      hookManager: createNoopHookManager(),
    });
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "b.txt": "b\n" });
      registerWorkRepo(db, repo);
      configureSigningCredential(db, repo, "ssh_key");
      const repoName = path.basename(repo);

      const pendingB = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/b",
        merge_head_sha: git(repo, ["rev-parse", "feature/b"]),
        cwd: repo,
      });
      const originalPin = pendingB.merge_candidate_pin_sha;
      expect(originalPin).toMatch(/^[0-9a-f]{40,64}$/);

      // Review F1 — the sibling merge is a genuine authorized queue merge:
      // signed, and recorded with its merge SHA by the completed request.
      insertSiblingMergeRequest(db, repo, "merge-a", "feature/a");
      const siblingMergeSha = signedMergeIntoMain(repo, "feature/a");
      queue.setResult("merge-a", 0, mergeResultOutput(siblingMergeSha));
      await queue.drainFinalizers();

      const newBase = git(repo, ["rev-parse", "main"]);
      const refreshed = queue.getRequest(pendingB.id);
      expect(refreshed?.status).toBe("pending");
      expect(refreshed?.merge_preflight_base_sha).toBe(newBase);
      expect(refreshed?.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      expect(refreshed?.merge_candidate_pin_sha).not.toBe(originalPin);
      expect(git(repo, ["rev-parse", `refs/mandible/auth-candidates/${pendingB.id}`]))
        .toBe(refreshed!.merge_candidate_pin_sha);
      expect(git(repo, ["rev-parse", `${refreshed!.merge_candidate_pin_sha}^1`])).toBe(newBase);
      expect(git(repo, ["rev-parse", `${refreshed!.merge_candidate_pin_sha}^2`]))
        .toBe(pendingB.merge_head_sha);
      expect(events.some((event) => {
        const data = event.data as Record<string, unknown>;
        const request = data.request as Record<string, unknown> | undefined;
        return event.event === "auth:updated" && request?.id === pendingB.id;
      })).toBe(true);

      // Approval now hits the exact-candidate fast path.
      queue.approve(pendingB.id);
      await waitForStatus(queue, pendingB.id, "completed");
      expect(envs).toHaveLength(1);
      expect(envs[0]?.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT).toBe("1");
      expect(envs[0]?.MANDIBLE_AUTH_PREFLIGHT_BASE_SHA).toBe(newBase);
      expect(envs[0]?.MANDIBLE_AUTH_CANDIDATE_PIN_SHA).toBe(refreshed!.merge_candidate_pin_sha);
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("revalidates and re-pins dependents of the merged request first", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/other", { "other.txt": "other\n" });
      commitOnBranch(repo, "feature/dep", { "dep.txt": "dep\n" });
      registerWorkRepo(db, repo);
      configureSigningCredential(db, repo, "ssh_key");
      const repoName = path.basename(repo);

      insertSiblingMergeRequest(db, repo, "merge-a", "feature/a");

      // Submitted first: without prioritization this request would be
      // revalidated first (created_at order).
      const other = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/other --into main",
        title: "Merge feature/other",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/other",
        merge_head_sha: git(repo, ["rev-parse", "feature/other"]),
        cwd: repo,
      });
      const dep = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/dep --into main",
        title: "Merge feature/dep",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/dep",
        merge_head_sha: git(repo, ["rev-parse", "feature/dep"]),
        cwd: repo,
        depends_on_id: "merge-a",
      });
      expect(other.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      expect(dep.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);

      const siblingMergeSha = signedMergeIntoMain(repo, "feature/a");
      queue.setResult("merge-a", 0, mergeResultOutput(siblingMergeSha));
      await queue.drainFinalizers();

      const newBase = git(repo, ["rev-parse", "main"]);
      expect(queue.getRequest(dep.id)?.merge_preflight_base_sha).toBe(newBase);
      expect(queue.getRequest(other.id)?.merge_preflight_base_sha).toBe(newBase);
      const updatedIds = events
        .filter((event) => event.event === "auth:updated")
        .map((event) => {
          const data = event.data as Record<string, unknown>;
          return (data.request as Record<string, unknown> | undefined)?.id;
        });
      const depIndex = updatedIds.indexOf(dep.id);
      const otherIndex = updatedIds.indexOf(other.id);
      expect(depIndex).toBeGreaterThanOrEqual(0);
      expect(otherIndex).toBeGreaterThanOrEqual(0);
      expect(depIndex).toBeLessThan(otherIndex);
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("leaves a sibling whose head moved after review un-repinned", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "b.txt": "b\n" });
      registerWorkRepo(db, repo);
      const repoName = path.basename(repo);

      const pendingB = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/b",
        merge_head_sha: git(repo, ["rev-parse", "feature/b"]),
        cwd: repo,
      });
      const originalPin = pendingB.merge_candidate_pin_sha;
      const originalBase = pendingB.merge_preflight_base_sha;
      expect(originalPin).toMatch(/^[0-9a-f]{40,64}$/);

      // Head drift: the reviewed content changed after submission.
      git(repo, ["checkout", "feature/b"]);
      writeFile(repo, "b2.txt", "b2\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "revise feature/b"]);
      git(repo, ["checkout", "main"]);

      const now = 100;
      db.prepare(
        `INSERT INTO auth_requests (
          id, session_id, type, command, title, cwd, repo, base_branch, head_branch,
          status, created_at, updated_at, expires_at, output, execution_mode,
          files_changed, additions, deletions, approval_source
        ) VALUES (
          'merge-a', NULL, 'merge', 'mandible auth merge feature/a --into main',
          'Merge feature/a', ?, ?, 'main', 'feature/a',
          'executing', ?, ?, ?, '', 'daemon', 0, 0, 0, 'manual'
        )`
      ).run(repo, repoName, now, now, now + 1000);
      git(repo, ["merge", "--no-ff", "feature/a", "-m", "merge feature/a"]);
      queue.setResult("merge-a", 0, "ok");
      await queue.drainFinalizers();

      // Head drift stays strict: the stale candidate is never re-attested.
      const untouched = queue.getRequest(pendingB.id);
      expect(untouched?.status).toBe("pending");
      expect(untouched?.merge_preflight_base_sha).toBe(originalBase);
      expect(untouched?.merge_candidate_pin_sha).toBe(originalPin);
      expect(events.some((event) => {
        const data = event.data as Record<string, unknown>;
        const request = data.request as Record<string, unknown> | undefined;
        return event.event === "auth:updated" && request?.id === pendingB.id;
      })).toBe(false);
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("defers sibling revalidation until a same-repo merge execution finishes", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    let releaseExec!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseExec = resolve;
    });
    const queue = new AuthQueue({
      db,
      executor: async (options) => {
        if (options.command.includes("feature/exec")) {
          await gate;
        }
        return {
          exit_code: 1,
          signal: null,
          stdout: "",
          stderr: "fixture stop\n",
          output: "fixture stop\n",
          started_at: Date.now(),
          finished_at: Date.now(),
        };
      },
      hookManager: createNoopHookManager(),
    });
    try {
      commitOnBranch(repo, "feature/exec", { "exec.txt": "exec\n" });
      commitOnBranch(repo, "feature/c", { "c.txt": "c\n" });
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      registerWorkRepo(db, repo);
      configureSigningCredential(db, repo, "ssh_key");
      const repoName = path.basename(repo);

      const execRequest = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/exec --into main",
        title: "Merge feature/exec",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/exec",
        merge_head_sha: git(repo, ["rev-parse", "feature/exec"]),
        cwd: repo,
      });
      const pendingC = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/c --into main",
        title: "Merge feature/c",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/c",
        merge_head_sha: git(repo, ["rev-parse", "feature/c"]),
        cwd: repo,
      });
      const staleBase = pendingC.merge_preflight_base_sha;
      queue.approve(execRequest.id);

      insertSiblingMergeRequest(db, repo, "merge-a", "feature/a");
      const siblingMergeSha = signedMergeIntoMain(repo, "feature/a");
      queue.setResult("merge-a", 0, mergeResultOutput(siblingMergeSha));

      await new Promise((resolve) => setTimeout(resolve, 150));
      // The revalidation pass is parked behind the executing same-repo merge:
      // no preflight ran, so the sibling still carries its stale pin.
      expect(queue.getRequest(pendingC.id)?.merge_preflight_base_sha).toBe(staleBase);
      // And an approve-time recompute never runs against a busy repo chain:
      // the stale candidate stays strictly blocked — and issue 2205073 says
      // the approver is told that waiting, not requeueing, is the fix.
      expect(() => queue.approve(pendingC.id)).toThrow(/requeue and reapprove/);
      expect(() => queue.approve(pendingC.id)).toThrow(/Refusal: execution_chain_busy/);

      releaseExec();
      await waitForStatus(queue, execRequest.id, "completed");
      await queue.drainFinalizers();
      const refreshed = queue.getRequest(pendingC.id);
      expect(refreshed?.status).toBe("pending");
      expect(refreshed?.merge_preflight_base_sha).toBe(git(repo, ["rev-parse", "main"]));
      expect(refreshed?.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
