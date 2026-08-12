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
 * byte sequences are executable. Hierarchical/multi-source commands have no
 * canonical form (no per-source reviewed head exists — issue fff66b9) and are
 * therefore not approvable through the queue.
 */
export function canonicalAuthMergeCommands(
  headBranch: string | null | undefined,
  baseBranch: string | null | undefined,
): string[] {
  if (!headBranch || !baseBranch) return [];
  if (!isSafeBranchName(headBranch) || !isSafeBranchName(baseBranch)) return [];
  const core = `auth merge ${headBranch} --into ${baseBranch}`;
  const prefixes = ["mandible", path.join(os.homedir(), ".dotfiles/bin/mandible")];
  const commands: string[] = [];
  for (const prefix of prefixes) {
    commands.push(`${prefix} ${core}`);
    commands.push(`${prefix} ${core} --preserve-head-branch`);
  }
  return commands;
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

export function repoRootFromGitCommonDir(cwd: string): string | null {
  try {
    const gitCommonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf-8", timeout: 5000 }
    ).trim();
    return gitCommonDir ? path.dirname(gitCommonDir) : null;
  } catch {
    return null;
  }
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
  try {
    const sha = execFileSync(
      "git",
      ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
      { cwd: repoRoot, encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (sha) {
      return sha;
    }
  } catch {
    throw new AuthExecutionContextError(
      `Unable to resolve auth merge head commit for ${branch}.`
    );
  }
  throw new AuthExecutionContextError(
    `Unable to resolve auth merge head commit for ${branch}.`
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

  const cwdRepoRoot = repoRootFromGitCommonDir(cwd);
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

function verifyLocalBranch(
  repoRoot: string,
  field: "base_branch" | "head_branch",
  branch: string
): void {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoRoot,
      timeout: 5000,
    });
  } catch {
    throw new AuthExecutionContextError(
      `Invalid '${field}' for auth merge execution context: local branch '${branch}' does not exist in ${repoRoot}.`
    );
  }
}

function verifyHeadAheadOfBase(repoRoot: string, baseBranch: string, headBranch: string): void {
  try {
    const count = Number(
      execFileSync(
        "git",
        ["rev-list", "--count", `refs/heads/${baseBranch}..refs/heads/${headBranch}`],
        { cwd: repoRoot, encoding: "utf-8", timeout: 10000 }
      ).trim()
    );
    if (!Number.isFinite(count) || count <= 0) {
      throw new AuthExecutionContextError(
        `Invalid 'head_branch' for auth merge execution context: ${headBranch} is not ahead of ${baseBranch}.`
      );
    }
  } catch (error) {
    if (error instanceof AuthExecutionContextError) {
      throw error;
    }
    throw new AuthExecutionContextError(
      `Unable to validate auth merge branch ancestry for ${headBranch} onto ${baseBranch}.`
    );
  }
}

function resolveBaseBranchWorktree(repoRoot: string, baseBranch: string): string {
  const entries = parseWorktreePorcelain(
    execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10000,
    })
  );
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
