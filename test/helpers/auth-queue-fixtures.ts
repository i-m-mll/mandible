/**
 * Shared fixtures for the auth-queue test files (issue 9e40a31).
 *
 * `test/auth-queue.test.ts` was one 6,122-line file holding 139 uniformly
 * expensive tests. Vitest parallelises across files, never within one, so that
 * file alone was 98.9% of the default gate's wall clock. It is now eight files
 * that share this module.
 *
 * Two costs are memoised per worker process:
 *
 * - The pristine Git repository. `createAuthCheckRepo()` used to run six git
 *   subprocesses per call, 83 times per run. It now copies one immutable
 *   template built once. The copy boundary is exactly the state after the
 *   initial commit: index and worktree agree, no signing key has been written,
 *   no hook installed, no ref rewritten and no linked worktree registered.
 *   Everything after that point is a clone-local mutation and must never reach
 *   the template.
 * - The migrated SQLite schema. `createMigratedDb()` used to run `migrate()`
 *   against a fresh `:memory:` database ~92 times per run. It now deserialises
 *   one serialised template. This is hygiene, not a lever: measurement puts the
 *   whole migration load near 1s of a 101.5s file.
 *
 * Git configuration is isolated here rather than inherited. The previous
 * wrapper stripped only `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`, so a developer's
 * `core.hooksPath`, `init.templateDir` or signing defaults reached the fixture
 * and could change what these tests were actually exercising.
 */
import SqliteDatabase from "../../src/sqlite.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect } from "vitest";

import { AuthHookManager } from "../../src/auth-hooks.js";
import { AuthQueue } from "../../src/auth-queue.js";
import type { Db } from "../../src/db.js";
import {
  createLedgerIssue as createSharedLedgerIssue,
  createLedgerProject as createSharedLedgerProject,
  createMigratedDb as createSharedMigratedDb,
} from "./ledger-fixtures.js";
import {
  addCredential,
  addDelegatedSigningLease,
  getOperator,
} from "../../src/users/store.js";

// --- temp-path custody -----------------------------------------------------
//
// Every path this module creates is tracked. Per-test paths are removed in
// `afterEach` and templates in `afterAll`, so a test that throws before its own
// `finally` cannot leak a repository, database, key, hook or linked worktree
// into the next test or past the end of the file. Individual tests keep their
// own `finally { fs.rmSync(repo) }` blocks; this is the backstop, and removal
// is idempotent.

const perTestPaths = new Set<string>();
const templatePaths = new Set<string>();

function removePath(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

/** Register a path for removal after the current test. */
export function trackTempPath(target: string): string {
  perTestPaths.add(target);
  return target;
}

/**
 * A unique path that is guaranteed not to exist, inside a tracked temporary
 * parent directory.
 *
 * Three cases used to derive such a path from `Date.now()` or from a fixed
 * constant. That was invisible while the file ran serially and is a collision
 * the moment two of them run in different forks in the same millisecond — the
 * same class of latent defect the `cli-instance-preflight` fix uncovered. A
 * timestamp is not a uniqueness primitive.
 *
 * The path must not exist, not merely be unique: `git worktree add` and
 * `fs.symlinkSync` both refuse an occupied destination, and the ENOENT
 * preflight case is only meaningful while nothing is there. So the parent is
 * created and tracked, and the returned child inside it is left absent.
 */
export function uniqueMissingPath(prefix: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  trackTempPath(parent);
  return path.join(parent, prefix);
}

/** Paths the fixture is currently holding — used by the isolation contract. */
export function trackedTempPaths(): { perTest: string[]; templates: string[] } {
  return { perTest: [...perTestPaths], templates: [...templatePaths] };
}

afterEach(() => {
  for (const target of perTestPaths) removePath(target);
  perTestPaths.clear();
});

afterAll(() => {
  for (const target of perTestPaths) removePath(target);
  perTestPaths.clear();
  // Before removal, while the bytes still exist to be compared.
  verifyTemplateIntegrity();
  for (const target of templatePaths) removePath(target);
  templatePaths.clear();
  pristineRepoTemplate = null;
  pristineRepoDigest = null;
  emptyGitTemplateDir = null;
  migratedDbTemplate = null;
});

// --- git -------------------------------------------------------------------

/**
 * An empty `--template` directory. Without it `git init` copies whatever
 * `init.templateDir` points at, plus Git's own sample hooks; with it the
 * template repository is both machine-independent and smaller to copy.
 *
 * `hooks/` and `info/` are present but empty. `git init` creates only what the
 * template contains, and a genuinely empty template therefore produces a
 * repository with no `.git/hooks` directory at all — which breaks the tests
 * that install a native hook by writing straight into it.
 */
let emptyGitTemplateDir: string | null = null;

function gitTemplateDir(): string {
  if (emptyGitTemplateDir) return emptyGitTemplateDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-git-template-"));
  fs.mkdirSync(path.join(dir, "hooks"));
  fs.mkdirSync(path.join(dir, "info"));
  templatePaths.add(dir);
  emptyGitTemplateDir = dir;
  return dir;
}

export function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    // Ambient configuration is not part of what these tests assert. Read
    // neither the system file nor the user's global file.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    ...extraEnv,
  };
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

export function writeFile(repo: string, relativePath: string, content: string): void {
  const fullPath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

/**
 * The exact construction the tests used before memoisation, run once. Kept as
 * its own function so the template is provably the same repository shape the
 * per-test copies used to be built from.
 */
function buildPristineRepo(destination: string): void {
  git(destination, ["init", "-b", "main", `--template=${gitTemplateDir()}`]);
  git(destination, ["config", "user.name", "Mandible Test"]);
  git(destination, ["config", "user.email", "mandible-test@localhost"]);
  git(destination, ["config", "commit.gpgsign", "false"]);
  writeFile(destination, "shared.txt", "base\n");
  git(destination, ["add", "."]);
  git(destination, ["commit", "-m", "init"]);
}

/**
 * The template must be copyable to any path. Anything that pins a repository
 * to its location — an absolute `core.worktree`, an object alternate, a linked
 * worktree's administrative record — would survive the copy and point at the
 * template.
 */
function assertRelocatable(repo: string): void {
  expect(git(repo, ["status", "--porcelain"])).toBe("");
  expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  // Read the config file rather than `git config --get`: a missing key exits
  // non-zero, and an assertion helper must not depend on a thrown subprocess.
  const localConfig = fs.readFileSync(path.join(repo, ".git", "config"), "utf8");
  expect(localConfig).not.toMatch(/^\s*worktree\s*=/m);
  expect(fs.existsSync(path.join(repo, ".git", "objects", "info", "alternates"))).toBe(false);
  expect(fs.existsSync(path.join(repo, ".git", "worktrees"))).toBe(false);
  expect(fs.existsSync(path.join(repo, ".git", "commondir"))).toBe(false);
  const hooks = path.join(repo, ".git", "hooks");
  const installedHooks = fs.existsSync(hooks)
    ? fs.readdirSync(hooks).filter((entry) => !entry.endsWith(".sample"))
    : [];
  expect(installedHooks).toEqual([]);
}

/**
 * Content digest of a directory tree: every path, and every file's bytes or
 * link target, in a stable order.
 *
 * The review asked for the template to be checksummed before and after each
 * use. That is the right property and the wrong place to check it: 83 copies
 * per file, each preceded and followed by a full tree hash, reinstates a large
 * share of the subprocess cost the memoisation just removed. The property —
 * the template is never mutated — is instead verified once per file in
 * `afterAll`, and explicitly by the fixture-isolation contract, which is where
 * a mutation would actually be introduced.
 */
function treeDigest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (relative: string): void => {
    const entries = fs
      .readdirSync(path.join(dir, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      hash.update(child).update("\0");
      if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(path.join(dir, child)));
      else if (entry.isDirectory()) walk(child);
      else hash.update(fs.readFileSync(path.join(dir, child)));
    }
  };
  walk(".");
  return hash.digest("hex");
}

let pristineRepoTemplate: string | null = null;
let pristineRepoDigest: string | null = null;

function pristineRepo(): string {
  if (pristineRepoTemplate) return pristineRepoTemplate;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-template-"));
  templatePaths.add(dir);
  buildPristineRepo(dir);
  assertRelocatable(dir);
  pristineRepoDigest = treeDigest(dir);
  pristineRepoTemplate = dir;
  return dir;
}

/**
 * The template is handed to `fs.cpSync` as a source and to nothing else. If its
 * bytes ever differ from the moment it was frozen, some test reached through a
 * copy and mutated the original, and every later copy in that file was silently
 * wrong. No-op when the file never built a template.
 */
export function verifyTemplateIntegrity(): void {
  if (!pristineRepoTemplate || !pristineRepoDigest) return;
  expect(treeDigest(pristineRepoTemplate)).toBe(pristineRepoDigest);
}

/**
 * A private, complete, writable copy of the pristine repository. Callers may
 * mutate it however they like — the template is never handed out and never
 * mutated.
 */
export function createAuthCheckRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-check-"));
  fs.cpSync(pristineRepo(), repo, { recursive: true });
  return trackTempPath(repo);
}

export function commitOnBranch(repo: string, branch: string, changes: Record<string, string>): void {
  git(repo, ["checkout", "-b", branch, "main"]);
  for (const [file, content] of Object.entries(changes)) {
    writeFile(repo, file, content);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", branch]);
  git(repo, ["checkout", "main"]);
}

// --- databases -------------------------------------------------------------

let migratedDbTemplate: Buffer | null = null;

export function createMigratedDb(): Db {
  if (!migratedDbTemplate) {
    const seed = createSharedMigratedDb({
      operator: { slug: "auth-test-operator", display_name: "Auth Test Operator" },
      now: 1,
    });
    migratedDbTemplate = seed.serialize();
    seed.close();
  }
  // Deserialise from a copy: the template buffer is reused for every case and
  // must not observe a test's writes.
  return SqliteDatabase.fromSnapshot(Buffer.from(migratedDbTemplate)) as unknown as Db;
}

export function createLedgerProject(db: Db, root: string) {
  return createSharedLedgerProject(db, root, { mkdir: true, defaultBranch: "main", remoteUrl: "" });
}

export function createLedgerIssue(
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

export function createQueue(options: ConstructorParameters<typeof AuthQueue>[0] = {}) {
  const db = createMigratedDb();
  return new AuthQueue({ db, ...options });
}

export function registerWorkRepo(
  db: InstanceType<typeof SqliteDatabase>,
  repoRoot: string,
  defaultBranch = "main",
): void {
  db.prepare(
    `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
     VALUES (?, ?, ?, ?, 1, 0)`
  ).run(path.basename(repoRoot), fs.realpathSync(repoRoot), path.basename(repoRoot), defaultBranch);
}

// --- users, credentials, evidence -----------------------------------------

export function registerTestDelegatedLease(
  db: InstanceType<typeof SqliteDatabase>,
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

export function executionEvidenceChain(
  db: InstanceType<typeof SqliteDatabase>,
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

/**
 * Generates a real keypair inside the repository, exactly as before. The key is
 * deliberately not memoised: it lives in the working tree, so `git add .` in
 * `commitOnBranch` commits it, and sharing one key across cases would change
 * what those commits contain. The measured cost is ~0.5s of a 101.5s file.
 */
export function configureSigningCredential(
  db: InstanceType<typeof SqliteDatabase>,
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

// --- authorized-merge provenance -------------------------------------------

// Issue 08a5f04 (review F1) — helpers that advance main through a *genuine*
// authorized queue merge: a signed merge commit recorded by a successfully
// completed auth request (MANDIBLE_MERGE_RESULT marker + reviewed
// merge_head_sha), which is exactly what base-transition provenance
// verification demands. Requires configureSigningCredential on the repo first.
export function insertSiblingMergeRequest(
  db: InstanceType<typeof SqliteDatabase>,
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

export function signedMergeIntoMain(repo: string, sourceBranch: string): string {
  git(repo, ["checkout", "main"]);
  git(repo, ["merge", "--no-ff", "--no-edit", "-S", sourceBranch]);
  return git(repo, ["rev-parse", "main"]);
}

export function mergeResultOutput(mergeSha: string): string {
  return `MANDIBLE_MERGE_RESULT {"merge_sha":"${mergeSha}"}\n`;
}

// Authorized base advance recorded directly as a finalized completed request
// (no live finalizer involvement) — for approve-time recompute tests.
export function advanceMainViaAuthorizedMerge(
  db: InstanceType<typeof SqliteDatabase>,
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

// --- sessions and work units -----------------------------------------------

export function createNoopHookManager(): AuthHookManager {
  return {
    executeHooks: async () => []
  } as unknown as AuthHookManager;
}

export async function waitForStatus(queue: AuthQueue, id: string, status: string, timeoutMs = 2000) {
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

export function insertMandibleSession(
  db: InstanceType<typeof SqliteDatabase>,
  id: string,
  status: string,
): void {
  db.prepare(
    "INSERT INTO sessions (id, app, status, created_at, updated_at) VALUES (?, 'codex', ?, datetime('now'), datetime('now'))",
  ).run(id, status);
}

export function insertConsoleSession(
  db: InstanceType<typeof SqliteDatabase>,
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

export function insertWorkUnit(
  db: InstanceType<typeof SqliteDatabase>,
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

/** Obtain genuine operator proof in a private fixture repository. */
export async function approveFixtureRequest(queue: AuthQueue, id: string): Promise<ReturnType<AuthQueue['approve']>> {
  const db = (queue as unknown as { db: Db }).db;
  let request = queue.getRequest(id)!;
  // Command-state tests need a real signing context even when their command
  // has no repository semantics. Set it through the normal pending edit API.
  if (!request.cwd && !request.command.includes('auth merge')) {
    request = queue.update(id, { cwd: createAuthCheckRepo() });
  }
  if (request.cwd && fs.existsSync(path.join(request.cwd, '.git')) &&
      !fs.existsSync(path.join(request.cwd, '.mandible-test-signing-key'))) {
    configureSigningCredential(db, request.cwd, 'ssh_key');
  }
  return queue.approveWithOperatorProof(id, getOperator(db)!.id);
}

/** Stored historical rows test projections/recovery, never execution authority. */
export function seedHistoricalAuthCompletion(queue: AuthQueue, id: string, output = '', exitCode = 0, error: string | null = null): void {
  const db = (queue as unknown as { db: Db }).db;
  const request = queue.getRequest(id)!;
  db.prepare("UPDATE auth_requests SET status = 'completed', exit_code = ?, error = ?, output = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
    .run(exitCode, error, output, request.created_at, request.created_at, id);
}

/** A historical interrupted process, without invented signing evidence. */
export function seedHistoricalAuthExecution(queue: AuthQueue, id: string): void {
  const db = (queue as unknown as { db: Db }).db;
  const request = queue.getRequest(id)!;
  db.prepare("UPDATE auth_requests SET status = 'executing', approved_at = ?, updated_at = ? WHERE id = ?")
    .run(request.created_at, request.created_at, id);
}

/** A real signed exact-candidate receipt from the delivery fixture. */
export async function publishFixtureExecution(queue: AuthQueue, options: Parameters<NonNullable<ConstructorParameters<typeof AuthQueue>[0]['executor']>>[0]) {
  const { publishTestCandidate } = await import('./auth-delivery-fixtures.js');
  const { output } = publishTestCandidate(options.cwd!, queue.getRequest(options.request_id)!);
  options.onOutput?.({ request_id: options.request_id, stream: 'stderr', text: output, timestamp: Date.now() });
  return { exit_code: 0, signal: null, stdout: '', stderr: output, output, started_at: Date.now(), finished_at: Date.now() };
}

