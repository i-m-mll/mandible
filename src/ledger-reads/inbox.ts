import path from "node:path";
import { getDb, type Db } from "../db.js";
import { computeAuthRequestOutcome } from "../contracts.js";
import type { AuthRequestOutcome, AuthRequestStatus, WebhookEventRow } from "../types.js";
import type { RepoInfo } from "../work-scanner.js";
import { listLedgerOpenIssues } from "../ledger/issue-projection.js";
import { mapWorkUnitRow, readWorkUnitLivenessSnapshot } from "../work-unit-utils.js";
import { getIntSetting } from "../routes/settings.js";
import { listManagedReminderOccurrences, getManagedReminder, resolveManagedReminderProject } from "../managed-reminders.js";

export interface ContinuationRow {
  id: string;
  branch: string;
  continuation: string;
  ended_at: string;
  cwd: string | null;
}

interface AuthResultRow {
  id: string;
  title: string;
  status: AuthRequestStatus;
  exit_code: number | null;
  error: string | null;
  head_branch: string | null;
  resolved_at: number | null;
  repo: string | null;
  base_branch: string | null;
  post_merge_handoff: string | null;
  issue_references: string | null;
  issue_closures: string | null;
  issue_ids: string | null;
  // Bug: 4e32923 — scoping fields used by the three-tier query
  target_session_id: string | null;
  target_repo_root: string | null;
  delivered_at: number | null;
}

// Bug: 93c57c4 — the status-to-outcome mapping is canonical in contracts.ts.
function computeOutcome(row: AuthResultRow): AuthRequestOutcome {
  return computeAuthRequestOutcome(row.status);
}

// Bug: 4e32923 — auth_result tier classification used for scoped inbox delivery.
//   tier 1: owner session (target_session_id matches current session)
//   tier 2: same project (target_repo_root matches), after project grace window
//   tier 3: any session, after global grace window
//   tier 0: legacy unscoped rows (target_session_id IS NULL) — broadcast as before
type AuthResultTier = 0 | 1 | 2 | 3;

const COLUMNS_AUTH_RESULT =
  "id, title, status, exit_code, error, head_branch, resolved_at, repo, base_branch, " +
  "post_merge_handoff, issue_references, issue_closures, issue_ids, target_session_id, target_repo_root, delivered_at";

export const RESOLVED_STATUSES = "('completed', 'failed', 'rejected', 'withdrawn', 'superseded', 'expired', 'dismissed', 'needs_rebase')";

interface TierRow {
  row: AuthResultRow;
  tier: AuthResultTier;
}

interface AuthResultScope {
  sessionId: string;
  repoRoot: string | null;
  branch?: string | null;
}

/**
 * Bug: 4e32923 — the three-tier escalation model as one SQL source shared by
 * the inbox list and the badge count. `tier` is NULL when the current session
 * has no claim on the row yet (it still belongs only to its owner / project).
 *   tier 0: legacy unscoped rows (no target session), broadcast as before
 *   tier 1: owner session sees its own undelivered result immediately
 *   tier 2: any session in the same repo, after the project grace window
 *   tier 3: any session anywhere, after the global grace window
 */
function authResultTierQuery(opts: AuthResultScope): { from: string; params: unknown[] } {
  const now = Date.now();
  const projectCutoff = now - getIntSetting("inbox.project_grace_days", 7) * 86_400_000;
  const globalCutoff = now - getIntSetting("inbox.global_grace_days", 30) * 86_400_000;
  const params: unknown[] = [opts.sessionId, opts.repoRoot, projectCutoff, globalCutoff];
  const branchFilter = opts.branch ? " AND head_branch = ?" : "";
  if (opts.branch) params.push(opts.branch);
  const from = `(SELECT *, CASE
        WHEN target_session_id IS NULL THEN 0
        WHEN target_session_id = ?1 THEN 1
        WHEN ?2 IS NOT NULL AND target_repo_root = ?2 AND COALESCE(resolved_at, 0) <= ?3 THEN 2
        WHEN COALESCE(resolved_at, 0) <= ?4 THEN 3
      END AS tier
      FROM auth_requests
      WHERE status IN ${RESOLVED_STATUSES} AND acknowledged_by IS NULL AND delivered_at IS NULL${branchFilter})
    WHERE tier IS NOT NULL`;
  return { from, params };
}

/**
 * Bug: 4e32923 — auth_results the given session + repo may claim, owner tier
 * first and most recent first within a tier. A branch filter restricts to
 * auth requests targeting that head branch for branch-bound dashboards.
 */
export function queryAuthResultsForSession(db: ReturnType<typeof getDb>, opts: AuthResultScope): TierRow[] {
  const { from, params } = authResultTierQuery(opts);
  const rows = db.prepare(
    `SELECT ${COLUMNS_AUTH_RESULT}, tier FROM ${from} ORDER BY tier ASC, COALESCE(resolved_at, 0) DESC`,
  ).all(...params) as Array<AuthResultRow & { tier: AuthResultTier }>;
  return rows.map(({ tier, ...row }) => ({ row, tier }));
}

export function countAuthResultsForSession(db: ReturnType<typeof getDb>, opts: AuthResultScope): number {
  const { from, params } = authResultTierQuery(opts);
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${from}`).get(...params) as { count: number }).count);
}

/**
 * Issue 27241e6 — open convergence alerts. One row per (auth request, hook),
 * enforced by a UNIQUE constraint, so a hook that fails on every attempt
 * contributes exactly one inbox item rather than one per attempt. Repo-scoped
 * when the caller supplied a repo, because a convergence failure is a fact
 * about one repository's deployed state.
 */
export function hookAlertItems(
  db: ReturnType<typeof getDb>,
  repo?: string | null,
): Array<Record<string, unknown>> {
  const present = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_hook_alerts'",
  ).get();
  if (!present) return [];
  const rows = repo
    ? db.prepare(
        `SELECT * FROM auth_hook_alerts WHERE acknowledged_at IS NULL AND repo = ?
         ORDER BY created_at DESC LIMIT 50`,
      ).all(repo) as Array<Record<string, unknown>>
    : db.prepare(
        `SELECT * FROM auth_hook_alerts WHERE acknowledged_at IS NULL
         ORDER BY created_at DESC LIMIT 50`,
      ).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id,
    auth_request_id: row.auth_request_id,
    hook_id: row.hook_id,
    hook_label: row.hook_label,
    session_id: row.session_id,
    repo: row.repo,
    detail: row.detail,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}



export function parseWebhookData(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function getSessionRepoRoot(db: Db, sessionId: string): string | null {
  if (!sessionId) return null;
  const row = db
    .prepare("SELECT cwd FROM sessions WHERE id = ? LIMIT 1")
    .get(sessionId) as { cwd: string | null } | undefined;
  return row?.cwd ?? null;
}

export function mapAuthResultRow(db: Db, row: AuthResultRow, tier: AuthResultTier, includeRepo: boolean) {
  const base: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    status: row.status,
    outcome: computeOutcome(row),
    exit_code: row.exit_code,
    error: row.error,
    head_branch: row.head_branch,
    resolved_at: row.resolved_at,
    post_merge_handoff: row.post_merge_handoff ?? null,
    issue_references: row.issue_references ? JSON.parse(row.issue_references) : null,
    issue_closures: row.issue_closures ? JSON.parse(row.issue_closures) : null,
    issue_ids: row.issue_ids ? JSON.parse(row.issue_ids) : null,
    // Bug: 4e32923 — surface delivery scope so clients can distinguish
    // "this was meant for me" (tier 1) from escalated items (tier 2/3).
    tier,
    target_session_id: row.target_session_id,
    target_repo_root: row.target_repo_root,
    action_outcomes: authActionOutcomes(db, row.id),
  };
  if (includeRepo) {
    base.repo = row.repo ?? null;
    base.base_branch = row.base_branch ?? null;
  }
  return base;
}

export function authActionOutcomes(db: Db, requestId: string): Array<Record<string, unknown>> {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_request_actions'",
  ).get();
  if (!exists) return [];
  const rows = db.prepare(
    `SELECT id, ordinal, kind, target_issue_ref, state, applied_at, outcome_detail
     FROM auth_request_actions
     WHERE auth_request_id = ?
     ORDER BY ordinal ASC, staged_at ASC, id ASC`,
  ).all(requestId) as Array<{
    id: string;
    ordinal: number;
    kind: string;
    target_issue_ref: string;
    state: string;
    applied_at: number | null;
    outcome_detail: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    ordinal: row.ordinal,
    kind: row.kind,
    target_issue_ref: row.target_issue_ref,
    state: row.state,
    applied_at: row.applied_at,
    outcome_detail: row.outcome_detail,
  }));
}

export function reminderOccurrenceItems(db: Db, projectRef?: string): Array<Record<string, unknown>> {
  let projectId: string | undefined;
  if (projectRef) {
    try {
      projectId = resolveManagedReminderProject(db, projectRef).id;
    } catch {
      return [];
    }
  }
  return listManagedReminderOccurrences(db, { projectId, acknowledged: false }).map((occurrence) => {
    const reminder = getManagedReminder(db, occurrence.task_id);
    return {
      id: occurrence.id,
      task_id: occurrence.task_id,
      revision_id: occurrence.revision_id,
      message: occurrence.message,
      project_id: reminder.project_id,
      project_key: reminder.project_key,
      predicate: reminder.revision.payload.predicate,
      payload_digest: reminder.revision.payload_digest,
      created_by_user_id: occurrence.created_by_user_id,
      fired_by_user_id: occurrence.fired_by_user_id,
      triggering_evidence: occurrence.triggering_evidence,
      created_at: occurrence.created_at,
    };
  });
}

function listInboxWorkUnits(db: Db, continuation: boolean, repo: string | null) {
  return (db.prepare(`SELECT * FROM work_units WHERE state IN ('open', 'committed')
    ${continuation ? "AND continuation IS NOT NULL" : ""}${repo ? " AND repo_id = ?" : ""}
    ORDER BY ${continuation ? "continuation_at" : "created_at"} DESC`).all(...(repo ? [repo] : [])) as Record<string, unknown>[]).map(mapWorkUnitRow);
}

export type InboxScope = { kind: "global" } | { kind: "scoped"; branch: string | null; repo: string | null };

export function inbox(db: Db, { sessionId, repos, scope }: { sessionId: string; repos: RepoInfo[] | null; scope: InboxScope }) {
  const global = scope.kind === "global";
  const branch = scope.kind === "scoped" ? scope.branch : null;
  const repo = scope.kind === "scoped" ? scope.repo : null;
  const continuations = db
    .prepare(
      `SELECT id, branch, continuation, ended_at, cwd FROM sessions
       WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL
         AND status IN ('ended', 'dead')${branch ? " AND branch = ? AND id != ?" : ""}
       ORDER BY ended_at DESC`
    )
    .all(...(branch ? [branch, sessionId] : [])) as ContinuationRow[];

  const repoRoot = sessionId ? getSessionRepoRoot(db, sessionId) : null;
  const authResultTiers = queryAuthResultsForSession(db, {
    sessionId,
    repoRoot,
    branch,
  });

  const workUnits = listInboxWorkUnits(db, false, repo);
  const workUnitContinuations = listInboxWorkUnits(db, true, repo);

  const issues = repos && (global || repo) ? listLedgerOpenIssues(db, { getRepos: () => repos }, repo ?? undefined) : [];
  const openIssues = global ? issues : issues.map(({ id, title, labels }) => ({ id, title, labels }));

  const pendingWebhooks = db
    .prepare(
      `SELECT * FROM webhook_events
       WHERE status = 'pending'${branch ? " AND target_branch = ?" : ""}
       ORDER BY created_at DESC LIMIT 50`
    )
    .all(...(branch ? [branch] : [])) as WebhookEventRow[];

  const reminderOccurrences = reminderOccurrenceItems(db, repo ?? undefined);
  const hookAlerts = hookAlertItems(db, repo);

  const total = continuations.length + authResultTiers.length + openIssues.length
    + workUnits.length + workUnitContinuations.length + pendingWebhooks.length
    + reminderOccurrences.length + hookAlerts.length;

  const payload = {
    continuations: continuations.map((row) => ({
      session_id: row.id,
      continuation: row.continuation,
      branch: row.branch,
      ended_at: row.ended_at,
      ...(global ? { repo: row.cwd ? path.basename(row.cwd) : null } : {}),
    })),
    auth_results: authResultTiers.map(({ row, tier }) => mapAuthResultRow(db, row, tier, global)),
    open_issues: openIssues,
    work_units: workUnits,
    work_unit_continuations: workUnitContinuations,
    pending_webhooks: pendingWebhooks.map((row) => ({
      id: row.id,
      source: row.source,
      event_type: row.event_type,
      title: row.title,
      priority: row.priority,
      target_branch: row.target_branch,
      target_issue: row.target_issue,
      created_at: row.created_at,
      // Issue 71a287e — the structured payload is what the dashboard alert
      // renders (credential label, leak location, remediation commands). It
      // never contains credential material.
      data: parseWebhookData(row.data_json),
    })),
    managed_reminder_occurrences: reminderOccurrences,
    // Issue 27241e6 — deduplicated convergence alerts: a merge landed but the
    // repository is not live until its required hook succeeds.
    hook_alerts: hookAlerts,
    total,
  };
  return { payload, liveness: readWorkUnitLivenessSnapshot(db, [...workUnits, ...workUnitContinuations]) };
}
