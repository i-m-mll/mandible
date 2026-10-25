import path from "node:path";
import type { AuthQueue } from "../auth-queue.js";
import { getDb, type Db } from "../db.js";
import { resolveId } from "../entity-refs.js";
import { listLedgerOpenIssues } from "../ledger/issue-projection.js";
import type { SessionManager } from "../session-manager.js";
import type { RouteOptions } from "../server.js";
import { computeAuthRequestOutcome, DOMAIN_EVENTS } from "../contracts.js";
import { broadcast } from "../sse.js";
import type { AuthRequestOutcome, AuthRequestStatus, WebhookEventRow } from "../types.js";
import type { WorkScanner } from "../work-scanner.js";
import { getIntSetting } from "./settings.js";
import {
  mapWorkUnitRow,
  workUnitLiveness,
  type WorkUnitWithLiveness,
} from "../work-unit-utils.js";
import { sendJson } from "./http.js";
import { resolveSessionIdAttributionResult } from "../identity/resolver.js";
import type { ResolvedClientIdentity } from "../server.js";
import {
  acknowledgeManagedReminderOccurrence,
  getManagedReminder,
  listManagedReminderOccurrences,
  resolveManagedReminderProject,
  ManagedReminderError,
} from "../managed-reminders.js";

// Bug: 8a281b3 — inbox rewrite: work units replace raw open issues as the
// primary "needs attention" signal. Auth results and continuations remain.

export interface InboxRouteServer {
  get(path: string, handler: (req: unknown, res: unknown) => void, options: RouteOptions): void;
  post(path: string, handler: (req: unknown, res: unknown) => void, options: RouteOptions): void;
}

function getQueryParam(req: unknown, key: string): string | undefined {
  if (!req || typeof req !== "object") return undefined;
  const record = req as Record<string, unknown>;
  if (!record.query || typeof record.query !== "object") return undefined;
  const query = record.query as Record<string, unknown>;
  const value = query[key];
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? (value[0] as string) : undefined;
  }
  return typeof value === "string" ? (value as string) : undefined;
}

function getParam(req: unknown, key: string): string | undefined {
  if (!req || typeof req !== "object") return undefined;
  const record = req as Record<string, unknown>;
  if (record.params && typeof record.params === "object") {
    const params = record.params as Record<string, unknown>;
    if (typeof params[key] === "string") return params[key] as string;
  }
  if (typeof record.param === "function") {
    const value = (record.param as (k: string) => unknown)(key);
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** Issue 71a287e — tolerate an unparseable webhook payload rather than 500. */
function parseWebhookData(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getBody(req: unknown): Record<string, unknown> | null {
  if (!req || typeof req !== "object") return null;
  const record = req as Record<string, unknown>;
  if (record.body && typeof record.body === "object") {
    return record.body as Record<string, unknown>;
  }
  return null;
}

function acknowledgementValue(
  db: ReturnType<typeof getDb>,
  req: unknown,
  sessionId: string | null,
  legacy: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const identity = req && typeof req === "object"
    ? (req as { client_identity?: ResolvedClientIdentity | null }).client_identity ?? null
    : null;
  const sessionResolution = sessionId
    ? resolveSessionIdAttributionResult(db, sessionId)
    : { status: "no_match" as const };
  if (sessionResolution.status === "conflict") {
    return { ok: false, error: "Acknowledgement session claims resolve to conflicting users." };
  }
  const sessionAttribution = sessionResolution.status === "resolved"
    ? sessionResolution.attribution
    : null;
  if (identity && sessionAttribution && identity.user_id !== sessionAttribution.user_id) {
    return { ok: false, error: "Authenticated client and acknowledgement session resolve to different users." };
  }
  return {
    ok: true,
    value: identity?.user_id ?? sessionAttribution?.user_id ?? (sessionId || legacy),
  };
}

interface ContinuationRow {
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

const RESOLVED_STATUSES = "('completed', 'failed', 'rejected', 'withdrawn', 'superseded', 'expired', 'dismissed', 'needs_rebase')";

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
function queryAuthResultsForSession(db: ReturnType<typeof getDb>, opts: AuthResultScope): TierRow[] {
  const { from, params } = authResultTierQuery(opts);
  const rows = db.prepare(
    `SELECT ${COLUMNS_AUTH_RESULT}, tier FROM ${from} ORDER BY tier ASC, COALESCE(resolved_at, 0) DESC`,
  ).all(...params) as Array<AuthResultRow & { tier: AuthResultTier }>;
  return rows.map(({ tier, ...row }) => ({ row, tier }));
}

function countAuthResultsForSession(db: ReturnType<typeof getDb>, opts: AuthResultScope): number {
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
function hookAlertItems(
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

function countOpenHookAlerts(db: ReturnType<typeof getDb>): number {
  const present = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_hook_alerts'",
  ).get();
  if (!present) return 0;
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM auth_hook_alerts WHERE acknowledged_at IS NULL",
  ).get() as { count: number };
  return Number(row.count);
}

export function countGlobalInboxBadge(db: ReturnType<typeof getDb>): number {
  const continuation = db.prepare(
    `SELECT COUNT(*) AS count FROM sessions
     WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL
       AND status IN ('ended', 'dead')`,
  ).get() as { count: number };
  const authResults = countAuthResultsForSession(db, { sessionId: "", repoRoot: null });
  const reminderOccurrences = db.prepare(
    "SELECT COUNT(*) AS count FROM managed_task_occurrences WHERE acknowledged_at IS NULL",
  ).get() as { count: number };
  return Number(continuation.count) + authResults + Number(reminderOccurrences.count)
    + countOpenHookAlerts(db);
}

// Bug: f3dbb3e — mapWorkUnitRow and work-unit liveness live in work-unit-utils.ts

/** Longest event-loop turn a bulk acknowledgement aims to take. */
const BULK_ACK_TURN_BUDGET_MS = 20;
/** Rows per transaction; the commit, not the UPDATE, writes the pages. */
const BULK_ACK_ROWS_PER_COMMIT = 8;

/**
 * Acknowledge every resolved, unacknowledged auth request, a budgeted slice
 * per event-loop turn. Setting `acknowledged_by` rewrites the whole row,
 * including its diff summary and output in overflow pages, so a backlog of a
 * thousand requests commits tens of megabytes that no index can avoid. Each
 * row is re-checked as it is written, so a request acknowledged or returned
 * to pending while the pass waits is left alone.
 */
async function acknowledgeResolvedAuthRequests(db: Db, ackValue: string): Promise<void> {
  const ids = (db.prepare(
    `SELECT id FROM auth_requests WHERE status IN ${RESOLVED_STATUSES} AND acknowledged_by IS NULL`,
  ).all() as Array<{ id: string }>).map((row) => row.id);
  const acknowledge = db.prepare(
    `UPDATE auth_requests SET acknowledged_by = ?
      WHERE id = ? AND status IN ${RESOLVED_STATUSES} AND acknowledged_by IS NULL`,
  );
  const commit = db.transaction((batch: string[]) => {
    for (const id of batch) acknowledge.run(ackValue, id);
  });
  let next = 0;
  while (next < ids.length) {
    const deadline = performance.now() + BULK_ACK_TURN_BUDGET_MS;
    do {
      commit(ids.slice(next, next + BULK_ACK_ROWS_PER_COMMIT));
      next += BULK_ACK_ROWS_PER_COMMIT;
    } while (next < ids.length && performance.now() < deadline);
    if (next < ids.length) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function registerInboxRoutes(
  server: InboxRouteServer,
  sessionManager?: SessionManager,
  // Bug: 4e32923 — authQueue is required for the new /api/inbox/delivered
  // endpoint that marks auth_requests as delivered to the owner session.
  authQueue?: AuthQueue,
  workScanner?: WorkScanner,
): void {
  const db = getDb();

  // Bug: 4e32923 — helper: best-effort lookup of a session's repo root for
  // tier-2/3 scoping. The sessions table stores the repo root in `cwd`.
  function getSessionRepoRoot(sessionId: string): string | null {
    if (!sessionId) return null;
    const row = db
      .prepare("SELECT cwd FROM sessions WHERE id = ? LIMIT 1")
      .get(sessionId) as { cwd: string | null } | undefined;
    return row?.cwd ?? null;
  }

  function mapAuthResultRow(row: AuthResultRow, tier: AuthResultTier, includeRepo: boolean) {
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
      action_outcomes: authActionOutcomes(row.id),
    };
    if (includeRepo) {
      base.repo = row.repo ?? null;
      base.base_branch = row.base_branch ?? null;
    }
    return base;
  }

  function authActionOutcomes(requestId: string): Array<Record<string, unknown>> {
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

  // Bug: 8a281b3 — helper to get work units needing attention for inbox
  function getWorkUnitsNeedingAttention(repoFilter?: string): WorkUnitWithLiveness[] {
    const conditions = ["state IN ('open', 'committed')"];
    const params: unknown[] = [];

    if (repoFilter) {
      conditions.push("repo_id = ?");
      params.push(repoFilter);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM work_units${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[];

    const workUnits = rows.map(mapWorkUnitRow);
    const liveness = workUnitLiveness(db, workUnits, sessionManager);
    return workUnits
      .map((wu) => ({ ...wu, liveness: liveness(wu) }))
      // Show work units that need attention: their agent has stopped. One whose
      // liveness is unknown may still be worked on, so it is not offered.
      .filter((wu) => wu.liveness.state === "stopped");
  }

  // Bug: 8a281b3 — helper to get work-unit continuations
  // Bug: f3dbb3e — filter by open/committed state so resolved/abandoned units
  // don't surface stale continuations
  function getWorkUnitContinuations(repoFilter?: string): WorkUnitWithLiveness[] {
    const conditions = ["continuation IS NOT NULL", "state IN ('open', 'committed')"];
    const params: unknown[] = [];

    if (repoFilter) {
      conditions.push("repo_id = ?");
      params.push(repoFilter);
    }

    const where = ` WHERE ${conditions.join(" AND ")}`;
    const rows = db
      .prepare(`SELECT * FROM work_units${where} ORDER BY continuation_at DESC`)
      .all(...params) as Record<string, unknown>[];

    const workUnits = rows.map(mapWorkUnitRow);
    const liveness = workUnitLiveness(db, workUnits, sessionManager);
    return workUnits
      .map((wu) => ({ ...wu, liveness: liveness(wu) }))
      // Only show continuations whose agent has stopped
      .filter((wu) => wu.liveness.state === "stopped");
  }

  function ledgerOpenIssues(repoFilter?: string): Array<{
    id: string;
    title: string;
    labels: string[];
    repo_id?: string;
    repo_name?: string;
  }> {
    if (!workScanner) return [];
    return listLedgerOpenIssues(db, workScanner, repoFilter);
  }

  function reminderOccurrenceItems(projectRef?: string): Array<Record<string, unknown>> {
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

  // GET /api/inbox — unified query of pending items for a branch
  server.get("/api/inbox", (req, res) => {
    const branch = getQueryParam(req, "branch");
    const repo = getQueryParam(req, "repo");
    const sessionId = getQueryParam(req, "session_id") ?? "";

    // Continuations: ended/dead sessions with unacknowledged continuation notes
    const continuations = branch
      ? (db
          .prepare(
            `SELECT id, branch, continuation, ended_at FROM sessions
             WHERE branch = ? AND continuation IS NOT NULL AND continuation_acked_by IS NULL
               AND status IN ('ended', 'dead') AND id != ?
             ORDER BY ended_at DESC`
          )
          .all(branch, sessionId) as ContinuationRow[])
      : (db
          .prepare(
            `SELECT id, branch, continuation, ended_at FROM sessions
             WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL
               AND status IN ('ended', 'dead')
             ORDER BY ended_at DESC`
          )
          .all() as ContinuationRow[]);

    // Bug: 4e32923 — three-tier auth_result query: owner session (tier 1),
    // same project after grace (tier 2), global after grace (tier 3), and
    // legacy unscoped rows (tier 0) broadcast as before for safety.
    const repoRoot = sessionId ? getSessionRepoRoot(sessionId) : null;
    const authResultTiers = queryAuthResultsForSession(db, {
      sessionId,
      repoRoot,
      branch: branch ?? null,
    });

    // Bug: 8a281b3 — work units replace open issues as the primary "needs attention" signal
    const workUnits = getWorkUnitsNeedingAttention(repo ?? undefined);
    const workUnitContinuations = getWorkUnitContinuations(repo ?? undefined);

    // Open issues: ledger-backed compatibility field, filtered by repo.
    const openIssues = repo
      ? ledgerOpenIssues(repo).map(({ id, title, labels }) => ({ id, title, labels }))
      : [];

    // Bug: 9f66ad9 — pending webhook events, optionally filtered by branch
    const pendingWebhooks = branch
      ? (db
          .prepare(
            `SELECT * FROM webhook_events
             WHERE status = 'pending' AND target_branch = ?
             ORDER BY created_at DESC LIMIT 50`
          )
          .all(branch) as WebhookEventRow[])
      : (db
          .prepare(
            `SELECT * FROM webhook_events
             WHERE status = 'pending'
             ORDER BY created_at DESC LIMIT 50`
          )
          .all() as WebhookEventRow[]);

    const reminderOccurrences = reminderOccurrenceItems(repo);
    const hookAlerts = hookAlertItems(db, repo ?? null);

    const total = continuations.length + authResultTiers.length + openIssues.length
      + workUnits.length + workUnitContinuations.length + pendingWebhooks.length
      + reminderOccurrences.length + hookAlerts.length;

    sendJson(res, 200, {
      continuations: continuations.map((row) => ({
        session_id: row.id,
        continuation: row.continuation,
        branch: row.branch,
        ended_at: row.ended_at,
      })),
      auth_results: authResultTiers.map(({ row, tier }) => mapAuthResultRow(row, tier, false)),
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
    });
  }, { operation: { id: "get:/api/inbox", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // GET /api/inbox/global — all unacknowledged items across all branches and repos
  server.get("/api/inbox/global", (req, res) => {
    const sessionId = getQueryParam(req, "session_id") ?? "";

    // Continuations: all unacknowledged, any branch
    const continuations = db
      .prepare(
        `SELECT id, branch, continuation, ended_at, cwd FROM sessions
         WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL
           AND status IN ('ended', 'dead')
         ORDER BY ended_at DESC`
      )
      .all() as ContinuationRow[];

    // Bug: 4e32923 — same three-tier query as branch-scoped inbox, but without
    // a branch filter. If session_id is unknown, only legacy (tier 0) and
    // global-grace-aged (tier 3) rows surface — owner/project tiers require a
    // session id to make sense.
    const repoRoot = sessionId ? getSessionRepoRoot(sessionId) : null;
    const authResultTiers = queryAuthResultsForSession(db, {
      sessionId,
      repoRoot,
      branch: null,
    });

    // Bug: 8a281b3 — work units needing attention (all repos)
    const workUnits = getWorkUnitsNeedingAttention();
    const workUnitContinuations = getWorkUnitContinuations();

    // Open issues: all ledger repos (kept for backward compat).
    const openIssues = ledgerOpenIssues();

    // Bug: 9f66ad9 — pending webhook events (all)
    const pendingWebhooks = db
      .prepare(
        `SELECT * FROM webhook_events
         WHERE status = 'pending'
         ORDER BY created_at DESC LIMIT 50`
      )
      .all() as WebhookEventRow[];

    const reminderOccurrences = reminderOccurrenceItems();
    const hookAlerts = hookAlertItems(db, null);

    const total = continuations.length + authResultTiers.length + openIssues.length
      + workUnits.length + workUnitContinuations.length + pendingWebhooks.length
      + reminderOccurrences.length + hookAlerts.length;

    sendJson(res, 200, {
      continuations: continuations.map((row) => ({
        session_id: row.id,
        continuation: row.continuation,
        branch: row.branch,
        ended_at: row.ended_at,
        repo: row.cwd ? path.basename(row.cwd) : null,
      })),
      auth_results: authResultTiers.map(({ row, tier }) => mapAuthResultRow(row, tier, true)),
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
    });
  }, { operation: { id: "get:/api/inbox/global", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // Bug: 4e32923 — GET /api/inbox/undelivered?target_session_id=<id> returns
  // the set of resolved auth_requests owned by <id> that have not yet been
  // marked delivered. The channel server calls this on startup so a previous
  // session's session-id (e.g. after a Claude Code resume that preserves
  // MANDIBLE_SESSION_ID) can replay any auth results that resolved while the
  // SSE listener was offline — before subscribing to the live event stream.
  //
  // Returns a minimal record set: id, head_branch, status, exit_code,
  // resolved_at, title — enough to build a channel-event payload without a
  // second fetch. Rows still subject to tier-1 ownership: target_session_id
  // must match and delivered_at must be NULL. Legacy unscoped rows
  // (target_session_id IS NULL) are intentionally excluded — they belong to
  // every session and are delivered live, not replayed.
  server.get("/api/inbox/undelivered", (req, res) => {
    const targetSessionId = getQueryParam(req, "target_session_id") ?? "";
    // Bug: 6d7411b — conversation_id is a secondary matching criterion. When
    // Claude Code resumes, the session id changes but the conversation id
    // persists. Passing both lets the query return auth requests submitted
    // under a previous session id for the same conversation.
    const conversationId = getQueryParam(req, "conversation_id") ?? "";
    if (!targetSessionId) {
      sendJson(res, 400, { error: "missing target_session_id" });
      return;
    }

    // Bug: 6d7411b — match on EITHER target_session_id OR conversation_id so
    // auth requests submitted under a previous session id (before a resume)
    // are still discoverable by the new session.
    let sql: string;
    let params: unknown[];
    if (conversationId) {
      sql =
        `SELECT id, head_branch, status, exit_code, resolved_at, title, target_session_id
         FROM auth_requests
         WHERE (target_session_id = ? OR conversation_id = ?)
           AND delivered_at IS NULL
           AND resolved_at IS NOT NULL
           AND acknowledged_by IS NULL
           AND status IN ('completed', 'failed', 'rejected', 'withdrawn', 'superseded', 'expired', 'dismissed', 'needs_rebase')
         ORDER BY resolved_at ASC`;
      params = [targetSessionId, conversationId];
    } else {
      sql =
        `SELECT id, head_branch, status, exit_code, resolved_at, title, target_session_id
         FROM auth_requests
         WHERE target_session_id = ?
           AND delivered_at IS NULL
           AND resolved_at IS NOT NULL
           AND acknowledged_by IS NULL
           AND status IN ('completed', 'failed', 'rejected', 'withdrawn', 'superseded', 'expired', 'dismissed', 'needs_rebase')
         ORDER BY resolved_at ASC`;
      params = [targetSessionId];
    }

    const rows = db
      .prepare(sql)
      .all(...params) as Array<{
        id: string;
        head_branch: string | null;
        status: AuthRequestStatus;
        exit_code: number | null;
        resolved_at: number | null;
        title: string | null;
        target_session_id: string | null;
      }>;
    sendJson(res, 200, {
      undelivered: rows.map((row) => ({
        id: row.id,
        head_branch: row.head_branch,
        status: row.status,
        exit_code: row.exit_code,
        resolved_at: row.resolved_at,
        title: row.title,
        target_session_id: row.target_session_id,
        action_outcomes: authActionOutcomes(row.id),
      })),
    });
  }, { operation: { id: "get:/api/inbox/undelivered", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // Bug: 4e32923 — POST /api/inbox/delivered/:id marks an auth_request as
  // delivered to its owner session via the MCP channel server. Idempotent:
  // re-delivery returns 204 without further work. Once marked, the row stops
  // surfacing on the owner's tier-1 inbox and does not escalate to tiers 2/3.
  server.post("/api/inbox/delivered/:id", (req, res) => {
    const id = getParam(req, "id");
    if (!id) {
      sendJson(res, 400, { error: "missing auth_request id" });
      return;
    }
    if (!authQueue) {
      // Defensive: in test contexts that wire inbox without an authQueue, we
      // fall back to a direct DB update so the endpoint stays exercisable.
      const resolved = resolveId(db, "auth_request", id);
      if (!resolved.ok) {
        sendJson(res, resolved.error === "ambiguous" ? 409 : 404, {
          error: resolved.error === "ambiguous"
            ? `ambiguous prefix '${id}' names more than one auth request (${resolved.matches.join(", ")}); pass a longer prefix.`
            : "auth request not found",
        });
        return;
      }
      const now = Date.now();
      db.prepare(
        "UPDATE auth_requests SET delivered_at = ?, updated_at = ? WHERE id = ? AND delivered_at IS NULL"
      ).run(now, now, resolved.id);
      sendJson(res, 204, null);
      return;
    }
    const ok = authQueue.markDelivered(id);
    if (!ok) {
      sendJson(res, 404, { error: "auth request not found" });
      return;
    }
    broadcast(DOMAIN_EVENTS.INBOX_ACKNOWLEDGED, { kind: "delivered", id });
    sendJson(res, 204, null);
  }, { operation: { id: "post:/api/inbox/delivered/:id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "inbox" }, fileRpc: "allow" });

  // POST /api/inbox/ack-all — acknowledge all unacknowledged continuations and auth results
  server.post("/api/inbox/ack-all", async (req, res) => {
    const ack = acknowledgementValue(db, req, null, "bulk");
    if (!ack.ok) {
      sendJson(res, 403, { error: ack.error });
      return;
    }
    db.prepare(
      "UPDATE sessions SET continuation_acked_by = ? WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL AND status IN ('ended', 'dead')"
    ).run(ack.value);
    await acknowledgeResolvedAuthRequests(db, ack.value);
    db.prepare(
      `UPDATE managed_task_occurrences
          SET acknowledged_by = ?, acknowledged_at = ?
        WHERE acknowledged_at IS NULL`,
    ).run(ack.value, Date.now());
    broadcast(DOMAIN_EVENTS.INBOX_ACKNOWLEDGED, { kind: "all", id: null });
    sendJson(res, 200, { ok: true });
  }, { operation: { id: "post:/api/inbox/ack-all", effects: ["ledger:write"], requestSchema: null, reportingCategory: "inbox" }, fileRpc: "deny" });

  // POST /api/inbox/:type/:id/ack — acknowledge an inbox item
  server.post("/api/inbox/:type/:id/ack", (req, res) => {
    const type = getParam(req, "type");
    const id = getParam(req, "id");
    if (!type || !id) {
      sendJson(res, 400, { error: "missing type or id" });
      return;
    }

    const body = getBody(req);
    const sessionId = typeof body?.session_id === "string" ? body.session_id : null;
    const ack = acknowledgementValue(db, req, sessionId, "manual");
    if (!ack.ok) {
      sendJson(res, 403, { error: ack.error });
      return;
    }

    if (type === "continuation") {
      // Bug: caa157e — resolve UUID prefix for session IDs
      const resolved = resolveId(db, "session_row", id);
      if (!resolved.ok) {
        if (resolved.error === "ambiguous") {
          sendJson(res, 409, {
            error: `ambiguous prefix '${id}' names more than one session (${resolved.matches.join(", ")}); pass a longer prefix.`
          });
        } else {
          sendJson(res, 404, { error: "continuation not found or already acknowledged" });
        }
        return;
      }
      const result = db
        .prepare(
          "UPDATE sessions SET continuation_acked_by = ? WHERE id = ? AND continuation_acked_by IS NULL"
        )
        .run(ack.value, resolved.id);
      if (result.changes === 0) {
        sendJson(res, 404, { error: "continuation not found or already acknowledged" });
        return;
      }
      broadcast(DOMAIN_EVENTS.INBOX_ACKNOWLEDGED, { kind: "continuation", id: resolved.id });
      sendJson(res, 200, { ok: true });
    } else if (type === "auth_result") {
      // Bug: caa157e — resolve UUID prefix for auth request IDs
      const resolved = resolveId(db, "auth_request", id);
      if (!resolved.ok) {
        if (resolved.error === "ambiguous") {
          sendJson(res, 409, {
            error: `ambiguous prefix '${id}' names more than one auth request (${resolved.matches.join(", ")}); pass a longer prefix.`
          });
        } else {
          sendJson(res, 404, { error: "auth request not found or already acknowledged" });
        }
        return;
      }
      const result = db
        .prepare(
          "UPDATE auth_requests SET acknowledged_by = ? WHERE id = ? AND acknowledged_by IS NULL"
        )
        .run(ack.value, resolved.id);
      if (result.changes === 0) {
        sendJson(res, 404, { error: "auth request not found or already acknowledged" });
        return;
      }
      broadcast(DOMAIN_EVENTS.INBOX_ACKNOWLEDGED, { kind: "auth_result", id: resolved.id });
      sendJson(res, 200, { ok: true });
    } else if (type === "hook_alert") {
      // Issue 27241e6 — acknowledging the alert dismisses the notice only. It
      // does not mark the request converged; the durable hook row still says
      // `failed` until a retry actually succeeds.
      const result = db
        .prepare(
          "UPDATE auth_hook_alerts SET acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ? AND acknowledged_at IS NULL",
        )
        .run(Date.now(), ack.value, Date.now(), id);
      if (result.changes === 0) {
        sendJson(res, 404, { error: "hook alert not found or already acknowledged" });
        return;
      }
      broadcast(DOMAIN_EVENTS.INBOX_ACKNOWLEDGED, { kind: "hook_alert", id });
      sendJson(res, 200, { ok: true });
    } else if (type === "managed_reminder_occurrence") {
      try {
        acknowledgeManagedReminderOccurrence(db, id, ack.value);
        broadcast(DOMAIN_EVENTS.INBOX_ACKNOWLEDGED, { kind: "managed_reminder_occurrence", id });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        if (error instanceof ManagedReminderError) {
          sendJson(res, error.status, { error: error.message, code: error.code });
        } else {
          throw error;
        }
      }
    } else {
      sendJson(res, 400, {
        error: "type must be 'continuation', 'auth_result', 'hook_alert', or 'managed_reminder_occurrence'",
      });
    }
  }, { operation: { id: "post:/api/inbox/:type/:id/ack", effects: ["ledger:write"], requestSchema: null, reportingCategory: "inbox" }, fileRpc: "allow" });
}
