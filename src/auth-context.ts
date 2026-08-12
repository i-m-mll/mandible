import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Db } from "./db.js";

export interface AuthMergeContextInput {
  type?: string | null;
  command?: string | null;
  cwd?: string | null;
  target_repo_root?: string | null;
  repo?: string | null;
  base_branch?: string | null;
  head_branch?: string | null;
}

export interface AuthMergeExecutionContext {
  targetRepoRoot: string;
  executionCwd: string;
  repoName: string | null;
  baseBranch: string;
  headBranch: string;
  headSha: string;
}

export interface AuthMergeReviewMetadata {
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  diffSummary?: string;
  commitMessage?: string;
}

export interface AuthMergeReviewMetadataOptions {
  counts?: boolean;
  diffSummary?: boolean;
  commitMessage?: boolean;
}

export class AuthExecutionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthExecutionContextError";
  }
}

const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
const MAX_DIFF_BYTES = 102400;
const MAX_DIFF_PREVIEW_BYTES = MAX_DIFF_BYTES;
const MAX_DIFF_PREVIEW_READ_BYTES = MAX_DIFF_PREVIEW_BYTES + 1;
const GIT_REF_TIMEOUT_MS = 5000;

/**
 * Issue 2205073 — every git spawn on the approval path runs with
 * GIT_OPTIONAL_LOCKS=0. Read-only probes must never take the index lock: on a
 * busy repo the lock contention is exactly the kind of transient failure that
 * used to be reported as "branch does not exist".
 */
export function authGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
}

/**
 * Issue 2205073 — how a git invocation failed, told apart honestly.
 *
 * `execFileSync` throws one error shape for three very different worlds:
 *  - the process ran and exited non-zero (`status` is a number) — a real git
 *    answer, e.g. `show-ref --verify` exiting 1 for a ref that is absent;
 *  - the process was killed by the timeout (`code === "ETIMEDOUT"`) — git
 *    never answered, so nothing was learned about the repo;
 *  - the process could not be spawned at all (`code` is an errno such as
 *    EMFILE, EAGAIN, ENOENT, ENOMEM) — a daemon-health failure that says
 *    nothing about the repository.
 *
 * Collapsing all three into "the branch does not exist" is the defect this
 * classifier exists to prevent: a real EMFILE from watcher fd exhaustion was
 * reported to the operator as a missing `main` branch on a healthy repo.
 */
export type GitFailure =
  | { kind: "exit"; status: number; stderr: string }
  | { kind: "timeout"; timeoutMs: number | null; stderr: string }
  | { kind: "spawn"; errno: string | null; stderr: string };

export function classifyGitFailure(error: unknown, timeoutMs: number | null = null): GitFailure {
  const record = (error ?? {}) as {
    status?: unknown;
    code?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  const stderr = typeof record.stderr === "string"
    ? record.stderr.trim()
    : Buffer.isBuffer(record.stderr)
      ? record.stderr.toString("utf-8").trim()
      : "";
  if (typeof record.status === "number") {
    return { kind: "exit", status: record.status, stderr };
  }
  if (record.code === "ETIMEDOUT") {
    return { kind: "timeout", timeoutMs, stderr };
  }
  return {
    kind: "spawn",
    errno: typeof record.code === "string" ? record.code : null,
    stderr,
  };
}

/**
 * Issue 2205073 — a human-readable cause plus the fix that actually applies.
 * Never asserts anything about repository contents for a failure that never
 * reached the repository.
 */
export function describeGitFailure(failure: GitFailure): string {
  const detail = failure.stderr ? ` git said: ${truncate(failure.stderr, 300)}` : "";
  switch (failure.kind) {
    case "timeout":
      return (
        `git timed out${failure.timeoutMs ? ` after ${failure.timeoutMs}ms` : ""} and never answered, ` +
        "so this is not evidence about the repository. Retry the approval; if it keeps timing out, " +
        `check daemon health and repo load.${detail}`
      );
    case "spawn":
      return (
        `git could not be executed (${failure.errno ?? "unknown spawn failure"}), ` +
        "so this is not evidence about the repository. Retry the approval; if it persists, check " +
        "daemon health — process/file-descriptor exhaustion (EMFILE/EAGAIN/ENOMEM) is the usual cause." +
        detail
      );
    case "exit":
      return `git exited with status ${failure.status}.${detail}`;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function isAuthMergeCommand(input: AuthMergeContextInput): boolean {
  const command = input.command ?? "";
  return command.includes("auth merge") || command.includes("auth-merge");
}

/**
 * Issue 08a5f04 (review F2) — the canonical auth merge command space.
 *
 * The submission CLI (cli/auth-request.sh) builds
 * `${HOME}/.dotfiles/bin/mandible auth merge <head> --into <base>`; a bare
 * `mandible` prefix is the enumerated PATH-resolved equivalent, and
 * `--preserve-head-branch` is the one legitimate execution modifier that is
 * not representable in structured fields. Everything a merge execution does is
 * derived from these structured fields, so approval refuses any stored command
 * that does not byte-equal one of these forms: a mutated command can never
 * execute, and shell-expansion evasion is impossible because only these exact
 * byte sequences are executable. Multi-source commands have no canonical form
 * (no per-source reviewed head exists) and are therefore not approvable
 * through the queue; hierarchical merge execution itself was removed in issue
 * 060c9c8.
 *
 * The absolute-prefix variants embed os.homedir() and the whole command later
 * runs through `bash -c`, so a daemon launched with a metacharacter-bearing
 * HOME could otherwise smuggle hostile bytes into an "approvable" command.
 * When the home path contains anything outside a strict safe byte set the
 * absolute-prefix variants are omitted entirely (fail closed to the bare
 * `mandible` prefix) rather than emitting a dangerous byte form. Argv-based
 * execution is the long-term fix (issue fff66b9).
 */
export function canonicalAuthMergeCommands(
  headBranch: string | null | undefined,
  baseBranch: string | null | undefined,
): string[] {
  if (!headBranch || !baseBranch) return [];
  if (!isSafeBranchName(headBranch) || !isSafeBranchName(baseBranch)) return [];
  const core = `auth merge ${headBranch} --into ${baseBranch}`;
  const prefixes = ["mandible"];
  const homeDir = safeCanonicalHomeDir();
  if (homeDir) {
    prefixes.push(path.join(homeDir, ".dotfiles/bin/mandible"));
  }
  const commands: string[] = [];
  for (const prefix of prefixes) {
    commands.push(`${prefix} ${core}`);
    commands.push(`${prefix} ${core} --preserve-head-branch`);
  }
  return commands;
}

// Issue 08a5f04 (review advisory) — bytes allowed in a home path that may be
// embedded verbatim in a canonical command executed via `bash -c`. No
// whitespace and no shell metacharacters: alnum, `/`, `.`, `_`, `-` only.
const SAFE_HOME_PATH = /^\/[A-Za-z0-9._/-]*$/;

function safeCanonicalHomeDir(): string | null {
  let home: string;
  try {
    home = os.homedir();
  } catch {
    return null;
  }
  if (!home || !SAFE_HOME_PATH.test(home) || home.includes("..")) {
    return null;
  }
  return home;
}

/**
 * Issue 08a5f04 (channel-server compatibility) — normalize the legacy
 * single-source merge command shape at submission time.
 *
 * Older submitters (the MCP channel server's `mandible_submit_auth`, raw API
 * clients) stored `mandible auth merge <branch>` with no `--into <base>`;
 * canonical enforcement at approval refuses that shape. When the submitted
 * command matches EXACTLY the legacy single-source shape, its one argument
 * byte-equals the server-resolved head branch, and both resolved branches are
 * safe names, this returns the canonical `mandible auth merge <head> --into
 * <base>` form so the reviewed row is canonical from the start. Anything else
 * — extra flags, a different branch argument, multi-source shapes — returns
 * null and the command is stored as-is (approval will refuse it, as designed).
 *
 * This normalization runs only at POST submission, never at approval: the
 * reviewed row must already carry the canonical bytes the approver sees.
 */
export function normalizeLegacySingleSourceMergeCommand(
  command: string | null | undefined,
  headBranch: string | null | undefined,
  baseBranch: string | null | undefined,
): string | null {
  if (!command || !headBranch || !baseBranch) return null;
  if (!isSafeBranchName(headBranch) || !isSafeBranchName(baseBranch)) return null;
  const match = /^mandible auth merge (\S+)$/.exec(command);
  if (!match || match[1] !== headBranch) return null;
  return `mandible auth merge ${headBranch} --into ${baseBranch}`;
}

function isSafeBranchName(value: string): boolean {
  return (
    SAFE_BRANCH_NAME.test(value) &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".")
  );
}

/**
 * Issue 2205073 (review F8) — the repo-root probe is a git invocation like any
 * other, and it fails in the same three worlds the classifier tells apart.
 *
 * `root` is set only when git actually answered with a git-common-dir.
 * `failure` carries how git failed, so callers can tell "git says this is not a
 * repository" (exit) apart from "git never answered" (timeout/spawn errno).
 * Collapsing the latter into a null root is what let the approval path report a
 * healthy, registered repository as an invalid or unregistered `cwd`.
 */
export interface RepoRootProbe {
  root: string | null;
  failure: GitFailure | null;
}

export function probeRepoRootFromGitCommonDir(cwd: string): RepoRootProbe {
  try {
    const gitCommonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf-8",
        timeout: GIT_REF_TIMEOUT_MS,
        env: authGitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
    return { root: gitCommonDir ? path.dirname(gitCommonDir) : null, failure: null };
  } catch (error) {
    return { root: null, failure: classifyGitFailure(error, GIT_REF_TIMEOUT_MS) };
  }
}

/**
 * Best-effort form for callers that only enrich optional metadata from a cwd
 * (repo-name backfill at submission). Anything that refuses work on the answer
 * must use `probeRepoRootFromGitCommonDir` and report the failure honestly.
 */
export function repoRootFromGitCommonDir(cwd: string): string | null {
  return probeRepoRootFromGitCommonDir(cwd).root;
}

export function resolveAuthMergeExecutionContext(
  db: Db,
  input: AuthMergeContextInput
): AuthMergeExecutionContext {
  const baseBranch = requireValidBranch("base_branch", input.base_branch ?? null);
  const headBranch = requireValidBranch("head_branch", input.head_branch ?? null);
  const repo = resolveRegisteredTargetRepo(db, input);

  validateProtectedBaseBranch(db, repo, baseBranch);
  verifyLocalBranch(repo.root, "base_branch", baseBranch);
  verifyLocalBranch(repo.root, "head_branch", headBranch);
  verifyHeadAheadOfBase(repo.root, baseBranch, headBranch);
  const headSha = resolveBranchHeadSha(repo.root, headBranch);

  const executionCwd = resolveBaseBranchWorktree(repo.root, baseBranch);
  return {
    targetRepoRoot: repo.root,
    executionCwd,
    repoName: repo.name,
    baseBranch,
    headBranch,
    headSha,
  };
}

export function resolveBranchHeadSha(repoRoot: string, branch: string): string {
  let sha: string;
  try {
    sha = execFileSync(
      "git",
      ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: GIT_REF_TIMEOUT_MS,
        env: authGitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
  } catch (error) {
    // Issue 2205073 — say whether git answered "no such ref" or never ran.
    throw new AuthExecutionContextError(
      `Unable to resolve auth merge head commit for ${branch}: ` +
        describeGitFailure(classifyGitFailure(error, GIT_REF_TIMEOUT_MS))
    );
  }
  if (sha) {
    return sha;
  }
  throw new AuthExecutionContextError(
    `Unable to resolve auth merge head commit for ${branch}: git resolved the ref to an empty value.`
  );
}

export async function computeAuthMergeReviewMetadata(
  repoRoot: string,
  baseBranch: string,
  headBranch: string,
  options: AuthMergeReviewMetadataOptions = {
    counts: true,
    diffSummary: true,
    commitMessage: true,
  }
): Promise<AuthMergeReviewMetadata> {
  const range = `refs/heads/${baseBranch}..refs/heads/${headBranch}`;
  const metadata: AuthMergeReviewMetadata = {};

  if (options.counts !== false) {
    const shortstat = execFileSync("git", ["diff", "--shortstat", range], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10000,
      env: authGitEnv(),
    }).trim();
    const { filesChanged, additions, deletions } = parseGitShortstat(shortstat);
    metadata.filesChanged = filesChanged;
    metadata.additions = additions;
    metadata.deletions = deletions;
  }

  if (options.diffSummary !== false) {
    metadata.diffSummary = await readBoundedDiffPreview(repoRoot, range);
  }

  if (options.commitMessage !== false) {
    metadata.commitMessage =
      execFileSync("git", ["log", "--format=- %s", "-20", range], {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 10000,
        env: authGitEnv(),
      }).trim() || `Merge ${headBranch}`;
  }

  return metadata;
}

async function readBoundedDiffPreview(repoRoot: string, range: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytesRead = 0;
    let truncated = false;
    let timedOut = false;

    const child = spawn("git", ["diff", range], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: authGitEnv(),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 10000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) {
        return;
      }
      const remaining = MAX_DIFF_PREVIEW_READ_BYTES - bytesRead;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, Math.max(remaining, 0)));
        bytesRead += remaining;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
      bytesRead += chunk.length;
      if (bytesRead >= MAX_DIFF_PREVIEW_READ_BYTES) {
        truncated = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderrChunks).length < 4096) {
        stderrChunks.push(chunk);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new AuthExecutionContextError("Timed out while collecting auth merge diff preview."));
        return;
      }
      if (code !== 0 && !truncated) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
        reject(new AuthExecutionContextError(
          stderr ? `Unable to collect auth merge diff preview: ${stderr}` : "Unable to collect auth merge diff preview."
        ));
        return;
      }

      const previewBytes = Buffer.concat(chunks).subarray(0, MAX_DIFF_PREVIEW_BYTES);
      const preview = previewBytes.toString("utf-8");
      resolve(
        truncated
          ? `${preview}\n... [truncated: diff preview exceeded ${MAX_DIFF_PREVIEW_BYTES} bytes]`
          : preview
      );
    });
  });
}

function parseGitShortstat(shortstat: string): {
  filesChanged: number;
  additions: number;
  deletions: number;
} {
  const filesChanged = Number(shortstat.match(/(\d+) files? changed/)?.[1] ?? 0);
  const additions = Number(shortstat.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0);
  const deletions = Number(shortstat.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0);
  return {
    filesChanged: Number.isFinite(filesChanged) ? filesChanged : 0,
    additions: Number.isFinite(additions) ? additions : 0,
    deletions: Number.isFinite(deletions) ? deletions : 0,
  };
}

function requireValidBranch(field: "base_branch" | "head_branch", value: string | null): string {
  if (!value) {
    throw new AuthExecutionContextError(
      `Auth merge requests require '${field}' so the server can resolve execution context.`
    );
  }
  if (!isSafeBranchName(value)) {
    throw new AuthExecutionContextError(
      `Invalid '${field}' for auth merge execution context: ${value}`
    );
  }
  return value;
}

function resolveRegisteredTargetRepo(
  db: Db,
  input: AuthMergeContextInput
): { root: string; name: string | null; defaultBranch: string | null } {
  const explicitTarget = input.target_repo_root?.trim() || null;
  if (explicitTarget) {
    const normalized = normalizeExistingPath(explicitTarget);
    if (!normalized) {
      throw new AuthExecutionContextError(
        `Invalid or unregistered 'target_repo_root' for auth merge execution context: ${explicitTarget}`
      );
    }
    const repo = findRegisteredRepo(db, normalized);
    if (!repo) {
      throw new AuthExecutionContextError(
        `Invalid or unregistered 'target_repo_root' for auth merge execution context: ${explicitTarget}`
      );
    }
    return repo;
  }

  const cwd = input.cwd?.trim() || null;
  if (!cwd) {
    const repo = input.repo?.trim() ? findRegisteredRepoByRef(db, input.repo.trim()) : null;
    if (repo) {
      return repo;
    }
    throw new AuthExecutionContextError(
      "Auth merge requests require target_repo_root, repo, or cwd; raw-route submissions must identify a registered work repo."
    );
  }

  // Issue 2205073 (review F8) — a raw/local request may identify its repository
  // only through cwd. When `git rev-parse` times out or cannot be spawned
  // (EMFILE from fd exhaustion, EAGAIN, ENOMEM), nothing was learned about this
  // path: saying it is "invalid or unregistered" sends the operator to register
  // an already-registered repo while the real cause is daemon/process health.
  const cwdProbe = probeRepoRootFromGitCommonDir(cwd);
  if (cwdProbe.failure && cwdProbe.failure.kind !== "exit") {
    throw new AuthExecutionContextError(
      `Unable to resolve the repository for 'cwd' ${cwd}: ${describeGitFailure(cwdProbe.failure)}`
    );
  }
  const cwdRepoRoot = cwdProbe.root;
  if (!cwdRepoRoot) {
    throw new AuthExecutionContextError(
      `Invalid or unregistered 'cwd' for auth merge execution context: ${cwd}`
    );
  }

  const repo = findRegisteredRepo(db, cwdRepoRoot);
  if (!repo) {
    throw new AuthExecutionContextError(
      `Invalid or unregistered 'cwd' for auth merge execution context: ${cwd}`
    );
  }
  return repo;
}

function findRegisteredRepoByRef(
  db: Db,
  repoRef: string
): { root: string; name: string | null; defaultBranch: string | null } | null {
  const normalizedRef = normalizeExistingPath(repoRef);
  const rows = db
    .prepare(
      "SELECT id, root, name, default_branch FROM work_repos WHERE dir_exists = 1 AND excluded = 0"
    )
    .all() as Array<{ id: string; root: string; name: string | null; default_branch: string | null }>;
  for (const row of rows) {
    const normalizedRoot = normalizeExistingPath(row.root);
    if (!normalizedRoot) {
      continue;
    }
    if (
      row.id === repoRef ||
      row.name === repoRef ||
      row.root === repoRef ||
      normalizedRoot === normalizedRef ||
      path.basename(normalizedRoot) === repoRef
    ) {
      return {
        root: normalizedRoot,
        name: row.name ?? null,
        defaultBranch: row.default_branch ?? null,
      };
    }
  }
  return null;
}

function findRegisteredRepo(
  db: Db,
  repoRoot: string
): { root: string; name: string | null; defaultBranch: string | null } | null {
  const normalized = normalizeExistingPath(repoRoot);
  if (!normalized) {
    return null;
  }

  const exact = db
    .prepare(
      "SELECT root, name, default_branch FROM work_repos WHERE root = ? AND dir_exists = 1 AND excluded = 0 LIMIT 1"
    )
    .get(normalized) as { root: string; name: string | null; default_branch: string | null } | undefined;
  if (exact?.root) {
    return {
      root: normalized,
      name: exact.name ?? null,
      defaultBranch: exact.default_branch ?? null,
    };
  }

  const rows = db
    .prepare("SELECT root, name, default_branch FROM work_repos WHERE dir_exists = 1 AND excluded = 0")
    .all() as Array<{ root: string; name: string | null; default_branch: string | null }>;
  for (const row of rows) {
    if (normalizeExistingPath(row.root) === normalized) {
      return {
        root: normalized,
        name: row.name ?? null,
        defaultBranch: row.default_branch ?? null,
      };
    }
  }

  return null;
}

function validateProtectedBaseBranch(
  db: Db,
  repo: { root: string; defaultBranch: string | null },
  baseBranch: string
): void {
  const protectedBranches = new Set(
    readProtectedBranches(db).map((branch) => branch.trim()).filter(Boolean)
  );
  if (repo.defaultBranch) {
    protectedBranches.add(repo.defaultBranch);
  }
  if (!protectedBranches.has(baseBranch)) {
    throw new AuthExecutionContextError(
      `Invalid 'base_branch' for auth merge execution context: ${baseBranch} is not a protected/default branch for ${repo.root}.`
    );
  }
}

function readProtectedBranches(db: Db): string[] {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'protected_branches'")
      .get() as { value?: string } | undefined;
    return String(row?.value ?? "main,develop").split(",");
  } catch {
    return ["main", "develop"];
  }
}

/**
 * Issue 2205073 — `git show-ref --verify --quiet` answers "this ref is absent"
 * with exit status 1 and nothing else. Only that answer justifies claiming the
 * branch does not exist; a timeout, a spawn errno, or any other git status
 * (128 = repository-level fatal) is reported as what it is.
 */
function verifyLocalBranch(
  repoRoot: string,
  field: "base_branch" | "head_branch",
  branch: string
): void {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoRoot,
      timeout: GIT_REF_TIMEOUT_MS,
      env: authGitEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    const failure = classifyGitFailure(error, GIT_REF_TIMEOUT_MS);
    if (failure.kind === "exit" && failure.status === 1) {
      throw new AuthExecutionContextError(
        `Invalid '${field}' for auth merge execution context: local branch '${branch}' does not exist in ${repoRoot}.`
      );
    }
    throw new AuthExecutionContextError(
      `Unable to verify '${field}' branch '${branch}' in ${repoRoot}: ${describeGitFailure(failure)}`
    );
  }
}

function verifyHeadAheadOfBase(repoRoot: string, baseBranch: string, headBranch: string): void {
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["rev-list", "--count", `refs/heads/${baseBranch}..refs/heads/${headBranch}`],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 10000,
        env: authGitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
  } catch (error) {
    throw new AuthExecutionContextError(
      `Unable to validate auth merge branch ancestry for ${headBranch} onto ${baseBranch}: ` +
        describeGitFailure(classifyGitFailure(error, 10000))
    );
  }
  const count = Number(output);
  if (!Number.isFinite(count) || count <= 0) {
    throw new AuthExecutionContextError(
      `Invalid 'head_branch' for auth merge execution context: ${headBranch} is not ahead of ${baseBranch}.`
    );
  }
}

function resolveBaseBranchWorktree(repoRoot: string, baseBranch: string): string {
  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10000,
      env: authGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Issue 2205073 — a failed worktree listing is not evidence that the base
    // branch is unchecked-out.
    throw new AuthExecutionContextError(
      `Unable to list worktrees for ${repoRoot} while resolving base_branch '${baseBranch}': ` +
        describeGitFailure(classifyGitFailure(error, 10000))
    );
  }
  const entries = parseWorktreePorcelain(porcelain);
  const expectedBranch = `refs/heads/${baseBranch}`;
  const match = entries.find((entry) => entry.branch === expectedBranch);
  if (!match) {
    const branches = entries
      .map((entry) => entry.branch?.replace(/^refs\/heads\//, "") ?? "(detached)")
      .join(", ");
    throw new AuthExecutionContextError(
      `Auth merge execution context could not resolve base_branch '${baseBranch}' to a checked-out worktree for ${repoRoot}. Checked-out branches: ${branches || "(none)"}.`
    );
  }
  const normalized = normalizeExistingPath(match.worktree);
  if (!normalized) {
    throw new AuthExecutionContextError(
      `Auth merge execution worktree for base_branch '${baseBranch}' does not exist: ${match.worktree}`
    );
  }
  return normalized;
}

function parseWorktreePorcelain(output: string): Array<{ worktree: string; branch: string | null }> {
  const entries: Array<{ worktree: string; branch: string | null }> = [];
  let current: { worktree: string; branch: string | null } | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { worktree: line.slice("worktree ".length), branch: null };
      continue;
    }
    if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }

  if (current) {
    entries.push(current);
  }
  return entries;
}

export function normalizeExistingPath(value: string): string | null {
  try {
    return realpathSync(path.resolve(value));
  } catch {
    return null;
  }
}
