import path from "node:path";
import { getDb, resolvePrefix } from "../db.js";
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
export function registerInboxRoutes(server, _sessionRegistry, issueScanner) {
    const db = getDb();
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
                .prepare(`SELECT id, title, status, exit_code, error, head_branch, resolved_at FROM auth_requests
             WHERE head_branch = ? AND status IN ('completed', 'rejected', 'expired', 'dismissed')
               AND acknowledged_by IS NULL
             ORDER BY resolved_at DESC`)
                .all(branch)
            : db
                .prepare(`SELECT id, title, status, exit_code, error, head_branch, resolved_at FROM auth_requests
             WHERE status IN ('completed', 'rejected', 'expired', 'dismissed')
               AND acknowledged_by IS NULL
             ORDER BY resolved_at DESC`)
                .all();
        // Open issues: from issue scanner, filtered by repo
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
        const total = continuations.length + authResults.length + openIssues.length;
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
            })),
            open_issues: openIssues,
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
            .prepare(`SELECT id, title, status, exit_code, error, head_branch, resolved_at, repo, base_branch FROM auth_requests
         WHERE status IN ('completed', 'rejected', 'expired', 'dismissed')
           AND acknowledged_by IS NULL
         ORDER BY resolved_at DESC`)
            .all();
        // Open issues: all repos
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
        const total = continuations.length + authResults.length + openIssues.length;
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
            })),
            open_issues: openIssues,
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
