import { AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";
import { approveFixtureRequest, seedHistoricalAuthExecution } from "./helpers/auth-queue-fixtures.js";
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

      let executionStarted: () => void;
      const started = new Promise<void>(resolve => { executionStarted = resolve; });
      queue = new AuthQueue({ db, now: () => 0, hookManager: createNoopHookManager(), backgroundMaintenance: false, executor: async () => { executionStarted(); return new Promise<never>(() => {}); } });
      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/atomic-recovery --into main",
        title: "Atomic recovery",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/atomic-recovery",
        merge_head_sha: git(repo, ["rev-parse", "feature/atomic-recovery"]),
        cwd: repo,
      }));
      await approveFixtureRequest(queue, request.id);
      await started;
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
        pinned.commit_message!,
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
        ? (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
            command: "echo same-repo follower",
            title: "Same-repo follower",
            cwd: repo,
            target_repo_root: repo,
          }))
        : null;
      (await queue.dispose());

      queue = new AuthQueue({
        db,
        hookManager: follower
          ? ({
              ...createNoopHookManager(),
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
        const blocked = await waitUntil(async () => {
          const current = (await queue.getRequest(request.id))!;
          return current.error?.includes("needs recovery") ? current : undefined;
        }, "the collision to be reported as needing recovery");
        expect(blocked.status).toBe("executing");
        expect(blocked.exit_code).toBeNull();
        expect(blocked.merge_candidate_pin_sha).toBe(pinned.merge_candidate_pin_sha);
        expect(blocked.error).toContain("needs recovery");
        expect(fs.readFileSync(path.join(repo, "atomic.txt"), "utf8")).toBe("local collision\n");
        return;
      }
      if (follower) {
        await approveFixtureRequest(queue, follower.id);
        await waitForStatus(queue, follower.id, "completed");
        expect(order.indexOf("recovery-hook-end")).toBeLessThan(order.indexOf("follower-executor"));
      }
      const recovered = await waitForStatus(queue, request.id, "completed");

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
      (await queue?.dispose());
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(["clean", "untracked", "staged", "divergent"] as const)(
    "refuses legacy interrupted publication and preserves a %s checkout", async (kind) => {
      const repo = createAuthCheckRepo();
      const otherRepo = kind === "divergent" ? createAuthCheckRepo() : null;
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;
      try {
        commitOnBranch(repo, "feature/interrupted", { "interrupted.txt": "land me\n" });
        queue = new AuthQueue({ db, now: () => 0, backgroundMaintenance: false });
        const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: "merge", command: "mandible auth merge feature/interrupted --into main",
          title: "Legacy interrupted merge", repo: path.basename(repo), base_branch: "main", head_branch: "feature/interrupted",
          merge_head_sha: git(repo, ["rev-parse", "feature/interrupted"]), cwd: repo,
          target_repo_root: otherRepo ?? repo, execution_mode: "remote" }));
        (await seedHistoricalAuthExecution(queue, request.id));
        git(repo, ["merge", "--no-ff", "--no-commit", "feature/interrupted"]);
        if (kind === "untracked" || kind === "staged") {
          writeFile(repo, "unrelated.txt", "preserve me\n");
          if (kind === "staged") git(repo, ["add", "unrelated.txt"]);
        }
        const before = git(repo, ["status", "--porcelain"]);
        const tree = git(repo, ["write-tree"]);
        const base = git(repo, ["rev-parse", "main"]);
        const otherState = otherRepo ? git(otherRepo, ["status", "--porcelain"]) : null;
        (await queue.dispose());
        queue = new AuthQueue({ db, now: () => 6 * 60 * 1000 });
        const recovered = await waitForStatus(queue, request.id, "completed");
        expect(recovered.exit_code).toBe(1);
        expect(recovered.execution_evidence_id).toBeNull();
        expect(recovered.merge_finalized_at).toBeNull();
        expect(git(repo, ["status", "--porcelain"])).toBe(before);
        expect(git(repo, ["write-tree"])).toBe(tree);
        expect(git(repo, ["rev-parse", "main"])).toBe(base);
        expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
        if (otherRepo) expect(git(otherRepo, ["status", "--porcelain"])).toBe(otherState);
      } finally {
        (await queue?.dispose()); db.close(); fs.rmSync(repo, { recursive: true, force: true });
        if (otherRepo) fs.rmSync(otherRepo, { recursive: true, force: true });
      }
    });

  it("does not recover a legitimate long-running in-flight executor", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    let queue: AuthQueue | null = null;
    try {
      commitOnBranch(repo, "feature/long-running", { "long-running.txt": "land me\n" });
      registerWorkRepo(db, repo);
      let markStarted: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      queue = new AuthQueue({ db, now: () => now, executor: async () => {
        markStarted(); return new Promise<never>(() => {});
      } });
      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: "merge", command: "mandible auth merge feature/long-running --into main",
        title: "Long-running merge", repo: path.basename(repo), base_branch: "main", head_branch: "feature/long-running",
        merge_head_sha: git(repo, ["rev-parse", "feature/long-running"]), cwd: repo }));
      await approveFixtureRequest(queue, request.id); await started;
      now = 11 * 60 * 1000; (await queue.expireStale());
      expect((await queue.getRequest(request.id))).toMatchObject({ status: "executing", exit_code: null, error: null });
      expect(git(repo, ["status", "--porcelain"])).toBe("");
    } finally { (await queue?.dispose()); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });
});
