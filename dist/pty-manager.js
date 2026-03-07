/**
 * PTY Manager — manages terminal sessions backed by node-pty.
 * Bug: e980dd8
 */
import { randomUUID } from "node:crypto";
import pty from "node-pty";
import { getDb } from "./db.js";
import { broadcast } from "./sse.js";
// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------
const RING_BUFFER_BYTES = 512 * 1024; // 512 KB per session
// Strip common ANSI/VT100 sequences so we can attempt JSON.parse on raw PTY lines.
const ANSI_STRIP_RE = /\x1b\[[0-9;]*[mGKHFABCDJu]|\x1b\][^\x07]*\x07|\x0f|\x1b[()][AB012]/g;
// Env keys that must NOT be inherited by PTY children (they wire agent signing keys).
const POLLUTED_ENV_KEYS_PREFIX = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];
const POLLUTED_ENV_KEYS_EXACT = new Set([
    "CLAUDECODE",
    "GIT_CONFIG_COUNT",
]);
// -----------------------------------------------------------------------
// RingBuffer
// -----------------------------------------------------------------------
export class RingBuffer {
    buf;
    head = 0;
    size = 0;
    constructor(capacity = RING_BUFFER_BYTES) {
        this.buf = Buffer.allocUnsafe(capacity);
    }
    /** Append a string (UTF-8) to the ring buffer. */
    append(data) {
        const incoming = Buffer.from(data, "utf8");
        const cap = this.buf.length;
        let offset = 0;
        let remaining = incoming.length;
        while (remaining > 0) {
            const canWrite = Math.min(remaining, cap - this.head);
            incoming.copy(this.buf, this.head, offset, offset + canWrite);
            this.head = (this.head + canWrite) % cap;
            this.size = Math.min(this.size + canWrite, cap);
            offset += canWrite;
            remaining -= canWrite;
        }
    }
    /**
     * Returns a contiguous Buffer containing current ring buffer contents
     * in chronological order. Handles wrap-around correctly.
     */
    snapshot() {
        if (this.size === 0)
            return Buffer.alloc(0);
        const cap = this.buf.length;
        if (this.size < cap) {
            // Buffer has not wrapped yet; data is at [head - size .. head)
            const start = (this.head - this.size + cap) % cap;
            return Buffer.from(this.buf.subarray(start, start + this.size));
        }
        // Buffer is full (wrapped). Data is [head .. end] + [0 .. head].
        const result = Buffer.allocUnsafe(cap);
        const tail = this.buf.subarray(this.head);
        const front = this.buf.subarray(0, this.head);
        tail.copy(result, 0);
        front.copy(result, tail.length);
        return result;
    }
    /** Reset the buffer. */
    clear() {
        this.head = 0;
        this.size = 0;
    }
    /** Current number of bytes stored. */
    get byteLength() {
        return this.size;
    }
}
// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
/** Compute the derived agent_type field from a ConsoleSession DB row. */
function computeAgentType(command, is_operator) {
    if (is_operator)
        return "operator";
    if (command === "claude")
        return "claude";
    if (command === "codex")
        return "codex";
    return "shell";
}
/** Build a clean environment for PTY children. */
function buildPtyEnv(extraEnv) {
    const cleaned = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined)
            continue;
        if (POLLUTED_ENV_KEYS_EXACT.has(k))
            continue;
        if (POLLUTED_ENV_KEYS_PREFIX.some((prefix) => k.startsWith(prefix)))
            continue;
        cleaned[k] = v;
    }
    // Apply caller-supplied overrides on top
    Object.assign(cleaned, extraEnv);
    return cleaned;
}
function rowToSession(row) {
    const is_operator = row.is_operator === 1;
    return {
        id: row.id,
        label: row.label,
        command: row.command,
        args: JSON.parse(row.args_json),
        cwd: row.cwd,
        env: JSON.parse(row.env_json),
        cols: row.cols,
        rows: row.rows,
        status: row.status,
        pid: row.pid,
        exit_code: row.exit_code,
        auto_restart: row.auto_restart === 1,
        is_operator,
        interaction_mode: (row.interaction_mode ?? "both"),
        created_at: row.created_at,
        updated_at: row.updated_at,
        started_at: row.started_at,
        stopped_at: row.stopped_at,
        agent_type: computeAgentType(row.command, is_operator),
    };
}
// -----------------------------------------------------------------------
// PtySession
// -----------------------------------------------------------------------
export class PtySession {
    id;
    meta;
    ptyProc = null;
    ringBuffer;
    wsClients = new Set();
    lineBuffer = "";
    onDataDisposable = null;
    onExitDisposable = null;
    logger;
    constructor(meta, logger) {
        this.id = meta.id;
        this.meta = meta;
        this.ringBuffer = new RingBuffer();
        this.logger = logger;
    }
    /** Start the PTY process. */
    start() {
        if (this.ptyProc) {
            this.logger("warn", "pty_already_running", { id: this.id });
            return;
        }
        const env = buildPtyEnv(this.meta.env);
        try {
            this.ptyProc = pty.spawn(this.meta.command, this.meta.args, {
                name: "xterm-256color",
                cols: this.meta.cols,
                rows: this.meta.rows,
                cwd: this.meta.cwd ?? process.env.HOME ?? "/tmp",
                env,
            });
        }
        catch (err) {
            this.logger("error", "pty_spawn_failed", { id: this.id, error: String(err) });
            const now = Date.now();
            this.meta = { ...this.meta, status: "crashed", pid: null, updated_at: now };
            this.dbUpdate({ status: "crashed", pid: null, updated_at: now });
            broadcast("console:session:exit", { id: this.id, exitCode: -1, signal: null, status: "crashed" });
            return;
        }
        const now = Date.now();
        this.meta = {
            ...this.meta,
            status: "running",
            pid: this.ptyProc.pid,
            started_at: now,
            updated_at: now,
        };
        this.dbUpdate({ status: "running", pid: this.ptyProc.pid, started_at: now, updated_at: now });
        this.onDataDisposable = this.ptyProc.onData((data) => {
            this.handleData(data);
        });
        this.onExitDisposable = this.ptyProc.onExit(({ exitCode, signal }) => {
            this.handleExit({ exitCode: exitCode ?? 0, signal: signal ?? null });
        });
        broadcast("console:session:started", {
            id: this.id,
            pid: this.meta.pid,
            started_at: this.meta.started_at,
        });
        this.logger("info", "pty_started", { id: this.id, pid: this.meta.pid, command: this.meta.command });
    }
    /** Stop the PTY process with an optional signal. */
    stop(signal) {
        if (!this.ptyProc)
            return;
        this.onDataDisposable?.dispose();
        this.onExitDisposable?.dispose();
        this.onDataDisposable = null;
        this.onExitDisposable = null;
        try {
            this.ptyProc.kill(signal ?? "SIGHUP");
        }
        catch {
            // Process may already be gone
        }
        this.ptyProc = null;
        const now = Date.now();
        this.meta = {
            ...this.meta,
            status: "stopped",
            pid: null,
            stopped_at: now,
            updated_at: now,
        };
        this.dbUpdate({ status: "stopped", pid: null, stopped_at: now, updated_at: now });
        // Notify WebSocket clients of status change
        this.broadcastWsStatus("stopped");
        broadcast("console:session:stopped", { id: this.id, stopped_at: now });
        this.logger("info", "pty_stopped", { id: this.id });
    }
    /** Resize the PTY. */
    resize(cols, rows) {
        if (this.ptyProc) {
            try {
                this.ptyProc.resize(cols, rows);
            }
            catch (err) {
                this.logger("warn", "pty_resize_failed", { id: this.id, error: String(err) });
            }
        }
        this.meta = { ...this.meta, cols, rows };
        this.dbUpdate({ cols, rows, updated_at: Date.now() });
    }
    /** Write raw input to the PTY. */
    write(data) {
        if (!this.ptyProc)
            return;
        try {
            this.ptyProc.write(data);
        }
        catch (err) {
            this.logger("warn", "pty_write_failed", { id: this.id, error: String(err) });
        }
    }
    /**
     * Add a WebSocket client. Replays ring buffer immediately, then sends
     * init metadata. Removes client on 'close'.
     *
     * If the session is no longer running (crashed or ended), sends a UTF-8
     * error banner to the terminal and closes the WebSocket with code 1001
     * rather than adding it to the active client set. This prevents the
     * "cursor but no output" zombie state after a Mandible restart.
     */
    addWsClient(ws) {
        // Reject clients connecting to a dead/ended session
        if (this.meta.status !== "running") {
            try {
                ws.send(Buffer.from(`\r\n\x1b[33m[Session ${this.meta.status} — create a new session]\x1b[0m\r\n`, "utf8"));
            }
            catch {
                // ignore send errors on already-closing sockets
            }
            ws.close(1001, "session ended");
            return;
        }
        this.wsClients.add(ws);
        // Replay ring buffer as a single binary message
        const snapshot = this.ringBuffer.snapshot();
        if (snapshot.length > 0) {
            try {
                ws.send(snapshot);
            }
            catch (err) {
                this.logger("warn", "ws_replay_failed", { id: this.id, error: String(err) });
            }
        }
        // Send init metadata as JSON text frame
        try {
            ws.send(JSON.stringify({ type: "init", session: this.meta }));
        }
        catch (err) {
            this.logger("warn", "ws_init_failed", { id: this.id, error: String(err) });
        }
        ws.on("close", () => {
            this.removeWsClient(ws);
        });
        ws.on("message", (data, isBinary) => {
            if (isBinary) {
                // Raw PTY input
                this.write(typeof data === "string" ? data : data.toString("utf8"));
            }
            else {
                // JSON control message
                const text = typeof data === "string" ? data : data.toString("utf8");
                try {
                    const msg = JSON.parse(text);
                    if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
                        this.resize(msg.cols, msg.rows);
                    }
                    // "ping" and unknown types are silently ignored
                }
                catch {
                    // Not valid JSON — silently ignore
                }
            }
        });
    }
    /** Remove a WebSocket client from the broadcast set. */
    removeWsClient(ws) {
        this.wsClients.delete(ws);
    }
    /** Return a snapshot of the ring buffer for HTTP-based replay. */
    getBufferSnapshot() {
        return this.ringBuffer.snapshot();
    }
    // ----------------------------------------------------------------
    // Private
    // ----------------------------------------------------------------
    handleData(data) {
        this.ringBuffer.append(data);
        // Broadcast raw PTY bytes to all connected WebSocket clients
        if (this.wsClients.size > 0) {
            const buf = Buffer.from(data, "utf8");
            for (const ws of this.wsClients) {
                try {
                    ws.send(buf);
                }
                catch {
                    // Client disconnected; will be cleaned up on 'close' event
                }
            }
        }
        // Opportunistically parse stream-json lines for structured events
        this.feedLineParser(data);
    }
    feedLineParser(raw) {
        this.lineBuffer += raw;
        const lines = this.lineBuffer.split("\n");
        // Keep the incomplete last segment in the buffer
        this.lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
            if (line.trim()) {
                this.parseStreamJsonLine(line);
            }
        }
    }
    parseStreamJsonLine(line) {
        // Strip ANSI codes before attempting JSON parse
        const stripped = line.replace(ANSI_STRIP_RE, "").trim();
        // Only attempt parse on lines that look like JSON objects
        if (!stripped.startsWith("{"))
            return;
        let parsed;
        try {
            parsed = JSON.parse(stripped);
        }
        catch {
            return; // Not JSON — silently ignore (VT100, etc.)
        }
        // Validate it's a ClaudeStreamLine by checking the 'type' field
        if (typeof parsed !== "object" ||
            parsed === null ||
            !("type" in parsed)) {
            return;
        }
        const event = parsed;
        broadcast("console:stream_event", {
            console_session_id: this.id,
            event,
        });
        // Badge notification when a run completes
        if (event.type === "result") {
            broadcast("console:inbox:badge", { count: 1 });
        }
    }
    handleExit({ exitCode, signal }) {
        this.onDataDisposable?.dispose();
        this.onExitDisposable?.dispose();
        this.onDataDisposable = null;
        this.onExitDisposable = null;
        this.ptyProc = null;
        const crashed = exitCode > 0;
        const status = crashed ? "crashed" : "stopped";
        const now = Date.now();
        this.meta = {
            ...this.meta,
            status,
            pid: null,
            exit_code: exitCode,
            stopped_at: now,
            updated_at: now,
        };
        this.dbUpdate({ status, pid: null, exit_code: exitCode, stopped_at: now, updated_at: now });
        // Notify WebSocket clients
        this.broadcastWsStatus(status, exitCode);
        broadcast("console:session:exit", {
            id: this.id,
            exitCode,
            signal,
            status,
        });
        this.logger("info", "pty_exited", { id: this.id, exitCode, signal, status });
        // Clear WebSocket clients — they will reconnect if needed
        this.wsClients.clear();
        // Auto-restart crashed sessions
        if (this.meta.auto_restart && crashed) {
            this.logger("info", "pty_auto_restart_scheduled", { id: this.id, delay: 2000 });
            const timer = setTimeout(() => {
                if (this.meta.auto_restart) {
                    this.logger("info", "pty_auto_restart", { id: this.id });
                    this.start();
                }
            }, 2000);
            // Allow process to exit even if restart timer is pending
            if (timer && typeof timer === "object" && "unref" in timer) {
                timer.unref();
            }
        }
    }
    broadcastWsStatus(status, exitCode) {
        if (this.wsClients.size === 0)
            return;
        const msg = JSON.stringify({
            type: "status",
            status,
            ...(exitCode !== undefined ? { exitCode } : {}),
        });
        for (const ws of this.wsClients) {
            try {
                ws.send(msg);
            }
            catch {
                // Ignore send errors on disconnect
            }
        }
    }
    dbUpdate(fields) {
        const db = getDb();
        const assignments = [];
        const values = [];
        for (const [key, value] of Object.entries(fields)) {
            assignments.push(`${key} = ?`);
            values.push(value);
        }
        if (assignments.length === 0)
            return;
        if (!("updated_at" in fields)) {
            assignments.push("updated_at = ?");
            values.push(Date.now());
        }
        values.push(this.id);
        db.prepare(`UPDATE console_sessions SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    }
}
// -----------------------------------------------------------------------
// PtyManager
// -----------------------------------------------------------------------
/** Default operator session configuration. */
const OPERATOR_DEFAULTS = {
    command: "claude",
    args: ["--dangerously-skip-permissions", "--output-format", "stream-json"],
    cwd: process.env.HOME ?? "/tmp",
    env: {},
    cols: 220,
    rows: 50,
    auto_restart: true,
    is_operator: true,
    interaction_mode: "both",
};
export class PtyManager {
    sessions = new Map();
    logger;
    constructor(_db, logger) {
        this.logger = logger;
    }
    /**
     * Initialize from DB: reconcile running/stopped state after daemon restart.
     * All previously 'running' sessions are marked 'stopped' (their PTYs are
     * gone after restart). Operator sessions with auto_restart=1 are then
     * restarted, transitioning them back to 'running' via start().
     * This prevents the zombie terminal state where addWsClient() would accept
     * WS connections for dead sessions that produce no output.
     */
    init() {
        const db = getDb();
        const rows = db
            .prepare("SELECT * FROM console_sessions")
            .all();
        for (const row of rows) {
            const session = rowToSession(row);
            const ptySession = new PtySession(session, this.logger);
            this.sessions.set(session.id, ptySession);
            if (session.status === "running") {
                // All PTY processes are gone after a daemon restart. Mark every
                // previously-running session as 'stopped' so that addWsClient() rejects
                // incoming WS connections with an informative error rather than accepting
                // them and silently producing no output (zombie terminal state).
                // Operator sessions with auto_restart=1 will be restarted below and
                // will transition back to 'running' once start() is called.
                db.prepare("UPDATE console_sessions SET status = 'stopped', pid = NULL, updated_at = ? WHERE id = ?").run(Date.now(), session.id);
                ptySession.meta = { ...ptySession.meta, status: "stopped", pid: null };
            }
        }
        // Start operator sessions with auto_restart
        const operatorRow = db
            .prepare("SELECT * FROM console_sessions WHERE is_operator = 1 LIMIT 1")
            .get();
        if (operatorRow && operatorRow.auto_restart === 1) {
            const ptySession = this.sessions.get(operatorRow.id);
            if (ptySession) {
                this.logger("info", "operator_auto_start", { id: operatorRow.id });
                ptySession.start();
            }
        }
    }
    /** Create a new console session (does NOT start it). */
    create(input) {
        const db = getDb();
        const id = randomUUID();
        const now = Date.now();
        const args = input.args ?? [];
        const env = input.env ?? {};
        const cols = input.cols ?? 120;
        const rows = input.rows ?? 30;
        const auto_restart = input.auto_restart ? 1 : 0;
        const is_operator = input.is_operator ? 1 : 0;
        const interaction_mode = input.interaction_mode ?? "both";
        db.prepare(`INSERT INTO console_sessions
         (id, label, command, args_json, cwd, env_json, cols, rows,
          status, auto_restart, is_operator, interaction_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?)`).run(id, input.label, input.command, JSON.stringify(args), input.cwd ?? null, JSON.stringify(env), cols, rows, auto_restart, is_operator, interaction_mode, now, now);
        const session = rowToSession({
            id,
            label: input.label,
            command: input.command,
            args_json: JSON.stringify(args),
            cwd: input.cwd ?? null,
            env_json: JSON.stringify(env),
            cols,
            rows,
            status: "stopped",
            pid: null,
            exit_code: null,
            auto_restart: auto_restart,
            is_operator: is_operator,
            interaction_mode,
            created_at: now,
            updated_at: now,
            started_at: null,
            stopped_at: null,
        });
        const ptySession = new PtySession(session, this.logger);
        this.sessions.set(id, ptySession);
        broadcast("console:session:created", { session });
        return session;
    }
    /** Get a PtySession by ID. */
    get(id) {
        return this.sessions.get(id);
    }
    /** Get all PtySessions. */
    getAll() {
        return Array.from(this.sessions.values());
    }
    /** Start a session by ID. */
    start(id) {
        const session = this.sessions.get(id);
        if (!session)
            throw new Error(`session not found: ${id}`);
        session.start();
    }
    /** Stop a session by ID. */
    stop(id, signal) {
        const session = this.sessions.get(id);
        if (!session)
            throw new Error(`session not found: ${id}`);
        session.stop(signal);
    }
    /** Stop and remove a session from DB and memory. */
    delete(id) {
        const session = this.sessions.get(id);
        if (!session)
            throw new Error(`session not found: ${id}`);
        if (session.meta.status === "running") {
            session.stop("SIGHUP");
        }
        const db = getDb();
        db.prepare("DELETE FROM console_sessions WHERE id = ?").run(id);
        this.sessions.delete(id);
        broadcast("console:session:deleted", { id });
    }
    /** Resize a session's PTY. */
    resize(id, cols, rows) {
        const session = this.sessions.get(id);
        if (!session)
            throw new Error(`session not found: ${id}`);
        session.resize(cols, rows);
    }
    /** Write input to a session's PTY. */
    write(id, data) {
        const session = this.sessions.get(id);
        if (!session)
            throw new Error(`session not found: ${id}`);
        session.write(data);
    }
    /**
     * Add a WebSocket client to a session.
     * Returns false if session not found.
     */
    addWsClient(id, ws) {
        const session = this.sessions.get(id);
        if (!session)
            return false;
        session.addWsClient(ws);
        return true;
    }
    /**
     * Start or create the Operator session.
     * - Reads console_operator_session_id from settings
     * - If empty: creates a new session with default operator config, saves ID
     * - If found: retrieves from sessions map
     * - Calls start() on the session
     */
    startOperator() {
        const db = getDb();
        const settingRow = db
            .prepare("SELECT value FROM settings WHERE key = 'console_operator_session_id'")
            .get();
        const existingId = settingRow?.value ?? "";
        if (existingId) {
            const ptySession = this.sessions.get(existingId);
            if (ptySession) {
                if (ptySession.meta.status !== "running") {
                    ptySession.start();
                }
                return;
            }
            // Session ID is in settings but not in memory — may have been deleted.
            // Fall through to create a new one.
        }
        // Create a new operator session
        const session = this.create({
            label: "Operator",
            ...OPERATOR_DEFAULTS,
        });
        // Persist the operator session ID
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run("console_operator_session_id", session.id, Date.now());
        this.start(session.id);
    }
    /** Kill all PTYs. Called during daemon shutdown. */
    close() {
        for (const session of this.sessions.values()) {
            if (session.meta.status === "running") {
                try {
                    session.stop("SIGHUP");
                }
                catch {
                    // Best effort
                }
            }
        }
    }
}
