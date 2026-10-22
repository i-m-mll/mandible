import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { Db } from "./db.js";
import { protectedBranchNames } from "./protected-branches.js";
import { resolveProjectRef, type RegistryCheckout, type RegistryProject } from "./ledger/project-registry.js";
import { isPreservedAppWorktreePath } from "./worktree-preservation.js";
import { parseJsonObject } from "./row-coerce.js";
import {
  classifyIgnored,
  ignoredStatusPaths,
  readIgnoredPolicy,
  type IgnoredFile,
} from "./trash-ignored.js";

export const TRASH_RETENTION_POLICY = "trash-retention.v1";
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

export type TrashReason = "superseded" | "merged" | "abandoned" | "manual";
export type TrashState =
  | "active"
  | "remove_failed"
  | "restored"
  | "expired"
  | "restore_failed"
  | "gc_pending"
  | "gc_failed";

export interface TrashEntry {
  id: string;
  project_id: string;
  project_key: string;
  checkout_id: string;
  repo_root: string;
  branch: string;
  issue_refs: string[];
  reason: TrashReason;
  actor: string;
  snapshot_ref: string;
  snapshot_oid: string;
  original_oid: string;
  retention_policy: typeof TRASH_RETENTION_POLICY;
  retention_days: number;
  state: TrashState;
  created_at: number;
  expires_at: number;
  restored_at: number | null;
  expired_at: number | null;
  last_error: string | null;
  outcome: Record<string, unknown>;
}

export interface TrashCreateInput {
  project: string;
  branch: string;
  reason: TrashReason;
  actor?: string;
  issue_refs?: string[];
  checkout_root?: string;
  retention_days?: number;
  merged_into?: string;
}

export interface TrashRestoreInput {
  worktree_path?: string;
  actor?: string;
}

export class TrashServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TrashServiceError";
  }
}

interface TrashRow {
  id: string;
  project_id: string;
  project_key: string;
  checkout_id: string;
  repo_root: string;
  branch: string;
  issue_refs_json: string;
  reason: TrashReason;
  actor: string;
  snapshot_ref: string;
  snapshot_oid: string;
  original_oid: string;
  retention_policy: typeof TRASH_RETENTION_POLICY;
  retention_days: number;
  state: TrashState;
  created_at: number;
  expires_at: number;
  restored_at: number | null;
  expired_at: number | null;
  last_error: string | null;
  outcome_json: string;
}

interface GitWorktree {
  path: string;
  branch: string | null;
}

/**
 * Ignored files kept in trash custody. They live in a parentless commit under
 * their own ref, separate from the tracked snapshot, because restore makes the
 * snapshot commit the branch tip and ignored bytes must never enter the branch.
 */
export interface IgnoredCustody {
  kept: number;
  skipped: number;
  refused: number;
  kept_bytes: number;
  limit_bytes: number | null;
  kept_paths: string[];
  kept_paths_truncated: boolean;
  ref: string | null;
  oid: string | null;
}

export interface TrashCreateOutcome {
  worktree_removed: boolean;
  branch_removed: boolean;
  worktree_path: string | null;
  merge_evidence: MergeEvidence | null;
  ignored: IgnoredCustody;
}

const IGNORED_PATH_REPORT_LIMIT = 50;
const TRASH_IDENTITY = {
  GIT_AUTHOR_NAME: "Mandible Trash",
  GIT_AUTHOR_EMAIL: "trash@mandible.local",
  GIT_COMMITTER_NAME: "Mandible Trash",
  GIT_COMMITTER_EMAIL: "trash@mandible.local",
};

function ignoredCustodyRef(entryId: string): string {
  return `refs/mandible/trash-ignored/${entryId}`;
}

function git(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; input?: string } = {},
): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      ...options.env,
    },
  });
  if (result.error) {
    throw new TrashServiceError(result.error.message, "git_unavailable", 500);
  }
  if (result.status !== 0) {
    if (options.allowFailure) return "";
    const message = (result.stderr || result.stdout || `git exited ${result.status}`).trim();
    throw new TrashServiceError(message, "git_failed", 409, { args });
  }
  return result.stdout.trim();
}

function parseWorktrees(repoRoot: string): GitWorktree[] {
  const raw = git(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
  const records = raw.split("\0\0").filter(Boolean);
  return records.map((record) => {
    let worktreePath = "";
    let branch: string | null = null;
    for (const field of record.split("\0")) {
      if (field.startsWith("worktree ")) worktreePath = field.slice("worktree ".length);
      if (field.startsWith("branch refs/heads/")) branch = field.slice("branch refs/heads/".length);
    }
    return { path: worktreePath, branch };
  }).filter((entry) => entry.path !== "");
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateNewWorktreePath(repoRoot: string, requested: string): string {
  const requestedPath = path.resolve(requested);
  if (fs.existsSync(requestedPath)) {
    throw new TrashServiceError("worktree_path must not already exist", "worktree_path_exists", 409);
  }

  let existingParent = path.dirname(requestedPath);
  while (!fs.existsSync(existingParent)) {
    const next = path.dirname(existingParent);
    if (next === existingParent) break;
    existingParent = next;
  }
  let realRepoRoot: string;
  let realParent: string;
  try {
    realRepoRoot = fs.realpathSync(repoRoot);
    realParent = fs.realpathSync(existingParent);
  } catch {
    throw new TrashServiceError(
      "worktree_path parent cannot be resolved safely",
      "invalid_worktree_path",
      409,
    );
  }
  if (realParent !== realRepoRoot && !isInside(realRepoRoot, realParent)) {
    throw new TrashServiceError(
      "worktree_path must remain inside the registered checkout after resolving symlinks",
      "invalid_worktree_path",
      409,
    );
  }
  return requestedPath;
}

function validateBranch(repoRoot: string, branch: string): string {
  const value = branch.trim();
  if (!value || value.startsWith("refs/") || value === "HEAD") {
    throw new TrashServiceError("branch must be a normal local branch name", "invalid_branch");
  }
  git(repoRoot, ["check-ref-format", "--branch", value]);
  return value;
}

function resolveProject(db: Db, ref: string): RegistryProject {
  const result = resolveProjectRef(db, ref);
  if ((!result.ok && result.reason === "ambiguous")) {
    throw new TrashServiceError(`ambiguous project ref: ${ref}`, "ambiguous_project", 409, {
      candidates: result.candidates ?? [],
    });
  }
  if (!result.ok) {
    throw new TrashServiceError(`project not found: ${ref}`, "project_not_found", 404);
  }
  if (result.matched_by === "work_repo_id") {
    throw new TrashServiceError(
      "path-derived work_repo_id cannot authorize trash custody; use a canonical project ref",
      "noncanonical_project_ref",
      409,
      { matched_by: result.matched_by },
    );
  }
  return result.project;
}

function branchOid(repoRoot: string, branch: string): string | null {
  const ref = `refs/heads/${branch}`;
  return git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
    allowFailure: true,
  }) || null;
}

function chooseCheckout(
  project: RegistryProject,
  branch: string,
  checkoutRoot?: string,
): RegistryCheckout {
  if (checkoutRoot) {
    const normalized = path.resolve(checkoutRoot);
    const checkout = project.checkouts.find((candidate) => path.resolve(candidate.root) === normalized);
    if (!checkout) {
      throw new TrashServiceError(
        "checkout_root is not registered to the canonical project",
        "checkout_not_registered",
        409,
      );
    }
    if (!fs.existsSync(checkout.root) || !branchOid(checkout.root, branch)) {
      throw new TrashServiceError("branch is not present in the selected checkout", "branch_not_found", 404);
    }
    return checkout;
  }

  const candidates = project.checkouts.filter(
    (checkout) => fs.existsSync(checkout.root) && branchOid(checkout.root, branch) !== null,
  );
  if (candidates.length === 0) {
    throw new TrashServiceError("branch not found in a registered project checkout", "branch_not_found", 404);
  }
  if (candidates.length > 1) {
    throw new TrashServiceError(
      "branch exists in multiple registered checkouts; checkout_root is required",
      "ambiguous_checkout",
      409,
      { roots: candidates.map((checkout) => checkout.root) },
    );
  }
  return candidates[0];
}

function indexGitlinks(cwd: string, env?: NodeJS.ProcessEnv): Map<string, string> {
  const output = git(cwd, ["ls-files", "--stage", "-z"], { env });
  const gitlinks = new Map<string, string>();
  for (const record of output.split("\0")) {
    const match = record.match(/^160000 ([0-9a-f]+) [0-3]\t([\s\S]+)$/);
    if (match) gitlinks.set(match[2], match[1]);
  }
  return gitlinks;
}

function commitGitlinks(cwd: string, commitOid: string): Map<string, string> {
  const output = git(cwd, ["ls-tree", "-r", "-z", commitOid]);
  const gitlinks = new Map<string, string>();
  for (const record of output.split("\0")) {
    const match = record.match(/^160000 commit ([0-9a-f]+)\t([\s\S]+)$/);
    if (match) gitlinks.set(match[2], match[1]);
  }
  return gitlinks;
}

function assertTrackedGitlinksClean(worktreePath: string, gitlinks: Map<string, string>): void {
  for (const relativePath of gitlinks.keys()) {
    const nestedPath = path.join(worktreePath, relativePath);
    if (!fs.existsSync(path.join(nestedPath, ".git"))) continue;
    const result = spawnSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
      {
        cwd: nestedPath,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    if (result.status !== 0) {
      throw new TrashServiceError(
        `cannot inspect nested repository before trashing: ${relativePath}`,
        "nested_repository_unknown",
        409,
        { path: relativePath },
      );
    }
    if (result.stdout.trim()) {
      throw new TrashServiceError(
        `dirty submodule cannot be snapshotted losslessly: ${relativePath}`,
        "dirty_submodule",
        409,
        { path: relativePath },
      );
    }
  }
}

function captureWorktreeTree(
  worktreePath: string,
  originalOid: string,
  entryId: string,
): { dirty: boolean; tree: string } {
  const status = git(worktreePath, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
  ]);
  if (!status) {
    return { dirty: false, tree: git(worktreePath, ["rev-parse", `${originalOid}^{tree}`]) };
  }

  const indexPath = path.join(os.tmpdir(), `mandible-trash-index-${entryId}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const originalGitlinks = commitGitlinks(worktreePath, originalOid);
    assertTrackedGitlinksClean(worktreePath, originalGitlinks);
    git(worktreePath, ["read-tree", originalOid], { env });
    git(worktreePath, ["add", "-A", "--", "."], { env });
    const capturedGitlinks = indexGitlinks(worktreePath, env);
    const embedded = [...capturedGitlinks.keys()].filter((candidate) => !originalGitlinks.has(candidate));
    if (embedded.length > 0) {
      throw new TrashServiceError(
        `embedded repositories cannot be snapshotted losslessly: ${embedded.join(", ")}`,
        "embedded_repository",
        409,
        { paths: embedded },
      );
    }
    const advanced = [...capturedGitlinks].flatMap(([gitlinkPath, capturedOid]) => {
      const originalGitlinkOid = originalGitlinks.get(gitlinkPath);
      return originalGitlinkOid && originalGitlinkOid !== capturedOid
        ? [{ path: gitlinkPath, original_oid: originalGitlinkOid, captured_oid: capturedOid }]
        : [];
    });
    if (advanced.length > 0) {
      throw new TrashServiceError(
        `advanced tracked gitlinks cannot be snapshotted losslessly: ${advanced.map((item) => item.path).join(", ")}`,
        "advanced_gitlink",
        409,
        { gitlinks: advanced },
      );
    }
    const tree = git(worktreePath, ["write-tree"], { env });
    return { dirty: true, tree };
  } finally {
    fs.rmSync(indexPath, { force: true });
    fs.rmSync(`${indexPath}.lock`, { force: true });
  }
}

interface IgnoredPlan {
  kept: IgnoredFile[];
  skipped: number;
  keptBytes: number;
  limitBytes: number;
}

const NO_WORKTREE_IGNORED: IgnoredCustody = {
  kept: 0,
  skipped: 0,
  refused: 0,
  kept_bytes: 0,
  limit_bytes: null,
  kept_paths: [],
  kept_paths_truncated: false,
  ref: null,
  oid: null,
};

/**
 * Decide, before anything is removed, which ignored files trash must keep.
 * Refuses the whole removal when the unique ignored bytes exceed the limit or
 * cannot be stored in Git, so the worktree stays untouched.
 */
function planIgnored(repoRoot: string, worktreePath: string): IgnoredPlan {
  const policyResult = readIgnoredPolicy(repoRoot);
  if (!policyResult.ok) {
    throw new TrashServiceError(
      `invalid [trash.ignored] config in ${policyResult.source}: ${policyResult.error}`,
      "invalid_repo_config",
      409,
      { source: policyResult.source },
    );
  }
  const { policy } = policyResult;
  const status = git(worktreePath, [
    "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal",
    "--ignore-submodules=none",
  ]);
  const classification = classifyIgnored(worktreePath, ignoredStatusPaths(status), policy);
  const overLimit = classification.keptBytes > policy.maxPreservedBytes;
  if (overLimit || classification.unpreservable.length > 0) {
    const largest = [...classification.kept].sort((left, right) => right.bytes - left.bytes);
    const refused = classification.kept.length + classification.unpreservable.length;
    const reasons = [
      ...(overLimit
        ? [`${classification.kept.length} ignored files total ${classification.keptBytes} bytes, over the ${policy.maxPreservedBytes}-byte limit`]
        : []),
      ...(classification.unpreservable.length > 0
        ? [`${classification.unpreservable.length} ignored entries cannot be stored in Git`]
        : []),
    ];
    throw new TrashServiceError(
      `refusing to remove worktree with unpreserved ignored files: ${reasons.join("; ")}. Nothing was removed.`,
      "ignored_files_refused",
      409,
      {
        outcome: { worktree_removed: false, branch_removed: false, worktree_path: worktreePath },
        ignored: {
          kept: 0,
          skipped: classification.skipped,
          refused,
          total_bytes: classification.keptBytes,
          limit_bytes: policy.maxPreservedBytes,
          files: largest.slice(0, IGNORED_PATH_REPORT_LIMIT)
            .map((file) => ({ path: file.path, bytes: file.bytes })),
          files_truncated: largest.length > IGNORED_PATH_REPORT_LIMIT,
          unpreservable: classification.unpreservable.slice(0, IGNORED_PATH_REPORT_LIMIT),
          config_source: policyResult.source,
        },
      },
    );
  }
  return {
    kept: classification.kept,
    skipped: classification.skipped,
    keptBytes: classification.keptBytes,
    limitBytes: policy.maxPreservedBytes,
  };
}

function captureIgnored(worktreePath: string, kept: readonly IgnoredFile[], entryId: string): string | null {
  if (kept.length === 0) return null;
  const oids = git(worktreePath, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
    input: `${kept.map((file) => file.path).join("\n")}\n`,
  }).split("\n");
  if (oids.length !== kept.length) {
    throw new TrashServiceError("git hash-object returned an unexpected object count", "git_failed", 500);
  }
  const indexPath = path.join(os.tmpdir(), `mandible-trash-ignored-index-${entryId}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const records = kept.map((file, index) => `${file.executable ? "100755" : "100644"} ${oids[index]}\t${file.path}\0`);
    git(worktreePath, ["update-index", "--add", "-z", "--index-info"], { env, input: records.join("") });
    const tree = git(worktreePath, ["write-tree"], { env });
    return git(worktreePath, ["commit-tree", tree], {
      env: TRASH_IDENTITY,
      input: "Mandible trash ignored files\n",
    });
  } finally {
    fs.rmSync(indexPath, { force: true });
    fs.rmSync(`${indexPath}.lock`, { force: true });
  }
}

function ignoredCustody(plan: IgnoredPlan, ref: string | null, oid: string | null): IgnoredCustody {
  return {
    kept: plan.kept.length,
    skipped: plan.skipped,
    refused: 0,
    kept_bytes: plan.keptBytes,
    limit_bytes: plan.limitBytes,
    kept_paths: plan.kept.slice(0, IGNORED_PATH_REPORT_LIMIT).map((file) => file.path),
    kept_paths_truncated: plan.kept.length > IGNORED_PATH_REPORT_LIMIT,
    ref,
    oid,
  };
}

interface RecordedIgnoredCustody {
  ref: string;
  oid: string;
}

function recordedIgnoredCustody(entry: TrashEntry): RecordedIgnoredCustody | null {
  const ignored = entry.outcome.ignored;
  if (!ignored || typeof ignored !== "object") return null;
  const { ref, oid } = ignored as Partial<IgnoredCustody>;
  return typeof ref === "string" && typeof oid === "string" ? { ref, oid } : null;
}

function readBlobs(repoRoot: string, oids: readonly string[]): Buffer[] {
  if (oids.length === 0) return [];
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: `${oids.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0) {
    throw new TrashServiceError(
      `cannot read ignored-file custody: ${result.error?.message ?? result.stderr.toString().trim()}`,
      "ignored_custody_unreadable",
      409,
    );
  }
  const output = result.stdout;
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const oid of oids) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (header[0] !== oid || header[1] !== "blob") {
      throw new TrashServiceError(`ignored-file custody object is missing: ${oid}`, "ignored_custody_unreadable", 409);
    }
    const size = Number(header[2]);
    blobs.push(output.subarray(headerEnd + 1, headerEnd + 1 + size));
    offset = headerEnd + 1 + size + 1;
  }
  return blobs;
}

/**
 * Write kept ignored files back into a worktree as untracked files, byte for
 * byte, without touching its index. A path that already exists is left alone
 * and counted, so a partially removed worktree can be refilled.
 */
function materializeIgnored(
  repoRoot: string,
  custody: RecordedIgnoredCustody,
  worktreePath: string,
): { restored: number; present: number } {
  const probe = probeExactRef(repoRoot, custody.ref);
  if (probe.status !== "present" || probe.oid !== custody.oid) {
    throw new TrashServiceError(
      "ignored-file custody ref is missing or no longer matches its record",
      "ignored_custody_mismatch",
      409,
      { ref: custody.ref },
    );
  }
  const realWorktree = fs.realpathSync(worktreePath);
  const files = git(repoRoot, ["ls-tree", "-r", "-z", custody.oid]).split("\0").filter(Boolean)
    .map((record) => {
      const match = record.match(/^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/);
      if (!match) {
        throw new TrashServiceError("ignored-file custody holds a non-file entry", "ignored_custody_unreadable", 409);
      }
      return { mode: match[1], oid: match[2], path: match[3] };
    });
  const missing = files.filter((file) => {
    try {
      fs.lstatSync(path.join(realWorktree, file.path));
      return false;
    } catch {
      return true;
    }
  });
  const blobs = readBlobs(repoRoot, missing.map((file) => file.oid));
  missing.forEach((file, index) => {
    const target = path.join(realWorktree, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const realParent = fs.realpathSync(path.dirname(target));
    if (realParent !== realWorktree && !isInside(realWorktree, realParent)) {
      throw new TrashServiceError(
        `ignored file would be written outside the worktree: ${file.path}`,
        "invalid_worktree_path",
        409,
      );
    }
    fs.writeFileSync(target, blobs[index], { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
  });
  return { restored: missing.length, present: files.length - missing.length };
}

function deleteIgnoredRef(repoRoot: string, entryId: string): void {
  const ref = ignoredCustodyRef(entryId);
  const probe = probeExactRef(repoRoot, ref);
  if (probe.status === "unknown") {
    throw new TrashServiceError(`cannot inspect ignored-file custody ref: ${probe.error}`, "snapshot_probe_unknown", 409);
  }
  if (probe.status === "present") git(repoRoot, ["update-ref", "-d", ref, probe.oid]);
}

function linkedIssueRefs(db: Db, projectId: string, branch: string, explicit: string[]): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT COALESCE(NULLIF(i.short_id, ''), i.id) AS issue_ref
       FROM ledger_issues i
       LEFT JOIN issue_branches b ON b.issue_id = i.id
       LEFT JOIN work_units w ON w.ledger_issue_id = i.id
      WHERE i.project_id = ? AND (b.branch = ? OR w.branch = ?)
      ORDER BY issue_ref`,
  ).all(projectId, branch, branch) as Array<{ issue_ref: string }>;
  return [...new Set([...explicit.map((value) => value.trim()).filter(Boolean), ...rows.map((row) => row.issue_ref)])]
    .sort();
}


function mapRow(row: TrashRow): TrashEntry {
  const { issue_refs_json: issueRefsJson, outcome_json: outcomeJson, ...entry } = row;
  return {
    ...entry,
    issue_refs: JSON.parse(issueRefsJson) as string[],
    outcome: parseJsonObject(outcomeJson),
  };
}

const SELECT_ENTRY = `SELECT t.*, p.project_key
  FROM trash_entries t
  JOIN ledger_projects p ON p.id = t.project_id`;

function getEntry(db: Db, id: string): TrashEntry {
  const row = db.prepare(`${SELECT_ENTRY} WHERE t.id = ?`).get(id) as TrashRow | undefined;
  if (!row) throw new TrashServiceError(`trash entry not found: ${id}`, "trash_not_found", 404);
  return mapRow(row);
}

export function listTrashEntries(
  db: Db,
  filters: { project?: string; state?: TrashState } = {},
): TrashEntry[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.project) {
    where.push("t.project_id = ?");
    values.push(resolveProject(db, filters.project).id);
  }
  if (filters.state) {
    where.push("t.state = ?");
    values.push(filters.state);
  }
  const sql = `${SELECT_ENTRY}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
    ORDER BY t.created_at DESC, t.id`;
  return (db.prepare(sql).all(...values) as TrashRow[]).map(mapRow);
}

export type MergeEvidence = "merged" | "tree-equivalent";

/**
 * What one removal did. A branch proven merged into `merged_into` whose
 * worktree holds no unique bytes is removed outright, with no entry or refs;
 * anything else is kept in reversible trash custody.
 */
export type TrashRemoval =
  | { result: "trashed"; entry: TrashEntry; outcome: TrashCreateOutcome }
  | { result: "removed"; entry: null; outcome: TrashCreateOutcome };

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new TrashServiceError(
    (result.stderr || result.error?.message || "git merge-base failed").trim(),
    "git_failed",
    409,
  );
}

/**
 * Prove the branch contributes no bytes to `target`: either it is an ancestor,
 * or a synthetic merge reproduces the target's exact tree. `git cherry` is not
 * enough because it ignores merge-resolution tree changes.
 */
function proveMergedInto(repoRoot: string, branchTip: string, target: string): MergeEvidence {
  const targetOid = branchOid(repoRoot, target);
  if (!targetOid) throw new TrashServiceError(`merge target not found: ${target}`, "target_not_found", 404);
  if (isAncestor(repoRoot, branchTip, targetOid)) return "merged";
  const targetTree = git(repoRoot, ["rev-parse", "--verify", `${targetOid}^{tree}`]);
  const mergeTree = git(repoRoot, ["merge-tree", "--write-tree", targetOid, branchTip], { allowFailure: true })
    .split("\n")[0];
  if (mergeTree === targetTree) return "tree-equivalent";
  throw new TrashServiceError(
    `git cannot prove merged or patch-equivalent to ${target}`,
    "branch_not_merged",
    409,
    { target },
  );
}

function removeLocalBranch(
  repoRoot: string,
  worktree: GitWorktree | null,
  branch: string,
  originalOid: string,
  outcome: TrashCreateOutcome,
): void {
  if (worktree) {
    git(repoRoot, ["worktree", "remove", "--force", worktree.path]);
    outcome.worktree_removed = true;
  }
  git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`, originalOid]);
  outcome.branch_removed = true;
}

export function trashBranch(
  db: Db,
  input: TrashCreateInput,
  now = Date.now(),
): TrashRemoval {
  if (!input.project?.trim()) throw new TrashServiceError("project is required", "missing_project");
  if (!input.branch?.trim()) throw new TrashServiceError("branch is required", "missing_branch");
  if (!["superseded", "merged", "abandoned", "manual"].includes(input.reason)) {
    throw new TrashServiceError("invalid trash reason", "invalid_reason");
  }
  const retentionDays = input.retention_days ?? DEFAULT_TRASH_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new TrashServiceError("retention_days must be an integer between 1 and 3650", "invalid_retention");
  }

  const project = resolveProject(db, input.project);
  const checkout = chooseCheckout(project, input.branch.trim(), input.checkout_root);
  const branch = validateBranch(checkout.root, input.branch);
  if (protectedBranchNames(db, checkout.default_branch).has(branch)) {
    throw new TrashServiceError(`refusing to trash protected/default branch: ${branch}`, "protected_branch", 409);
  }
  const originalOid = branchOid(checkout.root, branch);
  if (!originalOid) throw new TrashServiceError(`branch not found: ${branch}`, "branch_not_found", 404);
  const mergedInto = input.merged_into?.trim() || null;
  if (mergedInto === branch) {
    throw new TrashServiceError("merged_into must name a different branch", "invalid_merge_target");
  }
  const evidence = mergedInto ? proveMergedInto(checkout.root, originalOid, mergedInto) : null;
  const worktree = parseWorktrees(checkout.root).find((entry) => entry.branch === branch) ?? null;
  if (worktree && path.resolve(worktree.path) === path.resolve(checkout.root)) {
    throw new TrashServiceError("refusing to remove the registered root worktree", "current_worktree", 409);
  }
  if (worktree && isPreservedAppWorktreePath(worktree.path)) {
    throw new TrashServiceError(
      `refusing to trash app-managed worktree: ${worktree.path}`,
      "app_managed_worktree",
      409,
    );
  }
  if (worktree && !fs.existsSync(worktree.path)) {
    throw new TrashServiceError(
      `registered worktree path is missing: ${worktree.path}`,
      "worktree_missing",
      409,
      { worktree_path: worktree.path },
    );
  }
  const active = db.prepare(
    `SELECT id FROM trash_entries
      WHERE project_id = ? AND branch = ?
        AND state IN ('active','remove_failed','restore_failed','gc_failed')
      LIMIT 1`,
  ).get(project.id, branch) as { id: string } | undefined;
  if (active) {
    throw new TrashServiceError("branch already has a live trash entry", "trash_exists", 409, {
      id: active.id,
    });
  }

  const id = randomUUID();
  const ignoredPlan = worktree ? planIgnored(checkout.root, worktree.path) : null;
  const captured = worktree ? captureWorktreeTree(worktree.path, originalOid, id) : null;
  const outcome: TrashCreateOutcome = {
    worktree_removed: false,
    branch_removed: false,
    worktree_path: worktree?.path ?? null,
    merge_evidence: evidence,
    ignored: ignoredPlan ? ignoredCustody(ignoredPlan, null, null) : NO_WORKTREE_IGNORED,
  };

  if (evidence && !captured?.dirty && (ignoredPlan?.kept.length ?? 0) === 0) {
    try {
      removeLocalBranch(checkout.root, worktree, branch, originalOid, outcome);
    } catch (error) {
      throw new TrashServiceError("local removal failed", "remove_failed", 409, {
        error: error instanceof Error ? error.message : String(error),
        outcome,
      });
    }
    return { result: "removed", entry: null, outcome };
  }

  const snapshotRef = `refs/mandible/trash/${id}`;
  const snapshotOid = worktree && captured?.dirty
    ? git(worktree.path, ["commit-tree", captured.tree, "-p", originalOid], {
      env: TRASH_IDENTITY,
      input: `Mandible trash snapshot for ${branch}\n`,
    })
    : originalOid;
  const ignoredOid = worktree && ignoredPlan ? captureIgnored(worktree.path, ignoredPlan.kept, id) : null;
  const ignoredRef = ignoredOid ? ignoredCustodyRef(id) : null;
  if (ignoredPlan) outcome.ignored = ignoredCustody(ignoredPlan, ignoredRef, ignoredOid);
  git(checkout.root, ["update-ref", snapshotRef, snapshotOid, "0".repeat(40)]);
  const releaseRefs = () => {
    git(checkout.root, ["update-ref", "-d", snapshotRef, snapshotOid], { allowFailure: true });
    if (ignoredRef && ignoredOid) {
      git(checkout.root, ["update-ref", "-d", ignoredRef, ignoredOid], { allowFailure: true });
    }
  };
  if (ignoredRef && ignoredOid) {
    try {
      git(checkout.root, ["update-ref", ignoredRef, ignoredOid, "0".repeat(40)]);
    } catch (error) {
      releaseRefs();
      throw error;
    }
  }
  const actor = input.actor?.trim() || "mandible";
  const issueRefs = linkedIssueRefs(db, project.id, branch, input.issue_refs ?? []);
  const expiresAt = now + retentionDays * 86_400_000;
  try {
    db.prepare(
      `INSERT INTO trash_entries (
         id, project_id, checkout_id, repo_root, branch, issue_refs_json,
         reason, actor, snapshot_ref, snapshot_oid, original_oid,
         retention_policy, retention_days, state, created_at, expires_at, outcome_json
       ) VALUES (
         @id, @project_id, @checkout_id, @repo_root, @branch, @issue_refs_json,
         @reason, @actor, @snapshot_ref, @snapshot_oid, @original_oid,
         @retention_policy, @retention_days, 'active', @created_at, @expires_at, @outcome_json
       )`,
    ).run({
      id,
      project_id: project.id,
      checkout_id: checkout.id,
      repo_root: checkout.root,
      branch,
      issue_refs_json: JSON.stringify(issueRefs),
      reason: input.reason,
      actor,
      snapshot_ref: snapshotRef,
      snapshot_oid: snapshotOid,
      original_oid: originalOid,
      retention_policy: TRASH_RETENTION_POLICY,
      retention_days: retentionDays,
      created_at: now,
      expires_at: expiresAt,
      outcome_json: JSON.stringify(outcome),
    });
  } catch (error) {
    releaseRefs();
    throw error;
  }

  try {
    removeLocalBranch(checkout.root, worktree, branch, originalOid, outcome);
    db.prepare("UPDATE trash_entries SET outcome_json = ? WHERE id = ?")
      .run(JSON.stringify(outcome), id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let recordingError: string | null = null;
    try {
      db.prepare(
        "UPDATE trash_entries SET state = 'remove_failed', last_error = ?, outcome_json = ? WHERE id = ?",
      ).run(message, JSON.stringify(outcome), id);
    } catch (recordError) {
      // Removal finality comes from the completed Git operations, not from the
      // database write. Preserve it in the error response even when recording
      // the repair state also fails, so callers never continue in a path that
      // has already been removed.
      recordingError = recordError instanceof Error ? recordError.message : String(recordError);
    }
    throw new TrashServiceError("snapshot is safe but local removal failed", "remove_failed", 409, {
      id,
      snapshot_ref: snapshotRef,
      error: message,
      outcome,
      ...(recordingError ? { recording_error: recordingError } : {}),
    });
  }

  return { result: "trashed", entry: getEntry(db, id), outcome };
}

export function restoreTrashEntry(
  db: Db,
  id: string,
  input: TrashRestoreInput = {},
  now = Date.now(),
): { entry: TrashEntry; branch: string; worktree_path: string | null } {
  const entry = getEntry(db, id);
  if (!(["active", "remove_failed", "restore_failed"] as TrashState[]).includes(entry.state)) {
    throw new TrashServiceError(`trash entry cannot be restored from state ${entry.state}`, "invalid_state", 409);
  }
  if (entry.expires_at <= now) {
    throw new TrashServiceError("trash entry is past its retention window", "retention_expired", 409);
  }
  const checkout = db.prepare(
    "SELECT id, project_id, root FROM ledger_project_checkouts WHERE id = ? AND project_id = ?",
  ).get(entry.checkout_id, entry.project_id) as { id: string; project_id: string; root: string } | undefined;
  if (!checkout || path.resolve(checkout.root) !== path.resolve(entry.repo_root)) {
    throw new TrashServiceError("canonical checkout is missing or changed", "checkout_mismatch", 409);
  }
  if (!fs.existsSync(entry.repo_root)) {
    throw new TrashServiceError("registered checkout is missing", "checkout_missing", 404);
  }
  const liveSnapshot = git(entry.repo_root, ["rev-parse", "--verify", `${entry.snapshot_ref}^{commit}`], {
    allowFailure: true,
  });
  if (!liveSnapshot) {
    throw new TrashServiceError("trash snapshot ref is missing", "snapshot_missing", 404);
  }
  if (liveSnapshot !== entry.snapshot_oid) {
    throw new TrashServiceError("trash snapshot ref no longer matches its record", "snapshot_mismatch", 409);
  }
  const liveBranchOid = branchOid(entry.repo_root, entry.branch);
  const existingWorktree = parseWorktrees(entry.repo_root)
    .find((candidate) => candidate.branch === entry.branch) ?? null;
  const ignoredCustodyOf = recordedIgnoredCustody(entry);
  const requestedValue = input.worktree_path?.trim() || "";
  const requestedPath = requestedValue ? path.resolve(requestedValue) : null;

  if (entry.state === "remove_failed" && existingWorktree) {
    if (requestedPath && path.resolve(existingWorktree.path) !== requestedPath) {
      throw new TrashServiceError(
        "remove_failed entry still has a worktree at a different path",
        "remove_failed_collision",
        409,
        { worktree_path: existingWorktree.path, branch_oid: liveBranchOid },
      );
    }
    if (liveBranchOid !== entry.original_oid && liveBranchOid !== entry.snapshot_oid) {
      throw new TrashServiceError(
        "remove_failed branch moved after custody was recorded",
        "branch_collision",
        409,
        { branch_oid: liveBranchOid },
      );
    }
    const captured = captureWorktreeTree(
      existingWorktree.path,
      liveBranchOid ?? entry.original_oid,
      `${entry.id}-restore-check`,
    );
    const snapshotTree = git(entry.repo_root, ["rev-parse", `${entry.snapshot_oid}^{tree}`]);
    if (captured.tree !== snapshotTree) {
      throw new TrashServiceError(
        "remove_failed worktree no longer matches its immutable snapshot",
        "remove_failed_collision",
        409,
        { worktree_path: existingWorktree.path },
      );
    }
    const refilled = ignoredCustodyOf
      ? materializeIgnored(entry.repo_root, ignoredCustodyOf, existingWorktree.path)
      : { restored: 0, present: 0 };
    db.prepare(
      `UPDATE trash_entries
          SET state = 'restored', restored_at = ?, last_error = NULL,
              outcome_json = ?
        WHERE id = ?`,
    ).run(now, JSON.stringify({
      restored_by: input.actor?.trim() || "mandible",
      worktree_path: existingWorktree.path,
      repaired_remove_failed: true,
      ignored: entry.outcome.ignored ?? null,
      ignored_restored: refilled.restored,
      ignored_present: refilled.present,
    }), id);
    return { entry: getEntry(db, id), branch: entry.branch, worktree_path: existingWorktree.path };
  }

  const validatedRequestedPath = requestedValue
    ? validateNewWorktreePath(entry.repo_root, requestedValue)
    : null;
  if (entry.state !== "remove_failed" && liveBranchOid) {
    throw new TrashServiceError(`branch already exists: ${entry.branch}`, "branch_collision", 409);
  }
  if (entry.state === "remove_failed" && liveBranchOid
      && liveBranchOid !== entry.original_oid && liveBranchOid !== entry.snapshot_oid) {
    throw new TrashServiceError(
      "remove_failed branch moved after custody was recorded",
      "branch_collision",
      409,
      { branch_oid: liveBranchOid },
    );
  }

  let branchCreated = false;
  let branchRepointed = false;
  try {
    if (!liveBranchOid) {
      git(entry.repo_root, ["update-ref", `refs/heads/${entry.branch}`, entry.snapshot_oid, "0".repeat(40)]);
      branchCreated = true;
    } else if (liveBranchOid === entry.original_oid && liveBranchOid !== entry.snapshot_oid) {
      git(entry.repo_root, [
        "update-ref", `refs/heads/${entry.branch}`, entry.snapshot_oid, entry.original_oid,
      ]);
      branchRepointed = true;
    }
    let materialized = { restored: 0, present: 0 };
    if (validatedRequestedPath) {
      git(entry.repo_root, ["worktree", "add", validatedRequestedPath, entry.branch]);
      if (ignoredCustodyOf) {
        materialized = materializeIgnored(entry.repo_root, ignoredCustodyOf, validatedRequestedPath);
      }
    }
    db.prepare(
      `UPDATE trash_entries
          SET state = 'restored', restored_at = ?, last_error = NULL,
              outcome_json = ?
        WHERE id = ?`,
    ).run(now, JSON.stringify({
      restored_by: input.actor?.trim() || "mandible",
      worktree_path: validatedRequestedPath,
      repaired_remove_failed: entry.state === "remove_failed",
      ignored: entry.outcome.ignored ?? null,
      ignored_restored: materialized.restored,
      ignored_present: materialized.present,
    }), id);
  } catch (error) {
    if (validatedRequestedPath) {
      git(entry.repo_root, ["worktree", "remove", "--force", validatedRequestedPath], {
        allowFailure: true,
      });
    }
    if (branchCreated) {
      git(entry.repo_root, ["update-ref", "-d", `refs/heads/${entry.branch}`, entry.snapshot_oid], {
        allowFailure: true,
      });
    }
    if (branchRepointed) {
      git(entry.repo_root, [
        "update-ref", `refs/heads/${entry.branch}`, entry.original_oid, entry.snapshot_oid,
      ], { allowFailure: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE trash_entries SET state = 'restore_failed', last_error = ? WHERE id = ?")
      .run(message, id);
    throw error;
  }
  return { entry: getEntry(db, id), branch: entry.branch, worktree_path: validatedRequestedPath };
}

export interface TrashGcOutcome {
  id: string;
  status: "expired" | "failed";
  error?: string;
}

type ExactRefProbe =
  | { status: "present"; oid: string }
  | { status: "absent" }
  | { status: "unknown"; error: string };

function probeExactRef(repoRoot: string, ref: string): ExactRefProbe {
  const result = spawnSync("git", [
    "for-each-ref", "--format=%(refname)%00%(objectname)", ref,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error) return { status: "unknown", error: result.error.message };
  if (result.status !== 0) {
    return {
      status: "unknown",
      error: (result.stderr || result.stdout || `git for-each-ref exited ${result.status}`).trim(),
    };
  }
  const exact = result.stdout.split("\n").map((line) => line.trim()).find((line) => {
    const separator = line.indexOf("\0");
    return separator >= 0 && line.slice(0, separator) === ref;
  });
  if (!exact) return { status: "absent" };
  const oid = exact.slice(exact.indexOf("\0") + 1);
  return oid
    ? { status: "present", oid }
    : { status: "unknown", error: "exact ref probe returned no object id" };
}

export function gcTrashEntries(
  db: Db,
  options: { now?: number; limit?: number; actor?: string } = {},
): { outcomes: TrashGcOutcome[]; expired: number; failed: number } {
  const now = options.now ?? Date.now();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
  const rows = db.prepare(
    `${SELECT_ENTRY}
      WHERE t.expires_at <= ?
        AND t.state IN ('active','remove_failed','restored','restore_failed','gc_pending','gc_failed')
      ORDER BY t.expires_at, t.id
      LIMIT ?`,
  ).all(now, limit) as TrashRow[];
  const outcomes: TrashGcOutcome[] = [];
  for (const row of rows) {
    const entry = mapRow(row);
    let refDeleted = false;
    let pendingRecorded = entry.state === "gc_pending";
    try {
      if (!fs.existsSync(entry.repo_root)) {
        throw new TrashServiceError("registered checkout is missing", "checkout_missing", 404);
      }
      const probe = probeExactRef(entry.repo_root, entry.snapshot_ref);
      if (probe.status === "unknown") {
        throw new TrashServiceError(
          `cannot inspect trash snapshot ref: ${probe.error}`,
          "snapshot_probe_unknown",
          409,
        );
      }
      if (probe.status === "absent" && entry.state !== "gc_pending") {
        throw new TrashServiceError("trash snapshot ref is missing", "snapshot_missing", 404);
      }
      if (probe.status === "absent") {
        if (entry.state === "gc_pending") {
          deleteIgnoredRef(entry.repo_root, entry.id);
          db.prepare(
            `UPDATE trash_entries
                SET state = 'expired', expired_at = ?, last_error = NULL, outcome_json = ?
              WHERE id = ? AND state = 'gc_pending'`,
          ).run(now, JSON.stringify({
            gc_actor: options.actor?.trim() || "mandible",
            replayed_pending: true,
          }), entry.id);
          outcomes.push({ id: entry.id, status: "expired" });
          continue;
        }
      } else if (probe.oid !== entry.snapshot_oid) {
        throw new TrashServiceError("trash snapshot ref no longer matches its record", "snapshot_mismatch", 409);
      }
      if (entry.state !== "gc_pending") {
        db.prepare(
          "UPDATE trash_entries SET state = 'gc_pending', last_error = NULL WHERE id = ?",
        ).run(entry.id);
        pendingRecorded = true;
      }
      deleteIgnoredRef(entry.repo_root, entry.id);
      git(entry.repo_root, ["update-ref", "-d", entry.snapshot_ref, entry.snapshot_oid]);
      refDeleted = true;
      db.prepare(
        `UPDATE trash_entries
            SET state = 'expired', expired_at = ?, last_error = NULL, outcome_json = ?
          WHERE id = ?`,
      ).run(now, JSON.stringify({ gc_actor: options.actor?.trim() || "mandible" }), entry.id);
      outcomes.push({ id: entry.id, status: "expired" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (pendingRecorded) {
        try {
          db.prepare("UPDATE trash_entries SET last_error = ? WHERE id = ? AND state = 'gc_pending'")
            .run(message, entry.id);
        } catch {
          // The durable pending transition remains authoritative even if the
          // diagnostic write also fails; a later GC pass can replay it.
        }
      } else if (!refDeleted) {
        db.prepare("UPDATE trash_entries SET state = 'gc_failed', last_error = ? WHERE id = ?")
          .run(message, entry.id);
      }
      outcomes.push({ id: entry.id, status: "failed", error: message });
    }
  }
  const expired = outcomes.filter((outcome) => outcome.status === "expired").length;
  return { outcomes, expired, failed: outcomes.length - expired };
}

let trashGcTimer: ReturnType<typeof setInterval> | null = null;
let trashGcStartupTimer: ReturnType<typeof setTimeout> | null = null;

export function startTrashGcScheduler(
  db: Db,
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void,
  options: { intervalMs?: number; startupDelayMs?: number } = {},
): void {
  stopTrashGcScheduler();
  const run = () => {
    try {
      const result = gcTrashEntries(db, { actor: "mandible-daemon" });
      if (result.outcomes.length > 0) {
        log(result.failed > 0 ? "warn" : "info", "trash_gc_completed", {
          subsystem: "trash",
          expired: result.expired,
          failed: result.failed,
          failures: result.outcomes.filter((outcome) => outcome.status === "failed"),
        });
      }
    } catch (error) {
      log("warn", "trash_gc_failed", {
        subsystem: "trash",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  trashGcStartupTimer = setTimeout(run, options.startupDelayMs ?? 10_000);
  trashGcTimer = setInterval(run, options.intervalMs ?? 60 * 60 * 1_000);
  trashGcStartupTimer.unref?.();
  trashGcTimer.unref?.();
}

export function stopTrashGcScheduler(): void {
  if (trashGcStartupTimer) clearTimeout(trashGcStartupTimer);
  if (trashGcTimer) clearInterval(trashGcTimer);
  trashGcStartupTimer = null;
  trashGcTimer = null;
}
