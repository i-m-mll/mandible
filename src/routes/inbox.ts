import { inlineLedgerReader, type LedgerReader } from "../ledger-reads/index.js";
import { RESOLVED_STATUSES, type ContinuationRow, authActionOutcomes, parseWebhookData, getSessionRepoRoot, mapAuthResultRow, reminderOccurrenceItems, queryAuthResultsForSession, countAuthResultsForSession, hookAlertItems } from "../ledger-reads/inbox.js";
import { forEachInEventLoopSlices } from "../event-loop-slices.js";
import type { AuthQueue } from "../auth-queue.js";
import { getDb, type Db } from "../db.js";
import { resolveId } from "../entity-refs.js";
import { listLedgerOpenIssues } from "../ledger/issue-projection.js";
import type { SessionManager } from "../session-manager.js";
import type { RouteOptions } from "../server.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import { broadcast } from "../sse.js";
import type { AuthRequestStatus, WebhookEventRow } from "../types.js";
import type { WorkScanner } from "../work-scanner.js";
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

/** Rows per transaction; the commit, not the UPDATE, writes the pages. */
const BULK_ACK_ROWS_PER_COMMIT = 8;

/**
 * Acknowledge every resolved, unacknowledged auth request, a budgeted slice
 * per event-loop turn. Setting `acknowledged_by` rewrites the whole row,
 * including its diff summary and output in overflow pages, so a backlog of a
 * thousand requests commits tens of megabytes that no index can avoid. Each
 * row's resolution is re-checked as it is written, so a request acknowledged
 * or retried while the pass waits is left alone.
 */
async function acknowledgeResolvedAuthRequests(db: Db, ackValue: string): Promise<void> {
  const resolutions = db.prepare(
    `SELECT id, resolved_at FROM auth_requests WHERE status IN ${RESOLVED_STATUSES} AND acknowledged_by IS NULL`,
  ).all() as Array<{ id: string; resolved_at: number | null }>;
  const acknowledge = db.prepare(
    `UPDATE auth_requests SET acknowledged_by = ?
      WHERE id = ? AND resolved_at IS ? AND status IN ${RESOLVED_STATUSES} AND acknowledged_by IS NULL`,
  );
  const commit = db.transaction((batch: typeof resolutions) => {
    for (const row of batch) acknowledge.run(ackValue, row.id, row.resolved_at);
  });
  function* batches() {
    for (let next = 0; next < resolutions.length; next += BULK_ACK_ROWS_PER_COMMIT) {
      yield resolutions.slice(next, next + BULK_ACK_ROWS_PER_COMMIT);
    }
  }
  await forEachInEventLoopSlices(batches(), commit);
}

export function registerInboxRoutes(
  server: InboxRouteServer,
  sessionManager?: SessionManager,
  // Bug: 4e32923 — authQueue is required for the new /api/inbox/delivered
  // endpoint that marks auth_requests as delivered to the owner session.
  authQueue?: AuthQueue,
  workScanner?: WorkScanner,
  reader: LedgerReader = inlineLedgerReader(),
): void {
  const db = getDb();

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
    const repoRoot = sessionId ? getSessionRepoRoot(db, sessionId) : null;
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

    const reminderOccurrences = reminderOccurrenceItems(db, repo);
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
      auth_results: authResultTiers.map(({ row, tier }) => mapAuthResultRow(db, row, tier, false)),
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
  server.get("/api/inbox/global", async (req, res) => {
    const sessionId = getQueryParam(req, "session_id") ?? "";

    const payload = await reader.run("inbox_global", { sessionId, repos: workScanner?.getRepos() ?? null });
    const liveness = workUnitLiveness(db, [...payload.work_units, ...payload.work_unit_continuations], sessionManager);
    const stopped = (units: typeof payload.work_units) => units
      .map(wu => ({ ...wu, liveness: liveness(wu) }))
      .filter(wu => wu.liveness.state === "stopped");
    const workUnits = stopped(payload.work_units);
    const continuations = stopped(payload.work_unit_continuations);
    sendJson(res, 200, { ...payload, work_units: workUnits, work_unit_continuations: continuations,
      total: payload.total - payload.work_units.length - payload.work_unit_continuations.length + workUnits.length + continuations.length });
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
        action_outcomes: authActionOutcomes(db, row.id),
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
    try {
      db.prepare(
        "UPDATE sessions SET continuation_acked_by = ? WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL AND status IN ('ended', 'dead')"
      ).run(ack.value);
      await acknowledgeResolvedAuthRequests(db, ack.value);
      db.prepare(
        `UPDATE managed_task_occurrences
            SET acknowledged_by = ?, acknowledged_at = ?
          WHERE acknowledged_at IS NULL`,
      ).run(ack.value, Date.now());
    } finally {
      broadcast(DOMAIN_EVENTS.INBOX_ACKNOWLEDGED, { kind: "all", id: null });
    }
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
