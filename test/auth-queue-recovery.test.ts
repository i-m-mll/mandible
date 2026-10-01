/**
 * @vitest-environment node
 *
 * Restart recovery and interrupted-merge repair.
 *
 * Split out of the former 6,122-line `test/auth-queue.test.ts` (issue 9e40a31).
 * Vitest parallelises across files and never within one, so that single file was
 * 98.9% of the default gate's wall clock. Test names and assertions are
 * unchanged; the shared helpers live in `test/helpers/auth-queue-fixtures.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import type { SseEvent } from "../src/types.js";
import { commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb, createNoopHookManager, git, registerWorkRepo, waitForStatus, writeFile } from "./helpers/auth-queue-fixtures.js";

describe("auth queue", () => {
  it.each([
    ["after CAS", false, false, false],
    ["after worktree sync", true, false, false],
    ["after result emission", true, true, false],
    ["with an untracked sync collision", false, false, true],
  ])("recovers an exact trusted atomic merge %s", async (_phase, syncBeforeRestart, resultBeforeRestart, blockSync) => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    let queue: AuthQueue | null = null;
    try {
      commitOnBranch(repo, "feature/atomic-recovery", { "atomic.txt": "atomic\n" });
      git(repo, ["checkout", "feature/atomic-recovery"]);
      git(repo, ["commit", "--amend", "-m", "atomic recovery\n\nCloses-Mandible-Issue: abc1234"]);
      git(repo, ["checkout", "main"]);
      registerWorkRepo(db, repo);
      const signing = configureSigningCredential(db, repo, "ssh_key");
      git(repo, ["config", "commit.gpgsign", "true"]);

      queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/atomic-recovery --into main",
        title: "Atomic recovery",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/atomic-recovery",
        merge_head_sha: git(repo, ["rev-parse", "feature/atomic-recovery"]),
        cwd: repo,
      });
      db.prepare(
        `UPDATE auth_requests
            SET status = 'executing', approved_at = 1, approved_by_user_id = ?,
                approval_source = 'manual', merge_atomic_enabled = 1
          WHERE id = ?`,
      ).run(signing.operatorId, request.id);
      const pinned = request;
      const mergeSha = git(repo, [
        "commit-tree",
        pinned.merge_candidate_tree_sha!,
        "-p",
        pinned.merge_preflight_base_sha!,
        "-p",
        pinned.merge_head_sha!,
        "-S",
        "-m",
        "Merge branch 'feature/atomic-recovery'",
      ]);
      const prepared = `MANDIBLE_MERGE_PREPARED ${JSON.stringify({
        merge_sha: mergeSha,
        base_sha: pinned.merge_preflight_base_sha,
        head_sha: pinned.merge_head_sha,
        tree_sha: pinned.merge_candidate_tree_sha,
      })}\n`;
      const applied = `MANDIBLE_MERGE_APPLIED ${JSON.stringify({
        merge_sha: mergeSha,
        base_sha: pinned.merge_preflight_base_sha,
      })}\n`;
      const emittedResult = `MANDIBLE_MERGE_RESULT ${JSON.stringify({
        merge_sha: mergeSha,
        repo_id: path.basename(repo),
        declared_issues: [],
      })}\n`;
      db.prepare("UPDATE auth_requests SET output = ? WHERE id = ?")
        .run(prepared + applied + (resultBeforeRestart ? emittedResult : ""), request.id);
      git(repo, ["update-ref", "refs/heads/main", mergeSha, pinned.merge_preflight_base_sha!]);
      if (syncBeforeRestart) {
        git(repo, ["read-tree", "-m", "-u", pinned.merge_preflight_base_sha!, mergeSha]);
      } else {
        expect(git(repo, ["write-tree"])).toBe(git(repo, ["rev-parse", `${pinned.merge_preflight_base_sha}^{tree}`]));
      }
      if (blockSync) writeFile(repo, "atomic.txt", "local collision\n");
      const order: string[] = [];
      const follower = _phase === "after CAS"
        ? queue.submit({
            command: "echo same-repo follower",
            title: "Same-repo follower",
            cwd: repo,
            target_repo_root: repo,
          })
        : null;
      queue.dispose();

      queue = new AuthQueue({
        db,
        hookManager: follower
          ? ({
              executeHooks: async () => {
                order.push("recovery-hook-start");
                await new Promise((resolve) => setTimeout(resolve, 50));
                order.push("recovery-hook-end");
                return [];
              },
            } as unknown as AuthHookManager)
          : createNoopHookManager(),
        executor: async () => {
          order.push("follower-executor");
          return {
            exit_code: 0,
            signal: null,
            stdout: "",
            stderr: "",
            output: "",
            started_at: Date.now(),
            finished_at: Date.now(),
          };
        },
        now: () => 10 * 60 * 1000,
      });
      if (blockSync) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const blocked = queue.getRequest(request.id)!;
        expect(blocked.status).toBe("executing");
        expect(blocked.exit_code).toBeNull();
        expect(blocked.merge_candidate_pin_sha).toBe(pinned.merge_candidate_pin_sha);
        expect(blocked.error).toContain("needs recovery");
        expect(fs.readFileSync(path.join(repo, "atomic.txt"), "utf8")).toBe("local collision\n");
        return;
      }
      if (follower) {
        queue.approve(follower.id);
        await waitForStatus(queue, follower.id, "completed", 5000);
        expect(order.indexOf("recovery-hook-end")).toBeLessThan(order.indexOf("follower-executor"));
      }
      const recovered = await waitForStatus(queue, request.id, "completed", 5000);

      expect(recovered.exit_code).toBe(0);
      expect(recovered.output).toContain(`"merge_sha":"${mergeSha}"`);
      expect(recovered.output).not.toContain("auto_close_issues");
      expect(git(repo, ["write-tree"])).toBe(pinned.merge_candidate_tree_sha);
      expect(git(repo, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
      const evidence = db.prepare(
        "SELECT details_json FROM attribution_evidence WHERE id = ?",
      ).get(recovered.execution_evidence_id) as { details_json: string };
      expect(JSON.parse(evidence.details_json)).toMatchObject({
        verified: true,
        signer_user_id: signing.operatorId,
      });
    } finally {
      queue?.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it("aborts an unambiguous interrupted merge and requeues it with a clean checkout", () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/interrupted", { "interrupted.txt": "land me\n" });
      const headSha = git(repo, ["rev-parse", "feature/interrupted"]);
      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/interrupted --into main",
        title: "Interrupted merge",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/interrupted",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
        execution_mode: "remote",
      });
      queue.approve(request.id);
      git(repo, ["merge", "--no-ff", "--no-commit", "feature/interrupted"]);
      expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
      queue.dispose();

      now = 6 * 60 * 1000;
      const restarted = new AuthQueue({ db, now: () => now });
      try {
        const recovered = restarted.getRequest(request.id);
        expect(recovered?.status).toBe("pending");
        expect(recovered?.exit_code).toBeNull();
        expect(recovered?.approved_at).toBeNull();
        expect(recovered?.approved_by_user_id).toBeNull();
        expect(recovered?.execution_evidence_id).toBeNull();
        expect(() => restarted.setResult(request.id, 0, "late remote result"))
          .toThrow(/cannot be recorded while request is pending/);
        expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
        expect(git(repo, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed without mutating an interrupted merge whose checkout has unrelated changes", () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/ambiguous", { "ambiguous.txt": "land me\n" });
      const headSha = git(repo, ["rev-parse", "feature/ambiguous"]);
      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/ambiguous --into main",
        title: "Ambiguous merge",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/ambiguous",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
        execution_mode: "remote",
      });
      queue.approve(request.id);
      git(repo, ["merge", "--no-ff", "--no-commit", "feature/ambiguous"]);
      writeFile(repo, "shared.txt", "unrelated local edit\n");
      queue.dispose();

      now = 6 * 60 * 1000;
      const restarted = new AuthQueue({ db, now: () => now });
      try {
        const recovered = restarted.getRequest(request.id);
        expect(recovered?.status).toBe("completed");
        expect(recovered?.exit_code).toBe(1);
        expect(recovered?.error).toContain("unstaged tracked changes");
        expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
        expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("unrelated local edit\n");
      } finally {
        restarted.dispose();
      }
    } finally {
      try {
        git(repo, ["merge", "--abort"]);
      } catch {
        // The assertion above diagnoses any unexpected recovery mutation.
      }
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed without aborting an interrupted merge with unrelated staged changes", () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/staged-ambiguous", { "expected.txt": "land me\n" });
      const headSha = git(repo, ["rev-parse", "feature/staged-ambiguous"]);
      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/staged-ambiguous --into main",
        title: "Staged ambiguous merge",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/staged-ambiguous",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
        execution_mode: "remote",
      });
      queue.approve(request.id);
      git(repo, ["merge", "--no-ff", "--no-commit", "feature/staged-ambiguous"]);
      writeFile(repo, "shared.txt", "unrelated staged edit\n");
      git(repo, ["add", "shared.txt"]);
      queue.dispose();

      now = 6 * 60 * 1000;
      const restarted = new AuthQueue({ db, now: () => now });
      try {
        const recovered = restarted.getRequest(request.id);
        expect(recovered?.status).toBe("completed");
        expect(recovered?.exit_code).toBe(1);
        expect(recovered?.error).toContain("staged index does not match the expected merge tree");
        expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
        expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("unrelated staged edit\n");
      } finally {
        restarted.dispose();
      }
    } finally {
      try {
        git(repo, ["merge", "--abort"]);
      } catch {
        // The assertion above diagnoses any unexpected recovery mutation.
      }
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed without mutating either checkout when cwd and target_repo_root diverge", () => {
    let now = 0;
    const cwdRepo = createAuthCheckRepo();
    const targetRepo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(cwdRepo, "feature/divergent", { "divergent.txt": "land me\n" });
      const headSha = git(cwdRepo, ["rev-parse", "feature/divergent"]);
      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/divergent --into main",
        title: "Divergent checkout merge",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/divergent",
        merge_head_sha: headSha,
        cwd: cwdRepo,
        target_repo_root: targetRepo,
        execution_mode: "remote",
      });
      queue.approve(request.id);
      git(cwdRepo, ["merge", "--no-ff", "--no-commit", "feature/divergent"]);
      const targetHead = git(targetRepo, ["rev-parse", "HEAD"]);
      queue.dispose();

      now = 6 * 60 * 1000;
      const restarted = new AuthQueue({ db, now: () => now });
      try {
        const recovered = restarted.getRequest(request.id);
        expect(recovered?.status).toBe("completed");
        expect(recovered?.exit_code).toBe(1);
        expect(recovered?.error).toContain("do not identify the same Git checkout");
        expect(fs.existsSync(path.join(cwdRepo, ".git", "MERGE_HEAD"))).toBe(true);
        expect(git(targetRepo, ["rev-parse", "HEAD"])).toBe(targetHead);
        expect(git(targetRepo, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
      } finally {
        restarted.dispose();
      }
    } finally {
      try {
        git(cwdRepo, ["merge", "--abort"]);
      } catch {
        // The assertion above diagnoses any unexpected recovery mutation.
      }
      db.close();
      fs.rmSync(cwdRepo, { recursive: true, force: true });
      fs.rmSync(targetRepo, { recursive: true, force: true });
    }
  });

  it("does not recover a legitimate long-running in-flight executor", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/long-running", { "long-running.txt": "land me\n" });
      registerWorkRepo(db, repo);
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const executor = async () => {
        markStarted?.();
        return await new Promise<never>(() => undefined);
      };
      const queue = new AuthQueue({ db, now: () => now, executor });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/long-running --into main",
        title: "Long-running merge",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/long-running",
        cwd: repo,
      });
      queue.approve(request.id);
      await started;
      git(repo, ["merge", "--no-ff", "--no-commit", "feature/long-running"]);

      now = 11 * 60 * 1000;
      queue.expireStale();

      const stillExecuting = queue.getRequest(request.id);
      expect(stillExecuting?.status).toBe("executing");
      expect(stillExecuting?.exit_code).toBeNull();
      expect(stillExecuting?.error).toBeNull();
      expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
      queue.dispose();
    } finally {
      try {
        git(repo, ["merge", "--abort"]);
      } catch {
        // Test cleanup only.
      }
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("recovers successful executing requests and reapplies merge finalizers on restart", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/recovered", { "recovered.txt": "recovered\n" });
      const headSha = git(repo, ["rev-parse", "feature/recovered"]);
      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/recovered --into main",
        title: "Recovered merge",
        repo: "mandible",
        base_branch: "main",
        head_branch: "feature/recovered",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
        execution_mode: "remote"
      });
      db.prepare(
        `INSERT INTO work_units (
          id, issue_id, repo_id, branch, kind, state, created_at, auth_request_id
        ) VALUES (
          'wu-recovered', 'issue-1', 'mandible', 'feature/recovered', 'solo', 'committed', ?, ?
        )`
      ).run(now, request.id);
      queue.approve(request.id);
      git(repo, ["merge", "--no-ff", "feature/recovered", "-m", "merge recovered"]);
      queue.dispose();

      now = 6 * 60 * 1000;
      const events: SseEvent[] = [];
      const restarted = new AuthQueue({
        db,
        now: () => now,
        broadcast: (event) => events.push(event),
      });
      try {
        // Issue 75f52ac — recovery enqueues Stage 3 finalizers (merge_finalized_at
        // is the terminal marker); drain before asserting finalized state.
        await restarted.drainFinalizers();
        const recovered = restarted.getRequest(request.id);
        const workUnit = db.prepare("SELECT state, resolved_at FROM work_units WHERE id = 'wu-recovered'")
          .get() as { state: string; resolved_at: number | null };
        expect(recovered?.status).toBe("completed");
        expect(recovered?.exit_code).toBe(0);
        expect(recovered?.merge_finalized_at).toBe(now);
        const resolvedEvent = events.find((event) => event.event === "auth:resolved");
        expect(resolvedEvent?.data).toMatchObject({
          execution_evidence_id: recovered?.execution_evidence_id,
          signature_verification: {
            evidence_id: recovered?.execution_evidence_id,
          },
        });
        expect(workUnit.state).toBe("resolved");
        expect(workUnit.resolved_at).toBe(now);
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
