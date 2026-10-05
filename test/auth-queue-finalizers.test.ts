import { waitForStatus, publishFixtureExecution, approveFixtureRequest } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * Merge finalizers: work-unit resolution, ancestry containment, Codex archival.
 *
 * Split out of the former 6,122-line `test/auth-queue.test.ts` (issue 9e40a31).
 * Vitest parallelises across files and never within one, so that single file was
 * 98.9% of the default gate's wall clock. Test names and assertions are
 * unchanged; the shared helpers live in `test/helpers/auth-queue-fixtures.ts`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { LedgerStore } from "../src/ledger/store.js";
import { SYSTEM_ACTOR } from "./helpers/ledger-fixtures.js";
import { commitOnBranch, createAuthCheckRepo, createLedgerIssue, createLedgerProject, createMigratedDb, git, insertConsoleSession, insertMandibleSession, insertWorkUnit, registerWorkRepo, writeFile } from "./helpers/auth-queue-fixtures.js";

describe("auth queue", () => {
  it("resolves child branch work units after an integration branch merge", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/child-work", { "child.txt": "child\n" });
      const childHead = git(repo, ["rev-parse", "feature/child-work"]);
      git(repo, ["checkout", "-b", "integration/child-batch", "main"]);
      git(repo, ["merge", "--no-ff", "feature/child-work", "-m", "merge child work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/child-batch"]);
      git(repo, ["checkout", "main"]);


      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/child-work', ?)`
      ).run(fs.realpathSync(repo), childHead);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-child', 'child123', ?, 'feature/child-work', 'partition', 'committed', ?)`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/child-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/child-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      now = 1000;
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      expect(db.prepare("SELECT state, resolved_at FROM work_units WHERE id = 'wu-child'").get())
        .toEqual({ state: "resolved", resolved_at: now });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("recovers abandoned child work units when containment proves they landed", async () => {
    let now = 0;
    const archived: string[] = [];
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/abandoned-child", { "child.txt": "child\n" });
      const childHead = git(repo, ["rev-parse", "feature/abandoned-child"]);
      git(repo, ["checkout", "-b", "integration/abandoned-batch", "main"]);
      git(repo, ["merge", "--no-ff", "feature/abandoned-child", "-m", "merge child work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/abandoned-batch"]);
      git(repo, ["checkout", "main"]);

      git(repo, ["branch", "-D", "feature/abandoned-child"]);

      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/abandoned-child', ?)`
      ).run(fs.realpathSync(repo), childHead);
      db.prepare(
        `INSERT INTO work_units (
          id, issue_id, repo_id, branch, kind, state, provider, provider_session_id, created_at
        ) VALUES (
          'wu-abandoned-child', 'child123', ?, 'feature/abandoned-child', 'partition',
          'abandoned', 'codex', 'thread-abandoned-child', ?
        )`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options),
        db,
        now: () => now,
        codexThreadArchiver: {
          archive: async (threadId) => { archived.push(threadId); },
          unarchive: async () => undefined,
        },
      });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/abandoned-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/abandoned-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      now = 1000;
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      expect(db.prepare(
        "SELECT state, resolved_at, auth_request_id FROM work_units WHERE id = 'wu-abandoned-child'",
      ).get()).toEqual({ state: "resolved", resolved_at: now, auth_request_id: null });
      expect(archived).toEqual([]);
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("links and archives branch-contained recovered work units that match explicit closure issues", async () => {
    let now = 0;
    const archived: string[] = [];
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      const project = createLedgerProject(db, repo);
      const issue = createLedgerIssue(db, project.project.id, "child123", "Child issue");
      commitOnBranch(repo, "feature/closed-child", { "child.txt": "child\n" });
      const childHead = git(repo, ["rev-parse", "feature/closed-child"]);
      git(repo, ["checkout", "-b", "integration/closed-batch", "main"]);
      git(repo, ["merge", "--no-ff", "feature/closed-child", "-m", "merge child work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/closed-batch"]);
      git(repo, ["checkout", "main"]);

      git(repo, ["branch", "-D", "feature/closed-child"]);

      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/closed-child', ?)`
      ).run(fs.realpathSync(repo), childHead);
      db.prepare(
        `INSERT INTO work_units (
          id, issue_id, ledger_issue_id, repo_id, branch, kind, state, provider,
          provider_session_id, worker_provider_session_id, created_at
        ) VALUES (
          'wu-closed-child', 'child123', ?, ?, 'feature/closed-child', 'partition',
          'abandoned', 'codex', 'thread-closed-child', 'thread-closed-child', ?
        )`
      ).run(issue.id, path.basename(repo), now);

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options),
        db,
        now: () => now,
        codexThreadArchiver: {
          archive: async (threadId) => { archived.push(threadId); },
          unarchive: async () => undefined,
        },
      });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/closed-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/closed-batch",
        merge_head_sha: integrationHead,
        issue_closures: [issue.id],
        execution_mode: "daemon",
      });

      now = 1000;
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      expect(db.prepare(
        "SELECT state, resolved_at, auth_request_id FROM work_units WHERE id = 'wu-closed-child'",
      ).get()).toEqual({ state: "resolved", resolved_at: now, auth_request_id: request.id });
      expect(archived).toEqual(["thread-closed-child"]);
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not recover stale abandoned work units that were already contained in base", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      git(repo, ["checkout", "-b", "integration/unrelated-batch", "main"]);
      writeFile(repo, "unrelated.txt", "unrelated\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "integration work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/unrelated-batch"]);

      commitOnBranch(repo, "feature/stale-abandoned", { "stale.txt": "stale\n" });
      const staleHead = git(repo, ["rev-parse", "feature/stale-abandoned"]);
      git(repo, ["checkout", "main"]);
      git(repo, ["merge", "--no-ff", "feature/stale-abandoned", "-m", "merge stale work"]);
      git(repo, ["branch", "-D", "feature/stale-abandoned"]);


      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/stale-abandoned', ?)`
      ).run(fs.realpathSync(repo), staleHead);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-stale-abandoned', 'stale123', ?, 'feature/stale-abandoned', 'partition', 'abandoned', ?)`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/unrelated-batch --into main",
        title: "Merge unrelated integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/unrelated-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      now = 1000;
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      expect(db.prepare(
        "SELECT state, resolved_at, auth_request_id FROM work_units WHERE id = 'wu-stale-abandoned'",
      ).get()).toEqual({ state: "abandoned", resolved_at: null, auth_request_id: null });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("resolves a committed unit via the branch snapshot hash after the branch is deleted (batched)", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/snap-child", { "child.txt": "child\n" });
      const childHead = git(repo, ["rev-parse", "feature/snap-child"]);
      git(repo, ["checkout", "-b", "integration/snap-batch", "main"]);
      git(repo, ["merge", "--no-ff", "feature/snap-child", "-m", "merge child work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/snap-batch"]);
      git(repo, ["checkout", "main"]);

      // Delete the branch: only the last_commit_hash snapshot proves containment,
      // which for-each-ref --merged could never see.
      git(repo, ["branch", "-D", "feature/snap-child"]);

      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/snap-child', ?)`
      ).run(fs.realpathSync(repo), childHead);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-snap', 'snap123', ?, 'feature/snap-child', 'partition', 'committed', ?)`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/snap-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/snap-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      now = 1000;
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      expect(db.prepare("SELECT state, resolved_at FROM work_units WHERE id = 'wu-snap'").get())
        .toEqual({ state: "resolved", resolved_at: now });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not resolve a squash-merged committed unit whose original tip is unreachable (batched)", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      // Unrelated integration branch supplies a valid, mergeable request head.
      git(repo, ["checkout", "-b", "integration/squash-batch", "main"]);
      writeFile(repo, "unrelated.txt", "unrelated\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "integration work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/squash-batch"]);

      // The child's work reaches main through a squash commit, so its original
      // tip is not an ancestor of main or of the request head.
      commitOnBranch(repo, "feature/squash-child", { "squash.txt": "squash\n" });
      const childHead = git(repo, ["rev-parse", "feature/squash-child"]);
      git(repo, ["checkout", "main"]);
      git(repo, ["merge", "--squash", "feature/squash-child"]);
      git(repo, ["commit", "-m", "squash child work"]);
      git(repo, ["branch", "-D", "feature/squash-child"]);


      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/squash-child', ?)`
      ).run(fs.realpathSync(repo), childHead);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-squash', 'squash123', ?, 'feature/squash-child', 'partition', 'committed', ?)`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/squash-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/squash-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      now = 1000;
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      expect(db.prepare(
        "SELECT state, resolved_at FROM work_units WHERE id = 'wu-squash'",
      ).get()).toEqual({ state: "committed", resolved_at: null });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("batches ancestry checks into a bounded number of git spawns", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const rp = fs.realpathSync(repo);
    const db = createMigratedDb();
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-git-trace-"));
    const traceLog = path.join(traceDir, "git-calls.log");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shim = path.join(traceDir, "git");
    fs.writeFileSync(
      shim,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(traceLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o755 },
    );
    try {
      git(repo, ["checkout", "-b", "integration/budget-batch", "main"]);
      writeFile(repo, "budget.txt", "budget\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "integration work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/budget-batch"]);
      git(repo, ["checkout", "main"]);


      registerWorkRepo(db, repo);
      // 50 committed candidate rows in one repo, each with a distinct branch and a
      // (deliberately unresolvable) 40-hex snapshot hash so the batch probes both
      // targets and the tip map exactly once, not per row.
      const dummyHash = "0".repeat(40);
      const insertBranch = db.prepare(
        "INSERT INTO branches (repo_root, branch, last_commit_hash) VALUES (?, ?, ?)",
      );
      const insertUnit = db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES (?, ?, ?, ?, 'partition', 'committed', ?)`,
      );
      for (let i = 0; i < 50; i += 1) {
        const branch = `feature/budget-${i}`;
        insertBranch.run(rp, branch, dummyHash);
        insertUnit.run(`wu-budget-${i}`, `budget${i}`, path.basename(repo), branch, now);
      }

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/budget-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: rp,
        target_repo_root: rp,
        base_branch: "main",
        head_branch: "integration/budget-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      const prevPath = process.env.PATH;
      process.env.PATH = `${traceDir}${path.delimiter}${prevPath ?? ""}`;
      try {
        now = 1000;
        await approveFixtureRequest(queue, request.id);
        await waitForStatus(queue, request.id, "completed");
        await queue.drainFinalizers();
      } finally {
        process.env.PATH = prevPath;
      }
      queue.dispose();

      const lines = fs.readFileSync(traceLog, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
      const revListSpawns = lines.filter((l) => l.startsWith("rev-list ") && !l.includes("--count")).length;
      const forEachRefSpawns = lines.filter((l) => l.startsWith("for-each-ref ")).length;
      // 2 targets (merge_head_sha, refs/heads/main) + 1 tip map for 50 rows.
      expect(revListSpawns + forEachRefSpawns).toBeLessThanOrEqual(4);
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it("retires stale abandoned units from future scans without deleting them, sparing fresh rows", async () => {
    let now = 10_000;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      git(repo, ["checkout", "-b", "integration/retire-batch", "main"]);
      writeFile(repo, "retire.txt", "retire\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "integration work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/retire-batch"]);
      git(repo, ["checkout", "main"]);


      registerWorkRepo(db, repo);
      // Stale abandoned row: aged well past the retention window; never merged.
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-stale-retire', 'stale123', ?, 'feature/retire-stale', 'partition', 'abandoned', 0)`
      ).run(path.basename(repo));
      // Fresh abandoned row: created now, must not be retired.
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-fresh-retire', 'fresh123', ?, 'feature/retire-fresh', 'partition', 'abandoned', ?)`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now, workUnitAbandonedScanRetentionMs: 1000 });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/retire-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/retire-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      // Retired, but not deleted: row survives with its abandoned state.
      expect(db.prepare(
        "SELECT state, merge_scan_retired_at FROM work_units WHERE id = 'wu-stale-retire'",
      ).get()).toEqual({ state: "abandoned", merge_scan_retired_at: now });
      // Fresh row is untouched.
      expect(db.prepare(
        "SELECT state, merge_scan_retired_at FROM work_units WHERE id = 'wu-fresh-retire'",
      ).get()).toEqual({ state: "abandoned", merge_scan_retired_at: null });

      // Re-running the ancestry finalizer sweep changes nothing (NULL-guarded idempotency).
      await (queue as unknown as { resolveAncestryWorkUnitsOnMerge(r: unknown): Promise<string[]> })
        .resolveAncestryWorkUnitsOnMerge(queue.getRequest(request.id));
      expect(db.prepare(
        "SELECT merge_scan_retired_at FROM work_units WHERE id = 'wu-stale-retire'",
      ).get()).toEqual({ merge_scan_retired_at: now });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips the retirement sweep when the ancestry batch build fails, then retires once it succeeds", async () => {
    let now = 10_000;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      // A real, existing branch drives the batch to actually run `git rev-list`
      // against the request target (rather than short-circuiting on an
      // unresolved candidate ref).
      commitOnBranch(repo, "feature/live-candidate", { "live.txt": "live\n" });
      // A real, already-merged head branch so the pre-submit independence check
      // passes; the ancestry scan below still uses the (bogus) merge_head_sha.
      git(repo, ["checkout", "-b", "integration/bf-batch", "main"]);
      writeFile(repo, "bf.txt", "bf\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "integration bf work"]);
      git(repo, ["checkout", "main"]);

      const mainHead = git(repo, ["rev-parse", "main"]);

      registerWorkRepo(db, repo);
      // Live candidate on an existing branch: forces reachableFor() to spawn.
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-live', 'live123', ?, 'feature/live-candidate', 'partition', 'committed', ?)`
      ).run(path.basename(repo), now);
      // Stale abandoned row aged past retention: would be retired by a healthy pass.
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-stale-bf', 'stale-bf', ?, 'feature/stale-bf', 'partition', 'abandoned', 0)`
      ).run(path.basename(repo));

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now, workUnitAbandonedScanRetentionMs: 1000 });
      // A syntactically valid but nonexistent SHA makes `git rev-list <sha>`
      // fail for the request target, so the batch records a build failure.
      const bogusSha = "b".repeat(40);
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/bf-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/bf-batch",
        merge_head_sha: git(repo, ["rev-parse", "integration/bf-batch"]),
        execution_mode: "daemon",
      });

      await (queue as unknown as { resolveAncestryWorkUnitsOnMerge(r: unknown): Promise<string[]> })
        .resolveAncestryWorkUnitsOnMerge({ ...request, merge_head_sha: bogusSha });

      // Batch build failed this pass → retirement sweep skipped → the stale row
      // is NOT tombstoned (a transient git failure must not cost data).
      expect(db.prepare(
        "SELECT merge_scan_retired_at FROM work_units WHERE id = 'wu-stale-bf'",
      ).get()).toEqual({ merge_scan_retired_at: null });

      // Repair the target so the batch builds cleanly, then re-run the ancestry
      // finalizer: the same stale row is now retired, proving the earlier skip
      // was caused specifically by the batch build failure.

      await (queue as unknown as { resolveAncestryWorkUnitsOnMerge(r: unknown): Promise<string[]> })
        .resolveAncestryWorkUnitsOnMerge(queue.getRequest(request.id));
      expect(db.prepare(
        "SELECT state, merge_scan_retired_at FROM work_units WHERE id = 'wu-stale-bf'",
      ).get()).toEqual({ state: "abandoned", merge_scan_retired_at: now });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("excludes an already-retired abandoned unit from a later merge that contains its branch", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      // The child branch really is merged, so absent retirement it would resolve.
      commitOnBranch(repo, "feature/excluded-child", { "child.txt": "child\n" });
      const childHead = git(repo, ["rev-parse", "feature/excluded-child"]);
      git(repo, ["checkout", "-b", "integration/excluded-batch", "main"]);
      git(repo, ["merge", "--no-ff", "feature/excluded-child", "-m", "merge child work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/excluded-batch"]);
      git(repo, ["checkout", "main"]);


      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/excluded-child', ?)`
      ).run(fs.realpathSync(repo), childHead);
      // Pre-retired by a prior sweep: excluded from the candidate query entirely.
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at, merge_scan_retired_at)
         VALUES ('wu-excluded', 'excl123', ?, 'feature/excluded-child', 'partition', 'abandoned', 0, 5)`
      ).run(path.basename(repo));

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/excluded-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/excluded-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      now = 1000;
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      expect(db.prepare(
        "SELECT state, resolved_at FROM work_units WHERE id = 'wu-excluded'",
      ).get()).toEqual({ state: "abandoned", resolved_at: null });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("resolves a stale abandoned unit that the current merge contains before retiring it", async () => {
    let now = 10_000;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/order-child", { "child.txt": "child\n" });
      const childHead = git(repo, ["rev-parse", "feature/order-child"]);
      git(repo, ["checkout", "-b", "integration/order-batch", "main"]);
      git(repo, ["merge", "--no-ff", "feature/order-child", "-m", "merge child work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/order-batch"]);
      git(repo, ["checkout", "main"]);

      git(repo, ["branch", "-D", "feature/order-child"]);

      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/order-child', ?)`
      ).run(fs.realpathSync(repo), childHead);
      // Stale (created_at 0) and not yet retired: the scan must still get it.
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-order', 'order123', ?, 'feature/order-child', 'partition', 'abandoned', 0)`
      ).run(path.basename(repo));

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now, workUnitAbandonedScanRetentionMs: 1000 });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/order-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/order-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      // Resolved in the same pass; the sweep only touches rows still abandoned,
      // so this resolved row is never retired.
      expect(db.prepare(
        "SELECT state, resolved_at, merge_scan_retired_at FROM work_units WHERE id = 'wu-order'",
      ).get()).toEqual({ state: "resolved", resolved_at: now, merge_scan_retired_at: null });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("scans and does not throw when work_units lacks the retirement column", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    // Simulate a lightweight DB whose work_units predates migration 107.
    db.exec("ALTER TABLE work_units DROP COLUMN merge_scan_retired_at");
    try {
      commitOnBranch(repo, "feature/nocol-child", { "child.txt": "child\n" });
      const childHead = git(repo, ["rev-parse", "feature/nocol-child"]);
      git(repo, ["checkout", "-b", "integration/nocol-batch", "main"]);
      git(repo, ["merge", "--no-ff", "feature/nocol-child", "-m", "merge child work"]);
      const integrationHead = git(repo, ["rev-parse", "integration/nocol-batch"]);
      git(repo, ["checkout", "main"]);

      git(repo, ["branch", "-D", "feature/nocol-child"]);

      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/nocol-child', ?)`
      ).run(fs.realpathSync(repo), childHead);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-nocol', 'nocol123', ?, 'feature/nocol-child', 'partition', 'committed', ?)`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/nocol-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/nocol-batch",
        merge_head_sha: integrationHead,
        execution_mode: "daemon",
      });

      now = 1000;
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();
      expect(db.prepare("SELECT state, resolved_at FROM work_units WHERE id = 'wu-nocol'").get())
        .toEqual({ state: "resolved", resolved_at: now });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("archives only reliably linked terminal Codex worker threads after successful merge", async () => {
    const archived: string[] = [];
    const db = createMigratedDb();
    const repoRoot = createAuthCheckRepo();
    commitOnBranch(repoRoot, "feature/archive-worker", { "worker.txt": "delivered\n" });
    registerWorkRepo(db, repoRoot);
    const project = createLedgerProject(db, repoRoot);
    const issue = createLedgerIssue(db, project.project.id, "done123", "Done issue");
    const parent = createLedgerIssue(db, project.project.id, "parent1", "Parent issue");
    const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options),
      db,
      codexThreadArchiver: {
        archive: async (threadId) => { archived.push(threadId); },
        unarchive: async () => undefined,
      },
    });

    try {
      insertMandibleSession(db, "mandible-worker", "ended");
      insertMandibleSession(db, "parent-thread", "active");
      insertConsoleSession(db, {
        id: "console-worker",
        providerSessionId: "thread-worker",
        mandibleSessionId: "mandible-worker",
      });
      insertConsoleSession(db, {
        id: "console-parent",
        providerSessionId: "parent-thread",
        mandibleSessionId: "parent-thread",
      });
      insertConsoleSession(db, {
        id: "console-running",
        providerSessionId: "thread-running",
        status: "running",
      });
      new LedgerStore(db).addIssueCheckpoint(parent.id, {
        ...SYSTEM_ACTOR,
        kind: "parent-role",
        payload: { session_id: "parent-thread", mechanism: "thread", assumed_at: Date.now() },
        actor_type: "mandible_user",
        source: "mandible",
        created_at: Date.now(),
      });

      const request = queue.submit({
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
      insertWorkUnit(db, {
        id: "wu-worker",
        issueShortId: "done123",
        ledgerIssueId: issue.id,
        repoId: project.checkout.root,
        assignedSessionId: "console-worker",
        authRequestId: request.id,
      });
      insertWorkUnit(db, {
        id: "wu-parent",
        issueShortId: "done123",
        ledgerIssueId: issue.id,
        repoId: project.checkout.root,
        assignedSessionId: "console-parent",
        authRequestId: request.id,
      });
      insertWorkUnit(db, {
        id: "wu-running",
        issueShortId: "done123",
        ledgerIssueId: issue.id,
        repoId: project.checkout.root,
        assignedSessionId: "console-running",
        authRequestId: request.id,
      });

      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();

      expect(archived).toEqual(["thread-worker"]);
      expect(db.prepare("SELECT state FROM work_units WHERE id = 'wu-worker'").get())
        .toEqual({ state: "resolved" });
      expect(new LedgerStore(db).getIssue(issue.id)).toMatchObject({
        status: "closed",
        resolution: "delivered",
      });
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("replays Codex archive attempts for a completed merge without rerunning merge finalizers", async () => {
    const archived: string[] = [];
    const db = createMigratedDb();
    const repoRoot = createAuthCheckRepo();
    commitOnBranch(repoRoot, "feature/archive-worker", { "worker.txt": "delivered\n" });
    registerWorkRepo(db, repoRoot);
    const project = createLedgerProject(db, repoRoot);
    const issue = createLedgerIssue(db, project.project.id, "done123", "Done issue");
    const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options),
      db,
      codexThreadArchiver: {
        archive: async (threadId) => { archived.push(threadId); },
        unarchive: async () => undefined,
      },
    });

    try {
      insertMandibleSession(db, "mandible-worker", "ended");
      insertConsoleSession(db, {
        id: "console-worker",
        providerSessionId: "thread-worker",
        mandibleSessionId: "mandible-worker",
      });

      const request = queue.submit({
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
      insertWorkUnit(db, {
        id: "wu-worker",
        issueShortId: "done123",
        ledgerIssueId: issue.id,
        repoId: project.checkout.root,
        assignedSessionId: "console-worker",
        authRequestId: request.id,
      });

      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
      await queue.drainFinalizers();
      const finalizedAt = queue.getRequest(request.id)?.merge_finalized_at;
      const replay = await queue.replayCodexThreadArchives(request.id);

      expect(archived).toEqual(["thread-worker", "thread-worker"]);
      expect(replay).toMatchObject({
        request_id: request.id,
        archived: 1,
        candidates: [
          {
            provider_session_id: "thread-worker",
            issue_id: issue.id,
            work_unit_id: "wu-worker",
            archived: true,
          },
        ],
      });
      expect(queue.getRequest(request.id)?.merge_finalized_at).toBe(finalizedAt);
      expect(new LedgerStore(db).getIssue(issue.id)).toMatchObject({
        status: "closed",
        resolution: "delivered",
      });
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not replay finalized same-branch merge finalizers against newer pending requests on restart", async () => {
    let now = 1000;
    const db = createMigratedDb();
    const repo = createAuthCheckRepo();
    commitOnBranch(repo, "integration/reused", { "first.txt": "first\n" });
    registerWorkRepo(db, repo);
    const queue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
    const completed = queue.submit({
      type: "merge",
      command: "mandible auth merge integration/reused --into main",
      title: "First wave",
      repo: path.basename(repo),
      cwd: repo,
      base_branch: "main",
      head_branch: "integration/reused",
      merge_head_sha: git(repo, ["rev-parse", "integration/reused"]),
      execution_mode: "daemon"
    });
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
    const secondQueue = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
    const pending = secondQueue.submit({
      type: "merge",
      command: "mandible auth merge integration/reused --into main",
      title: "Second wave",
      repo: path.basename(repo),
      cwd: repo,
      base_branch: "main",
      head_branch: "integration/reused",
      merge_head_sha: git(repo, ["rev-parse", "integration/reused"]),
      execution_mode: "daemon"
    });
    secondQueue.dispose();

    now = 3000;
    const restarted = new AuthQueue({ executor: async (options) => publishFixtureExecution(queue, options), db, now: () => now });
    try {
      const stillPending = restarted.getRequest(pending.id);
      const finalized = restarted.getRequest(completed.id);
      expect(finalized?.merge_finalized_at).toBe(1000);
      expect(stillPending?.status).toBe("pending");
      expect(stillPending?.error).toBeNull();
    } finally {
      restarted.dispose();
      db.close();
    }
  });

  it.each(['same', 'different'] as const)('leaves unverified historical completion and its %s-head pending sibling unchanged', async (headKind) => {
    const db = createMigratedDb();
    const oldHead = 'a'.repeat(40);
    const pendingHead = headKind === 'same' ? oldHead : 'b'.repeat(40);
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
      expect(queue.getRequest('history')).toMatchObject({ status: 'completed', merge_finalized_at: null });
      expect(queue.getRequest('pending')).toMatchObject({ status: 'pending', error: null, superseded_by_request_id: null });
    } finally { queue.dispose(); db.close(); }
  });
});
