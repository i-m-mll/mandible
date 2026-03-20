import { IssueScanner } from "../issue-scanner.js";
import { getDb } from "../db.js";
import { mapWorkUnitRow, computeLiveness } from "../work-unit-utils.js";
function getParam(req, key) {
    if (!req || typeof req !== "object") {
        return undefined;
    }
    const record = req;
    if (record.params && typeof record.params === "object") {
        const params = record.params;
        if (typeof params[key] === "string") {
            return params[key];
        }
    }
    if (typeof record.param === "function") {
        const value = record.param(key);
        return typeof value === "string" ? value : undefined;
    }
    return undefined;
}
function getQueryParam(req, key) {
    if (!req || typeof req !== "object") {
        return undefined;
    }
    const record = req;
    if (!record.query || typeof record.query !== "object") {
        return undefined;
    }
    const query = record.query;
    const value = query[key];
    if (Array.isArray(value)) {
        return typeof value[0] === "string" ? value[0] : undefined;
    }
    return typeof value === "string" ? value : undefined;
}
function getBody(req) {
    if (!req || typeof req !== "object") {
        return null;
    }
    const record = req;
    if (record.body && typeof record.body === "object") {
        return record.body;
    }
    return null;
}
function sendJson(res, status, payload) {
    if (!res || typeof res !== "object") {
        return;
    }
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
// Bug: f3dbb3e — accept optional sessionRegistry + sessionManager for canonical
// liveness computation on work units in the context endpoint.
// Bug: cbbb3d9 — deps extended with sessionManager for spawn-from-issue endpoint.
export function registerIssueRoutes(server, workScanner, deps) {
    const issueScanner = new IssueScanner(workScanner);
    // GET /api/issues — list repo summaries with optional filtering
    server.get("/api/issues", (req, res) => {
        const repoFilter = getQueryParam(req, "repo");
        const statusFilter = getQueryParam(req, "status");
        const labelFilter = getQueryParam(req, "label");
        let summaries = issueScanner.getRepoSummaries();
        if (repoFilter) {
            summaries = summaries.filter((s) => s.repo_id === repoFilter || s.repo_name === repoFilter);
        }
        // Bug: e32ee8b — three-state filter: "merged" = closed + has "merged" label
        if (statusFilter === "open" || statusFilter === "closed" || statusFilter === "merged") {
            summaries = summaries.map((s) => ({
                ...s,
                issues: s.issues.filter((issue) => {
                    if (statusFilter === "merged") {
                        return issue.status === "closed" && issue.labels.includes("merged");
                    }
                    if (statusFilter === "closed") {
                        // "closed" filter excludes merged issues (they have their own state)
                        return issue.status === "closed" && !issue.labels.includes("merged");
                    }
                    return issue.status === statusFilter;
                }),
            }));
        }
        if (labelFilter) {
            summaries = summaries.map((s) => ({
                ...s,
                issues: s.issues.filter((issue) => issue.labels.some((label) => label.toLowerCase() === labelFilter.toLowerCase())),
            }));
        }
        // Filter out repos with no matching issues after filters
        summaries = summaries.filter((s) => s.issues.length > 0 || (!statusFilter && !labelFilter));
        sendJson(res, 200, summaries);
    });
    // GET /api/issues/find/:issueId — search all scanned repos for an issue by ID prefix.
    // Registered before /:repoId/:issueId to avoid the literal "find" being treated as repoId.
    server.get("/api/issues/find/:issueId", (req, res) => {
        const issueId = getParam(req, "issueId");
        if (!issueId) {
            sendJson(res, 400, { error: "missing issueId" });
            return;
        }
        const detail = issueScanner.findIssueAcrossRepos(issueId);
        if (!detail) {
            sendJson(res, 404, { error: "issue not found in any scanned repo" });
            return;
        }
        sendJson(res, 200, detail);
    });
    // POST /api/issues/resolutions — record a commit that resolved an issue
    // Registered before /:repoId/:issueId to avoid "resolutions" being treated as repoId.
    // Bug: c934e60 — issue lifecycle tracking
    server.post("/api/issues/resolutions", (req, res) => {
        const body = getBody(req);
        const issue_id = typeof body?.issue_id === "string" ? body.issue_id : "";
        const commit_sha = typeof body?.commit_sha === "string" ? body.commit_sha : "";
        const repo_id = typeof body?.repo_id === "string" ? body.repo_id : "";
        if (!issue_id || !commit_sha || !repo_id) {
            sendJson(res, 400, { error: "issue_id, commit_sha, and repo_id are required" });
            return;
        }
        const db = getDb();
        db.prepare(`INSERT OR IGNORE INTO issue_resolutions (issue_id, commit_sha, repo_id, resolved_at)
       VALUES (?, ?, ?, ?)`).run(issue_id, commit_sha, repo_id, Date.now());
        sendJson(res, 200, { ok: true });
    });
    // GET /api/issues/resolutions/:issueId — get resolutions for an issue
    // Bug: c934e60 — issue lifecycle tracking
    server.get("/api/issues/resolutions/:issueId", (req, res) => {
        const issueId = getParam(req, "issueId");
        if (!issueId) {
            sendJson(res, 400, { error: "missing issueId" });
            return;
        }
        const db = getDb();
        const rows = db.prepare(`SELECT commit_sha, repo_id, resolved_at
       FROM issue_resolutions
       WHERE issue_id = ?
       ORDER BY resolved_at ASC`).all(issueId);
        sendJson(res, 200, rows);
    });
    // GET /api/issues/:repoId/:issueId — issue detail with comments
    server.get("/api/issues/:repoId/:issueId", (req, res) => {
        const repoIdParam = getParam(req, "repoId");
        const issueId = getParam(req, "issueId");
        if (!repoIdParam || !issueId) {
            sendJson(res, 400, { error: "missing repoId or issueId" });
            return;
        }
        let repoId = repoIdParam;
        let detail = issueScanner.getIssueDetail(repoId, issueId);
        if (!detail) {
            const byName = issueScanner
                .getRepoSummaries()
                .find((summary) => summary.repo_name === repoIdParam || summary.repo_root === repoIdParam);
            if (byName) {
                repoId = byName.repo_id;
                detail = issueScanner.getIssueDetail(repoId, issueId);
            }
        }
        if (!detail) {
            sendJson(res, 404, { error: "issue not found" });
            return;
        }
        sendJson(res, 200, detail);
    });
    // POST /api/issues/:repoId/:issueId/status — close or reopen
    server.post("/api/issues/:repoId/:issueId/status", (req, res) => {
        const repoId = getParam(req, "repoId");
        const issueId = getParam(req, "issueId");
        if (!repoId || !issueId) {
            sendJson(res, 400, { error: "missing repoId or issueId" });
            return;
        }
        const body = getBody(req);
        const newStatus = body?.status;
        if (newStatus !== "open" && newStatus !== "closed") {
            sendJson(res, 400, { error: "status must be 'open' or 'closed'" });
            return;
        }
        const ok = newStatus === "closed"
            ? issueScanner.closeIssue(repoId, issueId)
            : issueScanner.reopenIssue(repoId, issueId);
        if (!ok) {
            sendJson(res, 500, { error: "failed to update issue status" });
            return;
        }
        sendJson(res, 200, { ok: true });
    });
    // POST /api/issues/:repoId/:issueId/comment — add comment
    server.post("/api/issues/:repoId/:issueId/comment", (req, res) => {
        const repoId = getParam(req, "repoId");
        const issueId = getParam(req, "issueId");
        if (!repoId || !issueId) {
            sendJson(res, 400, { error: "missing repoId or issueId" });
            return;
        }
        const body = getBody(req);
        const message = typeof body?.message === "string" ? body.message : "";
        if (!message.trim()) {
            sendJson(res, 400, { error: "message is required" });
            return;
        }
        const ok = issueScanner.addComment(repoId, issueId, message);
        if (!ok) {
            sendJson(res, 500, { error: "failed to add comment" });
            return;
        }
        sendJson(res, 200, { ok: true });
    });
    // POST /api/issues/:repoId/:issueId/label — add or remove label
    server.post("/api/issues/:repoId/:issueId/label", (req, res) => {
        const repoId = getParam(req, "repoId");
        const issueId = getParam(req, "issueId");
        if (!repoId || !issueId) {
            sendJson(res, 400, { error: "missing repoId or issueId" });
            return;
        }
        const body = getBody(req);
        const action = body?.action;
        const label = typeof body?.label === "string" ? body.label : "";
        if (action !== "add" && action !== "remove") {
            sendJson(res, 400, { error: "action must be 'add' or 'remove'" });
            return;
        }
        if (!label.trim()) {
            sendJson(res, 400, { error: "label is required" });
            return;
        }
        const ok = action === "add"
            ? issueScanner.addLabel(repoId, issueId, label)
            : issueScanner.removeLabel(repoId, issueId, label);
        if (!ok) {
            sendJson(res, 500, { error: `failed to ${action} label` });
            return;
        }
        sendJson(res, 200, { ok: true });
    });
    // POST /api/issues/scan — force rescan all repos
    server.post("/api/issues/scan", async (_req, res) => {
        const summaries = await issueScanner.scanAllAsync();
        sendJson(res, 200, summaries);
    });
    // POST /api/issues/:repoId/scan — force-scan a single repo by ID.
    // Used by the UI to unblock deep-link 404s on daemon reload: if the
    // IssueScanner hasn't scanned a repo yet, the UI can trigger a targeted
    // scan and retry the detail fetch rather than showing "Failed to load".
    server.post("/api/issues/:repoId/scan", async (req, res) => {
        const repoId = getParam(req, "repoId");
        if (!repoId) {
            sendJson(res, 400, { error: "missing repoId" });
            return;
        }
        const ok = await issueScanner.scanRepoByIdAsync(repoId);
        if (!ok) {
            sendJson(res, 404, { error: "repo not found" });
            return;
        }
        sendJson(res, 200, { ok: true });
    });
    // GET /api/issues/:repoId/:issueId/context — comprehensive issue context hub
    // Bug: 84cd5ae — issue detail hub aggregation endpoint
    server.get("/api/issues/:repoId/:issueId/context", (req, res) => {
        const repoIdParam = getParam(req, "repoId");
        const issueIdParam = getParam(req, "issueId");
        if (!repoIdParam || !issueIdParam) {
            sendJson(res, 400, { error: "missing repoId or issueId" });
            return;
        }
        // Resolve repo ID (may be a name)
        let repoId = repoIdParam;
        const byName = issueScanner
            .getRepoSummaries()
            .find((s) => s.repo_name === repoIdParam || s.repo_root === repoIdParam);
        if (byName) {
            repoId = byName.repo_id;
        }
        // 1. Issue detail from git-bug
        const issue = issueScanner.getIssueDetail(repoId, issueIdParam);
        if (!issue) {
            sendJson(res, 404, { error: "issue not found" });
            return;
        }
        const db = getDb();
        // 2. Work unit for this issue+repo
        const workUnitRow = db
            .prepare(`SELECT * FROM work_units
         WHERE issue_id = ? AND repo_id = ?
         ORDER BY created_at DESC LIMIT 1`)
            .get(issue.id, repoId);
        // Bug: f3dbb3e — use canonical liveness computation from work-unit-utils
        let workUnit = null;
        if (workUnitRow) {
            const wu = mapWorkUnitRow(workUnitRow);
            const liveness = deps?.sessionRegistry && deps?.sessionManager
                ? computeLiveness(wu, deps.sessionRegistry, deps.sessionManager)
                : (() => {
                    // Fallback: inline approximation when session deps not available
                    const assignedSessionId = wu.assigned_session_id;
                    if (!assignedSessionId) {
                        return { has_live_agent: false, agent_session_id: null, agent_status: null, is_processing: false, last_activity: null };
                    }
                    const sessionRow = db
                        .prepare("SELECT status, updated_at, last_active FROM sessions WHERE id = ?")
                        .get(assignedSessionId);
                    if (!sessionRow) {
                        return { has_live_agent: false, agent_session_id: null, agent_status: null, is_processing: false, last_activity: null };
                    }
                    const status = String(sessionRow.status ?? "unknown");
                    return {
                        has_live_agent: status === "active" || status === "idle",
                        agent_session_id: assignedSessionId,
                        agent_status: status,
                        is_processing: status === "active",
                        last_activity: sessionRow.last_active ?? sessionRow.updated_at ?? null,
                    };
                })();
            workUnit = {
                branch: wu.branch,
                state: wu.state,
                continuation: wu.continuation,
                assigned_session_id: wu.assigned_session_id,
                liveness,
            };
        }
        // 3. Linked sessions via session_issues
        const sessionLinks = db
            .prepare(`SELECT si.session_id, s.status, s.created_at, s.app
         FROM session_issues si
         LEFT JOIN sessions s ON s.id = si.session_id
         WHERE si.issue_id = ? AND si.repo_id = ?
         ORDER BY si.created_at ASC`)
            .all(issue.id, repoId);
        const sessions = sessionLinks.map((row) => ({
            session_id: String(row.session_id ?? ""),
            status: String(row.status ?? "unknown"),
            created_at: row.created_at ?? null,
            app: String(row.app ?? ""),
            has_conversation: false, // populated below
        }));
        // Check which sessions have conversations
        if (sessions.length > 0) {
            const sessionIds = sessions.map((s) => s.session_id);
            // Query conversations table for these session_ids
            try {
                const placeholders = sessionIds.map(() => "?").join(",");
                const convRows = db
                    .prepare(`SELECT DISTINCT session_id FROM conversations WHERE session_id IN (${placeholders})`)
                    .all(...sessionIds);
                const convSet = new Set(convRows.map((r) => r.session_id));
                for (const s of sessions) {
                    s.has_conversation = convSet.has(s.session_id);
                }
            }
            catch {
                // conversations table may not exist in all setups
            }
        }
        // 4. Auth requests linked to this issue
        // Auth requests store issue_ids as JSON array in the DB
        const authRows = db
            .prepare(`SELECT id, title, status, head_branch, issue_ids, created_at
         FROM auth_requests
         ORDER BY created_at DESC`)
            .all();
        // Bug: f3dbb3e — bidirectional prefix matching for issue IDs (same fix
        // as auth-queue.ts resolveWorkUnitsOnMerge)
        const authRequests = authRows
            .filter((row) => {
            const ids = row.issue_ids;
            if (!ids)
                return false;
            try {
                const parsed = typeof ids === "string" ? JSON.parse(ids) : ids;
                if (Array.isArray(parsed)) {
                    return parsed.some((id) => id.startsWith(issue.id) || issue.id.startsWith(id));
                }
            }
            catch {
                // not valid JSON
            }
            return false;
        })
            .map((row) => ({
            id: String(row.id ?? ""),
            title: String(row.title ?? ""),
            status: String(row.status ?? ""),
            head_branch: row.head_branch ?? null,
            created_at: row.created_at ?? null,
        }));
        // 5. Branch info from work scanner if available
        let branchInfo = null;
        const branch = workUnitRow?.branch;
        if (typeof branch === "string" && branch) {
            const scannerRepos = workScanner.getRepos();
            const scannerRepo = scannerRepos.find((r) => r.id === repoId);
            if (scannerRepo) {
                const branches = workScanner.getBranches(scannerRepo.root);
                const branchData = branches.find((b) => b.branch === branch);
                if (branchData) {
                    branchInfo = {
                        ahead: branchData.ahead,
                        behind: branchData.behind,
                        last_commit_date: branchData.last_commit_date ?? null,
                    };
                }
            }
        }
        sendJson(res, 200, {
            issue,
            work_unit: workUnit,
            sessions,
            auth_requests: authRequests,
            branch_info: branchInfo,
        });
    });
    // GET /api/issues/:repoId/:issueId/sessions — get linked sessions for an issue
    server.get("/api/issues/:repoId/:issueId/sessions", (req, res) => {
        const repoIdParam = getParam(req, "repoId");
        const issueId = getParam(req, "issueId");
        if (!repoIdParam || !issueId) {
            sendJson(res, 400, { error: "missing repoId or issueId" });
            return;
        }
        let repoId = repoIdParam;
        const byName = issueScanner
            .getRepoSummaries()
            .find((summary) => summary.repo_name === repoIdParam || summary.repo_root === repoIdParam);
        if (byName) {
            repoId = byName.repo_id;
        }
        const db = getDb();
        const links = db.prepare(`SELECT session_id, issue_id, repo_id, created_at
       FROM session_issues
       WHERE issue_id = ? AND repo_id = ?
       ORDER BY created_at ASC`).all(issueId, repoId);
        sendJson(res, 200, links);
    });
    // POST /api/issues/:repoId/:issueId/spawn — spawn an SDK console session for this issue
    // Bug: cbbb3d9 — spawn agent from issue hub
    server.post("/api/issues/:repoId/:issueId/spawn", (req, res) => {
        const repoIdParam = getParam(req, "repoId");
        const issueIdParam = getParam(req, "issueId");
        if (!repoIdParam || !issueIdParam) {
            sendJson(res, 400, { error: "missing repoId or issueId" });
            return;
        }
        const sessionManager = deps?.sessionManager;
        if (!sessionManager) {
            sendJson(res, 503, { error: "session manager not available" });
            return;
        }
        // Resolve repo ID
        let repoId = repoIdParam;
        const byName = issueScanner
            .getRepoSummaries()
            .find((s) => s.repo_name === repoIdParam || s.repo_root === repoIdParam);
        if (byName) {
            repoId = byName.repo_id;
        }
        // 1. Look up the issue for title
        const issue = issueScanner.getIssueDetail(repoId, issueIdParam);
        if (!issue) {
            sendJson(res, 404, { error: "issue not found" });
            return;
        }
        const db = getDb();
        const body = getBody(req);
        const label = typeof body?.label === "string" && body.label.trim()
            ? body.label.trim()
            : `Issue: ${issue.title.slice(0, 40)}`;
        // 2. Look up work unit for branch and continuation
        const workUnitRow = db
            .prepare(`SELECT * FROM work_units
         WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed')
         ORDER BY created_at DESC LIMIT 1`)
            .get(issue.id, repoId);
        const branch = workUnitRow?.branch ? String(workUnitRow.branch) : null;
        const continuation = workUnitRow?.continuation ? String(workUnitRow.continuation) : null;
        // 3. Look up worktree path for the branch
        let cwd = null;
        if (branch) {
            const scannerRepos = workScanner.getRepos();
            const scannerRepo = scannerRepos.find((r) => r.id === repoId);
            if (scannerRepo) {
                const branches = workScanner.getBranches(scannerRepo.root);
                const branchData = branches.find((b) => b.branch === branch);
                if (branchData?.worktree_path) {
                    cwd = branchData.worktree_path;
                }
                else {
                    // Fall back to repo root
                    cwd = scannerRepo.root;
                }
            }
        }
        if (!cwd) {
            // Fall back: find repo root from work scanner
            const scannerRepos = workScanner.getRepos();
            const scannerRepo = scannerRepos.find((r) => r.id === repoId);
            if (scannerRepo) {
                cwd = scannerRepo.root;
            }
        }
        // 4. Find provider_session_id from latest conversation linked to this issue (for resume)
        let providerSessionId = null;
        try {
            const sessionLink = db
                .prepare(`SELECT si.session_id FROM session_issues si
           JOIN sessions s ON s.id = si.session_id
           WHERE si.issue_id = ? AND si.repo_id = ?
           ORDER BY si.created_at DESC LIMIT 1`)
                .get(issue.id, repoId);
            if (sessionLink) {
                // Check if there's a console session with this mandible_session_id
                const consoleRow = db
                    .prepare(`SELECT provider_session_id FROM console_sessions
             WHERE mandible_session_id = ? AND provider_session_id IS NOT NULL
             ORDER BY created_at DESC LIMIT 1`)
                    .get(sessionLink.session_id);
                if (consoleRow?.provider_session_id) {
                    providerSessionId = consoleRow.provider_session_id;
                }
            }
        }
        catch {
            // Non-critical — proceed without provider_session_id
        }
        // 5. Create SDK console session (stopped — user sends the first prompt)
        const consoleSession = sessionManager.create({
            label,
            command: "claude",
            backend_type: "sdk",
            cwd,
            provider_session_id: providerSessionId,
        });
        // 6. Update work unit: assigned_session_id with the console session ID
        if (workUnitRow?.id) {
            db.prepare("UPDATE work_units SET assigned_session_id = ?, updated_at = ? WHERE id = ?").run(consoleSession.id, Date.now(), String(workUnitRow.id));
        }
        sendJson(res, 200, {
            console_session_id: consoleSession.id,
            continuation,
            branch,
            cwd,
        });
    });
    return issueScanner;
}
