import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { broadcast } from "./sse.js";
// Bug: 568eca7 — pinned-panes.tsv location for reaper backward compat
const PINNED_PANES_TSV = path.join(os.homedir(), ".cache", "claude-reaper", "pinned-panes.tsv");
let psSupported = null;
const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  pid INTEGER,
  pid_start TEXT,
  cwd TEXT,
  branch TEXT,
  worktree TEXT,
  terminal TEXT,
  multiplexer TEXT,
  nav_session TEXT,
  nav_tab TEXT,
  nav_pane_id TEXT,
  nav_extra TEXT,
  nav_metadata_status TEXT NOT NULL DEFAULT 'not_applicable',
  nav_metadata_attempts INTEGER NOT NULL DEFAULT 0,
  nav_metadata_last_error TEXT,
  nav_metadata_last_attempt_at TEXT,
  nav_metadata_next_retry_at TEXT,
  task TEXT,
  status TEXT NOT NULL,
  parent_id TEXT,
  agent_type TEXT,
  description TEXT,
  conversation_id TEXT,
  pinned INTEGER DEFAULT 0,
  continuation TEXT,
  continuation_acked_by TEXT,
  last_active TEXT,
  channel_connected_at INTEGER,
  channel_last_tool_call INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY(parent_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions(parent_id);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
CREATE INDEX IF NOT EXISTS sessions_app_idx ON sessions(app);
CREATE INDEX IF NOT EXISTS sessions_nav_metadata_idx
  ON sessions(nav_metadata_status, nav_metadata_next_retry_at);
`;
export function ensureSessionSchema(db) {
    db.exec(SESSION_SCHEMA);
    ensureSessionColumns(db);
}
function ensureSessionColumns(db) {
    const columns = db
        .prepare("PRAGMA table_info(sessions)")
        .all();
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("nav_metadata_status")) {
        db.exec("ALTER TABLE sessions ADD COLUMN nav_metadata_status TEXT NOT NULL DEFAULT 'not_applicable'");
    }
    if (!names.has("nav_metadata_attempts")) {
        db.exec("ALTER TABLE sessions ADD COLUMN nav_metadata_attempts INTEGER NOT NULL DEFAULT 0");
    }
    if (!names.has("nav_metadata_last_error")) {
        db.exec("ALTER TABLE sessions ADD COLUMN nav_metadata_last_error TEXT");
    }
    if (!names.has("nav_metadata_last_attempt_at")) {
        db.exec("ALTER TABLE sessions ADD COLUMN nav_metadata_last_attempt_at TEXT");
    }
    if (!names.has("nav_metadata_next_retry_at")) {
        db.exec("ALTER TABLE sessions ADD COLUMN nav_metadata_next_retry_at TEXT");
    }
    db.exec(`CREATE INDEX IF NOT EXISTS sessions_nav_metadata_idx
    ON sessions(nav_metadata_status, nav_metadata_next_retry_at)`);
    if (!names.has("pinned")) {
        db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0");
    }
    if (!names.has("continuation")) {
        db.exec("ALTER TABLE sessions ADD COLUMN continuation TEXT");
    }
    if (!names.has("continuation_acked_by")) {
        db.exec("ALTER TABLE sessions ADD COLUMN continuation_acked_by TEXT");
    }
    // Bug: e01653d — real user activity time from JSONL transcript mtime
    if (!names.has("last_active")) {
        db.exec("ALTER TABLE sessions ADD COLUMN last_active TEXT");
    }
    // Bug: 0b454df — channel-connected session tracking
    if (!names.has("channel_connected_at")) {
        db.exec("ALTER TABLE sessions ADD COLUMN channel_connected_at INTEGER");
    }
    if (!names.has("channel_last_tool_call")) {
        db.exec("ALTER TABLE sessions ADD COLUMN channel_last_tool_call INTEGER");
    }
    if (!names.has("conversation_id")) {
        db.exec("ALTER TABLE sessions ADD COLUMN conversation_id TEXT");
    }
}
function safeJsonParse(value) {
    if (!value) {
        return null;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
export function normalizePidStart(value) {
    if (!value) {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
        return trimmed;
    }
    return parsed.toISOString();
}
export function readPidStartTime(pid) {
    if (pid === process.pid) {
        const startTime = new Date(Date.now() - process.uptime() * 1000).toISOString();
        return normalizePidStart(startTime);
    }
    if (!canUsePs()) {
        return null;
    }
    try {
        const output = execSync(`ps -p ${pid} -o lstart=`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        if (output) {
            return normalizePidStart(output);
        }
        const fallback = execSync(`ps -o lstart= -p ${pid}`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        return normalizePidStart(fallback);
    }
    catch {
        return null;
    }
}
function canUsePs() {
    if (psSupported !== null) {
        return psSupported;
    }
    try {
        execSync("ps -p 1 -o lstart=", { stdio: "ignore" });
        psSupported = true;
    }
    catch {
        psSupported = false;
    }
    return psSupported;
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
export function checkLiveness(session) {
    if (session.status !== "active") {
        return "dead";
    }
    // Bug: 0b454df — channel-connected sessions: liveness is based on tool call
    // freshness rather than PID, since the MCP channel server runs in a separate
    // process that Mandible doesn't own. If channel_connected_at is set but there
    // is no PID, use channel_last_tool_call for staleness.
    if (session.channel_connected_at && !session.pid) {
        const lastToolCall = session.channel_last_tool_call ?? session.channel_connected_at;
        const CHANNEL_STALE_MS = 5 * 60 * 1000; // 5 minutes
        return (Date.now() - lastToolCall) < CHANNEL_STALE_MS ? "alive" : "dead";
    }
    if (!session.pid) {
        const updatedAt = new Date(session.updated_at).getTime();
        const ageMs = Date.now() - updatedAt;
        const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
        return ageMs > STALE_THRESHOLD_MS ? "dead" : "alive";
    }
    if (!isPidAlive(session.pid)) {
        return "dead";
    }
    if (session.pid_start) {
        const expected = normalizePidStart(session.pid_start);
        const current = readPidStartTime(session.pid);
        if (expected && current && expected !== current) {
            return "dead";
        }
    }
    return "alive";
}
function normalizeText(value) {
    if (value === null || value === undefined) {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
function computeNavMetadataState(input, existing) {
    const multiplexer = normalizeText(input.multiplexer);
    const navSessionInput = normalizeText(input.nav_session);
    const navPaneInput = normalizeText(input.nav_pane_id);
    const navTabInput = normalizeText(input.nav_tab);
    const existingStatus = existing?.nav_metadata_status ?? "not_applicable";
    const existingAttempts = existing?.nav_metadata_attempts ?? 0;
    const existingLastError = existing?.nav_metadata_last_error ?? null;
    const existingLastAttemptAt = existing?.nav_metadata_last_attempt_at ?? null;
    const existingNextRetryAt = existing?.nav_metadata_next_retry_at ?? null;
    if (multiplexer !== "zellij") {
        return {
            navTab: null,
            status: "not_applicable",
            attempts: 0,
            lastError: null,
            lastAttemptAt: null,
            nextRetryAt: null,
        };
    }
    if (navTabInput) {
        return {
            navTab: navTabInput,
            status: "ready",
            attempts: 0,
            lastError: null,
            lastAttemptAt: null,
            nextRetryAt: null,
        };
    }
    const existingNavSession = existing?.nav_session ?? null;
    const existingNavPane = existing?.nav_pane_id ?? null;
    const navTargetChanged = existing
        ? normalizeText(existingNavSession) !== navSessionInput ||
            normalizeText(existingNavPane) !== navPaneInput
        : false;
    const keepResolvedTab = Boolean(existing?.nav_tab) && !navTargetChanged;
    if (keepResolvedTab) {
        return {
            navTab: existing?.nav_tab ?? null,
            status: "ready",
            attempts: 0,
            lastError: null,
            lastAttemptAt: null,
            nextRetryAt: null,
        };
    }
    const preservedStatus = navTargetChanged
        ? "pending"
        : (existingStatus === "pending" ||
            existingStatus === "degraded" ||
            existingStatus === "failed")
            ? existingStatus
            : "pending";
    return {
        navTab: null,
        status: preservedStatus,
        attempts: navTargetChanged ? 0 : existingAttempts,
        lastError: navTargetChanged ? null : existingLastError,
        lastAttemptAt: navTargetChanged ? null : existingLastAttemptAt,
        nextRetryAt: navTargetChanged ? null : existingNextRetryAt,
    };
}
function toSession(row) {
    return {
        id: row.id,
        app: row.app,
        pid: row.pid ?? null,
        pid_start: row.pid_start ?? null,
        cwd: row.cwd ?? null,
        branch: row.branch ?? null,
        worktree: row.worktree ?? null,
        terminal: row.terminal ?? null,
        multiplexer: row.multiplexer ?? null,
        nav_session: row.nav_session ?? null,
        nav_tab: row.nav_tab ?? null,
        nav_pane_id: row.nav_pane_id ?? null,
        nav_extra: safeJsonParse(row.nav_extra),
        nav_metadata_status: row.nav_metadata_status ?? "not_applicable",
        nav_metadata_attempts: row.nav_metadata_attempts ?? 0,
        nav_metadata_last_error: row.nav_metadata_last_error ?? null,
        nav_metadata_last_attempt_at: row.nav_metadata_last_attempt_at ?? null,
        nav_metadata_next_retry_at: row.nav_metadata_next_retry_at ?? null,
        task: row.task ?? null,
        status: row.status,
        parent_id: row.parent_id ?? null,
        agent_type: row.agent_type ?? null,
        pinned: row.pinned ?? 0,
        continuation: row.continuation ?? null,
        continuation_acked_by: row.continuation_acked_by ?? null,
        description: row.description ?? null,
        conversation_id: row.conversation_id ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        ended_at: row.ended_at ?? null,
        // Bug: e01653d — real user activity time from JSONL transcript mtime
        last_active: row.last_active ?? null,
        // Bug: 0b454df — channel-connected session tracking
        channel_connected_at: row.channel_connected_at ?? null,
        channel_last_tool_call: row.channel_last_tool_call ?? null,
    };
}
/**
 * Check if a pane ID is in the pinned-panes.tsv file.
 * Format: tab-separated lines: scope\thost\tpane_id\tcontext\ttimestamp
 * Bug: 568eca7 — one-way import from reaper's pinned-panes.tsv on session registration
 */
function isPaneIdPinned(paneId) {
    try {
        if (!fs.existsSync(PINNED_PANES_TSV)) {
            return false;
        }
        const content = fs.readFileSync(PINNED_PANES_TSV, "utf8");
        for (const line of content.split("\n")) {
            if (!line.trim())
                continue;
            const fields = line.split("\t");
            // pane_id is the 3rd column (index 2)
            if (fields.length >= 3 && fields[2] === paneId) {
                return true;
            }
        }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Write or remove an entry in pinned-panes.tsv for backward compat with the reaper.
 * Bug: 568eca7
 */
export function syncPinnedPanesTsv(paneId, pinned) {
    try {
        const dir = path.dirname(PINNED_PANES_TSV);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (pinned) {
            // Append if not already present
            if (!isPaneIdPinned(paneId)) {
                const timestamp = new Date().toISOString();
                const line = `all\t\t${paneId}\t\t${timestamp}\n`;
                fs.appendFileSync(PINNED_PANES_TSV, line, "utf8");
            }
        }
        else {
            // Remove entries matching this pane ID
            if (!fs.existsSync(PINNED_PANES_TSV))
                return;
            const content = fs.readFileSync(PINNED_PANES_TSV, "utf8");
            const lines = content.split("\n").filter((line) => {
                if (!line.trim())
                    return false;
                const fields = line.split("\t");
                return !(fields.length >= 3 && fields[2] === paneId);
            });
            fs.writeFileSync(PINNED_PANES_TSV, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
        }
    }
    catch {
        // Non-critical — log silently fails are OK
    }
}
export class SessionRegistry {
    db;
    constructor(db) {
        this.db = db;
        ensureSessionSchema(db);
    }
    registerSession(input) {
        const now = new Date().toISOString();
        const pidStart = normalizePidStart(input.pid_start);
        const status = input.status ?? "active";
        const existingRow = this.db
            .prepare("SELECT * FROM sessions WHERE id = ?")
            .get(input.id);
        const existing = existingRow ? toSession(existingRow) : null;
        const pick = (incoming, previous) => {
            if (incoming === undefined) {
                return previous;
            }
            return normalizeText(incoming);
        };
        const multiplexer = pick(input.multiplexer, existing?.multiplexer ?? null);
        const navSession = pick(input.nav_session, existing?.nav_session ?? null);
        const navPaneId = pick(input.nav_pane_id, existing?.nav_pane_id ?? null);
        const navState = computeNavMetadataState({
            ...input,
            multiplexer,
            nav_session: navSession,
            nav_pane_id: navPaneId,
        }, existing);
        const navExtra = input.nav_extra ? JSON.stringify(input.nav_extra) : existingRow?.nav_extra ?? null;
        if (existing) {
            this.db
                .prepare(`UPDATE sessions SET
            app = ?,
            pid = ?,
            pid_start = ?,
            cwd = ?,
            branch = ?,
            worktree = ?,
            terminal = ?,
            multiplexer = ?,
            nav_session = ?,
            nav_tab = ?,
            nav_pane_id = ?,
            nav_extra = ?,
            nav_metadata_status = ?,
            nav_metadata_attempts = ?,
            nav_metadata_last_error = ?,
            nav_metadata_last_attempt_at = ?,
            nav_metadata_next_retry_at = ?,
            task = COALESCE(?, task),
            status = ?,
            parent_id = ?,
            agent_type = ?,
            description = ?,
            conversation_id = COALESCE(?, conversation_id),
            updated_at = ?,
            ended_at = ?
          WHERE id = ?
          `)
                .run(input.app, input.pid ?? null, pidStart, input.cwd ?? null, input.branch ?? null, input.worktree ?? null, input.terminal ?? null, multiplexer, navSession, navState.navTab, navPaneId, navExtra, navState.status, navState.attempts, navState.lastError, navState.lastAttemptAt, navState.nextRetryAt, input.task ?? null, status, input.parent_id ?? null, input.agent_type ?? null, input.description ?? null, input.conversation_id ?? null, now, status === "active" ? null : now, input.id);
            const session = this.getSession(input.id);
            if (session) {
                broadcast("session:updated", session);
                return session;
            }
        }
        this.db
            .prepare(`INSERT INTO sessions (
          id, app, pid, pid_start, cwd, branch, worktree, terminal, multiplexer,
          nav_session, nav_tab, nav_pane_id, nav_extra, nav_metadata_status,
          nav_metadata_attempts, nav_metadata_last_error, nav_metadata_last_attempt_at,
          nav_metadata_next_retry_at, task, status, parent_id,
          agent_type, description, conversation_id, created_at, updated_at, ended_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`)
            .run(input.id, input.app, input.pid ?? null, pidStart, input.cwd ?? null, input.branch ?? null, input.worktree ?? null, input.terminal ?? null, multiplexer, navSession, navState.navTab, navPaneId, navExtra, navState.status, navState.attempts, navState.lastError, navState.lastAttemptAt, navState.nextRetryAt, input.task ?? null, status, input.parent_id ?? null, input.agent_type ?? null, input.description ?? null, input.conversation_id ?? null, now, now, status === "active" ? null : now);
        const session = this.getSession(input.id);
        if (!session) {
            throw new Error("Failed to register session");
        }
        // Bug: 568eca7 — one-way import: if pane ID is in pinned-panes.tsv, mark session as pinned
        if (navPaneId && isPaneIdPinned(navPaneId) && !session.pinned) {
            this.db
                .prepare("UPDATE sessions SET pinned = 1 WHERE id = ?")
                .run(session.id);
            session.pinned = 1;
        }
        broadcast("session:registered", session);
        return session;
    }
    updateSession(id, update) {
        const session = this.getSession(id);
        if (!session) {
            return null;
        }
        const now = new Date().toISOString();
        const status = update.status ?? session.status;
        const endedAt = status === "active" ? null : session.ended_at ?? now;
        // Bug: 568eca7 — include pinned in updateSession
        const pinned = update.pinned !== undefined && update.pinned !== null
            ? update.pinned
            : null;
        this.db
            .prepare(`UPDATE sessions SET
          task = COALESCE(?, task),
          continuation = COALESCE(?, continuation),
          pinned = COALESCE(?, pinned),
          status = ?,
          updated_at = ?,
          ended_at = ?
        WHERE id = ?`)
            .run(update.task ?? null, update.continuation ?? null, pinned, status, now, endedAt, id);
        const updated = this.getSession(id);
        if (updated) {
            if (status === "ended" || status === "dead") {
                // Bug: cbbb3d9 — transfer continuation to work unit on session end
                this.transferContinuationToWorkUnit(updated);
                broadcast("session:ended", updated);
            }
            else {
                broadcast("session:updated", updated);
            }
        }
        return updated;
    }
    endSession(id, status = "ended") {
        return this.updateSession(id, { status });
    }
    registerChildSession(parentId, input) {
        const parent = this.getSession(parentId);
        if (!parent) {
            return null;
        }
        const childId = input.id ?? crypto.randomUUID();
        const child = this.registerSession({
            id: childId,
            app: input.app ?? parent.app,
            parent_id: parentId,
            agent_type: input.agent_type ?? null,
            description: input.description ?? null,
            task: input.description ?? null,
            status: input.status ?? "active",
        });
        broadcast("session:child:added", { parent_id: parentId, child });
        return child;
    }
    updateChildStatus(parentId, childId, status) {
        const child = this.getSession(childId);
        if (!child || child.parent_id !== parentId) {
            return null;
        }
        const updated = this.updateSession(childId, { status });
        if (updated && (status === "ended" || status === "dead")) {
            broadcast("session:child:ended", { parent_id: parentId, child: updated });
        }
        return updated;
    }
    listSessions(options = {}) {
        const clauses = [];
        const params = [];
        if (options.status) {
            clauses.push("status = ?");
            params.push(options.status);
        }
        if (options.app) {
            clauses.push("app = ?");
            params.push(options.app);
        }
        if (options.parent_id !== undefined) {
            if (options.parent_id === null) {
                clauses.push("parent_id IS NULL");
            }
            else {
                clauses.push("parent_id = ?");
                params.push(options.parent_id);
            }
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC`)
            .all(...params);
        return rows.map((row) => this.ensureLiveness(toSession(row)));
    }
    getSession(id) {
        const row = this.db
            .prepare("SELECT * FROM sessions WHERE id = ?")
            .get(id);
        if (!row) {
            return null;
        }
        return this.ensureLiveness(toSession(row));
    }
    getSessionByPid(pid) {
        const row = this.db
            .prepare("SELECT * FROM sessions WHERE pid = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
            .get(pid);
        if (!row) {
            return null;
        }
        return this.ensureLiveness(toSession(row));
    }
    listSessionsNeedingNavMetadata(limit = 50) {
        const now = new Date().toISOString();
        const rows = this.db
            .prepare(`SELECT * FROM sessions
         WHERE status = 'active'
           AND multiplexer = 'zellij'
           AND nav_metadata_status IN ('pending', 'degraded', 'failed')
           AND (nav_metadata_next_retry_at IS NULL OR nav_metadata_next_retry_at <= ?)
         ORDER BY
           CASE WHEN nav_metadata_next_retry_at IS NULL THEN 0 ELSE 1 END,
           nav_metadata_next_retry_at ASC,
           updated_at ASC
         LIMIT ?`)
            .all(now, Math.max(1, limit));
        return rows.map((row) => this.ensureLiveness(toSession(row)));
    }
    updateSessionNavMetadata(id, update) {
        const session = this.getSession(id);
        if (!session) {
            return null;
        }
        const now = new Date().toISOString();
        const navTab = update.nav_tab === undefined ? session.nav_tab : normalizeText(update.nav_tab);
        this.db
            .prepare(`UPDATE sessions SET
          nav_tab = ?,
          nav_metadata_status = ?,
          nav_metadata_attempts = ?,
          nav_metadata_last_error = ?,
          nav_metadata_last_attempt_at = ?,
          nav_metadata_next_retry_at = ?,
          updated_at = ?
        WHERE id = ?`)
            .run(navTab, update.nav_metadata_status, update.nav_metadata_attempts, normalizeText(update.nav_metadata_last_error), normalizeText(update.nav_metadata_last_attempt_at), normalizeText(update.nav_metadata_next_retry_at), now, id);
        const updated = this.getSession(id);
        if (updated) {
            broadcast("session:updated", updated);
            if ((updated.nav_metadata_status === "degraded" || updated.nav_metadata_status === "failed") &&
                updated.nav_metadata_status !== session.nav_metadata_status) {
                broadcast("session:metadata-warning", {
                    session_id: updated.id,
                    nav_metadata_status: updated.nav_metadata_status,
                    nav_metadata_last_error: updated.nav_metadata_last_error,
                    nav_metadata_attempts: updated.nav_metadata_attempts,
                });
            }
        }
        return updated;
    }
    getSessionTree(id) {
        const rows = this.db
            .prepare("SELECT * FROM sessions")
            .all();
        const sessions = rows.map((row) => this.ensureLiveness(toSession(row)));
        const byId = new Map();
        const children = new Map();
        for (const session of sessions) {
            byId.set(session.id, session);
            const key = session.parent_id ?? null;
            if (!children.has(key)) {
                children.set(key, []);
            }
            children.get(key)?.push(session);
        }
        const attach = (session) => {
            const childList = children.get(session.id) ?? [];
            session.children = childList.map((child) => attach({ ...child }));
            return session;
        };
        const root = byId.get(id);
        return root ? attach({ ...root }) : null;
    }
    /**
     * Return IDs of all pinned sessions (lightweight, for reaper consumption).
     * Bug: 568eca7
     */
    getPinnedSessionIds() {
        const rows = this.db
            .prepare("SELECT id FROM sessions WHERE pinned = 1")
            .all();
        return rows.map((row) => row.id);
    }
    // Bug: 81c9d85 — update last_active timestamp on activity events
    updateLastActive(sessionId, timestamp) {
        const ts = timestamp
            ? new Date(timestamp).toISOString()
            : new Date().toISOString();
        this.db
            .prepare("UPDATE sessions SET last_active = ?, updated_at = ? WHERE id = ?")
            .run(ts, ts, sessionId);
    }
    // Bug: 81c9d85 — transition session to idle when SDK prompt queue drains
    setIdle(sessionId) {
        const session = this.getSession(sessionId);
        if (!session || session.status !== "active") {
            return;
        }
        const now = new Date().toISOString();
        this.db
            .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?")
            .run(now, sessionId);
        const updated = this.getSession(sessionId);
        if (updated) {
            broadcast("session:updated", updated);
        }
    }
    // Bug: 81c9d85 — transition session to active (from idle or other non-terminal state)
    setActive(sessionId) {
        const session = this.getSession(sessionId);
        if (!session || session.status === "active") {
            return;
        }
        // Don't resurrect ended/dead sessions
        if (session.status === "ended" || session.status === "dead") {
            return;
        }
        const now = new Date().toISOString();
        this.db
            .prepare("UPDATE sessions SET status = 'active', updated_at = ? WHERE id = ?")
            .run(now, sessionId);
        const updated = this.getSession(sessionId);
        if (updated) {
            broadcast("session:updated", updated);
        }
    }
    killSession(id) {
        const session = this.getSession(id);
        if (!session || !session.pid) {
            return false;
        }
        try {
            process.kill(session.pid, "SIGTERM");
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Transfer a session's continuation to linked work units when the session ends.
     * Bug: cbbb3d9 — session-to-work-unit continuation transfer
     */
    transferContinuationToWorkUnit(session) {
        if (!session.continuation) {
            return;
        }
        try {
            // Find issues linked to this session
            const links = this.db
                .prepare("SELECT issue_id, repo_id FROM session_issues WHERE session_id = ?")
                .all(session.id);
            if (links.length === 0) {
                return;
            }
            const now = Date.now();
            for (const link of links) {
                // Find open/committed work unit for this issue+repo
                const wu = this.db
                    .prepare(`SELECT id FROM work_units
             WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed')
             ORDER BY created_at DESC LIMIT 1`)
                    .get(link.issue_id, link.repo_id);
                if (wu) {
                    this.db
                        .prepare(`UPDATE work_units SET continuation = ?, continuation_by = ?, continuation_at = ?
               WHERE id = ? AND (continuation_at IS NULL OR continuation_at < ?)`)
                        .run(session.continuation, session.id, now, wu.id, now);
                }
            }
        }
        catch {
            // Non-critical — best effort transfer
        }
    }
    ensureLiveness(session) {
        if (session.status !== "active") {
            return session;
        }
        const status = checkLiveness(session);
        if (status === "alive") {
            return session;
        }
        const now = new Date().toISOString();
        this.db
            .prepare("UPDATE sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?")
            .run("dead", now, now, session.id);
        const updated = { ...session, status: "dead", ended_at: now, updated_at: now };
        // Bug: cbbb3d9 — transfer continuation to work unit on session death
        this.transferContinuationToWorkUnit(updated);
        broadcast("session:ended", updated);
        return updated;
    }
}
