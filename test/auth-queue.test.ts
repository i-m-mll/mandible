import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import type { Db } from "../src/db.js";
import { LedgerStore } from "../src/ledger/store.js";
import type { SseEvent } from "../src/types.js";
import {
  SYSTEM_ACTOR,
  createLedgerIssue as createSharedLedgerIssue,
  createLedgerProject as createSharedLedgerProject,
  createMigratedDb as createSharedMigratedDb,
} from "./helpers/ledger-fixtures.js";
import {
  addAttributionEvidence,
  addCredential,
  addDelegatedSigningLease,
  createUser,
  getOperator,
} from "../src/users/store.js";

function createMigratedDb(): Db {
  return createSharedMigratedDb({
    operator: { slug: "auth-test-operator", display_name: "Auth Test Operator" },
    now: 1,
  });
}

function createLedgerProject(db: Db, root: string) {
  return createSharedLedgerProject(db, root, { mkdir: true, defaultBranch: "main", remoteUrl: "" });
}

function createLedgerIssue(
  db: Db,
  projectId: string,
  shortId: string,
  title = `Issue ${shortId}`,
) {
  return createSharedLedgerIssue(db, {
    project_id: projectId,
    title,
    kind: "feature",
    source: "mandible",
    aliases: [{ alias_kind: "git_bug_short", alias: shortId, source: "mandible", is_primary: true }],
  });
}

function createQueue(options: ConstructorParameters<typeof AuthQueue>[0] = {}) {
  const db = createMigratedDb();
  return new AuthQueue({ db, ...options });
}

function registerTestDelegatedLease(
  db: InstanceType<typeof Database>,
  id: string,
  now = Date.now(),
): string {
  const operator = getOperator(db)!;
  const credential = addCredential(db, operator.id, {
    type: "delegated_ssh_key",
    fingerprint: `SHA256:${"A".repeat(43)}`,
    public_material: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(20)} auth-test`,
  }, now - 1000);
  addDelegatedSigningLease(db, {
    id,
    credential_id: credential.id,
    owner_user_id: operator.id,
    minted_at: now - 1000,
    expires_at: now + 60_000,
    mint_method: "fresh_presence",
  });
  return operator.id;
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

function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...extraEnv };
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env,
  }).trim();
}

function writeFile(repo: string, relativePath: string, content: string): void {
  const fullPath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function executionEvidenceChain(
  db: InstanceType<typeof Database>,
  executionEvidenceId: string,
): {
  signature: { evidence_method: string; credential_id: string | null; details_json: string };
  authorization: { evidence_method: string; lease_id: string | null; details_json: string };
} {
  const signature = db.prepare(
    "SELECT evidence_method, credential_id, details_json FROM attribution_evidence WHERE id = ?",
  ).get(executionEvidenceId) as {
    evidence_method: string;
    credential_id: string | null;
    details_json: string;
  };
  const authorizationId = JSON.parse(signature.details_json).authorization_evidence_id as string;
  const authorization = db.prepare(
    "SELECT evidence_method, lease_id, details_json FROM attribution_evidence WHERE id = ?",
  ).get(authorizationId) as {
    evidence_method: string;
    lease_id: string | null;
    details_json: string;
  };
  return { signature, authorization };
}

function configureSigningCredential(
  db: InstanceType<typeof Database>,
  repo: string,
  type: "ssh_key" | "delegated_ssh_key",
): { credentialId: string; keyPath: string; operatorId: string } {
  const keyPath = path.join(repo, ".mandible-test-signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const publicMaterial = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`, "-E", "sha256"], {
    encoding: "utf8",
  }).trim().split(/\s+/)[1]!;
  const operator = getOperator(db)!;
  const credential = addCredential(db, operator.id, {
    type,
    fingerprint,
    public_material: publicMaterial,
  });
  git(repo, ["config", "gpg.format", "ssh"]);
  git(repo, ["config", "user.signingkey", keyPath]);
  return { credentialId: credential.id, keyPath, operatorId: operator.id };
}

// Issue 08a5f04 (review F1) — helpers that advance main through a *genuine*
// authorized queue merge: a signed merge commit recorded by a successfully
// completed auth request (MANDIBLE_MERGE_RESULT marker + reviewed
// merge_head_sha), which is exactly what base-transition provenance
// verification demands. Requires configureSigningCredential on the repo first.
function insertSiblingMergeRequest(
  db: InstanceType<typeof Database>,
  repo: string,
  requestId: string,
  sourceBranch: string,
  status: "executing" | "completed" = "executing",
): void {
  const now = 100;
  // Review F1 — recorded queue merges qualify as provenance only when their
  // signature verifies against the approving user's credentials, so the
  // fixture rows carry the operator (whose key configureSigningCredential
  // registered and configured for signing) as approver.
  const approverUserId = getOperator(db)?.id ?? null;
  db.prepare(
    `INSERT INTO auth_requests (
      id, session_id, type, command, title, cwd, repo, base_branch, head_branch,
      merge_head_sha, status, created_at, updated_at, expires_at, output, execution_mode,
      files_changed, additions, deletions, approval_source, approved_by_user_id
    ) VALUES (?, NULL, 'merge', ?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, '', 'daemon', 0, 0, 0, 'manual', ?)`
  ).run(
    requestId,
    `mandible auth merge ${sourceBranch} --into main`,
    `Merge ${sourceBranch}`,
    repo,
    path.basename(repo),
    sourceBranch,
    git(repo, ["rev-parse", sourceBranch]),
    status,
    now,
    now,
    now + 100_000,
    approverUserId,
  );
}

function signedMergeIntoMain(repo: string, sourceBranch: string): string {
  git(repo, ["checkout", "main"]);
  git(repo, ["merge", "--no-ff", "--no-edit", "-S", sourceBranch]);
  return git(repo, ["rev-parse", "main"]);
}

function mergeResultOutput(mergeSha: string): string {
  return `MANDIBLE_MERGE_RESULT {"merge_sha":"${mergeSha}"}\n`;
}

// Authorized base advance recorded directly as a finalized completed request
// (no live finalizer involvement) — for approve-time recompute tests.
function advanceMainViaAuthorizedMerge(
  db: InstanceType<typeof Database>,
  repo: string,
  sourceBranch: string,
  requestId: string,
): string {
  insertSiblingMergeRequest(db, repo, requestId, sourceBranch, "completed");
  const mergeSha = signedMergeIntoMain(repo, sourceBranch);
  const now = 100;
  db.prepare(
    "UPDATE auth_requests SET exit_code = 0, resolved_at = ?, merge_finalized_at = ?, output = ? WHERE id = ?",
  ).run(now, now, mergeResultOutput(mergeSha), requestId);
  return mergeSha;
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
        auto_close_issues: [],
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
      expect(recovered.output).toContain('"auto_close_issues":["abc1234"]');
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

  it("appends output chunks only while the request is executing", () => {
    const db = createMigratedDb();
    const queue = new AuthQueue({ db });

    const request = queue.submit({ command: "echo output", title: "Output" });
    // Issue 08a5f04 (review F1) — output is execution evidence: appends to a
    // request that is not executing are refused so a marker can never be
    // laundered into a pending or resolved row.
    expect(() => queue.appendOutput(request.id, "early")).toThrow(AuthQueueError);

    db.prepare("UPDATE auth_requests SET status = 'executing' WHERE id = ?").run(request.id);
    queue.appendOutput(request.id, "hello");
    queue.appendOutput(request.id, " world");

    const fetched = queue.getRequest(request.id);
    expect(fetched?.output).toBe("hello world");

    db.prepare("UPDATE auth_requests SET status = 'completed' WHERE id = ?").run(request.id);
    expect(() => queue.appendOutput(request.id, "late")).toThrow(AuthQueueError);
    expect(queue.getRequest(request.id)?.output).toBe("hello world");
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
      command: "mandible auth merge feature/partial --into main",
      title: "Partial execution",
      base_branch: "main",
      head_branch: "feature/partial",
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

  it("leaves copied auth state unchanged when background maintenance is disabled", () => {
    const db = createMigratedDb();
    const initial = new AuthQueue({ db, now: () => 0 });
    const request = initial.submit({
      command: "mandible auth merge feature/preview",
      title: "Copied preview request",
      execution_mode: "remote",
    });
    db.prepare(
      "UPDATE auth_requests SET status = 'executing', updated_at = 0 WHERE id = ?",
    ).run(request.id);
    initial.dispose();

    const preview = new AuthQueue({
      db,
      now: () => 6 * 60 * 1_000,
      backgroundMaintenance: false,
    });
    try {
      expect(preview.getRequest(request.id)?.status).toBe("executing");
    } finally {
      preview.dispose();
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
      queue.approve(request.id);
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
      queue.approve(request.id);
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
      queue.approve(request.id);
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
      queue.approve(request.id);
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
      queue.approve(request.id);
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
      queue.approve(request.id);
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
        queue.approve(request.id);
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

      queue.approve(request.id);
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

      queue.approve(request.id);
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
      queue.approve(request.id);
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

      queue.approve(request.id);
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
      queue.approve(request.id);
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

      queue.approve(request.id);
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

      queue.approve(request.id);
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
    queue.approve(completed.id);
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
      const resolved = await waitForStatus(queue, request.id, "completed");
      expect(calls).toEqual([fs.realpathSync(repo)]);
      const operator = getOperator(db)!;
      expect(resolved).toMatchObject({
        requested_by_user_id: operator.id,
        approved_by_user_id: operator.id,
      });
      const evidence = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(evidence.signature.evidence_method).toBe("credential_signature");
      expect(JSON.parse(evidence.signature.details_json)).toMatchObject({
        verified: false,
        authorization_evidence_method: "hardware_presence",
      });
      expect(evidence.authorization.evidence_method).toBe("hardware_presence");
      expect(evidence.authorization.lease_id).toBeNull();
      expect(JSON.parse(evidence.authorization.details_json)).toMatchObject({
        authorizer_user_id: operator.id,
      });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(featureWorktree, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("composes interactive approval with verified credential-signature evidence", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    try {
      commitOnBranch(repo, "feature/signed-interactive", { "signed.txt": "signed\n" });
      registerWorkRepo(db, repo);
      const signing = configureSigningCredential(db, repo, "ssh_key");
      const queue = new AuthQueue({
        db,
        broadcast: (event) => events.push(event),
        executor: async (options) => {
          git(options.cwd!, ["merge", "--no-ff", "--no-edit", "-S", "feature/signed-interactive"]);
          const mergeSha = git(options.cwd!, ["rev-parse", "HEAD"]);
          const output = `MANDIBLE_MERGE_RESULT {"merge_sha":"${mergeSha}"}\n`;
          options.onOutput?.({
            request_id: options.request_id,
            stream: "stderr",
            text: output,
            timestamp: Date.now(),
          });
          return {
            exit_code: 0,
            signal: null,
            stdout: "",
            stderr: output,
            output,
            started_at: Date.now(),
            finished_at: Date.now(),
          };
        },
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/signed-interactive --into main",
        title: "Merge signed interactive",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/signed-interactive",
        cwd: repo,
      });
      queue.approve(request.id);
      const resolved = await waitForStatus(queue, request.id, "completed");
      const chain = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(chain.signature).toMatchObject({
        evidence_method: "credential_signature",
        credential_id: signing.credentialId,
      });
      const signatureDetails = JSON.parse(chain.signature.details_json);
      expect(signatureDetails).toMatchObject({
        verified: true,
        signer_user_id: signing.operatorId,
        authorization_evidence_method: "hardware_presence",
      });
      expect(signatureDetails.commit_sha).toBe(git(repo, ["rev-parse", "main"]));
      expect(signatureDetails.target_head_sha).toBe(signatureDetails.commit_sha);
      expect(chain.authorization.evidence_method).toBe("hardware_presence");
      expect(queue.getSignatureVerification(request.id)).toMatchObject({
        verified: true,
        credential_id: signing.credentialId,
        user_id: signing.operatorId,
      });
      const resolvedEvent = events.findLast((event) => event.event === "auth:resolved");
      expect(resolvedEvent?.data).toMatchObject({
        execution_evidence_id: resolved!.execution_evidence_id,
        signature_verification: {
          verified: true,
          credential_id: signing.credentialId,
          user_id: signing.operatorId,
        },
      });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("composes delegated lease authorization with verified delegated-key evidence", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const now = Date.now();
    try {
      commitOnBranch(repo, "feature/signed-delegated", { "delegated.txt": "delegated\n" });
      registerWorkRepo(db, repo);
      const signing = configureSigningCredential(db, repo, "delegated_ssh_key");
      addDelegatedSigningLease(db, {
        id: "verified-delegated-lease",
        credential_id: signing.credentialId,
        owner_user_id: signing.operatorId,
        minted_at: now - 1000,
        expires_at: now + 60_000,
        mint_method: "reused_lease",
      });
      const queue = new AuthQueue({
        db,
        autoApprover: {
          getActiveApprovalContext: () => ({
            source: "auto_lease",
            leaseId: "verified-delegated-lease",
            approverUserId: signing.operatorId,
            env: { SSH_AUTH_SOCK: "/tmp/test-delegated.sock" },
          }),
        },
        executor: async (options) => {
          git(options.cwd!, ["merge", "--no-ff", "--no-edit", "-S", "feature/signed-delegated"]);
          const mergeSha = git(options.cwd!, ["rev-parse", "HEAD"]);
          const output = `MANDIBLE_MERGE_RESULT {"merge_sha":"${mergeSha}"}\n`;
          options.onOutput?.({
            request_id: options.request_id,
            stream: "stderr",
            text: output,
            timestamp: now,
          });
          return {
            exit_code: 0,
            signal: null,
            stdout: "",
            stderr: output,
            output,
            started_at: now,
            finished_at: now,
          };
        },
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/signed-delegated --into main",
        title: "Merge signed delegated",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/signed-delegated",
        cwd: repo,
      });
      const resolved = await waitForStatus(queue, request.id, "completed");
      const chain = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(JSON.parse(chain.signature.details_json)).toMatchObject({
        verified: true,
        signer_user_id: signing.operatorId,
        authorization_evidence_method: "delegated_lease",
      });
      expect(chain.authorization).toMatchObject({
        evidence_method: "delegated_lease",
        lease_id: "verified-delegated-lease",
      });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps legacy nullable-cache requests on preflight reuse", async () => {
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
      expect(request.merge_candidate_pin_sha).toBeNull();

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

  it("re-establishes the exact original range after a reviewed-head update for a native-hook merge", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const rangeSnapshot = path.join(repo, "hook-range.txt");
    try {
      commitOnBranch(repo, "feature/reviewed-update", { "feature.txt": "first\n" });
      registerWorkRepo(db, repo);

      // An executable native hook keeps this request on the ordinary
      // non-atomic merge path, matching the production lifecycle that exposed
      // the missing original-range base.
      const gitDir = git(repo, ["rev-parse", "--git-dir"]);
      const nativeHook = path.join(repo, gitDir, "hooks", "post-merge");
      writeFile(repo, path.relative(repo, nativeHook), "#!/bin/sh\nexit 0\n");
      fs.chmodSync(nativeHook, 0o755);

      const hookManager = new AuthHookManager(db);
      hookManager.create({
        repo_pattern: path.basename(repo),
        auth_type: "merge",
        command:
          `test -n "$MANDIBLE_AUTH_MERGE_BASE_SHA" && ` +
          `test -n "$MANDIBLE_AUTH_MERGE_HEAD_SHA" && ` +
          `printf '%s\\n%s\\n' "$MANDIBLE_AUTH_MERGE_BASE_SHA" ` +
          `"$MANDIBLE_AUTH_MERGE_HEAD_SHA" > "${rangeSnapshot}"`,
        label: "Required original range",
        required: true,
      });
      const queue = new AuthQueue({
        db,
        executor: async () => ({
          exit_code: 0,
          signal: null,
          stdout: "ok\n",
          stderr: "",
          output: "ok\n",
          started_at: Date.now(),
          finished_at: Date.now(),
        }),
        hookManager,
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/reviewed-update --into main",
        title: "Merge feature/reviewed-update",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/reviewed-update",
        merge_head_sha: git(repo, ["rev-parse", "feature/reviewed-update"]),
        cwd: repo,
      });
      const exactBase = git(repo, ["rev-parse", "main"]);

      git(repo, ["checkout", "feature/reviewed-update"]);
      writeFile(repo, "feature.txt", "reviewed final\n");
      git(repo, ["add", "feature.txt"]);
      git(repo, ["commit", "-m", "refresh reviewed head"]);
      const reviewedHead = git(repo, ["rev-parse", "HEAD"]);
      git(repo, ["checkout", "main"]);

      // This is the production update path. It must keep invalidating every
      // stale candidate field; approval is responsible for establishing a
      // fresh, clean exact range for the updated identity.
      const updated = queue.update(request.id, { merge_head_sha: reviewedHead });
      expect(updated.merge_preflight_base_sha).toBeNull();
      expect(updated.merge_candidate_pin_sha).toBeNull();

      const approved = queue.approve(request.id);
      expect(approved.merge_atomic_enabled).toBe(false);
      await waitForStatus(queue, request.id, "completed");

      expect(fs.readFileSync(rangeSnapshot, "utf8")).toBe(`${exactBase}\n${reviewedHead}\n`);
      expect(queue.getRequest(request.id)).toMatchObject({
        merge_preflight_base_sha: exactBase,
        merge_head_sha: reviewedHead,
      });
      expect(hookManager.convergence(request.id).state).toBe("complete");
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  // Issue 08a5f04 — pure base drift no longer blocks approval when the base
  // transition is fully accounted for by an authorized queue merge: the stale
  // candidate is recomputed against the current base within the same approval
  // action, re-pinned, and atomic mode is re-evaluated with the fresh pin.
  it("recomputes a stale pinned candidate on approve after an authorized sibling merge", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      commitOnBranch(repo, "feature/base-drift", { "feature.txt": "feature\n" });
      commitOnBranch(repo, "feature/sibling", { "sibling.txt": "sibling\n" });
      registerWorkRepo(db, repo);
      git(repo, ["config", "core.hooksPath", ".git/hooks"]);
      configureSigningCredential(db, repo, "ssh_key");

      const queue = new AuthQueue({
        db,
        executor: async (options) => {
          calls.push(options.env);
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

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/base-drift --into main",
        title: "Merge feature/base-drift",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/base-drift",
        merge_head_sha: git(repo, ["rev-parse", "feature/base-drift"]),
        cwd: repo,
      });
      const originalPin = request.merge_candidate_pin_sha;
      const originalBase = request.merge_preflight_base_sha;
      expect(originalPin).toMatch(/^[0-9a-f]{40,64}$/);
      // Genuine authorized queue merge: signed merge commit + completed
      // request recording it (review F1 — raw SHA movement is refused now).
      const newBase = advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-sibling");
      expect(newBase).not.toBe(originalBase);

      const approved = queue.approve(request.id);
      expect(approved.status).toBe("executing");
      await waitForStatus(queue, request.id, "completed");

      expect(calls).toHaveLength(1);
      const env = calls[0]!;
      // Fresh preflight reuse against the recomputed base.
      expect(env.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT).toBe("1");
      expect(env.MANDIBLE_AUTH_PREFLIGHT_BASE_SHA).toBe(newBase);
      // Fresh candidate pin: base parent moved, pin sha replaced.
      expect(env.MANDIBLE_AUTH_CANDIDATE_BASE_SHA).toBe(newBase);
      expect(env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA).toMatch(/^[0-9a-f]{40,64}$/);
      expect(env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA).not.toBe(originalPin);
      expect(git(repo, ["rev-parse", `${env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA}^1`])).toBe(newBase);
      expect(git(repo, ["rev-parse", `${env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA}^2`]))
        .toBe(request.merge_head_sha);
      // Review F3 — the reviewed head accompanies every daemon-started merge.
      expect(env.MANDIBLE_AUTH_EXPECTED_HEAD_SHA).toBe(request.merge_head_sha);
      // Atomic mode re-evaluated with the fresh pin.
      expect(env.MANDIBLE_AUTH_ATOMIC).toBe("1");
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails approval with conflict context when the recomputed candidate conflicts", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: string[] = [];
    try {
      commitOnBranch(repo, "feature/base-conflict", { "shared.txt": "feature\n" });
      commitOnBranch(repo, "feature/conflicting-sibling", { "shared.txt": "conflicting main change\n" });
      registerWorkRepo(db, repo);
      configureSigningCredential(db, repo, "ssh_key");

      const queue = new AuthQueue({
        db,
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
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/base-conflict --into main",
        title: "Merge feature/base-conflict",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/base-conflict",
        merge_head_sha: git(repo, ["rev-parse", "feature/base-conflict"]),
        cwd: repo,
      });
      expect(request.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      // Authorized queue merge whose content conflicts with the reviewed head:
      // provenance passes, the recomputed candidate does not merge cleanly.
      advanceMainViaAuthorizedMerge(db, repo, "feature/conflicting-sibling", "merge-conflicting");

      let thrown: unknown;
      try {
        queue.approve(request.id);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AuthQueueError);
      const authError = thrown as AuthQueueError;
      expect(authError.code).toBe("merge_check_failed");
      expect(authError.message).toContain("conflicts with the target branch");
      expect(authError.message).toContain("shared.txt");
      expect(authError.details).toBeDefined();
      expect(queue.getRequest(request.id)?.status).toBe("pending");
      expect(calls).toHaveLength(0);
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("still blocks approval when the head branch moved from the reviewed commit", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: string[] = [];
    try {
      commitOnBranch(repo, "feature/head-drift", { "feature.txt": "feature\n" });
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({
        db,
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
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/head-drift --into main",
        title: "Merge feature/head-drift",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/head-drift",
        merge_head_sha: git(repo, ["rev-parse", "feature/head-drift"]),
        cwd: repo,
      });
      expect(request.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      // Head drift: the reviewed content itself changed.
      git(repo, ["checkout", "feature/head-drift"]);
      writeFile(repo, "feature.txt", "revised feature\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "revise head"]);
      git(repo, ["checkout", "main"]);
      // Base drift on top of head drift must not unlock recompute either.
      writeFile(repo, "main-only.txt", "main\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "move main"]);

      expect(() => queue.approve(request.id)).toThrow(/moved from reviewed commit/);
      expect(queue.getRequest(request.id)?.status).toBe("pending");
      expect(calls).toHaveLength(0);
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("enables atomic execution only for fresh single-source requests without native hooks", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      commitOnBranch(repo, "feature/atomic-eligibility", { "atomic.txt": "atomic\n" });
      registerWorkRepo(db, repo);
      git(repo, ["config", "core.hooksPath", ".git/hooks"]);
      configureSigningCredential(db, repo, "ssh_key");
      const queue = new AuthQueue({
        db,
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
      const submit = (suffix: string, extra = "") => queue.submit({
        type: "merge",
        command: `mandible auth merge feature/atomic-eligibility --into main${extra}`,
        title: `Atomic eligibility ${suffix}`,
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/atomic-eligibility",
        merge_head_sha: git(repo, ["rev-parse", "feature/atomic-eligibility"]),
        cwd: repo,
      });

      const ordinary = submit("ordinary");
      queue.approve(ordinary.id);
      await waitForStatus(queue, ordinary.id, "completed");
      expect(envs.at(-1)?.MANDIBLE_AUTH_ATOMIC).toBe("1");
      expect(queue.getRequest(ordinary.id)?.merge_candidate_pin_sha).toBeNull();

      const hook = path.join(repo, ".git", "hooks", "pre-merge-commit");
      fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const hooked = submit("hooked");
      queue.approve(hooked.id);
      await waitForStatus(queue, hooked.id, "completed");
      expect(envs.at(-1)?.MANDIBLE_AUTH_ATOMIC).toBeUndefined();
      fs.rmSync(hook);

      // Issue 060c9c8 — hierarchical merge support is removed; a
      // hierarchical-shaped command is refused by canonical-command
      // verification at approval and the request stays pending.
      const hierarchical = submit("hierarchical", " --hierarchical");
      expect(() => queue.approve(hierarchical.id))
        .toThrow(/Hierarchical merge commands cannot be verified/);
      expect(queue.getRequest(hierarchical.id)?.status).toBe("pending");

      const dismissed = submit("dismissed");
      const dismissedPin = dismissed.merge_candidate_pin_sha!;
      queue.dismiss(dismissed.id);
      expect(queue.getRequest(dismissed.id)?.merge_candidate_pin_sha).toBeNull();
      expect(() => git(repo, ["cat-file", "-e", `${dismissedPin}^{commit}`])).not.toThrow();
      expect(() => git(repo, ["rev-parse", `refs/mandible/auth-candidates/${dismissed.id}`])).toThrow();
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
    const db = createMigratedDb();
    const approverUserId = registerTestDelegatedLease(db, "lease-1");
    const queue = new AuthQueue({
      db,
      autoApprover: {
        getActiveApprovalContext: () => ({
          source: "auto_lease",
          leaseId: "lease-1",
          approverUserId,
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
    queue.dispose();
    db.close();
  });

  it("auto-approves pending requests when a lease is enabled", () => {
    const db = createMigratedDb();
    const approverUserId = registerTestDelegatedLease(db, "lease-2");
    const queue = new AuthQueue({
      db,
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
      approverUserId,
      env: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
    });

    expect(approved.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(queue.getRequest(first.id)?.approval_source).toBe("auto_lease");
    expect(queue.getRequest(second.id)?.approval_lease_id).toBe("lease-2");
    queue.dispose();
    db.close();
  });

  it("records delegated_lease execution evidence when an active lease is reused", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const approverUserId = registerTestDelegatedLease(db, "lease-reuse");
    try {
      commitOnBranch(repo, "feature/lease-reuse", { "reuse.txt": "reuse\n" });
      registerWorkRepo(db, repo);
      const queue = new AuthQueue({
        db,
        autoApprover: {
          getActiveApprovalContext: () => ({
            source: "auto_lease",
            leaseId: "lease-reuse",
            approverUserId,
            env: {
              SSH_AUTH_SOCK: "/tmp/reused.sock",
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "user.signingkey",
              GIT_CONFIG_VALUE_0: "/tmp/delegated.pub",
            },
          }),
        },
        executor: async (options) => {
          expect(queue.getRequest(options.request_id)?.execution_evidence_id).toBeNull();
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

      const submitted = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/lease-reuse --into main",
        title: "Merge feature/lease-reuse",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/lease-reuse",
        cwd: repo,
      });
      expect(submitted.status).toBe("executing");
      const resolved = await waitForStatus(queue, submitted.id, "completed");
      const evidence = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(evidence.signature.evidence_method).toBe("credential_signature");
      expect(JSON.parse(evidence.signature.details_json)).toMatchObject({
        verified: false,
        authorization_evidence_method: "delegated_lease",
      });
      expect(evidence.authorization).toMatchObject({
        evidence_method: "delegated_lease",
        lease_id: "lease-reuse",
      });
      expect(JSON.parse(evidence.authorization.details_json)).toMatchObject({
        authorizer_user_id: approverUserId,
      });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps manual approval on the direct path when delegated signing is configured", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const approverUserId = registerTestDelegatedLease(db, "presence-1");
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
            throw new Error("manual approval must not request delegated presence");
          },
        },
        executor: async (options) => {
          order.push("executor");
          expect(queue.getRequest(options.request_id)?.execution_evidence_id).toBeNull();
          expect(options.env?.SSH_AUTH_SOCK).toBeUndefined();
          expect(options.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
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

      expect(order).toEqual(["executor"]);
      expect(resolved?.approval_source).toBe("manual");
      expect(resolved?.approval_lease_id).toBeNull();
      const evidence = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(evidence.signature.evidence_method).toBe("credential_signature");
      expect(JSON.parse(evidence.signature.details_json)).toMatchObject({
        verified: false,
        authorization_evidence_method: "hardware_presence",
      });
      expect(evidence.authorization).toMatchObject({
        evidence_method: "hardware_presence",
        lease_id: null,
      });
      expect(JSON.parse(evidence.authorization.details_json)).toMatchObject({
        authorizer_user_id: approverUserId,
      });
      const output = events
        .filter((event) => event.event === "auth:output")
        .map((event) => ((event.data as { text?: string }).text ?? ""))
        .join("");
      expect(output).not.toContain("waiting for YubiKey touch");
      expect(output).not.toContain("delegated signing key ready");
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", "presence-missing", /lease is missing/],
    ["expired", "presence-expired", /not currently valid/],
  ] as const)(
    "rejects a %s explicit delegated lease with SSH_AUTH_SOCK before execution",
    (kind, leaseId, expectedError) => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const now = Date.now();
      const operatorId = registerTestDelegatedLease(db, "presence-valid", now);
      if (kind === "expired") {
        db.prepare(
          "UPDATE delegated_signing_leases SET id = ?, expires_at = ? WHERE id = 'presence-valid'",
        ).run(leaseId, now - 1);
      }
      let executed = false;
      try {
        commitOnBranch(repo, `feature/${kind}-lease`, { [`${kind}.txt`]: `${kind}\n` });
        registerWorkRepo(db, repo);
        const queue = new AuthQueue({
          db,
          now: () => now,
          executor: async () => {
            executed = true;
            throw new Error("executor must not run");
          },
          hookManager: createNoopHookManager(),
        });
        const request = queue.submit({
          type: "merge",
          command: `mandible auth merge feature/${kind}-lease --into main`,
          title: `${kind} delegated lease`,
          repo: path.basename(repo),
          base_branch: "main",
          head_branch: `feature/${kind}-lease`,
          cwd: repo,
        });

        expect(() => queue.approve(request.id, {
          source: "auto_lease",
          leaseId,
          approverUserId: operatorId,
          env: { SSH_AUTH_SOCK: `/tmp/${kind}.sock` },
        })).toThrow(expectedError);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(executed).toBe(false);
        queue.dispose();
      } finally {
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.each(["approver", "lease"] as const)(
    "rejects a refreshed delegated signing %s that differs from the approved request",
    async (mismatch) => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const operatorId = registerTestDelegatedLease(db, "presence-valid");
      const other = createUser(db, {
        slug: `presence-other-${mismatch}`,
        kind: "human",
        display_name: "Other Presence User",
      });
      const otherCredential = addCredential(db, other.id, {
        type: "delegated_ssh_key",
        fingerprint: `SHA256:${"B".repeat(43)}`,
        public_material: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"B".repeat(20)} other`,
      });
      addDelegatedSigningLease(db, {
        id: "presence-other-lease",
        credential_id: otherCredential.id,
        owner_user_id: other.id,
        minted_at: Date.now() - 1000,
        expires_at: Date.now() + 60_000,
        mint_method: "fresh_presence",
      });
      let executed = false;
      try {
        commitOnBranch(repo, `feature/presence-${mismatch}`, { [`${mismatch}.txt`]: `${mismatch}\n` });
        registerWorkRepo(db, repo);
        const queue = new AuthQueue({
          db,
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
            presenceChallenge: async () => ({
              source: "presence_challenge",
              leaseId: mismatch === "lease" ? "presence-other-lease" : "presence-valid",
              approverUserId: mismatch === "approver" ? other.id : operatorId,
              env: { SSH_AUTH_SOCK: "/tmp/wrong-presence.sock" },
            }),
          },
          executor: async () => {
            executed = true;
            throw new Error("executor must not run");
          },
          hookManager: createNoopHookManager(),
        });
        const request = queue.submit({
          type: "merge",
          command: `mandible auth merge feature/presence-${mismatch} --into main`,
          title: `Presence ${mismatch} mismatch`,
          repo: path.basename(repo),
          base_branch: "main",
          head_branch: `feature/presence-${mismatch}`,
          cwd: repo,
        });
        queue.approve(request.id, {
          source: "presence_challenge",
          leaseId: "presence-valid",
          approverUserId: operatorId,
          env: {},
        });
        const failed = await waitForStatus(queue, request.id, "completed");
        expect(executed).toBe(false);
        expect(failed.error).toMatch(mismatch === "approver" ? /approver does not match/ : /lease is not valid/);
        queue.dispose();
      } finally {
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

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

  // Issue 08a5f04 — after a sibling merge advances the base, clean pending
  // candidates are proactively re-preflighted, re-pinned, and broadcast so
  // approval hits the exact-candidate fast path.
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

  // Issue 08a5f04 (review F5/F6) — fail-closed guards around candidate
  // recompute: pin corruption, unaccounted or rewritten base transitions,
  // command mutation, pin-cache failure, remote requests, and races between
  // provenance verification and re-pinning.
  describe("candidate recompute fail-closed guards", () => {
    const STRICT_MESSAGE = /Reviewed merge inputs or retained candidate changed; requeue and reapprove/;

    function createGuardQueue(db: Db, calls: Array<NodeJS.ProcessEnv | undefined>): AuthQueue {
      return new AuthQueue({
        db,
        executor: async (options) => {
          calls.push(options.env);
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
    }

    function submitPinnedRequest(
      queue: AuthQueue,
      repo: string,
      headBranch: string,
      command = `mandible auth merge ${headBranch} --into main`,
    ) {
      const request = queue.submit({
        type: "merge",
        command,
        title: `Merge ${headBranch}`,
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: headBranch,
        merge_head_sha: git(repo, ["rev-parse", headBranch]),
        cwd: repo,
      });
      expect(request.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      return request;
    }

    // Review F5 — a corrupted or deleted retained candidate at an UNMOVED base
    // is tamper evidence: approval refuses with the original strict message.
    it("refuses approval when the retained candidate is corrupted at a stable base", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/ref-corrupt", { "rc.txt": "rc\n" });
        commitOnBranch(repo, "feature/pin-corrupt", { "pc.txt": "pc\n" });
        registerWorkRepo(db, repo);

        // Deleted candidate ref.
        const refCorrupt = submitPinnedRequest(queue, repo, "feature/ref-corrupt");
        git(repo, ["update-ref", "-d", `refs/mandible/auth-candidates/${refCorrupt.id}`]);
        expect(() => queue.approve(refCorrupt.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(refCorrupt.id)?.status).toBe("pending");

        // Re-pointed pin (recorded pin no longer the reviewed candidate).
        const pinCorrupt = submitPinnedRequest(queue, repo, "feature/pin-corrupt");
        db.prepare("UPDATE auth_requests SET merge_candidate_pin_sha = ? WHERE id = ?")
          .run(git(repo, ["rev-parse", "main"]), pinCorrupt.id);
        expect(() => queue.approve(pinCorrupt.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(pinCorrupt.id)?.status).toBe("pending");

        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F6 — a base rewritten to a non-descendant is never treated as
    // sibling drift.
    it("refuses recompute when the base was rewritten to a non-descendant", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/rewrite", { "rw.txt": "rw\n" });
        registerWorkRepo(db, repo);
        const request = submitPinnedRequest(queue, repo, "feature/rewrite");

        git(repo, ["commit", "--amend", "-m", "rewritten history"]);
        expect(git(repo, ["rev-parse", "main"])).not.toBe(request.merge_preflight_base_sha);

        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F6 — a descendant base advance that is not accounted for by a
    // recorded, signature-verified queue merge is refused: raw commits and
    // even signed merges without a completed queue record.
    it("refuses recompute when the base advanced without a recorded authorized merge", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/unaccounted-a", { "ua.txt": "ua\n" });
        commitOnBranch(repo, "feature/unaccounted-b", { "ub.txt": "ub\n" });
        commitOnBranch(repo, "feature/rogue", { "rogue.txt": "rogue\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        // Plain descendant commit on the protected base.
        const first = submitPinnedRequest(queue, repo, "feature/unaccounted-a");
        writeFile(repo, "raw.txt", "raw\n");
        git(repo, ["add", "."]);
        git(repo, ["commit", "-m", "raw direct commit"]);
        expect(() => queue.approve(first.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(first.id)?.status).toBe("pending");

        // Signed merge with no completed queue record backing it.
        const second = submitPinnedRequest(queue, repo, "feature/unaccounted-b");
        signedMergeIntoMain(repo, "feature/rogue");
        expect(() => queue.approve(second.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(second.id)?.status).toBe("pending");

        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F2 — a PUT that mutates `command` drops the retained candidate,
    // and a hierarchical-shaped command is refused at approval (issue 060c9c8
    // removed hierarchical merge support) even across an authorized base
    // advance.
    it("invalidates the pin on command mutation and refuses hierarchical-shaped approval", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/mutated", { "mu.txt": "mu\n" });
        commitOnBranch(repo, "feature/hier", { "hi.txt": "hi\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        // PUT command mutation invalidates the retained candidate.
        const mutated = submitPinnedRequest(queue, repo, "feature/mutated");
        const updated = queue.update(mutated.id, {
          command: "mandible auth merge --hierarchical feature/mutated feature/evil --into main",
        });
        expect(updated.merge_candidate_pin_sha).toBeNull();
        expect(updated.merge_candidate_tree_sha).toBeNull();
        expect(updated.merge_preflight_base_sha).toBeNull();
        expect(() => git(repo, ["rev-parse", `refs/mandible/auth-candidates/${mutated.id}`])).toThrow();

        // Hierarchical-shaped command: refused outright by canonical-command
        // verification, before recompute or execution.
        const hier = submitPinnedRequest(
          queue,
          repo,
          "feature/hier",
          "mandible auth merge --hierarchical feature/hier feature/evil --into main",
        );
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-hier-sibling");
        expect(() => queue.approve(hier.id)).toThrow(/Hierarchical merge commands cannot be verified/);
        expect(queue.getRequest(hier.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F4 — when the fresh pin cannot be obtained during recompute, the
    // approval fails closed with the strict error and the previous pin state
    // is left fully intact (never proceeds unpinned with skip-preflight).
    it("fails closed when a previously-pinned request cannot obtain a fresh pin", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/pin-fail", { "pf.txt": "pf\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/pin-fail");
        const originalPin = request.merge_candidate_pin_sha!;
        const originalBase = request.merge_preflight_base_sha!;
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-pin-fail-sibling");

        vi.spyOn(
          queue as unknown as { createMergeCandidatePin: (request: unknown) => string },
          "createMergeCandidatePin",
        ).mockImplementation(() => {
          throw new Error("injected pin cache failure");
        });

        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        const after = queue.getRequest(request.id);
        expect(after?.status).toBe("pending");
        // Prior strictly-blocking state fully intact.
        expect(after?.merge_candidate_pin_sha).toBe(originalPin);
        expect(after?.merge_preflight_base_sha).toBe(originalBase);
        expect(git(repo, ["rev-parse", `refs/mandible/auth-candidates/${request.id}`])).toBe(originalPin);
        expect(calls).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F6 — remote requests never auto-recompute: a stale pin stays
    // strictly blocked even when the base advance is fully authorized.
    it("keeps remote requests strictly blocked on base drift", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/remote", { "rm.txt": "rm\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/remote");
        db.prepare("UPDATE auth_requests SET execution_mode = 'remote' WHERE id = ?").run(request.id);
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-remote-sibling");

        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F6 — the preflight must run against exactly the base whose
    // transition provenance was verified; a base that moves again in between
    // falls back to the strict error.
    it("refuses recompute when the base moves again between provenance verification and preflight", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/base-race", { "br.txt": "br\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/base-race");
        const originalPin = request.merge_candidate_pin_sha!;
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-race-sibling");

        const realCheck = queue.checkMergeIndependence.bind(queue);
        vi.spyOn(queue, "checkMergeIndependence").mockImplementation((input) => {
          // The base moves again after provenance verification but before the
          // recompute preflight resolves it.
          writeFile(repo, "race.txt", "race\n");
          git(repo, ["add", "."]);
          git(repo, ["commit", "-m", "raced base move"]);
          return realCheck(input);
        });

        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        const after = queue.getRequest(request.id);
        expect(after?.status).toBe("pending");
        expect(after?.merge_candidate_pin_sha).toBe(originalPin);
        expect(calls).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F6/F3 — when the head ref moves during recompute (after the head
    // check, before re-pinning), the fresh pin still binds the *reviewed* head
    // commit and the execution env still carries the reviewed head SHA, so the
    // shell layer merges (or refuses) against the reviewed object — never the
    // moved live ref.
    it("pins the reviewed head even when the head ref moves during recompute", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/head-race", { "hr.txt": "hr\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        git(repo, ["config", "core.hooksPath", ".git/hooks"]);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/head-race");
        const reviewedHead = request.merge_head_sha!;
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-head-race-sibling");

        const realCheck = queue.checkMergeIndependence.bind(queue);
        vi.spyOn(queue, "checkMergeIndependence").mockImplementation((input) => {
          const report = realCheck(input);
          // The head ref moves after recompute verification.
          git(repo, ["checkout", "feature/head-race"]);
          writeFile(repo, "late.txt", "late\n");
          git(repo, ["add", "."]);
          git(repo, ["commit", "-m", "late head move"]);
          git(repo, ["checkout", "main"]);
          return report;
        });

        queue.approve(request.id);
        await waitForStatus(queue, request.id, "completed");
        expect(calls).toHaveLength(1);
        const env = calls[0]!;
        const liveHead = git(repo, ["rev-parse", "feature/head-race"]);
        expect(liveHead).not.toBe(reviewedHead);
        // The pin and the execution env are bound to the reviewed commit.
        expect(env.MANDIBLE_AUTH_CANDIDATE_HEAD_SHA).toBe(reviewedHead);
        expect(env.MANDIBLE_AUTH_EXPECTED_HEAD_SHA).toBe(reviewedHead);
        expect(git(repo, ["rev-parse", `${env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA}^2`])).toBe(reviewedHead);
      } finally {
        vi.restoreAllMocks();
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F1 pass 2) — output-append forgery: an unrecorded
    // base advance cannot be laundered into provenance by appending a forged
    // MANDIBLE_MERGE_RESULT marker to a resolved request.
    it("refuses post-completion output-append forgery as merge provenance", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/forge-target", { "ft.txt": "ft\n" });
        commitOnBranch(repo, "feature/rogue", { "rg.txt": "rg\n" });
        commitOnBranch(repo, "feature/decoy", { "dc.txt": "dc\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/forge-target");
        // Signed but UNRECORDED base advance (no completed queue request).
        const newBase = signedMergeIntoMain(repo, "feature/rogue");
        // A completed request exists for the attacker to target, but its
        // output carries no marker for this merge.
        insertSiblingMergeRequest(db, repo, "forge-decoy", "feature/decoy", "completed");
        db.prepare("UPDATE auth_requests SET exit_code = 0, resolved_at = 100 WHERE id = ?")
          .run("forge-decoy");

        // The append is refused by the lifecycle lock…
        expect(() => queue.appendOutput("forge-decoy", mergeResultOutput(newBase)))
          .toThrow(/only be appended while a request is executing/);
        // …and the transition stays unaccounted, so approval fails strict.
        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F1 pass 2) — structured signature evidence is the
    // authoritative merge-SHA record: a forged output marker on a row that
    // carries evidence is ignored, and evidence without a valid SHA never
    // falls back to the marker.
    it("matches provenance against structured signature evidence, not the output marker", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/ev-a", { "eva.txt": "a\n" });
        commitOnBranch(repo, "feature/ev-b", { "evb.txt": "b\n" });
        commitOnBranch(repo, "feature/ev-sib-1", { "evs1.txt": "s1\n" });
        commitOnBranch(repo, "feature/ev-sib-2", { "evs2.txt": "s2\n" });
        registerWorkRepo(db, repo);
        git(repo, ["config", "core.hooksPath", ".git/hooks"]);
        configureSigningCredential(db, repo, "ssh_key");

        const first = submitPinnedRequest(queue, repo, "feature/ev-a");
        const second = submitPinnedRequest(queue, repo, "feature/ev-b");

        // Authorized advance whose structured evidence records the genuine
        // merge SHA while the output marker is forged to a different SHA.
        const base1 = advanceMainViaAuthorizedMerge(db, repo, "feature/ev-sib-1", "merge-ev-1");
        const genuineEvidence = addAttributionEvidence(db, {
          evidence_method: "credential_signature",
          details: { auth_request_id: "merge-ev-1", commit_sha: base1, verified: true },
        });
        db.prepare("UPDATE auth_requests SET execution_evidence_id = ?, output = ? WHERE id = ?")
          .run(genuineEvidence.id, mergeResultOutput("f".repeat(40)), "merge-ev-1");

        queue.approve(first.id);
        await waitForStatus(queue, first.id, "completed");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.MANDIBLE_AUTH_CANDIDATE_BASE_SHA).toBe(base1);

        // Authorized advance whose structured evidence lacks a valid SHA: the
        // structured record is authoritative, so the genuine output marker on
        // the same row must NOT rescue it.
        advanceMainViaAuthorizedMerge(db, repo, "feature/ev-sib-2", "merge-ev-2");
        const shaLessEvidence = addAttributionEvidence(db, {
          evidence_method: "credential_signature",
          details: { auth_request_id: "merge-ev-2", verified: true },
        });
        db.prepare("UPDATE auth_requests SET execution_evidence_id = ? WHERE id = ?")
          .run(shaLessEvidence.id, "merge-ev-2");

        expect(() => queue.approve(second.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(second.id)?.status).toBe("pending");
        expect(calls).toHaveLength(1);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F1 pass 2) — a merge SHA claimed by two completed
    // requests is reuse/forgery evidence and disqualifies the transition.
    it("refuses provenance when two completed requests claim the same merge commit", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/reuse-target", { "rt.txt": "rt\n" });
        commitOnBranch(repo, "feature/reuse-sib", { "rs.txt": "rs\n" });
        commitOnBranch(repo, "feature/reuse-decoy", { "rd.txt": "rd\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/reuse-target");
        const newBase = advanceMainViaAuthorizedMerge(db, repo, "feature/reuse-sib", "merge-reuse-1");
        // Second completed request claiming the SAME merge SHA in its output.
        insertSiblingMergeRequest(db, repo, "merge-reuse-2", "feature/reuse-decoy", "completed");
        db.prepare(
          "UPDATE auth_requests SET exit_code = 0, resolved_at = 100, merge_finalized_at = 100, output = ? WHERE id = ?",
        ).run(mergeResultOutput(newBase), "merge-reuse-2");

        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F1 pass 2) — octopus merges (3+ parents) are never
    // queue merges; the ^1/^2 probes alone would have accepted them.
    it("refuses provenance for an octopus merge commit on the base transition", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/octo-target", { "ot.txt": "ot\n" });
        commitOnBranch(repo, "feature/octo-1", { "o1.txt": "o1\n" });
        commitOnBranch(repo, "feature/octo-2", { "o2.txt": "o2\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/octo-target");
        // Signed octopus merge: first parent main, then octo-1 AND octo-2.
        insertSiblingMergeRequest(db, repo, "merge-octo", "feature/octo-1", "completed");
        git(repo, ["checkout", "main"]);
        git(repo, ["merge", "--no-ff", "--no-edit", "-S", "feature/octo-1", "feature/octo-2"]);
        const octoSha = git(repo, ["rev-parse", "main"]);
        expect(git(repo, ["show", "-s", "--format=%P", octoSha]).split(/\s+/)).toHaveLength(3);
        db.prepare(
          "UPDATE auth_requests SET exit_code = 0, resolved_at = 100, merge_finalized_at = 100, output = ? WHERE id = ?",
        ).run(mergeResultOutput(octoSha), "merge-octo");

        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F1 pass 2) — the chain-commit signature must
    // verify against the approving user's credentials specifically; another
    // registered user's trusted signature does not qualify.
    it("refuses provenance signed by a registered credential that is not the approver's", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/signer-target", { "st.txt": "st\n" });
        commitOnBranch(repo, "feature/signer-sib", { "ss.txt": "ss\n" });
        registerWorkRepo(db, repo);
        const operatorSigning = configureSigningCredential(db, repo, "ssh_key");

        // Second ACTIVE registered user with their own real signing key.
        const outsider = createUser(db, {
          slug: "provenance-outsider",
          kind: "human",
          display_name: "Provenance Outsider",
        });
        const outsiderKeyPath = path.join(repo, ".outsider-signing-key");
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", outsiderKeyPath]);
        const outsiderFingerprint = execFileSync(
          "ssh-keygen", ["-lf", `${outsiderKeyPath}.pub`, "-E", "sha256"], { encoding: "utf8" },
        ).trim().split(/\s+/)[1]!;
        addCredential(db, outsider.id, {
          type: "ssh_key",
          fingerprint: outsiderFingerprint,
          public_material: fs.readFileSync(`${outsiderKeyPath}.pub`, "utf8").trim(),
        });

        const request = submitPinnedRequest(queue, repo, "feature/signer-target");
        // Sibling merge recorded with the operator as approver but signed by
        // the outsider's (registered, trusted) key.
        git(repo, ["config", "user.signingkey", outsiderKeyPath]);
        advanceMainViaAuthorizedMerge(db, repo, "feature/signer-sib", "merge-outsider-signed");
        git(repo, ["config", "user.signingkey", operatorSigning.keyPath]);

        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F2 pass 2) — a mutated command is refused at
    // approval even though the mutation already cleared the pin (previously
    // the unpinned request would proceed without fresh review).
    it("refuses approval of a mutated command even when the request is unpinned", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/mutant", { "mt.txt": "mt\n" });
        registerWorkRepo(db, repo);

        const request = submitPinnedRequest(queue, repo, "feature/mutant");
        const mutated = queue.update(request.id, {
          command: "echo pwned && git push --force origin main",
        });
        // The mutation cleared the pin — the request is unpinned, not exempt.
        expect(mutated.merge_candidate_pin_sha).toBeNull();
        expect(() => queue.approve(request.id))
          .toThrow(/does not match the canonical form/);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);

        // Merge identity cannot be stripped to dodge enforcement either.
        expect(() => queue.update(request.id, { head_branch: null as unknown as string }))
          .toThrow();
        expect(queue.getRequest(request.id)?.head_branch).toBe("feature/mutant");
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F2 pass 2) — shell-expansion evasion dies with
    // canonicalization: only the canonical byte form is executable, so
    // `$X`-style smuggling never reaches bash.
    it("refuses a hierarchical-via-expansion command at approval", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/expansion", { "ex.txt": "ex\n" });
        registerWorkRepo(db, repo);

        const request = submitPinnedRequest(queue, repo, "feature/expansion");
        queue.update(request.id, {
          command:
            "X=--hierarchical; mandible auth merge feature/expansion feature/evil --into main $X",
        });
        expect(() => queue.approve(request.id))
          .toThrow(/does not match the canonical form/);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F6) — the repin compare-and-swap fails closed when
    // the retained candidate ref disappeared between validation and swap.
    it("fails closed when the candidate ref is deleted before the repin CAS", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/cas-gone", { "cg.txt": "cg\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/cas-gone");
        const newBase = advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-cas-sib");
        // Simulate mid-flight deletion: the ref vanishes after validation
        // would have passed, immediately before the CAS.
        git(repo, ["update-ref", "-d", `refs/mandible/auth-candidates/${request.id}`]);
        const repin = (queue as unknown as {
          repinMergeCandidate: (
            r: unknown, sha: string, fp: string | null, o: { failClosed: boolean },
          ) => unknown;
        }).repinMergeCandidate.bind(queue);
        expect(() => repin(queue.getRequest(request.id), newBase, null, { failClosed: true }))
          .toThrow(STRICT_MESSAGE);
        // Recorded pin state is untouched (still the original, now-strict pin).
        const after = queue.getRequest(request.id)!;
        expect(after.merge_candidate_pin_sha).toBe(request.merge_candidate_pin_sha);
        expect(after.merge_preflight_base_sha).toBe(request.merge_preflight_base_sha);
        // And approval keeps failing strict rather than proceeding unpinned.
        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F6) — a DB failure after the ref CAS succeeded
    // leaves ref and row divergent; every later approval refuses strictly
    // (fail closed) instead of proceeding on either state.
    it("fails closed when the DB update fails after a successful repin CAS", () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/cas-db", { "cd.txt": "cd\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/cas-db");
        const newBase = advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-cas-db");

        const rawDb = db as unknown as { prepare: (sql: string) => unknown };
        const realPrepare = rawDb.prepare.bind(db);
        rawDb.prepare = (sql: string) => {
          if (typeof sql === "string" && sql.includes("SET merge_preflight_base_sha")) {
            throw new Error("injected DB failure after CAS");
          }
          return realPrepare(sql);
        };
        try {
          const repin = (queue as unknown as {
            repinMergeCandidate: (
              r: unknown, sha: string, fp: string | null, o: { failClosed: boolean },
            ) => unknown;
          }).repinMergeCandidate.bind(queue);
          expect(() => repin(queue.getRequest(request.id), newBase, null, { failClosed: true }))
            .toThrow(/injected DB failure after CAS/);
        } finally {
          rawDb.prepare = realPrepare;
        }
        // Row still records the original pin; the ref moved. The divergence is
        // tamper-shaped and approval refuses strictly, never unpinned.
        const after = queue.getRequest(request.id)!;
        expect(after.merge_candidate_pin_sha).toBe(request.merge_candidate_pin_sha);
        expect(() => queue.approve(request.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F6) — MAX_BASE_TRANSITION_COMMITS boundary: a
    // 32-commit fully-authorized transition recomputes; 33 fails strict.
    it("accepts a 32-commit authorized transition and refuses 33", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/boundary-32", { "b32.txt": "b32\n" });
        commitOnBranch(repo, "feature/boundary-33", { "b33.txt": "b33\n" });
        registerWorkRepo(db, repo);
        git(repo, ["config", "core.hooksPath", ".git/hooks"]);
        configureSigningCredential(db, repo, "ssh_key");
        // Keep the signing key out of the chain commits: commitOnBranch does
        // `git add .`, and a tracked key gets its 0600 mode clobbered by later
        // checkouts, which breaks signing mid-chain.
        writeFile(repo, ".gitignore", ".mandible-test-signing-key*\n");
        git(repo, ["add", ".gitignore"]);
        git(repo, ["commit", "-m", "ignore signing key"]);

        const at32 = submitPinnedRequest(queue, repo, "feature/boundary-32");
        const at33 = submitPinnedRequest(queue, repo, "feature/boundary-33");

        let base = "";
        for (let index = 1; index <= 32; index += 1) {
          commitOnBranch(repo, `feature/chain-${index}`, { [`chain-${index}.txt`]: `${index}\n` });
          base = advanceMainViaAuthorizedMerge(db, repo, `feature/chain-${index}`, `merge-chain-${index}`);
        }

        queue.approve(at32.id);
        await waitForStatus(queue, at32.id, "completed");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.MANDIBLE_AUTH_CANDIDATE_BASE_SHA).toBe(base);

        commitOnBranch(repo, "feature/chain-33", { "chain-33.txt": "33\n" });
        advanceMainViaAuthorizedMerge(db, repo, "feature/chain-33", "merge-chain-33");

        expect(() => queue.approve(at33.id)).toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(at33.id)?.status).toBe("pending");
        expect(calls).toHaveLength(1);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }, 60_000);

    // Issue 2205073 — the guards above all keep failing closed, but the
    // approver must now be told WHICH guard refused and what fixes it. Before
    // this, every one of them produced the same generic sentence and the real
    // reason reached daemon_log only.
    describe("refusal reasons reach the approver", () => {
      it("names the missing signing credential and its fingerprint", () => {
        const repo = createAuthCheckRepo();
        const db = createMigratedDb();
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const queue = createGuardQueue(db, calls);
        try {
          commitOnBranch(repo, "feature/unregistered-target", { "ut.txt": "ut\n" });
          commitOnBranch(repo, "feature/unregistered-sib", { "us.txt": "us\n" });
          registerWorkRepo(db, repo);

          // The operator has *some* registered credential (so the allowed
          // signers file is non-empty) but the key that actually signs the
          // protected merge was never registered — the exact 2026-08-12
          // production shape.
          configureSigningCredential(db, repo, "ssh_key");
          const unregisteredKeyPath = path.join(repo, ".unregistered-signing-key");
          execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", unregisteredKeyPath]);
          const unregisteredFingerprint = execFileSync(
            "ssh-keygen", ["-lf", `${unregisteredKeyPath}.pub`, "-E", "sha256"], { encoding: "utf8" },
          ).trim().split(/\s+/)[1]!;

          const request = submitPinnedRequest(queue, repo, "feature/unregistered-target");
          git(repo, ["config", "user.signingkey", unregisteredKeyPath]);
          advanceMainViaAuthorizedMerge(db, repo, "feature/unregistered-sib", "merge-unregistered");

          let message = "";
          try {
            queue.approve(request.id);
            throw new Error("expected approval to be refused");
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain("Refusal: base_transition_unaccounted");
          expect(message).toContain("signature");
          expect(message).toContain(unregisteredFingerprint);
          expect(message).toContain(
            `mandible user credential add ${getOperator(db)!.slug} --from-git-signingkey`,
          );
          expect(queue.getRequest(request.id)?.status).toBe("pending");
          expect(calls).toHaveLength(0);
        } finally {
          queue.dispose();
          db.close();
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });

      // Head drift never reaches the recompute guard: the earlier execution
      // context resolution already reports it specifically. Pinned here so the
      // one already-honest approval error on this path stays honest.
      it("keeps head drift reported with both commits, before recompute runs", () => {
        const repo = createAuthCheckRepo();
        const db = createMigratedDb();
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const queue = createGuardQueue(db, calls);
        try {
          commitOnBranch(repo, "feature/drifted", { "df.txt": "df\n" });
          commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
          registerWorkRepo(db, repo);
          configureSigningCredential(db, repo, "ssh_key");

          const request = submitPinnedRequest(queue, repo, "feature/drifted");
          const reviewedHead = request.merge_head_sha!;
          advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-drift-sib");
          git(repo, ["checkout", "feature/drifted"]);
          writeFile(repo, "df2.txt", "df2\n");
          git(repo, ["add", "df2.txt"]);
          git(repo, ["commit", "-m", "revise"]);
          const newHead = git(repo, ["rev-parse", "feature/drifted"]);
          git(repo, ["checkout", "main"]);

          let message = "";
          try {
            queue.approve(request.id);
            throw new Error("expected approval to be refused");
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain("Head branch feature/drifted moved");
          expect(message).toContain(reviewedHead);
          expect(message).toContain(newHead);
          expect(calls).toHaveLength(0);
        } finally {
          queue.dispose();
          db.close();
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });

      it("names a corrupted retained candidate rather than blaming the inputs", () => {
        const repo = createAuthCheckRepo();
        const db = createMigratedDb();
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const queue = createGuardQueue(db, calls);
        try {
          commitOnBranch(repo, "feature/corrupt-reason", { "cr.txt": "cr\n" });
          registerWorkRepo(db, repo);

          const request = submitPinnedRequest(queue, repo, "feature/corrupt-reason");
          git(repo, ["update-ref", "-d", `refs/mandible/auth-candidates/${request.id}`]);

          expect(() => queue.approve(request.id))
            .toThrow(/Refusal: retained_candidate_invalid/);
          expect(() => queue.approve(request.id)).toThrow(/tamper evidence/);
          expect(calls).toHaveLength(0);
        } finally {
          queue.dispose();
          db.close();
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });

      it("names a remote request as structurally non-recomputable", () => {
        const repo = createAuthCheckRepo();
        const db = createMigratedDb();
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const queue = createGuardQueue(db, calls);
        try {
          commitOnBranch(repo, "feature/remote-reason", { "rr.txt": "rr\n" });
          commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
          registerWorkRepo(db, repo);
          configureSigningCredential(db, repo, "ssh_key");

          const request = submitPinnedRequest(queue, repo, "feature/remote-reason");
          db.prepare("UPDATE auth_requests SET execution_mode = 'remote' WHERE id = ?")
            .run(request.id);
          advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-remote-reason");

          let message = "";
          try {
            queue.approve(request.id);
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain("Refusal: not_recomputable_request");
          expect(message).toContain("execution_mode=remote");
          expect(calls).toHaveLength(0);
        } finally {
          queue.dispose();
          db.close();
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });

      it("names the pin failure when a fresh pin cannot be obtained", () => {
        const repo = createAuthCheckRepo();
        const db = createMigratedDb();
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const queue = createGuardQueue(db, calls);
        try {
          commitOnBranch(repo, "feature/pin-reason", { "pr.txt": "pr\n" });
          commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
          registerWorkRepo(db, repo);
          configureSigningCredential(db, repo, "ssh_key");

          const request = submitPinnedRequest(queue, repo, "feature/pin-reason");
          advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-pin-reason");
          vi.spyOn(
            queue as unknown as { createMergeCandidatePin: (request: unknown) => string },
            "createMergeCandidatePin",
          ).mockImplementation(() => {
            throw new Error("injected pin cache failure");
          });

          let message = "";
          try {
            queue.approve(request.id);
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain("Refusal: repin_failed");
          expect(message).toContain("injected pin cache failure");
          expect(calls).toHaveLength(0);
        } finally {
          vi.restoreAllMocks();
          queue.dispose();
          db.close();
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });
    });
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

    // No cwd at submit (merge preflight skips): the wrong path arrives with
    // the failed remote execution and is corrected via PUT below.
    const request = queue.submit({
      command: "mandible auth merge feature/foo --into main",
      title: "Merge foo",
      base_branch: "main",
      head_branch: "feature/foo",
      execution_mode: "remote",
    });
    queue.approve(request.id);
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
      queue.setResult(request.id, 0, "Merge made by recursive.\nok");

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
          command: "mandible auth merge feature/self-fix --into main",
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
          command: "mandible auth merge feature/order-fix --into main",
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
      const lifecycleEvents: string[] = [];
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      let queue: AuthQueue | null = null;

      const originalSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = (fn: (...args: unknown[]) => void, ms?: number) => {
        // Capture the delay used for the self-rebuild exit
        if (ms !== undefined && ms >= 1000) {
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
          hookManager: {
            executeHooks: async () => {
              lifecycleEvents.push("hooks");
              return [];
            },
          } as unknown as AuthHookManager,
          restartAvailability: {
            markRebuildStarted: (generationId) => {
              lifecycleEvents.push(`rebuild:${generationId}`);
              return generationId ?? null;
            },
            markShutdownStarted: (generationId) => {
              lifecycleEvents.push(`shutdown:${generationId}`);
              return true;
            },
          },
          restartFn: () => lifecycleEvents.push("restart"),
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
          command: "mandible auth merge feature/delay-test --into main",
          title: "Self-merge delay test",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/delay-test",
          cwd: repo,
          execution_mode: "daemon"
        });

        queue.approve(request.id);
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

  // Bug: 0de95bf — history list projection.
  describe("listHistorySummaries", () => {
    function submitCompleted(
      queue: AuthQueue,
      overrides: Partial<Parameters<AuthQueue["submit"]>[0]> = {},
    ): string {
      const headBranch = overrides.head_branch ?? "feature/x";
      const request = queue.submit({
        type: "merge",
        command: `mandible auth merge ${headBranch} --into main`,
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
      queue.approve(request.id);
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
      queue.approve(withActions.id);
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
          command: "mandible auth merge feature/self-park --into main",
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
        queue.approve(request.id);
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
      queue.approve(completed.id);
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
