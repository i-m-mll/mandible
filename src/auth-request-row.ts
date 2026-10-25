import { AUTH_REQUEST_TYPES, describeAuthExecutionFailure } from "./contracts.js";
import type { AuthRequest, AuthRequestStatus, AuthRequestType } from "./types.js";
import type { ProtectedRootDirtyAction } from "./auth-protected-root-dirty-action.js";

export function mapRow(row: Record<string, unknown>): AuthRequest {

  let issueReferences: string[] | null = null;
  if (row.issue_references != null) {
    try {
      issueReferences = JSON.parse(String(row.issue_references));
    } catch {
      issueReferences = null;
    }
  }

  let issueClosures: string[] | null = null;
  if (row.issue_closures != null) {
    try {
      issueClosures = JSON.parse(String(row.issue_closures));
    } catch {
      issueClosures = null;
    }
  }

  // Bug: 297677f — parse issues JSON array from DB
  let parsedIssues: string[] | null = null;
  if (row.issues != null) {
    try {
      parsedIssues = JSON.parse(String(row.issues));
    } catch {
      parsedIssues = null;
    }
  }

  // Bug: dd21c1e — parse type column, default to 'merge' for backward compat
  const rawType = row.type == null ? "merge" : String(row.type);
  const type: AuthRequestType = AUTH_REQUEST_TYPES.includes(rawType as AuthRequestType)
    ? (rawType as AuthRequestType)
    : "merge";

  return {
    space_publication_id: row.space_publication_id == null ? null : String(row.space_publication_id),
    id: String(row.id),
    session_id: row.session_id == null ? null : String(row.session_id),
    requested_by_user_id: row.requested_by_user_id == null ? null : String(row.requested_by_user_id),
    requester_evidence_method: row.requester_evidence_method == null ? null : String(row.requester_evidence_method),
    requester_credential_id: row.requester_credential_id == null ? null : String(row.requester_credential_id),
    approved_by_user_id: row.approved_by_user_id == null ? null : String(row.approved_by_user_id),
    execution_evidence_id: row.execution_evidence_id == null ? null : String(row.execution_evidence_id),
    type,
    command: String(row.command),
    title: String(row.title),
    cwd: row.cwd == null ? null : String(row.cwd),
    diff_summary: row.diff_summary == null ? null : String(row.diff_summary),
    commit_message: row.commit_message == null ? null : String(row.commit_message),
    // Issue 7d64d8f — non-null marks `commit_message` as the canonical,
    // agent-authored change message bound to these exact bytes.
    commit_message_digest:
      row.commit_message_digest == null ? null : String(row.commit_message_digest),
    spec_content: row.spec_content == null ? null : String(row.spec_content),
    repo: row.repo == null ? undefined : String(row.repo),
    base_branch: row.base_branch == null ? undefined : String(row.base_branch),
    head_branch: row.head_branch == null ? undefined : String(row.head_branch),
    merge_head_sha: row.merge_head_sha == null ? null : String(row.merge_head_sha),
    merge_candidate_tree_sha: row.merge_candidate_tree_sha == null
      ? null
      : String(row.merge_candidate_tree_sha),
    merge_candidate_pin_sha: row.merge_candidate_pin_sha == null
      ? null
      : String(row.merge_candidate_pin_sha),
    merge_atomic_enabled: row.merge_atomic_enabled === 1 || row.merge_atomic_enabled === true,
    merge_preflight_base_sha: row.merge_preflight_base_sha == null ? null : String(row.merge_preflight_base_sha),
    merge_preflight_queue_fingerprint: row.merge_preflight_queue_fingerprint == null
      ? null
      : String(row.merge_preflight_queue_fingerprint),
    merge_finalized_at: row.merge_finalized_at == null ? null : Number(row.merge_finalized_at),
    // Issue 75f52ac — durable per-step finalizer state (raw JSON string); detail
    // views and crash recovery read it. Kept as a string to match the column.
    merge_finalizer_state: row.merge_finalizer_state == null ? null : String(row.merge_finalizer_state),
    change_report: parseChangeReport(row.change_report_json),
    protected_root_dirty_action: row.protected_root_dirty_action_json == null
      ? null
      : JSON.parse(String(row.protected_root_dirty_action_json)) as ProtectedRootDirtyAction,
    files_changed: row.files_changed == null ? undefined : Number(row.files_changed),
    additions: row.additions == null ? undefined : Number(row.additions),
    deletions: row.deletions == null ? undefined : Number(row.deletions),
    post_merge_handoff: row.post_merge_handoff == null ? null : String(row.post_merge_handoff),
    issue_references: issueReferences,
    issue_closures: issueClosures ?? parsedIssues,
    issue_ids: null,
    issues: parsedIssues,
    depends_on_id: row.depends_on_id == null ? null : String(row.depends_on_id),
    execution_mode:
      row.execution_mode === "remote" || row.execution_mode === "daemon"
        ? (row.execution_mode as "remote" | "daemon")
        : "daemon",
    status: row.status as AuthRequestStatus,
    failure_reason: row.status === "failed"
      ? describeAuthExecutionFailure(
        row.error == null ? (row.output == null ? null : String(row.output)) : String(row.error),
        row.exit_code == null ? null : Number(row.exit_code),
      )
      : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_executed_at: row.last_executed_at == null ? null : Number(row.last_executed_at),
    approved_at: row.approved_at == null ? null : Number(row.approved_at),
    resolved_at: row.resolved_at == null ? null : Number(row.resolved_at),
    skipped_at: row.skipped_at == null ? null : Number(row.skipped_at),
    expires_at: Number(row.expires_at),
    exit_code: row.exit_code == null ? null : Number(row.exit_code),
    output: String(row.output ?? ""),
    error: row.error == null ? null : String(row.error),
    acknowledged_by: row.acknowledged_by == null ? null : String(row.acknowledged_by),
    // Bug: 4e32923 — owner session + repo root + channel-delivery watermark.
    target_session_id: row.target_session_id == null ? null : String(row.target_session_id),
    target_repo_root: row.target_repo_root == null ? null : String(row.target_repo_root),
    delivered_at: row.delivered_at == null ? null : Number(row.delivered_at),
    // Bug: 6d7411b — conversation_id for cross-resume matching
    conversation_id: row.conversation_id == null ? null : String(row.conversation_id),
    approval_source: row.approval_source == null ? "manual" : String(row.approval_source),
    approval_lease_id: row.approval_lease_id == null ? null : String(row.approval_lease_id),
    clearance_use_id: row.clearance_use_id == null ? null : String(row.clearance_use_id),
    supersedes_request_id: row.supersedes_request_id == null ? null : String(row.supersedes_request_id),
    superseded_by_request_id: row.superseded_by_request_id == null ? null : String(row.superseded_by_request_id),
    custody_work_unit_id: row.custody_work_unit_id == null ? null : String(row.custody_work_unit_id),
  };
}

export function parseChangeReport(value: unknown): AuthRequest["change_report"] {
  if (value == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error("Stored auth change report is not valid JSON.");
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    (parsed as { schema?: unknown }).schema !== "mandible-auth-change-report@1" ||
    !Array.isArray((parsed as { files?: unknown }).files)
  ) {
    throw new Error("Stored auth change report does not match mandible-auth-change-report@1.");
  }
  return parsed as NonNullable<AuthRequest["change_report"]>;
}
