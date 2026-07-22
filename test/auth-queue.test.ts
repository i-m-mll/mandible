import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import type { AuthHookManager } from "../src/auth-hooks.js";
import { migrate } from "../src/db.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import type { SseEvent } from "../src/types.js";

function createMigratedDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function createQueue(options: ConstructorParameters<typeof AuthQueue>[0] = {}) {
  const db = createMigratedDb();
  return new AuthQueue({ db, ...options });
}

function createNoopHookManager(): AuthHookManager {
  return {
    executeHooks: async () => []
  } as unknown as AuthHookManager;
}

async function waitForStatus(queue: AuthQueue, id: string, status: string, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const request = queue.getRequest(id);
    if (request?.status === status) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for status ${status}`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

function writeFile(repo: string, relativePath: string, content: string): void {
  const fullPath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function createAuthCheckRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-check-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Mandible Test"]);
  git(repo, ["config", "user.email", "mandible-test@localhost"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFile(repo, "shared.txt", "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

function commitOnBranch(repo: string, branch: string, changes: Record<string, string>): void {
  git(repo, ["checkout", "-b", branch, "main"]);
  for (const [file, content] of Object.entries(changes)) {
    writeFile(repo, file, content);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", branch]);
  git(repo, ["checkout", "main"]);
}

function registerWorkRepo(
  db: InstanceType<typeof Database>,
  repoRoot: string,
  defaultBranch = "main"
): void {
  db.prepare(
    `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
     VALUES (?, ?, ?, ?, 1, 0)`
  ).run(path.basename(repoRoot), fs.realpathSync(repoRoot), path.basename(repoRoot), defaultBranch);
}

function createLedgerProject(
  db: InstanceType<typeof Database>,
  root: string,
): ReturnType<typeof resolveProjectForCheckout> {
  fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name: path.basename(root),
    defaultBranch: "main",
    remoteUrl: "",
  });
}

function createLedgerIssue(
  db: InstanceType<typeof Database>,
  projectId: string,
  shortId: string,
  title = `Issue ${shortId}`,
) {
  return new LedgerStore(db).createIssue({
    project_id: projectId,
    title,
    body: "Body",
    kind: "feature",
    source: "mandible",
    aliases: [{ alias_kind: "git_bug_short", alias: shortId, source: "mandible", is_primary: true }],
  });
}

function insertMandibleSession(
  db: InstanceType<typeof Database>,
  id: string,
  status: string,
): void {
  db.prepare(
    "INSERT INTO sessions (id, app, status, created_at, updated_at) VALUES (?, 'codex', ?, datetime('now'), datetime('now'))",
  ).run(id, status);
}

function insertConsoleSession(
  db: InstanceType<typeof Database>,
  input: {
    id: string;
    providerSessionId: string;
    mandibleSessionId?: string | null;
    status?: string;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO console_sessions (
      id, label, command, args_json, provider_session_id, cwd, env_json, cols, rows,
      status, auto_restart, is_operator, interaction_mode, created_at, updated_at,
      backend_type, allowed_tools, mandible_session_id, resume_at_message, channel_enabled
    ) VALUES (?, ?, 'codex', '[]', ?, NULL, '{}', 120, 30,
      ?, 0, 0, 'both', ?, ?, 'spawn', NULL, ?, NULL, 0)`,
  ).run(
    input.id,
    input.id,
    input.providerSessionId,
    input.status ?? "stopped",
    now,
    now,
    input.mandibleSessionId ?? null,
  );
}

function insertWorkUnit(
  db: InstanceType<typeof Database>,
  input: {
    id: string;
    issueShortId: string;
    ledgerIssueId: string;
    repoId: string;
    assignedSessionId: string;
    authRequestId: string;
  },
): void {
  db.prepare(
    `INSERT INTO work_units (
      id, issue_id, ledger_issue_id, repo_id, branch, kind, state, assigned_session_id,
      created_at, auth_request_id
    ) VALUES (?, ?, ?, ?, 'feature/archive-worker', 'solo', 'committed', ?, ?, ?)`,
  ).run(
    input.id,
    input.issueShortId,
    input.ledgerIssueId,
    input.repoId,
    input.assignedSessionId,
    Date.now(),
    input.authRequestId,
  );
}

describe("auth queue", () => {
  it("submits request and returns pending status", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo hello", title: "Test" });
    expect(request.id).toBeTruthy();

    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("pending");
  });

  it("approves request, executes command, stores result", async () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "node -e \"console.log('ok')\"",
      title: "Run command"
    });

    const approved = queue.approve(request.id);
    expect(approved.status).toBe("executing");

    const resolved = await waitForStatus(queue, request.id, "completed");
    expect(resolved?.exit_code).toBe(0);
    expect(String(resolved?.output)).toContain("ok");
  });

  it("stores git context fields on submit", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo git",
      title: "Git",
      repo: "mandible",
      base_branch: "main",
      head_branch: "feature/demo",
      merge_head_sha: "1111111111111111111111111111111111111111",
      files_changed: 3,
      additions: 10,
      deletions: 2,
      execution_mode: "remote"
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.repo).toBe("mandible");
    expect(fetched?.base_branch).toBe("main");
    expect(fetched?.head_branch).toBe("feature/demo");
    expect(fetched?.merge_head_sha).toBe("1111111111111111111111111111111111111111");
    expect(fetched?.files_changed).toBe(3);
    expect(fetched?.additions).toBe(10);
    expect(fetched?.deletions).toBe(2);
    expect(fetched?.execution_mode).toBe("remote");
  });

  it("appends output chunks", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo output", title: "Output" });
    queue.appendOutput(request.id, "hello");
    queue.appendOutput(request.id, " world");

    const fetched = queue.getRequest(request.id);
    expect(fetched?.output).toBe("hello world");
  });

  it("sets result and completes request", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo done", title: "Done" });
    queue.setResult(request.id, 0, "ok", undefined);

    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("completed");
    expect(fetched?.exit_code).toBe(0);
    expect(fetched?.output).toBe("ok");
  });

  it("does not execute in remote mode", async () => {
    const calls: string[] = [];
    const executor = async () => {
      calls.push("called");
      return {
        exit_code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        output: "",
        started_at: Date.now(),
        finished_at: Date.now()
      };
    };
    const queue = createQueue({ executor });

    const request = queue.submit({
      command: "echo remote",
      title: "Remote",
      execution_mode: "remote"
    });

    const approved = queue.approve(request.id);
    expect(approved.status).toBe("executing");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(0);
  });

  it("recovers stale executing requests with partial output on restart", () => {
    let now = 0;
    const db = createMigratedDb();
    const queue = new AuthQueue({ db, now: () => now });
    const request = queue.submit({
      command: "mandible auth merge feature/partial",
      title: "Partial execution",
      execution_mode: "remote"
    });
    queue.approve(request.id);
    queue.appendOutput(request.id, "Executing merge command...\n");
    queue.dispose();

    now = 6 * 60 * 1000;
    const events: SseEvent[] = [];
    const restarted = new AuthQueue({ db, now: () => now, broadcast: (event) => events.push(event) });
    try {
      const recovered = restarted.getRequest(request.id);
      expect(recovered?.status).toBe("completed");
      expect(recovered?.exit_code).toBe(1);
      expect(recovered?.error).toContain("missing repository, base branch, or head branch metadata");
      expect(events.some((event) => event.event === "auth:resolved")).toBe(true);
    } finally {
      restarted.dispose();
      db.close();
    }
  });

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
      const restarted = new AuthQueue({ db, now: () => now });
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
      git(repo, ["merge", "--no-ff", "integration/child-batch", "-m", "merge integration"]);

      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/child-work', ?)`
      ).run(fs.realpathSync(repo), childHead);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-child', 'child123', ?, 'feature/child-work', 'partition', 'committed', ?)`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/child-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/child-batch",
        merge_head_sha: integrationHead,
        execution_mode: "remote",
      });

      now = 1000;
      queue.setResult(request.id, 0, "ok");
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
      git(repo, ["merge", "--no-ff", "integration/abandoned-batch", "-m", "merge integration"]);
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

      const queue = new AuthQueue({
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
        execution_mode: "remote",
      });

      now = 1000;
      queue.setResult(request.id, 0, "ok");
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
      git(repo, ["merge", "--no-ff", "integration/closed-batch", "-m", "merge integration"]);
      git(repo, ["branch", "-D", "feature/closed-child"]);

      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/closed-child', ?)`
      ).run(fs.realpathSync(repo), childHead);
      db.prepare(
        `INSERT INTO work_units (
          id, issue_id, ledger_issue_id, repo_id, branch, kind, state, provider,
          provider_session_id, created_at
        ) VALUES (
          'wu-closed-child', 'child123', ?, ?, 'feature/closed-child', 'partition',
          'abandoned', 'codex', 'thread-closed-child', ?
        )`
      ).run(issue.id, path.basename(repo), now);

      const queue = new AuthQueue({
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
        execution_mode: "remote",
      });

      now = 1000;
      queue.setResult(request.id, 0, "ok");
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
      git(repo, ["merge", "--no-ff", "integration/unrelated-batch", "-m", "merge integration"]);

      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/stale-abandoned', ?)`
      ).run(fs.realpathSync(repo), staleHead);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-stale-abandoned', 'stale123', ?, 'feature/stale-abandoned', 'partition', 'abandoned', ?)`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/unrelated-batch --into main",
        title: "Merge unrelated integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/unrelated-batch",
        merge_head_sha: integrationHead,
        execution_mode: "remote",
      });

      now = 1000;
      queue.setResult(request.id, 0, "ok");
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
      git(repo, ["merge", "--no-ff", "integration/snap-batch", "-m", "merge integration"]);
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

      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/snap-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/snap-batch",
        merge_head_sha: integrationHead,
        execution_mode: "remote",
      });

      now = 1000;
      queue.setResult(request.id, 0, "ok");
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
      git(repo, ["merge", "--no-ff", "integration/squash-batch", "-m", "merge integration"]);

      registerWorkRepo(db, repo);
      db.prepare(
        `INSERT INTO branches (repo_root, branch, last_commit_hash)
         VALUES (?, 'feature/squash-child', ?)`
      ).run(fs.realpathSync(repo), childHead);
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
         VALUES ('wu-squash', 'squash123', ?, 'feature/squash-child', 'partition', 'committed', ?)`
      ).run(path.basename(repo), now);

      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/squash-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/squash-batch",
        merge_head_sha: integrationHead,
        execution_mode: "remote",
      });

      now = 1000;
      queue.setResult(request.id, 0, "ok");
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
      git(repo, ["merge", "--no-ff", "integration/budget-batch", "-m", "merge integration"]);

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

      const queue = new AuthQueue({ db, now: () => now });
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
        execution_mode: "remote",
      });

      const prevPath = process.env.PATH;
      process.env.PATH = `${traceDir}${path.delimiter}${prevPath ?? ""}`;
      try {
        now = 1000;
        queue.setResult(request.id, 0, "ok");
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
      git(repo, ["merge", "--no-ff", "integration/retire-batch", "-m", "merge integration"]);

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

      const queue = new AuthQueue({ db, now: () => now, workUnitAbandonedScanRetentionMs: 1000 });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/retire-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/retire-batch",
        merge_head_sha: integrationHead,
        execution_mode: "remote",
      });

      queue.setResult(request.id, 0, "ok");
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

  // Integration reconciliation (issue 93d978e) — a transient git failure while
  // building the ancestry batch must not tombstone genuinely merged snapshots.
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
      git(repo, ["merge", "--no-ff", "integration/bf-batch", "-m", "merge integration bf"]);
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

      const queue = new AuthQueue({ db, now: () => now, workUnitAbandonedScanRetentionMs: 1000 });
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
        merge_head_sha: bogusSha,
        execution_mode: "remote",
      });

      queue.setResult(request.id, 0, "ok");
      await queue.drainFinalizers();

      // Batch build failed this pass → retirement sweep skipped → the stale row
      // is NOT tombstoned (a transient git failure must not cost data).
      expect(db.prepare(
        "SELECT merge_scan_retired_at FROM work_units WHERE id = 'wu-stale-bf'",
      ).get()).toEqual({ merge_scan_retired_at: null });

      // Repair the target so the batch builds cleanly, then re-run the ancestry
      // finalizer: the same stale row is now retired, proving the earlier skip
      // was caused specifically by the batch build failure.
      db.prepare("UPDATE auth_requests SET merge_head_sha = ? WHERE id = ?").run(mainHead, request.id);
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
      git(repo, ["merge", "--no-ff", "integration/excluded-batch", "-m", "merge integration"]);

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

      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/excluded-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/excluded-batch",
        merge_head_sha: integrationHead,
        execution_mode: "remote",
      });

      now = 1000;
      queue.setResult(request.id, 0, "ok");
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
      git(repo, ["merge", "--no-ff", "integration/order-batch", "-m", "merge integration"]);
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

      const queue = new AuthQueue({ db, now: () => now, workUnitAbandonedScanRetentionMs: 1000 });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/order-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/order-batch",
        merge_head_sha: integrationHead,
        execution_mode: "remote",
      });

      queue.setResult(request.id, 0, "ok");
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
      git(repo, ["merge", "--no-ff", "integration/nocol-batch", "-m", "merge integration"]);
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

      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge integration/nocol-batch --into main",
        title: "Merge integration",
        repo: path.basename(repo),
        cwd: repo,
        base_branch: "main",
        head_branch: "integration/nocol-batch",
        merge_head_sha: integrationHead,
        execution_mode: "remote",
      });

      now = 1000;
      expect(() => queue.setResult(request.id, 0, "ok")).not.toThrow();
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
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-thread-archive-"));
    const project = createLedgerProject(db, repoRoot);
    const issue = createLedgerIssue(db, project.project.id, "done123", "Done issue");
    const parent = createLedgerIssue(db, project.project.id, "parent1", "Parent issue");
    const queue = new AuthQueue({
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
        base_branch: "main",
        head_branch: "feature/archive-worker",
        issue_closures: ["done123"],
        execution_mode: "remote",
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

      queue.setResult(request.id, 0, "MANDIBLE_MERGE_RESULT {\"merge_sha\":\"abc123\"}\n");
      await queue.drainFinalizers();

      expect(archived).toEqual(["thread-worker"]);
      expect(db.prepare("SELECT state FROM work_units WHERE id = 'wu-worker'").get())
        .toEqual({ state: "resolved" });
      expect(new LedgerStore(db).getIssue(issue.id)).toMatchObject({
        status: "closed",
        resolution: "merged",
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
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-thread-archive-replay-"));
    const project = createLedgerProject(db, repoRoot);
    const issue = createLedgerIssue(db, project.project.id, "done123", "Done issue");
    const queue = new AuthQueue({
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
        base_branch: "main",
        head_branch: "feature/archive-worker",
        issue_closures: ["done123"],
        execution_mode: "remote",
      });
      insertWorkUnit(db, {
        id: "wu-worker",
        issueShortId: "done123",
        ledgerIssueId: issue.id,
        repoId: project.checkout.root,
        assignedSessionId: "console-worker",
        authRequestId: request.id,
      });

      queue.setResult(request.id, 0, "MANDIBLE_MERGE_RESULT {\"merge_sha\":\"abc123\"}\n");
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
        resolution: "merged",
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
    const queue = new AuthQueue({ db, now: () => now });
    const completed = queue.submit({
      type: "merge",
      command: "mandible auth merge integration/reused --into main",
      title: "First wave",
      repo: "rlrmp",
      base_branch: "main",
      head_branch: "integration/reused",
      merge_head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      execution_mode: "remote"
    });
    queue.setResult(completed.id, 0, "ok");
    await queue.drainFinalizers();
    queue.dispose();

    now = 2000;
    const secondQueue = new AuthQueue({ db, now: () => now });
    const pending = secondQueue.submit({
      type: "merge",
      command: "mandible auth merge integration/reused --into main",
      title: "Second wave",
      repo: "rlrmp",
      base_branch: "main",
      head_branch: "integration/reused",
      merge_head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      execution_mode: "remote"
    });
    secondQueue.dispose();

    now = 3000;
    const restarted = new AuthQueue({ db, now: () => now });
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

  it("does not auto-dismiss same-branch pending requests with a different recorded head", async () => {
    let now = 2000;
    const db = createMigratedDb();
    db.prepare(
      `INSERT INTO auth_requests (
        id, session_id, type, command, title, repo, base_branch, head_branch,
        merge_head_sha, status, created_at, updated_at, resolved_at, expires_at,
        exit_code, output, execution_mode, files_changed, additions, deletions,
        approval_source
      ) VALUES (
        'completed-old-head', NULL, 'merge', 'mandible auth merge feature/reused --into main',
        'Old head', 'repo', 'main', 'feature/reused',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'completed', 100, 1000, 1000, 10000,
        0, 'ok', 'remote', 0, 0, 0, 'manual'
      )`
    ).run();
    db.prepare(
      `INSERT INTO auth_requests (
        id, session_id, type, command, title, repo, base_branch, head_branch,
        merge_head_sha, status, created_at, updated_at, expires_at, output,
        execution_mode, files_changed, additions, deletions, approval_source
      ) VALUES (
        'pending-new-head', NULL, 'merge', 'mandible auth merge feature/reused --into main',
        'New head', 'repo', 'main', 'feature/reused',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'pending', 900, 900, 10000, '',
        'remote', 0, 0, 0, 'manual'
      )`
    ).run();

    const queue = new AuthQueue({ db, now: () => now });
    try {
      // Issue 75f52ac — constructor sweep enqueues Stage 3 finalizers; drain
      // before asserting finalized / auto-dismiss outcomes.
      await queue.drainFinalizers();
      const pending = queue.getRequest("pending-new-head");
      const completed = queue.getRequest("completed-old-head");
      expect(completed?.merge_finalized_at).toBe(now);
      expect(pending?.status).toBe("pending");
      expect(pending?.error).toBeNull();
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("auto-dismisses same-branch pending requests with the same recorded head", async () => {
    let now = 2000;
    const db = createMigratedDb();
    db.prepare(
      `INSERT INTO auth_requests (
        id, session_id, type, command, title, repo, base_branch, head_branch,
        merge_head_sha, status, created_at, updated_at, resolved_at, expires_at,
        exit_code, output, execution_mode, files_changed, additions, deletions,
        approval_source
      ) VALUES (
        'completed-same-head', NULL, 'merge', 'mandible auth merge feature/reused --into main',
        'Merged head', 'repo', 'main', 'feature/reused',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'completed', 100, 1000, 1000, 10000,
        0, 'ok', 'remote', 0, 0, 0, 'manual'
      )`
    ).run();
    db.prepare(
      `INSERT INTO auth_requests (
        id, session_id, type, command, title, repo, base_branch, head_branch,
        merge_head_sha, status, created_at, updated_at, expires_at, output,
        execution_mode, files_changed, additions, deletions, approval_source
      ) VALUES (
        'pending-same-head', NULL, 'merge', 'mandible auth merge feature/reused --into main',
        'Duplicate head', 'repo', 'main', 'feature/reused',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'pending', 900, 900, 10000, '',
        'remote', 0, 0, 0, 'manual'
      )`
    ).run();

    const queue = new AuthQueue({ db, now: () => now });
    try {
      // Issue 75f52ac — auto-dismiss is a Stage 3 finalizer; drain first.
      await queue.drainFinalizers();
      const pending = queue.getRequest("pending-same-head");
      expect(pending?.status).toBe("dismissed");
      expect(pending?.error).toContain("Auto-dismissed");
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("executes in daemon mode", async () => {
    const calls: string[] = [];
    const executor = async () => {
      calls.push("called");
      return {
        exit_code: 0,
        signal: null,
        stdout: "ok\n",
        stderr: "",
        output: "ok\n",
        started_at: Date.now(),
        finished_at: Date.now()
      };
    };
    const queue = createQueue({ executor });

    const request = queue.submit({
      command: "echo daemon",
      title: "Daemon",
      execution_mode: "daemon"
    });

    queue.approve(request.id);
    const resolved = await waitForStatus(queue, request.id, "completed");
    expect(resolved?.exit_code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("re-resolves daemon auth merge execution cwd before approval", async () => {
    const repo = createAuthCheckRepo();
    const featureWorktree = path.join(os.tmpdir(), `mandible-auth-approval-${Date.now()}`);
    const db = createMigratedDb();
    const calls: Array<string | null | undefined> = [];
    try {
      git(repo, ["worktree", "add", "-b", "feature/approval-cwd", featureWorktree]);
      git(featureWorktree, ["commit", "--allow-empty", "-m", "typed trailer\n\nMandible-Issue: abc1234"]);
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({
        db,
        executor: async (options) => {
          calls.push(options.cwd);
          return {
            exit_code: 0,
            signal: null,
            stdout: "ok\n",
            stderr: "",
            output: "ok\n",
            started_at: Date.now(),
            finished_at: Date.now(),
          };
        },
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/approval-cwd --into main",
        title: "Merge feature/approval-cwd",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/approval-cwd",
        cwd: featureWorktree,
      });

      const approved = queue.approve(request.id);
      expect(approved.cwd).toBe(fs.realpathSync(repo));
      await waitForStatus(queue, request.id, "completed");
      expect(calls).toEqual([fs.realpathSync(repo)]);
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(featureWorktree, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reuses submit-time merge preflight on approve when target and queue are unchanged", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      commitOnBranch(repo, "feature/reuse-preflight", { "feature.txt": "feature\n" });
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({
        db,
        executor: async (options) => {
          calls.push(options.env);
          return {
            exit_code: 0,
            signal: null,
            stdout: "ok\n",
            stderr: "",
            output: "ok\n",
            started_at: Date.now(),
            finished_at: Date.now(),
          };
        },
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/reuse-preflight --into main",
        title: "Merge feature/reuse-preflight",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/reuse-preflight",
        cwd: repo,
      });
      expect(request.merge_preflight_base_sha).toBe(git(repo, ["rev-parse", "main"]));
      expect(request.merge_preflight_queue_fingerprint).toMatch(/^[0-9a-f]{64}$/);

      queue.approve(request.id);
      await waitForStatus(queue, request.id, "completed");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT).toBe("1");
      expect(calls[0]?.MANDIBLE_AUTH_PREFLIGHT_BASE_SHA).toBe(request.merge_preflight_base_sha);
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not reuse submit-time merge preflight after the target branch moves", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      commitOnBranch(repo, "feature/target-moved", { "feature.txt": "feature\n" });
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({
        db,
        executor: async (options) => {
          calls.push(options.env);
          return {
            exit_code: 0,
            signal: null,
            stdout: "ok\n",
            stderr: "",
            output: "ok\n",
            started_at: Date.now(),
            finished_at: Date.now(),
          };
        },
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/target-moved --into main",
        title: "Merge feature/target-moved",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/target-moved",
        cwd: repo,
      });
      writeFile(repo, "main-only.txt", "main\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "move main"]);

      queue.approve(request.id);
      await waitForStatus(queue, request.id, "completed");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT).toBeUndefined();
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects daemon auth merge approval before spawning when context is incomplete", () => {
    const calls: string[] = [];
    const queue = createQueue({
      executor: async () => {
        calls.push("called");
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
    });

    const request = queue.submit({
      command: "mandible auth merge feature/no-context --into main",
      title: "No context",
    });

    expect(() => queue.approve(request.id)).toThrow(AuthQueueError);
    expect(queue.getRequest(request.id)?.status).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  it("auto-approves new requests while a lease is active and passes scoped env", async () => {
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    const queue = createQueue({
      autoApprover: {
        getActiveApprovalContext: () => ({
          source: "auto_lease",
          leaseId: "lease-1",
          env: {
            SSH_AUTH_SOCK: "/tmp/mandible-agent.sock",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "user.signingkey",
            GIT_CONFIG_VALUE_0: "/tmp/delegated.pub",
          },
        }),
      },
      executor: async (options) => {
        calls.push(options.env);
        return {
          exit_code: 0,
          signal: null,
          stdout: "ok\n",
          stderr: "",
          output: "ok\n",
          started_at: Date.now(),
          finished_at: Date.now(),
        };
      },
    });

    const request = queue.submit({
      command: "echo daemon",
      title: "Daemon",
      execution_mode: "daemon",
    });

    expect(request.status).toBe("executing");
    expect(request.approval_source).toBe("auto_lease");
    expect(request.approval_lease_id).toBe("lease-1");
    await waitForStatus(queue, request.id, "completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.SSH_AUTH_SOCK).toBe("/tmp/mandible-agent.sock");
    expect(calls[0]?.GIT_CONFIG_VALUE_0).toBe("/tmp/delegated.pub");
  });

  it("auto-approves pending requests when a lease is enabled", () => {
    const queue = createQueue({
      executor: async () => ({
        exit_code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        output: "",
        started_at: Date.now(),
        finished_at: Date.now(),
      }),
    });
    const first = queue.submit({ command: "echo one", title: "One" });
    const second = queue.submit({ command: "echo two", title: "Two" });

    const approved = queue.autoApprovePending({
      source: "auto_lease",
      leaseId: "lease-2",
      env: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
    });

    expect(approved.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(queue.getRequest(first.id)?.approval_source).toBe("auto_lease");
    expect(queue.getRequest(second.id)?.approval_lease_id).toBe("lease-2");
  });

  it("runs a delegated signing presence challenge before spawning auth merge execution", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const order: string[] = [];
    const events: SseEvent[] = [];
    try {
      commitOnBranch(repo, "feature/presence", { "presence.txt": "presence\n" });
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({
        db,
        broadcast: (event) => events.push(event),
        autoApprover: {
          getActiveApprovalContext: () => null,
          getDelegatedSigningStatus: () => ({
            provider: "yubikey-age",
            configured: true,
            public_key: "ssh-ed25519 delegated",
            public_key_path: "/tmp/delegated.pub",
            encrypted_passphrase_path: "/tmp/delegated.age",
            recipient_path: "/tmp/recipient.txt",
            missing_tools: [],
          }),
          presenceChallenge: async () => {
            order.push("challenge");
            return {
              source: "presence_challenge",
              leaseId: "presence-1",
              env: {
                SSH_AUTH_SOCK: "/tmp/presence.sock",
                MANDIBLE_AUTH_DELEGATED_SIGNING: "1",
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "user.signingkey",
                GIT_CONFIG_VALUE_0: "/tmp/delegated.pub",
              },
            };
          },
        },
        executor: async (options) => {
          order.push("executor");
          expect(options.env?.SSH_AUTH_SOCK).toBe("/tmp/presence.sock");
          expect(options.env?.GIT_CONFIG_VALUE_0).toBe("/tmp/delegated.pub");
          return {
            exit_code: 0,
            signal: null,
            stdout: "ok\n",
            stderr: "",
            output: "ok\n",
            started_at: Date.now(),
            finished_at: Date.now(),
          };
        },
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/presence --into main",
        title: "Merge feature/presence",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/presence",
        cwd: repo,
      });
      queue.approve(request.id);
      const resolved = await waitForStatus(queue, request.id, "completed");

      expect(order).toEqual(["challenge", "executor"]);
      expect(resolved?.approval_source).toBe("presence_challenge");
      expect(resolved?.approval_lease_id).toBe("presence-1");
      const output = events
        .filter((event) => event.event === "auth:output")
        .map((event) => ((event.data as { text?: string }).text ?? ""))
        .join("");
      expect(output).toContain("waiting for YubiKey touch");
      expect(output).toContain("delegated signing key ready");
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects request", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo nope", title: "Reject" });
    const rejected = queue.reject(request.id, "No");

    expect(rejected.status).toBe("rejected");

    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("rejected");
  });

  it("queues multiple requests FIFO and supports out-of-order approval", async () => {
    let time = 1;
    const queue = createQueue({ now: () => time++ });

    const first = queue.submit({ command: "echo one", title: "One" });
    const second = queue.submit({
      command: "node -e \"console.log('two')\"",
      title: "Two"
    });

    const pending = queue.listPending();
    const ids = pending.map((r) => r.id);
    expect(ids).toEqual([first.id, second.id]);

    queue.approve(second.id);
    const resolved = await waitForStatus(queue, second.id, "completed");
    expect(resolved?.exit_code).toBe(0);

    const stillPending = queue.getRequest(first.id);
    expect(stillPending?.status).toBe("pending");
  });

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
    const missingCwd = path.join(os.tmpdir(), "mandible-missing-auth-check-cwd");

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

  it("expires stale requests", () => {
    let now = 0;
    const queue = createQueue({ ttlMs: 10, now: () => now });

    const request = queue.submit({ command: "echo old", title: "Old" });

    now = 20;
    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("expired");
  });

  it("allows updating fields on a failed (non-zero exit) request", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo fail",
      title: "Fail",
      cwd: "/wrong/path"
    });
    // Simulate a failed execution
    queue.setResult(request.id, 1, "error output", "command failed");

    const failed = queue.getRequest(request.id);
    expect(failed?.status).toBe("completed");
    expect(failed?.exit_code).toBe(1);

    // Should be able to update fields on a failed request
    const updated = queue.update(request.id, { cwd: "/correct/path" });
    expect(updated.cwd).toBe("/correct/path");
    expect(updated.status).toBe("completed"); // Status unchanged
  });

  it("allows updating merge head sha on a pending request", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "mandible auth merge feature/foo --into main",
      title: "Merge foo",
      merge_head_sha: "1111111111111111111111111111111111111111",
    });

    const updated = queue.update(request.id, {
      merge_head_sha: "2222222222222222222222222222222222222222",
    });

    expect(updated.merge_head_sha).toBe("2222222222222222222222222222222222222222");
    expect(queue.getRequest(request.id)?.merge_head_sha).toBe(
      "2222222222222222222222222222222222222222",
    );
  });

  it("allows updating fields and resetting failed request to pending", () => {
    const events: SseEvent[] = [];
    const queue = createQueue({
      broadcast: (event) => {
        events.push(event);
      }
    });

    const request = queue.submit({
      command: "mandible auth merge feature/foo",
      title: "Merge foo",
      cwd: "/wrong/repo"
    });
    queue.setResult(request.id, 1, "Not a git repository", "cwd was wrong");

    // Update cwd and reset to pending in a single PUT
    const updated = queue.update(request.id, {
      cwd: "/correct/repo",
      status: "pending"
    });

    expect(updated.status).toBe("pending");
    expect(updated.cwd).toBe("/correct/repo");
    expect(updated.exit_code).toBeNull();
    expect(updated.error).toBeNull();
    expect(updated.output).toBe("");
    expect(updated.resolved_at).toBeNull();

    // Should broadcast auth:new for retry
    expect(events.some((e) => e.event === "auth:new" && (e.data as { request: { id: string } }).request.id === updated.id)).toBe(true);
  });

  it("allows resetting failed request to pending with status only (no other fields)", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo retry", title: "Retry" });
    queue.setResult(request.id, 1, "failed", "oops");

    const updated = queue.update(request.id, { status: "pending" });
    expect(updated.status).toBe("pending");
    expect(updated.exit_code).toBeNull();
  });

  it("rejects updating a successfully completed request", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo ok", title: "OK" });
    queue.setResult(request.id, 0, "success");

    expect(() => queue.update(request.id, { title: "New title" })).toThrow();
  });

  it("allows updating fields on an expired request", () => {
    let now = 0;
    const queue = createQueue({ ttlMs: 10, now: () => now });

    const request = queue.submit({
      command: "echo stale",
      title: "Stale",
      cwd: "/old/path"
    });

    now = 20; // Trigger expiry

    const updated = queue.update(request.id, {
      cwd: "/new/path",
      status: "pending"
    });

    expect(updated.status).toBe("pending");
    expect(updated.cwd).toBe("/new/path");
  });

  it("allows updating an approved request (Bug: 68aa754 — stuck execution recovery)", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo approved",
      title: "Approved",
      execution_mode: "remote" // remote so it doesn't auto-execute
    });
    queue.approve(request.id);

    // Approved requests can be modified for recovery scenarios (force-dismiss,
    // reset to pending after interrupted execution, etc.)
    const updated = queue.update(request.id, { title: "Changed" });
    expect(updated.title).toBe("Changed");
    expect(updated.status).toBe("executing");
  });

  it("fires SSE events for new, output, resolved", async () => {
    const events: SseEvent[] = [];
    const queue = createQueue({
      broadcast: (event) => {
        events.push(event);
      }
    });

    const request = queue.submit({
      command: "node -e \"console.log('stream')\"",
      title: "Stream"
    });

    expect(events.some((event) => event.event === "auth:new")).toBe(true);

    queue.approve(request.id);
    await waitForStatus(queue, request.id, "completed");

    expect(events.some((event) => event.event === "auth:output")).toBe(true);
    expect(events.some((event) => event.event === "auth:resolved")).toBe(true);
  });

  // Bug: 297677f — issues field tests
  it("stores issue references and closures separately", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Merge with typed issue links",
      issue_references: ["umbrella123"],
      issue_closures: ["done456"]
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issue_references).toEqual(["umbrella123"]);
    expect(fetched?.issue_closures).toEqual(["done456"]);
    expect(fetched?.issues).toBeNull();
  });

  it("maps legacy issues to issue_closures for compatibility", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Merge with legacy closes",
      issues: ["legacy123"]
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issue_closures).toEqual(["legacy123"]);
    expect(fetched?.issues).toEqual(["legacy123"]);
  });

  it("stores issues on submit and retrieves them", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Merge with closes",
      issues: ["abc123", "def456"]
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issues).toEqual(["abc123", "def456"]);
  });

  it("stores null issues when not provided", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Merge without closes"
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issues).toBeNull();
  });

  it("allows updating issues on a pending request", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Update closes"
    });

    const updated = queue.update(request.id, {
      issues: ["umbrella123"]
    });

    expect(updated.issues).toEqual(["umbrella123"]);
  });

  it("allows setting issues to null via update", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Clear closes",
      issues: ["abc123"]
    });

    const updated = queue.update(request.id, {
      issues: null
    });

    expect(updated.issues).toBeNull();
  });

  it("preserves issues through retry-via-update", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo retry",
      title: "Retry with closes",
      issues: ["umbrella789"]
    });

    // Simulate failed execution
    queue.setResult(request.id, 1, "error", "failed");

    // Reset to pending — issues should survive
    const updated = queue.update(request.id, { status: "pending" });
    expect(updated.status).toBe("pending");
    expect(updated.issues).toEqual(["umbrella789"]);
  });

  // Bug: 93c57c4 — outcome field tests
  describe("outcome field in resolved payload", () => {
    it("resolvedPayload has outcome=succeeded when completed with exit_code=0", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo ok", title: "Success" });
      queue.setResult(request.id, 0, "ok");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("succeeded");
      expect(data.status).toBe("completed");
    });

    it("resolvedPayload has outcome=failed when completed with exit_code=1", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo fail", title: "Failure" });
      queue.setResult(request.id, 1, "error output", "command failed");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("failed");
      expect(data.status).toBe("completed");
    });

    it("resolvedPayload has outcome=rejected when request is rejected", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo nope", title: "Reject" });
      queue.reject(request.id, "Not approved");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("rejected");
      expect(data.status).toBe("rejected");
    });

    it("resolvedPayload has outcome=dismissed when request is dismissed", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo dismiss", title: "Dismiss" });
      queue.dismiss(request.id);

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("dismissed");
      expect(data.status).toBe("dismissed");
    });

    it("resolvedPayload has outcome=null when request is still pending (non-terminal state)", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      // Use execution_mode=remote so it stays in executing without running
      const request = queue.submit({
        command: "echo pending",
        title: "Pending",
        execution_mode: "remote"
      });
      queue.approve(request.id);

      // auth:new fires but not auth:resolved yet — check the request directly
      const fetched = queue.getRequest(request.id);
      expect(fetched?.status).toBe("executing");
      // No auth:resolved event should have fired yet
      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeUndefined();
    });

    it("resolvedPayload has outcome=expired when request expires", () => {
      let now = 0;
      const events: SseEvent[] = [];
      const queue = createQueue({
        ttlMs: 10,
        now: () => now,
        broadcast: (e) => events.push(e)
      });

      const request = queue.submit({ command: "echo stale", title: "Stale" });

      now = 20; // trigger expiry
      queue.expireStale();

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("expired");
      expect(data.status).toBe("expired");
    });
  });

  // Bug: 929c6d0 — error output in resolved payload and error field
  describe("error output in resolved events", () => {
    it("includes error_output in resolved payload when exit_code is non-zero", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo fail", title: "Failure" });
      // Append some output as if the executor streamed it — this goes into the
      // DB output column. setResult with a non-empty output replaces it, so we
      // pass the same content through setResult to simulate what happens when
      // the executor finishes (output is the accumulated buffer).
      const output = "line 1\nline 2\nline 3\nerror: merge conflict\n";
      queue.setResult(request.id, 1, output, "command failed");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.error_output).toBeTruthy();
      expect(String(data.error_output)).toContain("error: merge conflict");
    });

    it("does not include error_output when exit_code is 0", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo ok", title: "Success" });
      queue.appendOutput(request.id, "Merge made by recursive.\n");
      queue.setResult(request.id, 0, "ok");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.error_output).toBeNull();
    });

    it("populates error field with tail of output for daemon-executed failures", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({
        broadcast: (e) => events.push(e),
        executor: async () => ({
          exit_code: 1,
          signal: null,
          stdout: "",
          stderr: "fatal: not a git repo\nfatal: merge failed\n",
          output: "fatal: not a git repo\nfatal: merge failed\n",
          started_at: Date.now(),
          finished_at: Date.now()
        })
      });

      const request = queue.submit({
        command: "git merge --gpg-sign feature/x",
        title: "Merge feature/x"
      });
      queue.approve(request.id);
      await waitForStatus(queue, request.id, "completed");

      const completed = queue.getRequest(request.id);
      expect(completed?.exit_code).toBe(1);
      // Bug: 929c6d0 — error field should now contain the tail of executor output
      expect(completed?.error).toBeTruthy();
      expect(completed?.error).toContain("fatal: merge failed");
    });

    it("preserves explicit error message over output tail when executor throws", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({
        broadcast: (e) => events.push(e),
        executor: async () => {
          throw new Error("Spawn failed: ENOENT");
        }
      });

      const request = queue.submit({
        command: "nonexistent-command",
        title: "Bad command"
      });
      queue.approve(request.id);
      await waitForStatus(queue, request.id, "completed");

      const completed = queue.getRequest(request.id);
      expect(completed?.exit_code).toBe(1);
      // When the executor throws, the error message from the exception is used
      expect(completed?.error).toBe("Spawn failed: ENOENT");
    });

    it("error_output is truncated to last 20 lines", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo fail", title: "Long output" });
      // Generate 30 lines of output (no trailing newline so split gives exactly 30)
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
      queue.setResult(request.id, 1, lines, "failed");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      const errorOutput = String(data.error_output);
      // Should contain lines 11-30 but not lines 1-10
      expect(errorOutput).toContain("line 30");
      expect(errorOutput).toContain("line 11");
      expect(errorOutput).not.toContain("line 10\n");
    });
  });

  // Bug: 03d6cb0 — self-rebuild delay: auth:resolved must broadcast BEFORE
  // the daemon schedules a process.exit for self-merges.
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
          hookManager: createNoopHookManager(),
          broadcast: (event) => {
            events.push(event);
            if (event.event === "auth:resolved") {
              // At the moment auth:resolved fires, exit should NOT yet be scheduled
              resolvedBeforeExit = !exitScheduled;
            }
          },
          executor: async () => ({
            exit_code: 0,
            signal: null,
            stdout: "Merge made by recursive.\n",
            stderr: "",
            output: "Merge made by recursive.\n",
            started_at: Date.now(),
            finished_at: Date.now()
          })
        });

        const request = queue.submit({
          command: "mandible auth merge main",
          title: "Self-merge",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/self-fix",
          cwd: repo,
          execution_mode: "daemon"
        });

        queue.approve(request.id);
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
      const hookManager = {
        executeHooks: async () => {
          events.push({ event: "test:hooks-ran", data: {} });
          return [];
        },
      } as unknown as AuthHookManager;

      try {
        commitOnBranch(repo, "feature/order-fix", { "order.txt": "fix\n" });
        registerWorkRepo(db, repo);
        queue = new AuthQueue({
          db,
          hookManager,
          broadcast: (event) => events.push(event),
          executor: async () => ({
            exit_code: 0,
            signal: null,
            stdout: "Merge made by recursive.\n",
            stderr: "",
            output: "Merge made by recursive.\n",
            started_at: Date.now(),
            finished_at: Date.now()
          })
        });

        const request = queue.submit({
          command: "mandible auth merge main",
          title: "Self-merge ordering",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/order-fix",
          cwd: repo,
          execution_mode: "daemon"
        });

        queue.approve(request.id);
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
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;

      const originalSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = (fn: (...args: unknown[]) => void, ms?: number) => {
        // Capture the delay used for the self-rebuild exit
        if (ms !== undefined && ms >= 1000) {
          exitDelayMs = ms;
          return originalSetTimeout(() => {}, 0);
        }
        return originalSetTimeout(fn, ms);
      };
      globalThis.setTimeout = setTimeoutSpy as typeof globalThis.setTimeout;

      try {
        commitOnBranch(repo, "feature/delay-test", { "delay.txt": "fix\n" });
        registerWorkRepo(db, repo);
        queue = new AuthQueue({
          db,
          hookManager: createNoopHookManager(),
          executor: async () => ({
            exit_code: 0,
            signal: null,
            stdout: "Merge made by recursive.\n",
            stderr: "",
            output: "Merge made by recursive.\n",
            started_at: Date.now(),
            finished_at: Date.now()
          })
        });

        const request = queue.submit({
          command: "mandible auth merge main",
          title: "Self-merge delay test",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/delay-test",
          cwd: repo,
          execution_mode: "daemon"
        });

        queue.approve(request.id);
        await waitForStatus(queue, request.id, "completed");
        await new Promise((resolve) => originalSetTimeout(resolve, 100));

        // Bug: 03d6cb0 — the delay must be >= 2000ms to give the channel
        // server time to receive and process the auth:resolved event.
        expect(exitDelayMs).toBe(2000);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        queue?.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  // Bug: 0de95bf — history list projection.
  describe("listHistorySummaries", () => {
    function submitCompleted(
      queue: AuthQueue,
      overrides: Partial<Parameters<AuthQueue["submit"]>[0]> = {},
    ): string {
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/x --into main",
        title: "History row",
        repo: "mandible",
        base_branch: "main",
        head_branch: "feature/x",
        diff_summary: "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\n",
        spec_content: "# Spec\n\nlots of text",
        commit_message: "feat: land it",
        execution_mode: "remote",
        ...overrides,
      });
      queue.setResult(request.id, 0, "verbose console output ".repeat(50));
      return request.id;
    }

    it("omits diff/spec/output body blobs but keeps commit_message", () => {
      const queue = createQueue();
      submitCompleted(queue);

      const [row] = queue.listHistorySummaries(50);
      expect(row).toBeDefined();
      // Body blobs are omitted entirely (undefined, not null/"").
      expect("diff_summary" in row).toBe(false);
      expect("spec_content" in row).toBe(false);
      expect("output" in row).toBe(false);
      // Bounded fields the sidebar needs are still present.
      expect(row.commit_message).toBe("feat: land it");
      expect(row.title).toBe("History row");
      expect(row.repo).toBe("mandible");
      expect(row.head_branch).toBe("feature/x");
    });

    it("reports action_count per row from a batched query", () => {
      const queue = createQueue();
      const withActions = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Has actions",
        repo: "mandible",
        base_branch: "main",
        head_branch: "feature/a",
        execution_mode: "remote",
        actions: [
          { kind: "comment_add", target_issue_ref: "abc1234", payload: { body: "one" } },
          { kind: "label_add", target_issue_ref: "abc1234", payload: { label: "verified" } },
        ],
      });
      queue.setResult(withActions.id, 0, "ok");
      submitCompleted(queue, { title: "No actions", head_branch: "feature/b" });

      const rows = queue.listHistorySummaries(50);
      const withActionsRow = rows.find((r) => r.id === withActions.id);
      const withoutRow = rows.find((r) => r.title === "No actions");
      expect(withActionsRow?.action_count).toBe(2);
      expect(withoutRow?.action_count).toBe(0);
    });

    it("only returns resolved rows, newest first, respecting the limit", () => {
      let now = 1000;
      const db = createMigratedDb();
      const queue = new AuthQueue({ db, now: () => now });
      // A pending row must not appear in history.
      queue.submit({ command: "echo pending", title: "Pending" });
      const first = submitCompleted(queue, { title: "First", head_branch: "feature/1" });
      now = 2000;
      const second = submitCompleted(queue, { title: "Second", head_branch: "feature/2" });

      const rows = queue.listHistorySummaries(50);
      expect(rows.map((r) => r.id)).toEqual([second, first]);
      expect(rows.some((r) => r.title === "Pending")).toBe(false);

      expect(queue.listHistorySummaries(1).map((r) => r.id)).toEqual([second]);
      queue.dispose();
      db.close();
    });
  });

  // Bug: 681739e — a self-merge restart must not kill chained executions. While
  // the restart is pending, admission is closed (new executions park instead of
  // starting), and the shutdown instant is recorded so the respawned daemon
  // fast-recovers any orphaned execution instead of waiting out the multi-minute
  // stuck-request threshold.
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
      const hookManager = {
        executeHooks: async () => {
          await hookGate;
          return [];
        },
      } as unknown as AuthHookManager;

      try {
        commitOnBranch(repo, "feature/self-park", { "park.txt": "fix\n" });
        registerWorkRepo(db, repo);
        queue = new AuthQueue({
          db,
          hookManager,
          executor: async (options) => {
            executed.push(options.request_id);
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
        });

        const selfMerge = queue.submit({
          command: "mandible auth merge main",
          title: "Self-merge",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/self-park",
          cwd: repo,
          execution_mode: "daemon",
        });
        queue.approve(selfMerge.id);

        // Wait for the self-merge to enter its hook phase (admission closed).
        const deadline = Date.now() + 2000;
        while (!queue.isRebuilding && Date.now() < deadline) {
          await new Promise((resolve) => originalSetTimeout(resolve, 10));
        }
        expect(queue.isRebuilding).toBe(true);

        // A request approved during the rebuild window must be parked, not run.
        const other = queue.submit({
          command: "echo other",
          title: "Other",
          execution_mode: "daemon",
        });
        queue.approve(other.id);
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

    it("fast-recovers an execution orphaned by a recorded self-merge shutdown", () => {
      const db = createMigratedDb();
      const now = 5_000_000;
      const q1 = new AuthQueue({ db, now: () => now });
      const req = q1.submit({
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

      const recovered = q2.getRequest(req.id);
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
      const req = q1.submit({
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

// Issue ded17e6 — per-repo execution chains keyed on canonical Git identity,
// canonical work-unit / dedupe matching, and self-merge drain.
describe("AuthQueue per-repo canonical identity (ded17e6)", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("waitFor timed out");
  }

  function gatedExecutor() {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const executor = async (options: { request_id: string }) => {
      started.push(options.request_id);
      await new Promise<void>((resolve) => releases.set(options.request_id, resolve));
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
      const reqA = queue.submit({
        type: "merge", command: "mandible auth merge feature/con-a --into main", title: "A",
        repo: path.basename(repoA), base_branch: "main", head_branch: "feature/con-a", cwd: repoA,
      });
      const reqB = queue.submit({
        type: "merge", command: "mandible auth merge feature/con-b --into main", title: "B",
        repo: path.basename(repoB), base_branch: "main", head_branch: "feature/con-b", cwd: repoB,
      });

      queue.approve(reqA.id);
      queue.approve(reqB.id);
      // Distinct canonical repos → both executors enter before either resolves.
      await waitFor(() => g.started.length === 2);
      expect([...g.started].sort()).toEqual([reqA.id, reqB.id].sort());

      g.release(reqA.id);
      g.release(reqB.id);
      await waitForStatus(queue, reqA.id, "completed");
      await waitForStatus(queue, reqB.id, "completed");
      await tick();
      // Chain-map hygiene: settled tails are removed.
      expect((queue as unknown as { executionChains: Map<string, unknown> }).executionChains.size).toBe(0);
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repoA, { recursive: true, force: true });
      fs.rmSync(repoB, { recursive: true, force: true });
    }
  });

  it("serializes same-repo merges FIFO across a symlink alias path", async () => {
    const repo = createAuthCheckRepo();
    const alias = path.join(os.tmpdir(), `mandible-ser-alias-${Date.now()}`);
    fs.symlinkSync(fs.realpathSync(repo), alias);
    const db = createMigratedDb();
    const g = gatedExecutor();
    try {
      commitOnBranch(repo, "feature/ser-one", { "one.txt": "1\n" });
      commitOnBranch(repo, "feature/ser-two", { "two.txt": "2\n" });
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({ db, executor: g.executor, hookManager: createNoopHookManager() });
      const req1 = queue.submit({
        type: "merge", command: "mandible auth merge feature/ser-one --into main", title: "1",
        repo: path.basename(repo), base_branch: "main", head_branch: "feature/ser-one", cwd: repo,
      });
      const req2 = queue.submit({
        type: "merge", command: "mandible auth merge feature/ser-two --into main", title: "2",
        repo: path.basename(repo), base_branch: "main", head_branch: "feature/ser-two", cwd: alias,
      });

      queue.approve(req1.id);
      queue.approve(req2.id);
      await waitFor(() => g.started.length === 1);
      await tick();
      // req2 (alias path → same canonical repo) is blocked behind req1.
      expect(g.started).toEqual([req1.id]);

      g.release(req1.id);
      await waitForStatus(queue, req1.id, "completed");
      await waitFor(() => g.started.length === 2);
      expect(g.started).toEqual([req1.id, req2.id]);

      g.release(req2.id);
      await waitForStatus(queue, req2.id, "completed");
      queue.dispose();
    } finally {
      db.close();
      try { fs.unlinkSync(alias); } catch { /* symlink already gone */ }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("serializes requests with unresolvable identity on the shared chain", async () => {
    const db = createMigratedDb();
    const g = gatedExecutor();
    try {
      const queue = new AuthQueue({ db, executor: g.executor, hookManager: createNoopHookManager() });
      const r1 = queue.submit({ command: "echo one", title: "one", execution_mode: "daemon" });
      const r2 = queue.submit({ command: "echo two", title: "two", execution_mode: "daemon" });

      queue.approve(r1.id);
      queue.approve(r2.id);
      await waitFor(() => g.started.length === 1);
      await tick();
      expect(g.started).toEqual([r1.id]);

      g.release(r1.id);
      await waitForStatus(queue, r1.id, "completed");
      await waitFor(() => g.started.length === 2);
      g.release(r2.id);
      await waitForStatus(queue, r2.id, "completed");
      queue.dispose();
    } finally {
      db.close();
    }
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
        git(repo, ["merge", "--no-ff", "integration/dot-batch", "-m", "merge integration"]);
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

        const queue = new AuthQueue({ db, now: () => now });
        const request = queue.submit({
          type: "merge", command: "mandible auth merge integration/dot-batch --into main", title: "Merge dotfiles",
          repo: ".dotfiles", cwd: repo, base_branch: "main", head_branch: "integration/dot-batch",
          merge_head_sha: integrationHead, execution_mode: "remote",
        });
        now = 1000;
        queue.setResult(request.id, 0, "ok");
        await queue.drainFinalizers();
        const state = (db.prepare("SELECT state FROM work_units WHERE id = 'wu-dot'").get() as { state: string }).state;
        queue.dispose();
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

  it("auto-dismisses a duplicate sibling recorded under an aliased repo string", async () => {
    let now = 0;
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/dup", { "dup.txt": "d\n" });
      const dupHead = git(repo, ["rev-parse", "feature/dup"]);
      git(repo, ["merge", "--no-ff", "feature/dup", "-m", "merge dup"]);
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

      const queue = new AuthQueue({ db, now: () => now });
      const sibling = queue.submit({
        type: "merge", command: "mandible auth merge feature/dup --into main", title: "dup sibling",
        repo: "dotfiles", cwd: repo, base_branch: "main", head_branch: "feature/dup",
        merge_head_sha: dupHead, execution_mode: "remote",
      });
      const completed = queue.submit({
        type: "merge", command: "mandible auth merge feature/dup --into main", title: "dup completed",
        repo: ".dotfiles", cwd: repo, base_branch: "main", head_branch: "feature/dup",
        merge_head_sha: dupHead, execution_mode: "remote",
      });
      now = 1000;
      queue.setResult(completed.id, 0, "ok");
      await queue.drainFinalizers();
      expect(queue.getRequest(sibling.id)?.status).toBe("dismissed");
      queue.dispose();
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
      queue.dispose();
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
      queue.dispose();
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
