import { getDb, resolvePrefix } from "../db.js";
import { navigateToSession } from "../navigate.js";
import { SessionRegistry, syncPinnedPanesTsv, } from "../registry.js";
function readBody(req) {
    return (req.body ?? {});
}
function sendJson(res, code, payload) {
    res.status(code).json(payload);
}
function parseStatus(value) {
    if (value === "active" || value === "ended" || value === "dead") {
        return value;
    }
    return undefined;
}
function deriveRepoNameFromRepoId(repoId) {
    const cleaned = repoId.trim().replace(/\/+$/, "");
    if (!cleaned)
        return repoId;
    const parts = cleaned.split("/");
    return parts[parts.length - 1] || cleaned;
}
function looksLikeBranchName(value) {
    if (!value)
        return false;
    if (value === "main" || value === "master" || value === "develop") {
        return true;
    }
    return /^(feature|fix|bugfix|hotfix|chore|release)\//.test(value);
}
function normalizeRepoDisplayName(repoId, repoName) {
    const fallback = deriveRepoNameFromRepoId(repoId);
    if (!repoName)
        return fallback;
    const trimmed = repoName.trim();
    if (!trimmed || looksLikeBranchName(trimmed))
        return fallback;
    // Normalize owner/repo to repo for compact UI display.
    if (trimmed.includes("/")) {
        const parts = trimmed.split("/");
        if (parts.length !== 2)
            return fallback;
        return parts[1] || fallback;
    }
    return trimmed;
}
function resolveCanonicalRepoId(issueScanner, repoId, repoName, issueId) {
    if (!issueScanner)
        return repoId;
    const direct = issueScanner.workScanner.getRepoById(repoId);
    if (direct?.exists)
        return direct.id;
    const summaries = issueScanner.getRepoSummaries();
    const byIdentifier = summaries.find((summary) => summary.repo_id === repoId ||
        summary.repo_name === repoId ||
        summary.repo_root === repoId ||
        (repoName != null && (summary.repo_name === repoName || summary.repo_root === repoName)));
    if (byIdentifier)
        return byIdentifier.repo_id;
    if (issueId) {
        const byIssue = summaries.filter((summary) => summary.issues.some((issue) => issue.id === issueId || issue.id.startsWith(issueId)));
        if (byIssue.length === 1) {
            return byIssue[0].repo_id;
        }
    }
    return repoId;
}
// Bug: caa157e — resolve session ID prefix, returning resolved ID or sending error response
function resolveSessionId(id, res) {
    const resolved = resolvePrefix(getDb(), "sessions", "id", id);
    if (resolved.ok) {
        return resolved.id;
    }
    if (resolved.error === "ambiguous") {
        sendJson(res, 409, {
            error: `Ambiguous prefix '${id}' — matches ${resolved.count} sessions. Use a longer prefix.`
        });
    }
    else {
        sendJson(res, 404, { error: "Session not found" });
    }
    return null;
}
export function registerSessionRoutes(server, registry = new SessionRegistry(getDb()), discovery, issueScanner) {
    server.post("/api/sessions/discover", (req, res) => {
        if (!discovery) {
            sendJson(res, 501, { error: "Session discovery not configured" });
            return;
        }
        const result = discovery.discoverSessions();
        sendJson(res, 200, result);
    });
    server.post("/api/sessions/register", (req, res) => {
        const payload = readBody(req);
        if (!payload.id || !payload.app) {
            sendJson(res, 400, { error: "Missing id or app" });
            return;
        }
        const session = registry.registerSession(payload);
        sendJson(res, 200, session);
    });
    server.patch("/api/sessions/:id", (req, res) => {
        const rawId = req.params.id;
        if (!rawId) {
            sendJson(res, 400, { error: "Missing session id" });
            return;
        }
        const id = resolveSessionId(rawId, res);
        if (!id)
            return;
        const payload = readBody(req);
        const updated = registry.updateSession(id, payload);
        if (!updated) {
            sendJson(res, 404, { error: "Session not found" });
            return;
        }
        // Bug: 568eca7 — sync pinned-panes.tsv for backward compat with reaper
        if (payload.pinned !== undefined && updated.nav_pane_id) {
            syncPinnedPanesTsv(updated.nav_pane_id, Boolean(payload.pinned));
        }
        sendJson(res, 200, updated);
    });
    server.patch("/api/sessions/:id/end", (req, res) => {
        const rawId = req.params.id;
        if (!rawId) {
            sendJson(res, 400, { error: "Missing session id" });
            return;
        }
        const id = resolveSessionId(rawId, res);
        if (!id)
            return;
        const payload = readBody(req);
        const status = payload.status ?? "ended";
        const ended = registry.endSession(id, status);
        if (!ended) {
            sendJson(res, 404, { error: "Session not found" });
            return;
        }
        sendJson(res, 200, ended);
    });
    server.post("/api/sessions/:id/children", (req, res) => {
        const parentId = req.params.id;
        if (!parentId) {
            sendJson(res, 400, { error: "Missing parent id" });
            return;
        }
        const payload = readBody(req);
        const child = registry.registerChildSession(parentId, payload);
        if (!child) {
            sendJson(res, 404, { error: "Parent not found" });
            return;
        }
        sendJson(res, 200, child);
    });
    server.patch("/api/sessions/:id/children/:childId", (req, res) => {
        const parentId = req.params.id;
        const childId = req.params.childId;
        if (!parentId || !childId) {
            sendJson(res, 400, { error: "Missing parent or child id" });
            return;
        }
        const payload = readBody(req);
        const status = payload.status ?? "ended";
        const updated = registry.updateChildStatus(parentId, childId, status);
        if (!updated) {
            sendJson(res, 404, { error: "Child not found" });
            return;
        }
        sendJson(res, 200, updated);
    });
    server.get("/api/sessions", (req, res) => {
        const query = req.query ?? {};
        const options = {
            status: parseStatus(query.status),
            app: query.app,
        };
        if (query.parent_id === "null") {
            options.parent_id = null;
        }
        else if (query.parent_id) {
            options.parent_id = query.parent_id;
        }
        const sessions = registry.listSessions(options);
        if (query.include === "issues" || query.include === "all_issues") {
            const showAll = query.include === "all_issues";
            const db = getDb();
            const allLinks = db.prepare(`SELECT session_id, issue_id, repo_id, created_at FROM session_issues`).all();
            const linkMap = new Map();
            for (const link of allLinks) {
                // Filter to open issues by default (treat unknown as open — safe default)
                if (!showAll && issueScanner) {
                    const status = issueScanner.getIssueStatus(link.repo_id, link.issue_id);
                    if (status === "closed") {
                        continue;
                    }
                }
                const existing = linkMap.get(link.session_id) ?? [];
                existing.push({ issue_id: link.issue_id, repo_id: link.repo_id, created_at: link.created_at });
                linkMap.set(link.session_id, existing);
            }
            // Load sticky project associations
            const allProjects = db.prepare(`SELECT session_id, repo_id, repo_name, created_at FROM session_projects`).all();
            const projectMap = new Map();
            for (const proj of allProjects) {
                const existing = projectMap.get(proj.session_id) ?? [];
                const normalizedName = normalizeRepoDisplayName(proj.repo_id, proj.repo_name);
                if (!existing.some((p) => p.repo_id === proj.repo_id)) {
                    existing.push({ repo_id: proj.repo_id, repo_name: normalizedName });
                }
                projectMap.set(proj.session_id, existing);
            }
            const enriched = sessions.map((s) => ({
                ...s,
                issues: linkMap.get(s.id) ?? [],
                projects: projectMap.get(s.id) ?? [],
            }));
            sendJson(res, 200, enriched);
            return;
        }
        sendJson(res, 200, sessions);
    });
    // Bug: 568eca7 — lightweight endpoint returning just pinned session IDs
    server.get("/api/sessions/pinned", (_req, res) => {
        const ids = registry.getPinnedSessionIds();
        sendJson(res, 200, { ids });
    });
    server.get("/api/sessions/by-pid/:pid", (req, res) => {
        const pidStr = req.params.pid;
        const pid = Number(pidStr);
        if (!pidStr || !Number.isInteger(pid) || pid <= 0) {
            sendJson(res, 400, { error: "Invalid PID" });
            return;
        }
        const session = registry.getSessionByPid(pid);
        if (!session) {
            sendJson(res, 404, { error: "No active session for PID" });
            return;
        }
        sendJson(res, 200, session);
    });
    server.get("/api/sessions/:id", (req, res) => {
        const rawId = req.params.id;
        if (!rawId) {
            sendJson(res, 400, { error: "Missing session id" });
            return;
        }
        const id = resolveSessionId(rawId, res);
        if (!id)
            return;
        const session = registry.getSession(id);
        if (!session) {
            sendJson(res, 404, { error: "Session not found" });
            return;
        }
        sendJson(res, 200, session);
    });
    server.get("/api/sessions/:id/tree", (req, res) => {
        const rawId = req.params.id;
        if (!rawId) {
            sendJson(res, 400, { error: "Missing session id" });
            return;
        }
        const id = resolveSessionId(rawId, res);
        if (!id)
            return;
        const tree = registry.getSessionTree(id);
        if (!tree) {
            sendJson(res, 404, { error: "Session not found" });
            return;
        }
        sendJson(res, 200, tree);
    });
    server.post("/api/sessions/:id/navigate", (req, res) => {
        const rawId = req.params.id;
        if (!rawId) {
            sendJson(res, 400, { error: "Missing session id" });
            return;
        }
        const id = resolveSessionId(rawId, res);
        if (!id)
            return;
        const session = registry.getSession(id);
        if (!session) {
            sendJson(res, 404, { error: "Session not found" });
            return;
        }
        const result = navigateToSession(session);
        sendJson(res, result.ok ? 200 : 500, result);
    });
    // Bug: 14e1e63 — write Reaper Notice before killing so it appears before pane-loop restarts
    server.post("/api/sessions/:id/kill", (req, res) => {
        const rawId = req.params.id;
        if (!rawId) {
            sendJson(res, 400, { error: "Missing session id" });
            return;
        }
        const id = resolveSessionId(rawId, res);
        if (!id)
            return;
        const session = registry.getSession(id);
        if (!session || !session.pid) {
            sendJson(res, 404, { error: "Session not found or missing pid" });
            return;
        }
        // Write Reaper Notice before killing so it appears before pane-loop restarts
        const pid = session.pid;
        const app = session.app || "claude";
        try {
            const { execFileSync, spawnSync } = require("child_process");
            const tty = execFileSync("ps", ["-p", String(pid), "-o", "tty="], {
                encoding: "utf8",
                timeout: 1000,
            }).trim();
            if (tty && tty !== "?") {
                const reapNotice = process.env.HOME
                    ? `${process.env.HOME}/.dotfiles/bin/reap-notice`
                    : "reap-notice";
                spawnSync(reapNotice, [
                    "--app", app,
                    "--pid", String(pid),
                    "--tty", tty,
                    "--source", "mandible",
                ], { timeout: 2000 });
            }
        }
        catch {
            // Non-fatal: notice failure should not block the kill
        }
        const ok = registry.killSession(id);
        if (!ok) {
            sendJson(res, 404, { error: "Session not found or missing pid" });
            return;
        }
        sendJson(res, 200, { ok: true });
    });
    // POST /api/sessions/:id/issues — link a session to an issue
    server.post("/api/sessions/:id/issues", (req, res) => {
        const rawSessionId = req.params.id;
        if (!rawSessionId) {
            sendJson(res, 400, { error: "Missing session id" });
            return;
        }
        const sessionId = resolveSessionId(rawSessionId, res);
        if (!sessionId)
            return;
        const body = readBody(req);
        if (!body.issue_id || !body.repo_id) {
            sendJson(res, 400, { error: "Missing issue_id or repo_id" });
            return;
        }
        const canonicalRepoId = resolveCanonicalRepoId(issueScanner, body.repo_id, body.repo_name, body.issue_id);
        const db = getDb();
        const now = Date.now();
        db.prepare(`INSERT INTO session_issues (session_id, issue_id, repo_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`).run(sessionId, body.issue_id, canonicalRepoId, now);
        // Persist project association (sticky — survives issue closure)
        let repoName = body.repo_name;
        if (!repoName || repoName.includes("/") || looksLikeBranchName(repoName)) {
            const repo = issueScanner?.workScanner.getRepoById(canonicalRepoId);
            if (repo) {
                repoName = repo.name;
            }
        }
        repoName = normalizeRepoDisplayName(canonicalRepoId, repoName);
        db.prepare(`INSERT INTO session_projects (session_id, repo_id, repo_name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`).run(sessionId, canonicalRepoId, repoName, now);
        sendJson(res, 200, {
            session_id: sessionId,
            issue_id: body.issue_id,
            repo_id: canonicalRepoId,
            created_at: now,
        });
    });
    // GET /api/sessions/:id/issues — get linked issues for a session
    server.get("/api/sessions/:id/issues", (req, res) => {
        const rawSessionId = req.params.id;
        if (!rawSessionId) {
            sendJson(res, 400, { error: "Missing session id" });
            return;
        }
        const sessionId = resolveSessionId(rawSessionId, res);
        if (!sessionId)
            return;
        const db = getDb();
        const links = db.prepare(`SELECT session_id, issue_id, repo_id, created_at
       FROM session_issues
       WHERE session_id = ?
       ORDER BY created_at ASC`).all(sessionId);
        sendJson(res, 200, links);
    });
}
