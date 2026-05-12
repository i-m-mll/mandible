import path from "node:path";
import { getDb, resolvePrefix } from "../db.js";
import { getIntSetting } from "./settings.js";
import { mapWorkUnitRow, computeLiveness, } from "../work-unit-utils.js";
function getQueryParam(req, key) {
    if (!req || typeof req !== "object")
        return undefined;
    const record = req;
    if (!record.query || typeof record.query !== "object")
        return undefined;
    const query = record.query;
    const value = query[key];
    if (Array.isArray(value)) {
        return typeof value[0] === "string" ? value[0] : undefined;
    }
    return typeof value === "string" ? value : undefined;
}
function getParam(req, key) {
    if (!req || typeof req !== "object")
        return undefined;
    const record = req;
    if (record.params && typeof record.params === "object") {
        const params = record.params;
        if (typeof params[key] === "string")
            return params[key];
    }
    if (typeof record.param === "function") {
        const value = record.param(key);
        return typeof value === "string" ? value : undefined;
    }
    return undefined;
}
function getBody(req) {
    if (!req || typeof req !== "object")
        return null;
    const record = req;
    if (record.body && typeof record.body === "object") {
        return record.body;
    }
    return null;
}
function sendJson(res, status, payload) {
    if (!res || typeof res !== "object")
        return;
    const record = res;
    if (typeof record.status === "function") {
        record.status(status);
    }
    else if (typeof record.code === "function") {
        record.code(status);
    }
    if (typeof record.json === "function") {
        record.json(payload);
        return;
    }
    if (typeof record.send === "function") {
        record.send(payload);
        return;
    }
    if (typeof record.end === "function") {
        record.end(JSON.stringify(payload));
    }
}
// Bug: 93c57c4 — derive outcome from lifecycle status + exit_code at read time.
function computeOutcome(row) {
    switch (row.status) {
        case "rejected": return "rejected";
        case "dismissed": return "dismissed";
        case "expired": return "expired";
        case "completed":
            return (row.exit_code != null && row.exit_code !== 0) ? "failed" : "succeeded";
        default:
            return null;
    }
}
const COLUMNS_AUTH_RESULT = "id, title, status, exit_code, error, head_branch, resolved_at, repo, base_branch, " +
    "post_merge_handoff, issue_ids, target_session_id, target_repo_root, delivered_at";
const RESOLVED_STATUSES = "('completed', 'rejected', 'expired', 'dismissed')";
/**
 * Bug: 4e32923 — fetch auth_results for the given session + repo with the
 * three-tier escalation model. Returns rows tagged with their tier so callers
 * can render or filter accordingly. Branch filter (if provided) restricts to
 * auth requests targeting that head branch — keeps the previous narrow-scope
 * behaviour available for branch-bound dashboards.
 */
function queryAuthResultsForSession(db, opts) {
    const now = Date.now();
    const projectGraceMs = getIntSetting("inbox.project_grace_days", 7) * 86_400_000;
    const globalGraceMs = getIntSetting("inbox.global_grace_days", 30) * 86_400_000;
    // Pull unacknowledged + undelivered resolved auth requests; we filter into
    // tiers in TypeScript because the per-tier SQL would be three separate
    // statements (and we want a single read for tier-attribution sort stability).
    const whereParts = [
        `status IN ${RESOLVED_STATUSES}`,
        "acknowledged_by IS NULL",
        "delivered_at IS NULL"
    ];
    const params = [];
    if (opts.branch) {
        whereParts.push("head_branch = ?");
        params.push(opts.branch);
    }
    const sql = `SELECT ${COLUMNS_AUTH_RESULT} FROM auth_requests ` +
        `WHERE ${whereParts.join(" AND ")} ORDER BY resolved_at DESC`;
    const rows = db.prepare(sql).all(...params);
    const out = [];
    for (const row of rows) {
        const resolvedAt = row.resolved_at ?? 0;
        const age = now - resolvedAt;
        // Legacy / unscoped rows: keep broadcasting (tier 0). Matches the pre-4e32923
        // behaviour for any auth_request that predates the CLI populating the
        // target_session_id field, so that nothing silently disappears for users
        // mid-migration.
        if (row.target_session_id == null) {
            out.push({ row, tier: 0 });
            continue;
        }
        // Tier 1: owner session sees its own undelivered result immediately.
        if (row.target_session_id === opts.sessionId) {
            out.push({ row, tier: 1 });
            continue;
        }
        // Tier 2: any session in the same repo, after project grace window.
        if (opts.repoRoot &&
            row.target_repo_root === opts.repoRoot &&
            age >= projectGraceMs) {
            out.push({ row, tier: 2 });
            continue;
        }
        // Tier 3: any session anywhere, after global grace window.
        if (age >= globalGraceMs) {
            out.push({ row, tier: 3 });
            continue;
        }
        // Otherwise the request still belongs only to its owner / project and the
        // current session has no claim on it — skip.
    }
    // Sort by tier ascending (owner first), then most recent first within tier.
    out.sort((a, b) => {
        if (a.tier !== b.tier)
            return a.tier - b.tier;
        return (b.row.resolved_at ?? 0) - (a.row.resolved_at ?? 0);
    });
    return out;
}
// Bug: f3dbb3e — mapWorkUnitRow and computeLiveness extracted to work-unit-utils.ts
export function registerInboxRoutes(server, sessionRegistry, issueScanner, sessionManager, 
// Bug: 4e32923 — authQueue is required for the new /api/inbox/delivered
// endpoint that marks auth_requests as delivered to the owner session.
authQueue) {
    const db = getDb();
    // Bug: 4e32923 — helper: best-effort lookup of a session's repo root for
    // tier-2/3 scoping. The sessions table stores the repo root in `cwd`.
    function getSessionRepoRoot(sessionId) {
        if (!sessionId)
            return null;
        const row = db
            .prepare("SELECT cwd FROM sessions WHERE id = ? LIMIT 1")
            .get(sessionId);
        return row?.cwd ?? null;
    }
    function mapAuthResultRow(row, tier, includeRepo) {
        const base = {
            id: row.id,
            title: row.title,
            status: row.status,
            outcome: computeOutcome(row),
            exit_code: row.exit_code,
            error: row.error,
            head_branch: row.head_branch,
            resolved_at: row.resolved_at,
            post_merge_handoff: row.post_merge_handoff ?? null,
            issue_ids: row.issue_ids ? JSON.parse(row.issue_ids) : null,
            // Bug: 4e32923 — surface delivery scope so clients can distinguish
            // "this was meant for me" (tier 1) from escalated items (tier 2/3).
            tier,
            target_session_id: row.target_session_id,
            target_repo_root: row.target_repo_root,
        };
        if (includeRepo) {
            base.repo = row.repo ?? null;
            base.base_branch = row.base_branch ?? null;
        }
        return base;
    }
    // Bug: 8a281b3 — helper to get work units needing attention for inbox
    function getWorkUnitsNeedingAttention(repoFilter) {
        const conditions = ["state IN ('open', 'committed')"];
        const params = [];
        if (repoFilter) {
            conditions.push("repo_id = ?");
            params.push(repoFilter);
        }
        const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
        const rows = db
            .prepare(`SELECT * FROM work_units${where} ORDER BY created_at DESC`)
            .all(...params);
        return rows
            .map(mapWorkUnitRow)
            .map((wu) => {
            const liveness = sessionManager
                ? computeLiveness(wu, sessionRegistry, sessionManager)
                : { has_live_agent: false, agent_session_id: null, agent_status: null, is_processing: false, last_activity: null };
            return { ...wu, liveness };
        })
            // Show work units that need attention (no live agent)
            .filter((wu) => !wu.liveness.has_live_agent);
    }
    // Bug: 8a281b3 — helper to get work-unit continuations
    // Bug: f3dbb3e — filter by open/committed state so resolved/abandoned units
    // don't surface stale continuations
    function getWorkUnitContinuations(repoFilter) {
        const conditions = ["continuation IS NOT NULL", "state IN ('open', 'committed')"];
        const params = [];
        if (repoFilter) {
            conditions.push("repo_id = ?");
            params.push(repoFilter);
        }
        const where = ` WHERE ${conditions.join(" AND ")}`;
        const rows = db
            .prepare(`SELECT * FROM work_units${where} ORDER BY continuation_at DESC`)
            .all(...params);
        return rows
            .map(mapWorkUnitRow)
            .map((wu) => {
            const liveness = sessionManager
                ? computeLiveness(wu, sessionRegistry, sessionManager)
                : { has_live_agent: false, agent_session_id: null, agent_status: null, is_processing: false, last_activity: null };
            return { ...wu, liveness };
        })
            // Only show continuations with no live agent
            .filter((wu) => !wu.liveness.has_live_agent);
    }
    // GET /api/inbox — unified query of pending items for a branch
    server.get("/api/inbox", (req, res) => {
        const branch = getQueryParam(req, "branch");
        const repo = getQueryParam(req, "repo");
        const sessionId = getQueryParam(req, "session_id") ?? "";
        // Continuations: ended/dead sessions with unacknowledged continuation notes
        const continuations = branch
            ? db
                .prepare(`SELECT id, branch, continuation, ended_at FROM sessions
             WHERE branch = ? AND continuation IS NOT NULL AND continuation_acked_by IS NULL
               AND status IN ('ended', 'dead') AND id != ?
             ORDER BY ended_at DESC`)
                .all(branch, sessionId)
            : db
                .prepare(`SELECT id, branch, continuation, ended_at FROM sessions
             WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL
               AND status IN ('ended', 'dead')
             ORDER BY ended_at DESC`)
                .all();
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
        // Open issues: from issue scanner, filtered by repo (kept for backward compat)
        let openIssues = [];
        if (repo) {
            const summaries = issueScanner.getRepoSummaries();
            for (const summary of summaries) {
                if (summary.repo_root === repo || summary.repo_name === repo || summary.repo_id === repo) {
                    openIssues = summary.issues
                        .filter((issue) => issue.status === "open")
                        .map((issue) => ({
                        id: issue.id,
                        title: issue.title,
                        labels: issue.labels,
                    }));
                    break;
                }
            }
        }
        // Bug: 9f66ad9 — pending webhook events, optionally filtered by branch
        const pendingWebhooks = branch
            ? db
                .prepare(`SELECT * FROM webhook_events
             WHERE status = 'pending' AND target_branch = ?
             ORDER BY created_at DESC LIMIT 50`)
                .all(branch)
            : db
                .prepare(`SELECT * FROM webhook_events
             WHERE status = 'pending'
             ORDER BY created_at DESC LIMIT 50`)
                .all();
        const total = continuations.length + authResultTiers.length + openIssues.length
            + workUnits.length + workUnitContinuations.length + pendingWebhooks.length;
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
            })),
            total,
        });
    });
    // GET /api/inbox/global — all unacknowledged items across all branches and repos
    server.get("/api/inbox/global", (req, res) => {
        const sessionId = getQueryParam(req, "session_id") ?? "";
        // Continuations: all unacknowledged, any branch
        const continuations = db
            .prepare(`SELECT id, branch, continuation, ended_at, cwd FROM sessions
         WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL
           AND status IN ('ended', 'dead')
         ORDER BY ended_at DESC`)
            .all();
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
        // Open issues: all repos (kept for backward compat)
        const openIssues = [];
        for (const summary of issueScanner.getRepoSummaries()) {
            for (const issue of summary.issues) {
                if (issue.status === "open") {
                    openIssues.push({
                        id: issue.id,
                        title: issue.title,
                        labels: issue.labels,
                        repo_id: summary.repo_id,
                        repo_name: summary.repo_name,
                    });
                }
            }
        }
        // Bug: 9f66ad9 — pending webhook events (all)
        const pendingWebhooks = db
            .prepare(`SELECT * FROM webhook_events
         WHERE status = 'pending'
         ORDER BY created_at DESC LIMIT 50`)
            .all();
        const total = continuations.length + authResultTiers.length + openIssues.length
            + workUnits.length + workUnitContinuations.length + pendingWebhooks.length;
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
            })),
            total,
        });
    });
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
        if (!targetSessionId) {
            sendJson(res, 400, { error: "missing target_session_id" });
            return;
        }
        const rows = db
            .prepare(`SELECT id, head_branch, status, exit_code, resolved_at, title, target_session_id
         FROM auth_requests
         WHERE target_session_id = ?
           AND delivered_at IS NULL
           AND resolved_at IS NOT NULL
           AND acknowledged_by IS NULL
           AND status IN ('completed', 'rejected', 'expired', 'dismissed')
         ORDER BY resolved_at ASC`)
            .all(targetSessionId);
        sendJson(res, 200, {
            undelivered: rows.map((row) => ({
                id: row.id,
                head_branch: row.head_branch,
                status: row.status,
                exit_code: row.exit_code,
                resolved_at: row.resolved_at,
                title: row.title,
                target_session_id: row.target_session_id,
            })),
        });
    });
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
            const resolved = resolvePrefix(db, "auth_requests", "id", id);
            if (!resolved.ok) {
                sendJson(res, resolved.error === "ambiguous" ? 409 : 404, {
                    error: resolved.error === "ambiguous"
                        ? `ambiguous prefix '${id}' — matches ${resolved.count} auth requests. Use a longer prefix.`
                        : "auth request not found",
                });
                return;
            }
            const now = Date.now();
            db.prepare("UPDATE auth_requests SET delivered_at = ?, updated_at = ? WHERE id = ? AND delivered_at IS NULL").run(now, now, resolved.id);
            sendJson(res, 204, null);
            return;
        }
        const ok = authQueue.markDelivered(id);
        if (!ok) {
            sendJson(res, 404, { error: "auth request not found" });
            return;
        }
        sendJson(res, 204, null);
    });
    // POST /api/inbox/ack-all — acknowledge all unacknowledged continuations and auth results
    server.post("/api/inbox/ack-all", (_req, res) => {
        db.prepare("UPDATE sessions SET continuation_acked_by = 'bulk' WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL AND status IN ('ended', 'dead')").run();
        db.prepare("UPDATE auth_requests SET acknowledged_by = 'bulk' WHERE status IN ('completed', 'rejected', 'expired', 'dismissed') AND acknowledged_by IS NULL").run();
        sendJson(res, 200, { ok: true });
    });
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
        if (type === "continuation") {
            // Bug: caa157e — resolve UUID prefix for session IDs
            const resolved = resolvePrefix(db, "sessions", "id", id);
            if (!resolved.ok) {
                if (resolved.error === "ambiguous") {
                    sendJson(res, 409, {
                        error: `ambiguous prefix '${id}' — matches ${resolved.count} sessions. Use a longer prefix.`
                    });
                }
                else {
                    sendJson(res, 404, { error: "continuation not found or already acknowledged" });
                }
                return;
            }
            const result = db
                .prepare("UPDATE sessions SET continuation_acked_by = ? WHERE id = ? AND continuation_acked_by IS NULL")
                .run(sessionId ?? "manual", resolved.id);
            if (result.changes === 0) {
                sendJson(res, 404, { error: "continuation not found or already acknowledged" });
                return;
            }
            sendJson(res, 200, { ok: true });
        }
        else if (type === "auth_result") {
            // Bug: caa157e — resolve UUID prefix for auth request IDs
            const resolved = resolvePrefix(db, "auth_requests", "id", id);
            if (!resolved.ok) {
                if (resolved.error === "ambiguous") {
                    sendJson(res, 409, {
                        error: `ambiguous prefix '${id}' — matches ${resolved.count} auth requests. Use a longer prefix.`
                    });
                }
                else {
                    sendJson(res, 404, { error: "auth request not found or already acknowledged" });
                }
                return;
            }
            const result = db
                .prepare("UPDATE auth_requests SET acknowledged_by = ? WHERE id = ? AND acknowledged_by IS NULL")
                .run(sessionId ?? "manual", resolved.id);
            if (result.changes === 0) {
                sendJson(res, 404, { error: "auth request not found or already acknowledged" });
                return;
            }
            sendJson(res, 200, { ok: true });
        }
        else {
            sendJson(res, 400, { error: "type must be 'continuation' or 'auth_result'" });
        }
    });
}
