import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AuthRequest } from "./types.js";

const MAX_DIFF_BYTES = 102400;

export interface ArtifactRebuildResult {
  changed: boolean;
  committed: boolean;
  commit_sha: string | null;
  output: string;
  files_changed: number;
  additions: number;
  deletions: number;
  diff_summary: string;
  commit_message: string;
}

export class ArtifactRebuildError extends Error {
  readonly output: string;

  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

function runShell(cwd: string, command: string): { status: number; output: string } {
  const result = spawnSync("bash", ["-lc", command], {
    cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function parseWorktreeForBranch(repoCwd: string, branch: string): string | null {
  const output = runGit(repoCwd, ["worktree", "list", "--porcelain"]);
  let currentWorktree = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentWorktree = line.slice("worktree ".length);
    } else if (line === `branch refs/heads/${branch}`) {
      return currentWorktree || null;
    }
  }
  return null;
}

function parseShortstat(shortstat: string): {
  files_changed: number;
  additions: number;
  deletions: number;
} {
  const files = shortstat.match(/(\d+) files? changed/)?.[1] ?? "0";
  const additions = shortstat.match(/(\d+) insertions?\(\+\)/)?.[1] ?? "0";
  const deletions = shortstat.match(/(\d+) deletions?\(-\)/)?.[1] ?? "0";
  return {
    files_changed: Number(files),
    additions: Number(additions),
    deletions: Number(deletions),
  };
}

function collectMetadata(cwd: string, baseBranch: string, headBranch: string): {
  files_changed: number;
  additions: number;
  deletions: number;
  diff_summary: string;
  commit_message: string;
} {
  const shortstat = runGit(cwd, ["diff", "--shortstat", `${baseBranch}..${headBranch}`]);
  const stats = parseShortstat(shortstat);
  const fullDiff = runGit(cwd, ["diff", `${baseBranch}..${headBranch}`]);
  const diff_summary = fullDiff.length > MAX_DIFF_BYTES
    ? `${fullDiff.slice(0, MAX_DIFF_BYTES)}\n... [truncated: ${fullDiff.length} bytes total, showing first ${MAX_DIFF_BYTES}]`
    : fullDiff;
  const commit_message = runGit(cwd, ["log", "--format=- %s", `${baseBranch}..${headBranch}`])
    .split("\n")
    .filter(Boolean)
    .slice(0, 20)
    .join("\n") || `Merge ${headBranch}`;
  return { ...stats, diff_summary, commit_message };
}

function onlyGeneratedArtifactPaths(paths: string[]): boolean {
  return paths.every((file) => file.startsWith("dist/") || file.startsWith("ui/dist/"));
}

function ensureTemporaryNodeModules(branchWorktree: string, repoCwd: string): (() => void) | null {
  const branchNodeModules = path.join(branchWorktree, "node_modules");
  if (fs.existsSync(branchNodeModules)) {
    return null;
  }
  const repoNodeModules = path.join(repoCwd, "node_modules");
  if (!fs.existsSync(repoNodeModules)) {
    return null;
  }
  fs.symlinkSync(repoNodeModules, branchNodeModules, "dir");
  return () => {
    try {
      fs.rmSync(branchNodeModules, { force: true });
    } catch {
      // Best-effort cleanup. A leftover symlink will be caught by the dirty
      // worktree check before committing artifacts.
    }
  };
}

export function rebuildArtifactsForRequest(request: AuthRequest): ArtifactRebuildResult {
  const repoCwd = request.cwd;
  const headBranch = request.head_branch;
  const baseBranch = request.base_branch;
  if (!repoCwd || !headBranch || !baseBranch) {
    throw new ArtifactRebuildError(
      "Artifact rebuild requires cwd, head_branch, and base_branch metadata.",
      ""
    );
  }
  if (request.repo !== "mandible" || request.type !== "merge") {
    throw new ArtifactRebuildError("Artifact rebuild is only available for Mandible merge requests.", "");
  }

  let output = "[artifact-rebuild] locating submitted branch worktree\n";
  const branchWorktree = parseWorktreeForBranch(repoCwd, headBranch);
  if (!branchWorktree) {
    throw new ArtifactRebuildError(
      `No worktree found for branch ${headBranch}. Rebuild artifacts from the branch worktree before approval.`,
      output
    );
  }

  const status = runGit(branchWorktree, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new ArtifactRebuildError(
      `Branch worktree is dirty; refusing to rebuild artifacts for ${headBranch}.`,
      `${output}${status}`
    );
  }

  const buildCommand = process.env.MANDIBLE_ARTIFACT_REBUILD_COMMAND ?? "npm run build";
  output += `[artifact-rebuild] running in ${branchWorktree}: ${buildCommand}\n`;
  const cleanupNodeModules = ensureTemporaryNodeModules(branchWorktree, repoCwd);
  if (cleanupNodeModules) {
    output += "[artifact-rebuild] using protected checkout node_modules for this build\n";
  }
  try {
    const build = runShell(branchWorktree, buildCommand);
    output += build.output;
    if (build.status !== 0) {
      throw new ArtifactRebuildError("Artifact rebuild command failed.", output);
    }
  } finally {
    cleanupNodeModules?.();
  }

  runGit(branchWorktree, ["add", "-f", "--", "dist", "ui/dist"]);
  const stagedFiles = runGit(branchWorktree, ["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean);
  if (!onlyGeneratedArtifactPaths(stagedFiles)) {
    throw new ArtifactRebuildError(
      "Artifact rebuild staged non-generated files; refusing to continue.",
      `${output}${stagedFiles.join("\n")}\n`
    );
  }

  if (stagedFiles.length === 0) {
    output += "[artifact-rebuild] generated artifacts already match the branch\n";
    return {
      changed: false,
      committed: false,
      commit_sha: null,
      output,
      ...collectMetadata(branchWorktree, baseBranch, headBranch),
    };
  }

  const nonGeneratedDirty = runGit(branchWorktree, ["status", "--porcelain"])
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const file = line.slice(3);
      return !file.startsWith("dist/") && !file.startsWith("ui/dist/");
    });
  if (nonGeneratedDirty.length > 0) {
    throw new ArtifactRebuildError(
      "Artifact rebuild changed non-generated files; refusing to commit.",
      `${output}${nonGeneratedDirty.join("\n")}\n`
    );
  }

  const signingKey = process.env.MANDIBLE_ARTIFACT_SIGNING_KEY
    ?? path.join(os.homedir(), ".ssh", "id_ed25519_agents.pub");
  const commitArgs = fs.existsSync(signingKey)
    ? ["-c", `user.signingkey=${signingKey}`, "commit", "-m", "build Mandible artifacts"]
    : ["commit", "-m", "build Mandible artifacts"];
  output += "[artifact-rebuild] committing generated artifacts on submitted branch\n";
  const commit = spawnSync("git", commitArgs, {
    cwd: branchWorktree,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  output += `${commit.stdout ?? ""}${commit.stderr ?? ""}`;
  if (commit.status !== 0) {
    throw new ArtifactRebuildError("Artifact rebuild commit failed.", output);
  }

  const commitSha = runGit(branchWorktree, ["rev-parse", "HEAD"]).trim();
  return {
    changed: true,
    committed: true,
    commit_sha: commitSha,
    output,
    ...collectMetadata(branchWorktree, baseBranch, headBranch),
  };
}
