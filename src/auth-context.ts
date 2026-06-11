import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
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
}

export class AuthExecutionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthExecutionContextError";
  }
}

const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

export function isAuthMergeCommand(input: AuthMergeContextInput): boolean {
  const command = input.command ?? "";
  return command.includes("auth merge") || command.includes("auth-merge");
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

  const executionCwd = resolveBaseBranchWorktree(repo.root, baseBranch);
  return {
    targetRepoRoot: repo.root,
    executionCwd,
    repoName: repo.name,
    baseBranch,
    headBranch,
  };
}

function requireValidBranch(field: "base_branch" | "head_branch", value: string | null): string {
  if (!value) {
    throw new AuthExecutionContextError(
      `Auth merge requests require '${field}' so the server can resolve execution context.`
    );
  }
  if (
    !SAFE_BRANCH_NAME.test(value) ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".")
  ) {
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
    throw new AuthExecutionContextError(
      "Auth merge requests require target_repo_root or cwd; raw-route submissions must identify a registered work repo."
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

function normalizeExistingPath(value: string): string | null {
  try {
    return realpathSync(path.resolve(value));
  } catch {
    return null;
  }
}
