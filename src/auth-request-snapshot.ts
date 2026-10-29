/**
 * The canonical serialization of an auth request that lifecycle revisions hash.
 * Lifecycle compare-and-swap compares the latest revision's digest with this
 * serialization of the current row, so every writer of a revision, including
 * schema migrations, uses this one serializer.
 */
import { createHash } from "node:crypto";
import type { Db } from "./db.js";

export interface PublicationRow {
  id: string; space_id: string; source_revision: string; snapshot_ref: string; content: string;
  repo_id: string; path: string; expected_destination_sha256: string | null; expected_destination_mode: string | null;
  issue_id: string; message: string; branch: string; worktree: string; commit_sha: string; version_ref: string;
  auth_request_id: string | null; state: string;
}
function spacePublicationsExist(db: Db): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_publications'").get(); }
export function authPublicationSnapshot(db: Db, requestId: string) {
  if (!spacePublicationsExist(db)) return null;
  const row = db.prepare("SELECT * FROM space_publications WHERE id = (SELECT space_publication_id FROM auth_requests WHERE id = ?)").get(requestId) as PublicationRow | undefined;
  if (!row) return null;
  return { id: row.id, space_id: row.space_id, source_revision: row.source_revision, snapshot_ref: row.snapshot_ref,
    repo_id: row.repo_id, path: row.path, expected_destination_sha256: row.expected_destination_sha256,
    expected_destination_mode: row.expected_destination_mode, issue_id: row.issue_id, message: row.message,
    branch: row.branch, worktree: row.worktree, commit_sha: row.commit_sha, version_ref: row.version_ref };
}
function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * The fields a snapshot serializes, in serialization order. A shape is frozen
 * once a revision has hashed it: a migration that writes revisions names the
 * shape of its own schema version, and the runtime names the current one.
 *
 * Adding a column to `auth_requests` or `auth_request_actions` changes nothing
 * here until it is deliberately added to a new shape. Add it to
 * `omittedWhenNull` so revisions recorded before it keep verifying, or have the
 * migration append a canonical revision for every request. The schema test in
 * test/auth-request-snapshot.test.ts fails until one of these is chosen.
 */
export interface AuthSnapshotShape {
  readonly request: readonly string[];
  readonly actions: readonly string[];
}

export const AUTH_SNAPSHOT_SHAPE_V212: AuthSnapshotShape = Object.freeze({
  request: Object.freeze([
    "id", "session_id", "command", "title", "cwd", "diff_summary", "spec_content", "status", "created_at",
    "updated_at", "approved_at", "resolved_at", "skipped_at", "expires_at", "exit_code", "output", "error", "repo",
    "base_branch", "head_branch", "files_changed", "additions", "deletions", "execution_mode", "commit_message",
    "last_executed_at", "acknowledged_by", "post_merge_handoff", "issue_ids", "depends_on_id", "issues", "type",
    "target_session_id", "target_repo_root", "delivered_at", "conversation_id", "approval_source",
    "approval_lease_id", "issue_references", "issue_closures", "merge_preflight_base_sha",
    "merge_preflight_queue_fingerprint", "merge_head_sha", "merge_finalized_at", "requested_by_user_id",
    "approved_by_user_id", "execution_evidence_id", "merge_finalizer_state", "merge_candidate_tree_sha",
    "merge_candidate_pin_sha", "merge_atomic_enabled", "commit_message_digest", "requester_evidence_method",
    "requester_credential_id", "clearance_use_id", "supersedes_request_id", "superseded_by_request_id",
    "custody_work_unit_id", "change_report_json", "space_publication_id", "protected_root_dirty_action_json",
  ]),
  actions: Object.freeze([
    "id", "auth_request_id", "ordinal", "kind", "target_issue_ref", "payload", "state", "target_digest",
    "staged_at", "updated_at", "applied_at", "outcome_detail", "replacement_action_id",
  ]),
});

export const AUTH_SNAPSHOT_SHAPE: AuthSnapshotShape = Object.freeze({
  request: Object.freeze([...AUTH_SNAPSHOT_SHAPE_V212.request, "depends_on_ids"]),
  actions: Object.freeze([...AUTH_SNAPSHOT_SHAPE_V212.actions, "request_origin_json"]),
});

// Columns added after receipts existed appear only when set, so receipts
// recorded before them keep verifying.
const OMITTED_WHEN_NULL = ["depends_on_ids", "space_publication_id", "protected_root_dirty_action_json"];
const JSON_REQUEST_COLUMNS = ["depends_on_ids", "issue_ids", "issues", "issue_references", "issue_closures", "merge_finalizer_state", "change_report_json", "protected_root_dirty_action_json"];

export function authRequestSnapshot(db: Db, requestId: string, shape: AuthSnapshotShape = AUTH_SNAPSHOT_SHAPE): string {
  const row = db.prepare(`SELECT ${shape.request.join(", ")} FROM auth_requests WHERE id = ?`).get(requestId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Auth request '${requestId}' is missing.`);
  const request = Object.fromEntries(Object.entries(row).filter(([key, value]) => !OMITTED_WHEN_NULL.includes(key) || value !== null).map(([key, value]) => [
    key,
    JSON_REQUEST_COLUMNS.includes(key) ? parseJsonColumn(value) : value ?? null,
  ]));
  const actions = db.prepare(
    `SELECT ${shape.actions.join(", ")} FROM auth_request_actions WHERE auth_request_id = ? ORDER BY ordinal, id`,
  ).all(requestId).map((action) => {
    const record = action as Record<string, unknown>;
    const { request_origin_json, ...rest } = record;
    return { ...rest, payload: parseJsonColumn(record.payload),
      ...(request_origin_json == null ? {} : { request_origin_json }) };
  });
  const publication = authPublicationSnapshot(db, requestId);
  return JSON.stringify({ request, actions, ...(publication ? { publication } : {}) });
}

export function authSnapshotDigest(snapshot: string): string {
  return createHash("sha256").update(snapshot).digest("hex");
}
