/**
 * Issue 8ae6b5f — the protected-root dirty action.
 *
 * When `mandible auth request` finds the protected checkout dirty and an
 * explicit `--dirty-policy` (allow-untracked, stash, or branch-off) lets it
 * continue, the CLI sends the structured action it took. A merge request
 * stores it in `auth_requests.protected_root_dirty_action_json`: it says where
 * someone's uncommitted work went.
 */

export interface ProtectedRootDirtyAction {
  policy: "allow-untracked" | "stash" | "branch-off";
  action: "allowed-untracked" | "stashed" | "branched-off";
  branch: string | null;
  worktree: string | null;
  stash: string | null;
  files: Array<{ status: string; path: string }>;
  message: string;
}

const POLICY_ACTIONS: Record<ProtectedRootDirtyAction["policy"], ProtectedRootDirtyAction["action"]> = {
  "allow-untracked": "allowed-untracked",
  stash: "stashed",
  "branch-off": "branched-off",
};

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/** Validate the CLI's structured action; `null` means none was taken. */
export function parseProtectedRootDirtyAction(
  value: unknown,
): { ok: true; action: ProtectedRootDirtyAction | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, action: null };
  const invalid = { ok: false as const, error: "Invalid 'protected_root_dirty_action'." };
  if (typeof value !== "object" || Array.isArray(value)) return invalid;
  const record = value as Record<string, unknown>;
  const policy = record.policy as ProtectedRootDirtyAction["policy"];
  if (!Object.hasOwn(POLICY_ACTIONS, policy) || record.action !== POLICY_ACTIONS[policy]) return invalid;
  if (typeof record.message !== "string" || !record.message.trim()) return invalid;
  if (!optionalString(record.branch) || !optionalString(record.worktree) || !optionalString(record.stash)) return invalid;
  if (!Array.isArray(record.files) || !record.files.every((file) =>
    file && typeof file === "object" && typeof file.status === "string" && typeof file.path === "string")) {
    return invalid;
  }
  return {
    ok: true,
    action: {
      policy,
      action: POLICY_ACTIONS[policy],
      branch: (record.branch as string | null | undefined) ?? null,
      worktree: (record.worktree as string | null | undefined) ?? null,
      stash: (record.stash as string | null | undefined) ?? null,
      files: (record.files as Array<{ status: string; path: string }>).map(({ status, path }) => ({ status, path })),
      message: record.message.trim(),
    },
  };
}
