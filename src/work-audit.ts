import type {
  BranchData,
  RepoInfo,
  WorktreeInventory,
} from "./work-scanner.js";
import { isPreservedAppWorktreePath } from "./worktree-preservation.js";

export type WorkAuditClassification =
  | "safe_candidate"
  | "unique_commits"
  | "dirty_worktree"
  | "protected"
  | "current"
  | "app_managed"
  | "unknown";

export interface WorkAuditProof {
  kind: "reachable" | "none" | "unknown";
  default_branch: string;
  merged: boolean | null;
}

export interface WorkAuditTrashRequest {
  project: string;
  checkout_root: string;
  branch: string;
  reason: "manual";
  issue_refs: string[];
}

export interface WorkAuditEntry {
  kind: "branch" | "detached_worktree";
  branch: string | null;
  classification: WorkAuditClassification;
  preserve_by_default: boolean;
  reason: string;
  blockers: string[];
  proof: WorkAuditProof;
  ahead_default: number | null;
  behind_default: number | null;
  default_branch: string;
  dirty: boolean | null;
  status_known: boolean;
  canonical_project: boolean;
  canonical_project_id: string | null;
  ambiguous_project: boolean;
  worktree_path: string | null;
  trash_request: WorkAuditTrashRequest | null;
  trash_command: string | null;
}

export interface WorkAuditEnvelope {
  repo: Pick<RepoInfo, "id" | "name" | "root" | "default_branch" | "last_scanned_at">;
  maintenance_issue_ref: null;
  maintenance_issue_note: string;
  worktree_inventory_known: boolean;
  entries: WorkAuditEntry[];
}

const MAINTENANCE_NOTE =
  "No authoritative repository maintenance issue is configured; cleanup will not infer one.";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function proofFor(branch: BranchData): WorkAuditProof {
  if (branch.default_comparison_known !== true) {
    return { kind: "unknown", default_branch: branch.default_branch, merged: null };
  }
  if (branch.ahead_default === 0) {
    return { kind: "reachable", default_branch: branch.default_branch, merged: true };
  }
  return { kind: "none", default_branch: branch.default_branch, merged: false };
}

function classifyBranch(
  branch: BranchData,
  liveInventoryKnown: boolean,
): { classification: WorkAuditClassification; reason: string } {
  const reaping = branch.reaping;
  if (!reaping) {
    return { classification: "unknown", reason: "Authoritative reaping safety facts are unavailable." };
  }
  if (reaping.default_branch) {
    return { classification: "protected", reason: "This is the canonical default branch." };
  }
  if (reaping.protected) {
    return { classification: "protected", reason: "This branch is protected by repository policy." };
  }
  if (reaping.current) {
    return { classification: "current", reason: "This branch is current in the canonical checkout." };
  }
  if (reaping.app_managed) {
    return { classification: "app_managed", reason: "This worktree is managed by an application lifecycle." };
  }
  if (!liveInventoryKnown || !reaping.facts_known || !reaping.canonical_project || reaping.ambiguous) {
    return {
      classification: "unknown",
      reason: "Cleanup authority or required Git safety facts are unknown or ambiguous.",
    };
  }
  if (!reaping.clean || branch.is_dirty) {
    return { classification: "dirty_worktree", reason: "The worktree has uncommitted changes." };
  }
  if (reaping.candidate) {
    return {
      classification: "safe_candidate",
      reason: "The clean branch tip is reachable from the canonical default branch.",
    };
  }
  if (branch.default_comparison_known === true && branch.ahead_default > 0) {
    return {
      classification: "unique_commits",
      reason: "The branch has commits that are not reachable from the canonical default branch.",
    };
  }
  return { classification: "unknown", reason: "The branch is not eligible for cleanup." };
}

function branchEntry(branch: BranchData, repo: RepoInfo, liveInventoryKnown: boolean): WorkAuditEntry {
  const { classification, reason } = classifyBranch(branch, liveInventoryKnown);
  const reaping = branch.reaping;
  const actionable = classification === "safe_candidate" && reaping?.candidate === true
    && Boolean(reaping.canonical_project_id);
  const trashRequest: WorkAuditTrashRequest | null = actionable
    ? {
        project: reaping!.canonical_project_id!,
        checkout_root: repo.root,
        branch: branch.branch,
        reason: "manual",
        issue_refs: [],
      }
    : null;
  const trashCommand = trashRequest
    ? [
        "mandible trash create",
        `--project ${shellQuote(trashRequest.project)}`,
        `--checkout-root ${shellQuote(trashRequest.checkout_root)}`,
        `--branch ${shellQuote(trashRequest.branch)}`,
        "--reason manual",
      ].join(" ")
    : null;

  const blockers = [...(reaping?.blockers ?? ["missing_reaping_safety"])];
  if (!liveInventoryKnown && !blockers.includes("unknown_worktree_inventory")) {
    blockers.unshift("unknown_worktree_inventory");
  }
  const statusKnown = liveInventoryKnown && branch.worktree_status_known === true;

  return {
    kind: "branch",
    branch: branch.branch,
    classification,
    preserve_by_default: !actionable,
    reason,
    blockers,
    proof: proofFor(branch),
    ahead_default: branch.default_comparison_known === true ? branch.ahead_default : null,
    behind_default: branch.default_comparison_known === true ? branch.behind_default : null,
    default_branch: branch.default_branch,
    dirty: statusKnown ? branch.is_dirty : null,
    status_known: statusKnown,
    canonical_project: reaping?.canonical_project === true,
    canonical_project_id: reaping?.canonical_project_id ?? null,
    ambiguous_project: reaping?.ambiguous === true,
    worktree_path: branch.worktree_path,
    trash_request: trashRequest,
    trash_command: trashCommand,
  };
}

function detachedEntry(
  worktree: WorktreeInventory["worktrees"][number],
  repo: RepoInfo,
): WorkAuditEntry {
  const appManaged = isPreservedAppWorktreePath(worktree.path);
  return {
    kind: "detached_worktree",
    branch: null,
    classification: appManaged ? "app_managed" : "unknown",
    preserve_by_default: true,
    reason: appManaged
      ? "This detached worktree is application-managed and has no branch to trash."
      : "This detached worktree has no branch to trash.",
    blockers: appManaged ? ["app_managed", "missing_branch"] : ["missing_branch"],
    proof: { kind: "unknown", default_branch: repo.default_branch, merged: null },
    ahead_default: null,
    behind_default: null,
    default_branch: repo.default_branch,
    dirty: null,
    status_known: false,
    canonical_project: false,
    canonical_project_id: null,
    ambiguous_project: false,
    worktree_path: worktree.path,
    trash_request: null,
    trash_command: null,
  };
}

export function buildWorkAudit(
  repo: RepoInfo,
  branches: BranchData[],
  inventory: WorktreeInventory,
): WorkAuditEnvelope {
  const entries = [
    ...branches.map((branch) => branchEntry(branch, repo, inventory.known)),
    ...inventory.worktrees
      .filter((worktree) => worktree.branch === null)
      .map((worktree) => detachedEntry(worktree, repo)),
  ];
  entries.sort((a, b) => {
    const pathOrder = (a.worktree_path ?? "").localeCompare(b.worktree_path ?? "");
    return (a.branch ?? "").localeCompare(b.branch ?? "") || pathOrder || a.kind.localeCompare(b.kind);
  });

  return {
    repo: {
      id: repo.id,
      name: repo.name,
      root: repo.root,
      default_branch: repo.default_branch,
      last_scanned_at: repo.last_scanned_at,
    },
    maintenance_issue_ref: null,
    maintenance_issue_note: MAINTENANCE_NOTE,
    worktree_inventory_known: inventory.known,
    entries,
  };
}
