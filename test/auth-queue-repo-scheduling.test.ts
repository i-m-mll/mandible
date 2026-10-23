import { AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";
import { approveFixtureRequest, awaitFixtureResolution, publishFixtureExecution } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * Per-repo canonical identity: execution chains, dedupe matching, self-merge drain.
 *
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { commitOnBranch, createAuthCheckRepo, createMigratedDb, createNoopHookManager, git, registerWorkRepo, uniqueMissingPath, waitForStatus } from "./helpers/auth-queue-fixtures.js";

// Issue ded17e6 — per-repo execution chains keyed on canonical Git identity,
// canonical work-unit / dedupe matching, and self-merge drain.
describe("AuthQueue per-repo canonical identity (ded17e6)", () => {
  const waitFor = (predicate: () => boolean) => waitUntil(predicate, "merge scheduling state");

  function gatedExecutor() {
    const started: string[] = [];
    const running = new Set<string>();
    // The requests still executing when each request's executor started.
    const runningAtStart = new Map<string, string[]>();
    const releases = new Map<string, () => void>();
    let queue: AuthQueue;
    const executor = async (options: Parameters<NonNullable<ConstructorParameters<typeof AuthQueue>[0]["executor"]>>[0]) => {
      started.push(options.request_id);
      runningAtStart.set(options.request_id, [...running]);
      running.add(options.request_id);
      await new Promise<void>((resolve) => releases.set(options.request_id, resolve));
      running.delete(options.request_id);
      if ((await queue.getRequest(options.request_id))?.type === "merge") return publishFixtureExecution(queue, options);
      return {
        exit_code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        output: "",
        started_at: Date.now(),
        finished_at: Date.now(),
      };
    };
    return {
      executor: executor as unknown as ConstructorParameters<typeof AuthQueue>[0]["executor"],
      started,
      runningAtStart,
      bindQueue: (value: AuthQueue) => { queue = value; },
      release: (id: string) => releases.get(id)?.(),
    };
  }

  it("runs merges in distinct repos concurrently and drains the chain map", async () => {
    const repoA = createAuthCheckRepo();
    const repoB = createAuthCheckRepo();
    const db = createMigratedDb();
    const g = gatedExecutor();
    try {
      commitOnBranch(repoA, "feature/con-a", { "a2.txt": "a\n" });
      commitOnBranch(repoB, "feature/con-b", { "b2.txt": "b\n" });
      registerWorkRepo(db, repoA);
      registerWorkRepo(db, repoB);

      const queue = new AuthQueue({ db, executor: g.executor, hookManager: createNoopHookManager() });
      g.bindQueue(queue);
      const reqA = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge", command: "mandible auth merge feature/con-a --into main", title: "A",
        repo: path.basename(repoA), base_branch: "main", head_branch: "feature/con-a", cwd: repoA, merge_head_sha: git(repoA, ["rev-parse", "feature/con-a"]),
      }));
      const reqB = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge", command: "mandible auth merge feature/con-b --into main", title: "B",
        repo: path.basename(repoB), base_branch: "main", head_branch: "feature/con-b", cwd: repoB, merge_head_sha: git(repoB, ["rev-parse", "feature/con-b"]),
      }));

      await approveFixtureRequest(queue, reqA.id);
      await approveFixtureRequest(queue, reqB.id);
      // Distinct canonical repos → both executors enter before either resolves.
      await waitFor(() => g.started.length === 2);
      expect([...g.started].sort()).toEqual([reqA.id, reqB.id].sort());

      g.release(reqA.id);
      g.release(reqB.id);
      await waitForStatus(queue, reqA.id, "completed");
      await waitForStatus(queue, reqB.id, "completed");
      // Chain-map hygiene: settled tails are removed.
      await waitFor(() => (queue as unknown as { executionChains: Map<string, unknown> }).executionChains.size === 0);
      (await queue.dispose());
    } finally {
      db.close();
      fs.rmSync(repoA, { recursive: true, force: true });
      fs.rmSync(repoB, { recursive: true, force: true });
    }
  });

  it("serializes same-repo merges FIFO across a symlink alias path", async () => {
    const repo = createAuthCheckRepo();
    const alias = uniqueMissingPath("mandible-ser-alias");
    fs.symlinkSync(fs.realpathSync(repo), alias);
    const db = createMigratedDb();
    const g = gatedExecutor();
    try {
      commitOnBranch(repo, "feature/ser-one", { "one.txt": "1\n" });
      commitOnBranch(repo, "feature/ser-two", { "two.txt": "2\n" });
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({ db, executor: g.executor, hookManager: createNoopHookManager() });
      g.bindQueue(queue);
      const req1 = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge", command: "mandible auth merge feature/ser-one --into main", title: "1",
        repo: path.basename(repo), base_branch: "main", head_branch: "feature/ser-one", cwd: repo, merge_head_sha: git(repo, ["rev-parse", "feature/ser-one"]),
      }));
      const req2 = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge", command: "mandible auth merge feature/ser-two --into main", title: "2",
        repo: path.basename(repo), base_branch: "main", head_branch: "feature/ser-two", cwd: alias, merge_head_sha: git(alias, ["rev-parse", "feature/ser-two"]),
      }));

      await approveFixtureRequest(queue, req1.id);
      await approveFixtureRequest(queue, req2.id);
      await waitFor(() => g.started.length === 1);
      expect(g.started).toEqual([req1.id]);

      g.release(req1.id);
      await waitForStatus(queue, req1.id, "completed");
      await waitFor(() => g.started.length === 2);
      // req2 (alias path → same canonical repo) ran only after req1 finished.
      expect(g.started).toEqual([req1.id, req2.id]);
      expect(g.runningAtStart.get(req2.id)).toEqual([]);

      g.release(req2.id);
      await waitForStatus(queue, req2.id, "completed");
      (await queue.dispose());
    } finally {
      db.close();
      try { fs.unlinkSync(alias); } catch { /* symlink already gone */ }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("uses one conservative chain key for unresolvable repository identities", async () => {
    const db = createMigratedDb();
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    try {
      const r1 = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit", command: "echo one", title: "one" }));
      const r2 = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit", command: "echo two", title: "two", cwd: uniqueMissingPath("unresolved") }));
      const chainKey = (request: typeof r1) => (queue as unknown as { reserveRepoAdmission(request: typeof r1, install: (key: string) => string): Promise<string> }).reserveRepoAdmission(request, key => key);
      expect(await chainKey(r1)).toBe(await chainKey(r2));
    } finally { (await queue.dispose()); db.close(); }
  });

  it("resolves a 'dotfiles' child work unit against a '.dotfiles' request only with registry backing", async () => {
    // The repo-string mismatch only bites Step 3 of resolveWorkUnitsOnMerge —
    // child branches merged through an integration branch, where the work unit's
    // branch differs from the request head_branch (so the direct branch-name
    // match cannot resolve it). Mirror the integration-branch topology.
    async function runFixture(withRegistry: boolean): Promise<string> {
      let now = 0;
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      try {
        commitOnBranch(repo, "feature/dot-child", { "dot.txt": "dot\n" });
        const childHead = git(repo, ["rev-parse", "feature/dot-child"]);
        git(repo, ["checkout", "-b", "integration/dot-batch", "main"]);
        git(repo, ["merge", "--no-ff", "feature/dot-child", "-m", "merge child"]);
        const integrationHead = git(repo, ["rev-parse", "integration/dot-batch"]);
        git(repo, ["checkout", "main"]);
        const realRoot = fs.realpathSync(repo);
        if (withRegistry) {
          db.prepare(
            `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
             VALUES ('dotfiles', ?, 'dotfiles', 'main', 1, 0)`
          ).run(realRoot);
        }
        db.prepare(
          `INSERT INTO branches (repo_root, branch, last_commit_hash) VALUES (?, 'feature/dot-child', ?)`
        ).run(realRoot, childHead);
        db.prepare(
          `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
           VALUES ('wu-dot', 'dot123', 'dotfiles', 'feature/dot-child', 'partition', 'committed', ?)`
        ).run(now);

        let queue: AuthQueue;
        queue = new AuthQueue({ db, now: () => now, executor: (options) => publishFixtureExecution(queue, options), hookManager: createNoopHookManager() });
        const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
          type: "merge", command: "mandible auth merge integration/dot-batch --into main", title: "Merge dotfiles",
          repo: ".dotfiles", cwd: repo, base_branch: "main", head_branch: "integration/dot-batch",
          merge_head_sha: integrationHead, execution_mode: "daemon",
        }));
        now = 1000;
        if (!withRegistry) {
          await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(/unregistered/);
          expect((await queue.getRequest(request.id))?.status).toBe("pending");
          (await queue.dispose());
          return "committed";
        }
        // Ancestry resolution is Stage 3, admitted after auth:resolved. A
        // completed row alone does not mean that finalizer drain has work yet.
        await awaitFixtureResolution(queue, request.id, async () => {
          await approveFixtureRequest(queue, request.id);
          await waitForStatus(queue, request.id, "completed");
        });
        await queue.drainFinalizers();
        const state = (db.prepare("SELECT state FROM work_units WHERE id = 'wu-dot'").get() as { state: string }).state;
        (await queue.dispose());
        return state;
      } finally {
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }

    // With the registry rooting "dotfiles" at the physical repo, the alias
    // mismatch is bridged and the work unit resolves.
    expect(await runFixture(true)).toBe("resolved");
    // Without it, canonical resolution finds no key and the string fallback does
    // not match "dotfiles" against ".dotfiles" — documents the fallback boundary.
    expect(await runFixture(false)).toBe("committed");
  });

  it("supersedes a duplicate sibling recorded under an aliased repo string", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/dup", { "dup.txt": "d\n" });
      const dupHead = git(repo, ["rev-parse", "feature/dup"]);
      const realRoot = fs.realpathSync(repo);
      // "dotfiles" resolves via work_repos, ".dotfiles" via a ledger project
      // display_name — both rooted at the same physical repo.
      db.prepare(
        `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
         VALUES ('dotfiles', ?, 'dotfiles', 'main', 1, 0)`
      ).run(realRoot);
      db.prepare(
        `INSERT INTO ledger_projects (id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at, project_key)
         VALUES ('prj-dot', '.dotfiles', 'ri-dot', '', 'local', ?, ?, 'dotkey')`
      ).run(now, now);
      db.prepare(
        `INSERT INTO ledger_project_checkouts (id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at)
         VALUES ('chk-dot', 'prj-dot', NULL, ?, '.dotfiles', 'main', '', ?, ?)`
      ).run(realRoot, now, now);

      let queue: AuthQueue;
        queue = new AuthQueue({ db, now: () => now, executor: (options) => publishFixtureExecution(queue, options), hookManager: createNoopHookManager() });
      const sibling = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge", command: "mandible auth merge feature/dup --into main", title: "dup sibling",
        repo: "dotfiles", cwd: repo, base_branch: "main", head_branch: "feature/dup",
        merge_head_sha: dupHead, execution_mode: "daemon",
      }));
      const completed = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge", command: "mandible auth merge feature/dup --into main", title: "dup completed",
        repo: ".dotfiles", cwd: repo, base_branch: "main", head_branch: "feature/dup",
        merge_head_sha: dupHead, execution_mode: "daemon",
      }));
      now = 1000;
      await approveFixtureRequest(queue, completed.id);
      await waitForStatus(queue, completed.id, "completed");
      await queue.drainFinalizers();
      expect((await queue.getRequest(sibling.id))).toMatchObject({
        status: "superseded",
        superseded_by_request_id: completed.id,
      });
      (await queue.dispose());
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("self-merge drain waits for a foreign execution before restarting", async () => {
    vi.useFakeTimers();
    try {
      let restarted = 0;
      const db = createMigratedDb();
      const queue = new AuthQueue({ db, restartFn: () => { restarted += 1; } });
      let releaseForeign!: () => void;
      const foreign = new Promise<void>((resolve) => { releaseForeign = resolve; });
      (queue as unknown as { inFlight: Map<string, Promise<void>> }).inFlight.set("foreign", foreign);

      const drain = (queue as unknown as { drainAndRestart(id: string): Promise<void> }).drainAndRestart("self");
      await vi.advanceTimersByTimeAsync(5000);
      expect(restarted).toBe(0); // still waiting on the foreign execution

      releaseForeign();
      await vi.advanceTimersByTimeAsync(0);
      expect(restarted).toBe(0); // foreign settled, but SSE-flush delay pending
      await vi.advanceTimersByTimeAsync(2000);
      await drain;
      expect(restarted).toBe(1);
      (await queue.dispose());
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("self-merge drain restarts after the 60s cap when a foreign execution never settles", async () => {
    vi.useFakeTimers();
    try {
      let restarted = 0;
      const db = createMigratedDb();
      const queue = new AuthQueue({ db, restartFn: () => { restarted += 1; } });
      const never = new Promise<void>(() => { /* never settles */ });
      (queue as unknown as { inFlight: Map<string, Promise<void>> }).inFlight.set("foreign", never);

      const drain = (queue as unknown as { drainAndRestart(id: string): Promise<void> }).drainAndRestart("self");
      await vi.advanceTimersByTimeAsync(59000);
      expect(restarted).toBe(0);
      await vi.advanceTimersByTimeAsync(1000); // reach the 60s drain cap
      await vi.advanceTimersByTimeAsync(2000); // SSE-flush delay
      await drain;
      expect(restarted).toBe(1);
      (await queue.dispose());
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
