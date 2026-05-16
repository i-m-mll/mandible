import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { linkWorkUnitToLedgerIssue } from "../ledger/operational-links.js";
import { mapWorkUnitRow as mapRow, enrichWithLiveness, } from "../work-unit-utils.js";
const VALID_STATES = new Set(["open", "committed", "resolved", "abandoned"]);
function readBody(req) {
    return (req.body ?? {});
}
function sendJson(res, code, payload) {
    res.status(code).json(payload);
}
function linkLedgerIssue(db, workUnitId, issueId, repoId) {
    try {
        const result = linkWorkUnitToLedgerIssue(db, {
            work_unit_id: workUnitId,
            issue_ref: issueId,
            repo_ref: repoId,
        });
        return result.ok ? result.issue_id : null;
    }
    catch {
        return null;
    }
}
export function registerWorkUnitRoutes(server, sessionRegistry, sessionManager) {
    const db = getDb();
    // POST /api/work-units/claim — create a new work unit (state=open)
    server.post("/api/work-units/claim", (req, res) => {
        const body = readBody(req);
        if (!body.issue_id || typeof body.issue_id !== "string") {
            sendJson(res, 400, { error: "Missing or invalid issue_id" });
            return;
        }
        if (!body.repo_id || typeof body.repo_id !== "string") {
            sendJson(res, 400, { error: "Missing or invalid repo_id" });
            return;
        }
        // Check for existing open/committed work unit for this issue+repo
        const existing = db
            .prepare("SELECT id, state, ledger_issue_id FROM work_units WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed')")
            .get(body.issue_id, body.repo_id);
        if (existing) {
            const ledgerIssueId = linkLedgerIssue(db, existing.id, body.issue_id, body.repo_id) ?? existing.ledger_issue_id;
            sendJson(res, 200, {
                id: existing.id,
                state: existing.state,
                existing: true,
                ledger_issue_id: ledgerIssueId,
            });
            return;
        }
        const id = randomUUID();
        const now = Date.now();
        const kind = body.kind && ["solo", "partition", "integration"].includes(body.kind)
            ? body.kind
            : "solo";
        db.prepare(`INSERT INTO work_units (id, issue_id, repo_id, branch, parent_branch, kind, state, assigned_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(id, body.issue_id, body.repo_id, body.branch ?? null, body.parent_branch ?? null, kind, body.assigned_session_id ?? null, now);
        const ledgerIssueId = linkLedgerIssue(db, id, body.issue_id, body.repo_id);
        sendJson(res, 201, { id, ledger_issue_id: ledgerIssueId });
    });
    // POST /api/work-units/activate — mark as committed, update timestamps
    server.post("/api/work-units/activate", (req, res) => {
        const body = readBody(req);
        if (!body.issue_id || typeof body.issue_id !== "string") {
            sendJson(res, 400, { error: "Missing or invalid issue_id" });
            return;
        }
        if (!body.repo_id || typeof body.repo_id !== "string") {
            sendJson(res, 400, { error: "Missing or invalid repo_id" });
            return;
        }
        const now = Date.now();
        // Find existing open work unit for this issue+repo
        const existing = db
            .prepare("SELECT id, state, ledger_issue_id FROM work_units WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed') ORDER BY created_at DESC LIMIT 1")
            .get(body.issue_id, body.repo_id);
        if (existing) {
            // Update to committed state, update timestamps
            const updates = ["state = 'committed'", "last_commit_at = ?"];
            const params = [now];
            if (existing.state === "open") {
                updates.push("activated_at = ?");
                params.push(now);
            }
            if (body.branch) {
                updates.push("branch = ?");
                params.push(body.branch);
            }
            if (body.assigned_session_id) {
                updates.push("assigned_session_id = ?");
                params.push(body.assigned_session_id);
            }
            params.push(existing.id);
            db.prepare(`UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`).run(...params);
            const ledgerIssueId = linkLedgerIssue(db, existing.id, body.issue_id, body.repo_id) ?? existing.ledger_issue_id;
            sendJson(res, 200, { id: existing.id, state: "committed", ledger_issue_id: ledgerIssueId });
        }
        else {
            // No existing work unit — create one in committed state (auto-claim)
            const id = randomUUID();
            db.prepare(`INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, assigned_session_id, created_at, activated_at, last_commit_at)
         VALUES (?, ?, ?, ?, 'solo', 'committed', ?, ?, ?, ?)`).run(id, body.issue_id, body.repo_id, body.branch ?? null, body.assigned_session_id ?? null, now, now, now);
            const ledgerIssueId = linkLedgerIssue(db, id, body.issue_id, body.repo_id);
            sendJson(res, 201, { id, state: "committed", ledger_issue_id: ledgerIssueId });
        }
    });
    // POST /api/work-units/release — set state back to open (for abandoned worktrees)
    server.post("/api/work-units/release", (req, res) => {
        const body = readBody(req);
        if (!body.issue_id || typeof body.issue_id !== "string") {
            sendJson(res, 400, { error: "Missing or invalid issue_id" });
            return;
        }
        if (!body.repo_id || typeof body.repo_id !== "string") {
            sendJson(res, 400, { error: "Missing or invalid repo_id" });
            return;
        }
        const result = db
            .prepare("UPDATE work_units SET state = 'open', assigned_session_id = NULL WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed')")
            .run(body.issue_id, body.repo_id);
        if (result.changes === 0) {
            sendJson(res, 404, { error: "No active work unit found for this issue and repo" });
            return;
        }
        sendJson(res, 200, { ok: true, released: result.changes });
    });
    // GET /api/work-units — list with optional filters, includes liveness overlay
    // Bug: 8a281b3 — liveness overlay on work-unit responses
    server.get("/api/work-units", (req, res) => {
        const conditions = [];
        const params = [];
        if (req.query.state) {
            conditions.push("state = ?");
            params.push(req.query.state);
        }
        if (req.query.repo_id) {
            conditions.push("repo_id = ?");
            params.push(req.query.repo_id);
        }
        if (req.query.branch) {
            conditions.push("branch = ?");
            params.push(req.query.branch);
        }
        if (req.query.issue_id) {
            conditions.push("issue_id = ?");
            params.push(req.query.issue_id);
        }
        const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
        const rows = db
            .prepare(`SELECT * FROM work_units${where} ORDER BY created_at DESC`)
            .all(...params);
        const workUnits = rows.map(mapRow);
        const enriched = workUnits.map((wu) => enrichWithLiveness(wu, sessionRegistry, sessionManager));
        sendJson(res, 200, { work_units: enriched });
    });
    // GET /api/work-units/:id — single work unit with liveness overlay
    // Bug: 8a281b3
    server.get("/api/work-units/:id", (req, res) => {
        const id = req.params.id;
        if (!id) {
            sendJson(res, 400, { error: "Missing work unit id" });
            return;
        }
        const row = db
            .prepare("SELECT * FROM work_units WHERE id = ?")
            .get(id);
        if (!row) {
            sendJson(res, 404, { error: "Work unit not found" });
            return;
        }
        const workUnit = mapRow(row);
        sendJson(res, 200, enrichWithLiveness(workUnit, sessionRegistry, sessionManager));
    });
    // PATCH /api/work-units/:id — update mutable fields
    // Bug: 8a281b3
    server.patch("/api/work-units/:id", (req, res) => {
        const id = req.params.id;
        if (!id) {
            sendJson(res, 400, { error: "Missing work unit id" });
            return;
        }
        const existing = db
            .prepare("SELECT id FROM work_units WHERE id = ?")
            .get(id);
        if (!existing) {
            sendJson(res, 404, { error: "Work unit not found" });
            return;
        }
        const body = readBody(req);
        const updates = [];
        const params = [];
        if (body.state !== undefined) {
            if (!VALID_STATES.has(body.state)) {
                sendJson(res, 400, { error: `Invalid state: ${body.state}. Must be one of: ${[...VALID_STATES].join(", ")}` });
                return;
            }
            updates.push("state = ?");
            params.push(body.state);
            // Auto-set resolved_at when transitioning to resolved
            if (body.state === "resolved") {
                updates.push("resolved_at = ?");
                params.push(Date.now());
            }
        }
        if ("assigned_session_id" in body) {
            updates.push("assigned_session_id = ?");
            params.push(body.assigned_session_id ?? null);
        }
        if ("continuation" in body) {
            updates.push("continuation = ?");
            params.push(body.continuation ?? null);
        }
        if ("continuation_by" in body) {
            updates.push("continuation_by = ?");
            params.push(body.continuation_by ?? null);
        }
        if ("continuation_at" in body) {
            updates.push("continuation_at = ?");
            params.push(body.continuation_at ?? null);
        }
        if ("auth_request_id" in body) {
            updates.push("auth_request_id = ?");
            params.push(body.auth_request_id ?? null);
        }
        if (updates.length === 0) {
            sendJson(res, 400, { error: "No fields to update" });
            return;
        }
        params.push(id);
        db.prepare(`UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`).run(...params);
        const updatedRow = db
            .prepare("SELECT * FROM work_units WHERE id = ?")
            .get(id);
        const workUnit = mapRow(updatedRow);
        sendJson(res, 200, enrichWithLiveness(workUnit, sessionRegistry, sessionManager));
    });
}
