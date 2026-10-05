import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Db } from "./db.js";
import { canonicalizeChangeMessage } from "./auth-change-message.js";
import { extractAtomicMergeState, extractSuccessfulMergeCommitSha, verifyAuthorizedMergeCommitSignature } from "./auth-signature-verification.js";

export interface RuntimePublicationBinding {
  requestId: string;
  executionId: string;
  hookId: string;
  commandDigest: string;
  root: string;
  mergeCommit?: string;
  mergeBase?: string;
  mergeHead?: string;
  frozenCandidate?: { tree: string; snapshotRevision: number; snapshotDigest: string; signerCredentialId: string };
}

/** Read-only, narrowly bound first-upgrade proof. A journal never authorizes a merge. */
export function verifyRuntimeHandoffPublication(db: Db, binding: RuntimePublicationBinding) {
  const fail = (reason: string): never => { throw new Error(`Runtime handoff publication refused: ${reason}`); };
  const row = db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(binding.requestId) as Record<string, any> | undefined;
  const hook = db.prepare("SELECT * FROM auth_hook_executions WHERE id = ?").get(binding.executionId) as Record<string, any> | undefined;
  if (!row || !hook || binding.hookId !== "builtin-mandible-rebuild" || row.type !== "merge" || !["executing", "completed"].includes(row.status) ||
      row.status === "completed" && row.exit_code !== 0 || !row.approved_by_user_id ||
      hook.auth_request_id !== row.id || hook.hook_id !== binding.hookId || hook.command_digest !== binding.commandDigest ||
      createHash("sha256").update(hook.command).digest("hex") !== binding.commandDigest) throw new Error("Runtime handoff publication refused: request or hook binding differs");
  const root = realpathSync(binding.root);
  if (realpathSync(row.target_repo_root ?? row.cwd) !== root) fail("repository binding differs");
  const commit = extractSuccessfulMergeCommitSha(row.output ?? "");
  if (!commit || binding.mergeCommit && binding.mergeCommit !== commit) fail("exact publication receipt is unavailable");
  const events = db.prepare("SELECT revision, snapshot_json, snapshot_sha256 FROM auth_request_lifecycle_events WHERE auth_request_id = ? AND next_status IN ('approved', 'executing') ORDER BY revision DESC").all(row.id) as Array<{ revision: number; snapshot_json: string; snapshot_sha256: string }>;
  const event = events.find(item => {
    if (createHash("sha256").update(item.snapshot_json).digest("hex") !== item.snapshot_sha256) return false;
    try { const r = JSON.parse(item.snapshot_json).request; return r.id === row.id && r.approved_by_user_id === row.approved_by_user_id && r.merge_preflight_base_sha && r.merge_head_sha && r.merge_candidate_tree_sha; }
    catch { return false; }
  });
  if (!event) fail("frozen approved candidate is unavailable");
  const frozen = JSON.parse(event!.snapshot_json).request;
  const base = frozen.merge_preflight_base_sha as string;
  const head = frozen.merge_head_sha as string;
  const tree = frozen.merge_candidate_tree_sha as string;
  if (binding.mergeBase && binding.mergeBase !== base || binding.mergeHead && binding.mergeHead !== head) fail("reviewed revisions differ");
  for (const field of ["base_branch", "head_branch", "approved_by_user_id", "commit_message", "commit_message_digest", "approval_lease_id"]) {
    if (row[field] !== frozen[field]) fail(`frozen ${field} differs`);
  }
  const atomic = extractAtomicMergeState(row.output ?? "");
  if (atomic.invalid || atomic.prepared && (atomic.prepared.merge_sha !== commit || atomic.prepared.base_sha !== base || atomic.prepared.head_sha !== head || atomic.prepared.tree_sha !== tree) ||
      atomic.applied && (atomic.applied.merge_sha !== commit || atomic.applied.base_sha !== base)) fail("atomic publication evidence differs");
  const lease = row.approval_lease_id ? db.prepare("SELECT credential_id FROM delegated_signing_leases WHERE id = ?").get(row.approval_lease_id) as { credential_id: string } | undefined : undefined;
  if (row.approval_lease_id && !lease) fail("delegated approval credential is unavailable");
  const signature = verifyAuthorizedMergeCommitSignature(db, root, commit!, row.approved_by_user_id, lease?.credential_id);
  if (!signature.verified || !signature.credential_id) fail("published signature is not authorized");
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of Object.keys(env)) if (/^GIT_(CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS)|DIR$|WORK_TREE$|INDEX_FILE$)/.test(key)) delete env[key as keyof typeof env];
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 5000 }).trim();
  if (git(["show", "-s", "--format=%P", commit!]) !== `${base} ${head}` || git(["rev-parse", `${commit}^{tree}`]) !== tree ||
      git(["rev-parse", "HEAD"]) !== commit || git(["rev-parse", `refs/heads/${row.base_branch}`]) !== commit ||
      git(["write-tree"]) !== tree || git(["status", "--porcelain", "--untracked-files=no"])) fail("exact applied checkout differs");
  if (frozen.commit_message_digest && canonicalizeChangeMessage(git(["show", "-s", "--format=%B", commit!])) !== frozen.commit_message) fail("canonical merge message differs");
  const frozenCandidate = { tree, snapshotRevision: event!.revision, snapshotDigest: event!.snapshot_sha256, signerCredentialId: signature.credential_id! };
  if (binding.frozenCandidate && JSON.stringify(binding.frozenCandidate) !== JSON.stringify(frozenCandidate)) fail("frozen proof binding differs");
  return { mergeCommit: commit!, mergeBase: base, mergeHead: head, frozenCandidate };
}
