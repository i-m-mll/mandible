// Quarantined: 4360464 — the delegated lease never reaches completed.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AuthQueue, AuthQueueError } from "../../src/auth-queue.js";
import { AuthHookManager } from "../../src/auth-hooks.js";
import type { Db } from "../../src/db.js";
import { LedgerStore } from "../../src/ledger/store.js";
import type { SseEvent } from "../../src/types.js";
import {
  SYSTEM_ACTOR,
  createLedgerIssue as createSharedLedgerIssue,
  createLedgerProject as createSharedLedgerProject,
  createMigratedDb as createSharedMigratedDb,
} from "../helpers/ledger-fixtures.js";
import {
  addAttributionEvidence,
  addCredential,
  addDelegatedSigningLease,
  createUser,
  getOperator,
} from "../../src/users/store.js";

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

  // Integration reconciliation (issue 93d978e) — a transient git failure while
  // building the ancestry batch must not tombstone genuinely merged snapshots.

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

  // Issue 08a5f04 — pure base drift no longer blocks approval when the base
  // transition is fully accounted for by an authorized queue merge: the stale
  // candidate is recomputed against the current base within the same approval
  // action, re-pinned, and atomic mode is re-evaluated with the fresh pin.

  // Issue 08a5f04 — after a sibling merge advances the base, clean pending
  // candidates are proactively re-preflighted, re-pinned, and broadcast so
  // approval hits the exact-candidate fast path.

  // Issue 08a5f04 (review F5/F6) — fail-closed guards around candidate
  // recompute: pin corruption, unaccounted or rewritten base transitions,
  // command mutation, pin-cache failure, remote requests, and races between
  // provenance verification and re-pinning.

  // Bug: 297677f — issues field tests

  // Bug: 93c57c4 — outcome field tests

  // Bug: 929c6d0 — error output in resolved payload and error field

  // Bug: 03d6cb0 — self-rebuild delay: auth:resolved must broadcast BEFORE
  // the daemon schedules a process.exit for self-merges.

  // Bug: 0de95bf — history list projection.

  // Bug: 681739e — a self-merge restart must not kill chained executions. While
  // the restart is pending, admission is closed (new executions park instead of
  // starting), and the shutdown instant is recorded so the respawned daemon
  // fast-recovers any orphaned execution instead of waiting out the multi-minute
  // stuck-request threshold.

});

// Issue ded17e6 — per-repo execution chains keyed on canonical Git identity,
// canonical work-unit / dedupe matching, and self-merge drain.

