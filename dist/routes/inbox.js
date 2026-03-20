import path from "node:path";
import { getDb, resolvePrefix } from "../db.js";
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
// Bug: f3dbb3e — mapWorkUnitRow and computeLiveness extracted to work-unit-utils.ts
export function registerInboxRoutes(server, sessionRegistry, issueScanner, sessionManager) {
    const db = getDb();
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
        // Auth results: resolved auth requests for this branch, unacknowledged
        const authResults = branch
            ? db
                .prepare(`SELECT id, title, status, exit_code, error, head_branch, resolved_at, post_merge_handoff, issue_ids FROM auth_requests
             WHERE head_branch = ? AND status IN ('completed', 'rejected', 'expired', 'dismissed')
               AND acknowledged_by IS NULL
             ORDER BY resolved_at DESC`)
                .all(branch)
            : db
                .prepare(`SELECT id, title, status, exit_code, error, head_branch, resolved_at, post_merge_handoff, issue_ids FROM auth_requests
             WHERE status IN ('completed', 'rejected', 'expired', 'dismissed')
               AND acknowledged_by IS NULL
             ORDER BY resolved_at DESC`)
                .all();
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
        const total = continuations.length + authResults.length + openIssues.length
            + workUnits.length + workUnitContinuations.length + pendingWebhooks.length;
        sendJson(res, 200, {
            continuations: continuations.map((row) => ({
                session_id: row.id,
                continuation: row.continuation,
                branch: row.branch,
                ended_at: row.ended_at,
            })),
            auth_results: authResults.map((row) => ({
                id: row.id,
                title: row.title,
                status: row.status,
                exit_code: row.exit_code,
                error: row.error,
                head_branch: row.head_branch,
                resolved_at: row.resolved_at,
                post_merge_handoff: row.post_merge_handoff ?? null,
                issue_ids: row.issue_ids ? JSON.parse(row.issue_ids) : null,
            })),
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
        // Continuations: all unacknowledged, any branch
        const continuations = db
            .prepare(`SELECT id, branch, continuation, ended_at, cwd FROM sessions
         WHERE continuation IS NOT NULL AND continuation_acked_by IS NULL
           AND status IN ('ended', 'dead')
         ORDER BY ended_at DESC`)
            .all();
        // Auth results: all unacknowledged
        const authResults = db
            .prepare(`SELECT id, title, status, exit_code, error, head_branch, resolved_at, repo, base_branch, post_merge_handoff, issue_ids FROM auth_requests
         WHERE status IN ('completed', 'rejected', 'expired', 'dismissed')
           AND acknowledged_by IS NULL
         ORDER BY resolved_at DESC`)
            .all();
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
        const total = continuations.length + authResults.length + openIssues.length
            + workUnits.length + workUnitContinuations.length + pendingWebhooks.length;
        sendJson(res, 200, {
            continuations: continuations.map((row) => ({
                session_id: row.id,
                continuation: row.continuation,
                branch: row.branch,
                ended_at: row.ended_at,
                repo: row.cwd ? path.basename(row.cwd) : null,
            })),
            auth_results: authResults.map((row) => ({
                id: row.id,
                title: row.title,
                status: row.status,
                exit_code: row.exit_code,
                error: row.error,
                head_branch: row.head_branch,
                resolved_at: row.resolved_at,
                repo: row.repo ?? null,
                base_branch: row.base_branch ?? null,
                post_merge_handoff: row.post_merge_handoff ?? null,
                issue_ids: row.issue_ids ? JSON.parse(row.issue_ids) : null,
            })),
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
