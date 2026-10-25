import { AuthHookManager } from "../auth-hooks.js";
import { authDependencies } from "../auth-dependency.js";
import { isAuthMergeCommand } from "../auth-context.js";
import { authRequestChangesBuildInputs } from "../runtime-build-scope.js";
import { latestCandidateAcceptances, type CandidateAcceptanceRead } from "../candidate-acceptance.js";
import type { Db } from "../db.js";
import type { AuthRequestSummary, AuthConvergence } from "../types.js";
import { mapRow, parseChangeReport } from "../auth-request-row.js";
import { AttributionReadResolver, authAttributionReadFields } from "../identity/read-projection.js";
import { listAuthExecutionAttempts } from "../auth-lifecycle.js";

// Columns selected for the history list projection. Deliberately excludes the
// unbounded body blobs `diff_summary`, `spec_content`, and `output` so a
// 50–200 row list does not read or serialize megabytes of text per poll. The
// full body is served by the detail route and fetched on selection. Keep this
// list updated when a non-blob auth_requests column is added.
const AUTH_HISTORY_SUMMARY_COLUMNS = [
  "id", "session_id", "command", "title", "cwd", "status",
  "created_at", "updated_at", "approved_at", "resolved_at", "skipped_at",
  "expires_at", "exit_code", "error", "repo", "base_branch", "head_branch",
  "files_changed", "additions", "deletions", "execution_mode", "commit_message",
  // Issue 7d64d8f — small scalar digest; list surfaces need it to label an
  // agent-authored canonical change message without refetching the detail row.
  "commit_message_digest",
  "last_executed_at", "acknowledged_by", "post_merge_handoff", "issue_ids",
  "depends_on_id", "issues", "type", "target_session_id", "target_repo_root",
  "delivered_at", "conversation_id", "approval_source", "approval_lease_id",
  "issue_references", "issue_closures", "merge_preflight_base_sha",
  "merge_preflight_queue_fingerprint", "merge_head_sha", "merge_candidate_tree_sha",
  "merge_candidate_pin_sha", "merge_atomic_enabled", "merge_finalized_at",
  // Issue 98d25f3 — omitting this made summaries report every request's
  // finalizer state as null, because `mapRow` maps an absent column to null and
  // cannot tell "not selected" from "not set". It is a small bounded JSON blob
  // (one record per finalizer step), not one of the unbounded body blobs.
  "merge_finalizer_state",
  // Issue 84d940f — same class as 98d25f3. Omitting these made every history
  // row's requester/approver/execution evidence resolve from a fabricated null:
  // `GET /api/auth/history` feeds the summary straight into
  // `authAttributionReadFields`, which reads exactly these three ids. They are
  // small scalar id columns, so projecting them costs nothing.
  "space_publication_id", "requested_by_user_id", "requester_evidence_method", "requester_credential_id",
  "approved_by_user_id", "execution_evidence_id", "clearance_use_id",
  "supersedes_request_id", "superseded_by_request_id",
  "custody_work_unit_id",
  // Issue 8ae6b5f — small bounded JSON: where a dirty policy moved protected-root changes.
  "protected_root_dirty_action_json",
].join(", ");

export function listAuthHistorySummaries(db: Db, { limit = 50 }: { limit?: number }): AuthRequestSummary[] {
  const rows = db
    .prepare(
      `SELECT ${AUTH_HISTORY_SUMMARY_COLUMNS} FROM auth_requests INDEXED BY idx_auth_requests_history ` +
        "WHERE status IN ('completed', 'failed', 'rejected', 'withdrawn', 'superseded', 'dismissed') " +
        "ORDER BY resolved_at DESC LIMIT ?"
    )
    .all(limit) as Record<string, unknown>[];
  if (rows.length === 0) {
    return [];
  }
  const counts = countActionsForRequests(db, rows.map((row) => String(row.id)));
  return rows.map((row) => {
    const mapped = mapRow(row);
    // Omit the blob keys entirely so the client can distinguish "not loaded"
    // (undefined) from a genuinely empty body (null from the detail route).
    const { diff_summary, spec_content, output, change_report, ...summary } = mapped;
    void diff_summary;
    void spec_content;
    void output;
    void change_report;
    return { ...summary, action_count: counts.get(String(row.id)) ?? 0 };
  });
}

function countActionsForRequests(db: Db, ids: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (ids.length === 0) {
    return counts;
  }
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT auth_request_id, COUNT(*) AS count FROM auth_request_actions ` +
        `WHERE auth_request_id IN (${placeholders}) GROUP BY auth_request_id`
    )
    .all(...ids) as Array<{ auth_request_id: string; count: number }>;
  for (const row of rows) {
    counts.set(String(row.auth_request_id), Number(row.count));
  }
  return counts;
}

export function authHistory(db: Db, params: { limit: number; type?: string }) {
  const resolver = new AttributionReadResolver(db);
  const requests = listAuthHistorySummaries(db, params).filter(row => !params.type || row.type === params.type);
  const hooks = new AuthHookManager(db);
  const selfUpdatingRepos = hooks.selfUpdatingRepos([...new Set(requests.filter(isAuthMergeCommand).flatMap(row => row.repo ? [row.repo] : []))]);
  const selfUpdates = requests.filter(row => isAuthMergeCommand(row) && selfUpdatingRepos.has(row.repo ?? ""));
  const reports = selfUpdates.length === 0 ? [] : db.prepare(
    `SELECT id, change_report_json FROM auth_requests WHERE id IN (${selfUpdates.map(() => "?").join(", ")})`,
  ).all(...selfUpdates.map(row => row.id)) as Array<{ id: string; change_report_json: unknown }>;
  const changeReports = new Map(reports.map(row => [row.id, parseChangeReport(row.change_report_json)]));
  const acceptanceIds = new Set(selfUpdates.filter(row => authRequestChangesBuildInputs({
    ...row, change_report: changeReports.get(row.id) ?? null,
  })).map(row => row.id));
  const acceptances = latestCandidateAcceptances(db, [...acceptanceIds]);
  const dependencies = authDependencies(db, [...new Set(requests.flatMap(row => row.depends_on_id ? [row.depends_on_id] : []))]);
  let convergence: Map<string, AuthConvergence>;
  try {
    convergence = hooks.convergenceForRequests(requests.map(row => row.id));
  } catch {
    // Match AuthQueue.convergenceForRequest when durable hook rows cannot be read.
    convergence = new Map(requests.map(row => [row.id, { state: "none", hooks: [] }]));
  }
  return requests.map(row => ({
    request: {
      ...row,
      dependency: row.depends_on_id ? dependencies.get(row.depends_on_id)! : null,
      convergence: convergence.get(row.id)!,
      execution_attempts: listAuthExecutionAttempts(db, row.id),
      ...authAttributionReadFields(resolver, row),
    },
    selfUpdates: isAuthMergeCommand(row) && selfUpdatingRepos.has(row.repo ?? ""),
    acceptance: { applies: acceptanceIds.has(row.id), latest: acceptances.get(row.id) ?? null } satisfies CandidateAcceptanceRead,
  }));
}

