import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Db } from "./db.js";
import type { BranchKeptReason, BranchRemovalOutput } from "./notices/contract.js";
import { trashBranch, TrashServiceError } from "./trash-service.js";

/** One landed branch's removal record, as stored in the merge finalizer state. */
export type BranchRemoval = BranchRemovalOutput["branches"][number];

/** Where a merge landed and what it closed: the inputs every removal of its branches shares. */
export interface MergeLanding {
  checkoutRoot: string;
  target: string;
  issueRefs: readonly string[];
}

const execFileAsync = promisify(execFile);

const KEPT_BY_TRASH_CODE: Readonly<Record<string, BranchKeptReason>> = {
  branch_not_merged: "not_merged",
  protected_branch: "protected",
  invalid_merge_target: "protected",
  current_worktree: "protected",
  app_managed_worktree: "app_managed",
  preview_worktree_owned: "preview_running",
  preview_custody_unavailable: "preview_running",
};

const RETRIED_KEPT_REASONS: ReadonlySet<BranchKeptReason> = new Set(["preview_running", "trash_refused"]);

/** Kept branches whose blocker can clear without their owner; the daemon retries them. */
export function isRetriedKeptBranch(entry: BranchRemoval): boolean {
  return entry.result === "kept" && entry.reason !== null && RETRIED_KEPT_REASONS.has(entry.reason);
}

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").filter(Boolean);
}

/** The top level of the checkout a merge ran in. Throws when Git cannot name it. */
export async function checkoutTopLevel(cwd: string): Promise<string> {
  const [root] = await gitLines(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error(`git cannot name the checkout of ${cwd}`);
  return root;
}

async function worktreesByBranch(root: string): Promise<Map<string, string>> {
  const byBranch = new Map<string, string>();
  let worktree: string | null = null;
  for (const line of await gitLines(root, ["worktree", "list", "--porcelain"])) {
    if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && worktree) byBranch.set(line.slice("branch refs/heads/".length), worktree);
  }
  return byBranch;
}

/**
 * The local branches a merge landed, each `pending`: the head branch unless the
 * request preserves it, its `<head>__*` children, then the given work-unit
 * branches. Names absent from the checkout are not candidates.
 */
export async function listLandedBranches(
  root: string,
  head: string | null,
  preserveHead: boolean,
  workUnitBranches: readonly string[],
): Promise<BranchRemoval[]> {
  const local = await gitLines(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  const present = new Set(local);
  const children = head ? local.filter(branch => branch.startsWith(`${head}__`)).sort() : [];
  const ordered = [...(head && !preserveHead ? [head] : []), ...children, ...[...workUnitBranches].sort()];
  const worktrees = await worktreesByBranch(root);
  return [...new Set(ordered)].filter(branch => present.has(branch)).map(branch => ({
    branch, result: "pending", reason: null, worktree_path: worktrees.get(branch) ?? null,
  }));
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await gitLines(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

/**
 * Remove one landed branch and its worktree through the trash service, and
 * return its new record. A branch already gone from the checkout is removed.
 * Every refusal becomes a kept reason; `error` carries the refusal's message
 * when it was not one the trash service names.
 */
export async function removeLandedBranch(
  db: Db,
  landing: MergeLanding,
  entry: BranchRemoval,
): Promise<{ entry: BranchRemoval; error: string | null }> {
  try {
    if (!await branchExists(landing.checkoutRoot, entry.branch)) {
      return { entry: { ...entry, result: "removed", reason: null }, error: null };
    }
    const removal = await trashBranch(db, {
      project: landing.checkoutRoot,
      checkout_root: landing.checkoutRoot,
      branch: entry.branch,
      reason: "merged",
      actor: "merge-finalizer",
      merged_into: landing.target,
      issue_refs: [...landing.issueRefs],
    });
    return {
      entry: { ...entry, result: removal.result, reason: null, worktree_path: removal.outcome.worktree_path ?? entry.worktree_path },
      error: null,
    };
  } catch (error) {
    const named = error instanceof TrashServiceError ? KEPT_BY_TRASH_CODE[error.code] : undefined;
    return {
      entry: { ...entry, result: "kept", reason: named ?? "trash_refused" },
      error: named ? null : error instanceof Error ? error.message : String(error),
    };
  }
}
