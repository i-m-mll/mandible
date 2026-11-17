/**
 * Issue a7cc881 — the operator's direct commit: a checkout's staged changes,
 * committed onto its protected branch as `git commit` would, but signed with
 * the approval key so the protected-branch guard accepts it.
 *
 * This module reads the checkout and moves the branch; the auth queue signs
 * and records (AuthQueue.commitAsOperator).
 */

import fs from "node:fs";
import path from "node:path";

import { authGitEnv } from "./auth-context.js";
import { observeChild } from "./child-observation.js";
import type { Db } from "./db.js";
import { buildProtectedBranchGuardProjection } from "./protected-branch-guard.js";

/** A checkout on a protected branch whose index differs from the branch tip. */
export interface StagedCommit {
  /** The worktree whose index is committed. */
  checkout: string;
  /** The repository's main checkout root, which names the repository. */
  repoRoot: string;
  repo: string;
  branch: string;
  parent: string;
  tree: string;
  files: number;
  additions: number;
  deletions: number;
  /** Unified diff of the staged changes, truncated like a merge request's. */
  diff: string;
}

export type StagedCommitResult = { ok: true; value: StagedCommit } | { ok: false; error: string };

const MAX_DIFF_BYTES = 102_400;

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  const result = await observeChild("git", args, {
    cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: authGitEnv(),
  });
  return result.status === 0 && !result.error
    ? { ok: true, stdout: result.stdout }
    : { ok: false, stderr: (result.stderr || result.error?.message || `git exited ${result.status}`).trim() };
}

/**
 * The staged commit `cwd` would make, or why it cannot: not a checkout, not on
 * a branch, the branch is not protected (plain `git commit` works there), or
 * nothing is staged. Reading it writes the index's tree objects and nothing else.
 */
export async function readStagedCommit(db: Db, cwd: string): Promise<StagedCommitResult> {
  const refuse = (error: string): StagedCommitResult => ({ ok: false, error: `${error} Nothing was committed.` });
  if (!path.isAbsolute(cwd) || !fs.existsSync(cwd)) return refuse(`${cwd} is not a directory.`);
  const top = await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (!top.ok) return refuse(`${cwd} is not a Git checkout.`);
  const [checkout = "", commonDir = ""] = top.stdout.trim().split("\n");
  const head = await git(checkout, ["symbolic-ref", "-q", "HEAD"]);
  if (!head.ok || !head.stdout.trim().startsWith("refs/heads/")) return refuse("HEAD is not on a branch.");
  const ref = head.stdout.trim();
  const branch = ref.slice("refs/heads/".length);
  const realCommonDir = fs.realpathSync.native(commonDir);
  const protectedRef = buildProtectedBranchGuardProjection(db).protectedRefs
    .some(([dir, protectedName]) => dir === realCommonDir && protectedName === ref);
  if (!protectedRef) return refuse(`${branch} is not a protected branch here; use git commit.`);
  const parent = await git(checkout, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (!parent.ok) return refuse(`${branch} has no commits yet.`);
  const tree = await git(checkout, ["write-tree"]);
  if (!tree.ok) return refuse(`The index cannot be committed: ${tree.stderr}`);
  const parentSha = parent.stdout.trim();
  const treeSha = tree.stdout.trim();
  const parentTree = await git(checkout, ["rev-parse", `${parentSha}^{tree}`]);
  if (!parentTree.ok) return refuse(`Cannot read ${branch}: ${parentTree.stderr}`);
  if (parentTree.stdout.trim() === treeSha) return refuse("No changes are staged.");
  const numstat = await git(checkout, ["diff-tree", "-r", "--numstat", parentSha, treeSha]);
  const diff = await git(checkout, ["diff-tree", "-r", "-p", "--full-index", parentSha, treeSha]);
  if (!numstat.ok || !diff.ok) return refuse("Cannot read the staged changes.");
  const rows = numstat.stdout.split("\n").filter(Boolean).map((line) => line.split("\t"));
  const count = (column: 0 | 1) => rows.reduce((sum, row) => sum + (Number.parseInt(row[column] ?? "", 10) || 0), 0);
  const bytes = Buffer.byteLength(diff.stdout);
  const repoRoot = path.dirname(realCommonDir);
  return {
    ok: true,
    value: {
      checkout,
      repoRoot,
      repo: path.basename(repoRoot),
      branch,
      parent: parentSha,
      tree: treeSha,
      files: rows.length,
      additions: count(0),
      deletions: count(1),
      diff: bytes > MAX_DIFF_BYTES
        ? `${Buffer.from(diff.stdout).subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n... [truncated: ${bytes} bytes total, showing first ${MAX_DIFF_BYTES}]`
        : diff.stdout,
    },
  };
}

/**
 * The message as `git commit -m` stores it: trailing whitespace removed from
 * each line, runs of blank lines collapsed, leading and trailing blank lines
 * dropped, one final newline. Null when nothing is left.
 */
export function cleanCommitMessage(raw: string): string | null {
  if (raw.includes("\0")) return null;
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/\s+$/, ""));
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept.at(-1) === "")) continue;
    kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();
  return kept.length ? `${kept.join("\n")}\n` : null;
}

/** The Touch ID sheet's reason: the action, repository, branch, subject and size. */
export function directCommitReason(staged: StagedCommit, message: string): string {
  const subject = message.split("\n", 1)[0]!;
  const shown = subject.length > 72 ? `${subject.slice(0, 71)}…` : subject;
  const files = `${staged.files} ${staged.files === 1 ? "file" : "files"} changed`;
  return `commit directly to ${staged.branch} of ${staged.repo}: "${shown}" (${files})`;
}

/**
 * Move the branch from the parent to `commitSha`, only while the checkout is
 * still on that branch and the branch still points at the parent. The index
 * already holds the commit's tree, so the checkout is left on the new tip with
 * its unstaged and untracked changes as they were.
 */
export async function publishDirectCommit(staged: StagedCommit, commitSha: string, message: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ref = `refs/heads/${staged.branch}`;
  const head = await git(staged.checkout, ["symbolic-ref", "-q", "HEAD"]);
  if (!head.ok || head.stdout.trim() !== ref) return { ok: false, error: `HEAD moved off ${staged.branch} before the commit was published. Nothing was committed.` };
  const subject = message.split("\n", 1)[0]!;
  const moved = await git(staged.checkout, ["update-ref", "-m", `mandible commit: ${subject}`, ref, commitSha, staged.parent]);
  return moved.ok
    ? { ok: true }
    : { ok: false, error: `${staged.branch} moved before the commit was published. Nothing was committed.` };
}
