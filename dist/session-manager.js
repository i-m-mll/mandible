import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { broadcast } from "./sse.js";
import { PTYBackend } from "./backends/pty-backend.js";
import { SDKBackend } from "./backends/sdk-backend.js";
const OPERATOR_DEFAULTS = {
    command: "claude",
    args: ["--dangerously-skip-permissions"],
    cwd: process.env.HOME ?? "/tmp",
    env: {},
    cols: 220,
    rows: 50,
    auto_restart: true,
    is_operator: true,
    interaction_mode: "both",
    backend_type: "sdk",
};
function computeAgentType(command, is_operator) {
    if (is_operator)
        return "operator";
    if (command === "claude")
        return "claude";
    if (command === "codex")
        return "codex";
    if (command === "gemini")
        return "gemini";
    return "shell";
}
function defaultBackendType(command) {
    return command === "claude" ? "sdk" : "pty";
}
function parseAllowedTools(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.filter((value) => typeof value === "string");
        }
    }
    catch {
        // Ignore malformed legacy data.
    }
    return null;
}
function rowToSession(row) {
    const is_operator = row.is_operator === 1;
    return {
        id: row.id,
        label: row.label,
        command: row.command,
        args: JSON.parse(row.args_json),
        provider_session_id: row.provider_session_id ?? null,
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
        backend_type: (row.backend_type === "sdk" ? "sdk" : "pty"),
        allowed_tools: parseAllowedTools(row.allowed_tools),
        mandible_session_id: row.mandible_session_id ?? null,
        agent_type: computeAgentType(row.command, is_operator),
    };
}
function stripModelArgs(args) {
    const next = [];
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--model" || args[i] === "-m") {
            i += 1;
            continue;
        }
        next.push(args[i]);
    }
    return next;
}
function serializeSessionField(key, value) {
    if (key === "allowed_tools") {
        return Array.isArray(value) ? JSON.stringify(value) : null;
    }
    return value;
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : null;
}
function readNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
export class SessionManager {
    sessions = new Map();
    logger;
    sessionRegistry;
    constructor(_db, logger, sessionRegistry) {
        this.logger = logger;
        this.sessionRegistry = sessionRegistry ?? null;
    }
    init() {
        const db = getDb();
        const rows = db
            .prepare("SELECT * FROM console_sessions")
            .all();
        for (const row of rows) {
            const session = rowToSession(row);
            const backend = this.createBackend(session, session.backend_type);
            this.sessions.set(session.id, backend);
            this.wireBackend(backend);
            if (session.status === "running") {
                db.prepare("UPDATE console_sessions SET status = 'stopped', pid = NULL, updated_at = ? WHERE id = ?").run(Date.now(), session.id);
                backend.meta = { ...backend.meta, status: "stopped", pid: null };
            }
        }
        const operatorRow = db
            .prepare("SELECT * FROM console_sessions WHERE is_operator = 1 LIMIT 1")
            .get();
        if (operatorRow && operatorRow.auto_restart === 1) {
            const backend = this.sessions.get(operatorRow.id);
            if (backend) {
                this.logger("info", "operator_auto_start", { id: operatorRow.id });
                backend.start();
            }
        }
    }
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
        const backend_type = input.backend_type ?? defaultBackendType(input.command);
        const allowed_tools = input.allowed_tools ?? null;
        db.prepare(`INSERT INTO console_sessions
         (id, label, command, args_json, provider_session_id, cwd, env_json, cols, rows,
          status, auto_restart, is_operator, interaction_mode, created_at, updated_at,
          backend_type, allowed_tools, mandible_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.label, input.command, JSON.stringify(args), null, input.cwd ?? null, JSON.stringify(env), cols, rows, auto_restart, is_operator, interaction_mode, now, now, backend_type, allowed_tools ? JSON.stringify(allowed_tools) : null, input.mandible_session_id ?? null);
        const session = rowToSession({
            id,
            label: input.label,
            command: input.command,
            args_json: JSON.stringify(args),
            provider_session_id: null,
            cwd: input.cwd ?? null,
            env_json: JSON.stringify(env),
            cols,
            rows,
            status: "stopped",
            pid: null,
            exit_code: null,
            auto_restart,
            is_operator,
            interaction_mode,
            created_at: now,
            updated_at: now,
            started_at: null,
            stopped_at: null,
            backend_type,
            allowed_tools: allowed_tools ? JSON.stringify(allowed_tools) : null,
            mandible_session_id: input.mandible_session_id ?? null,
        });
        const backend = this.createBackend(session, backend_type);
        this.sessions.set(id, backend);
        this.wireBackend(backend);
        broadcast("console:session:created", { session });
        return session;
    }
    get(id) {
        return this.sessions.get(id);
    }
    getAll() {
        return Array.from(this.sessions.values());
    }
    start(id) {
        this.requireSession(id).start();
    }
    stop(id, signal) {
        this.requireSession(id).stop(signal);
    }
    delete(id) {
        const session = this.requireSession(id);
        session.destroy();
        getDb().prepare("DELETE FROM console_sessions WHERE id = ?").run(id);
        this.sessions.delete(id);
        broadcast("console:session:deleted", { id });
    }
    resize(id, cols, rows) {
        this.requireSession(id).resize(cols, rows);
    }
    write(id, data) {
        this.requireSession(id).write(data);
    }
    sendPrompt(id, prompt) {
        this.requireSession(id).sendPrompt(prompt);
    }
    addWsClient(id, ws) {
        const session = this.sessions.get(id);
        if (!session)
            return false;
        session.addWsClient(ws);
        return true;
    }
    updateConfig(id, patch, { silent = false } = {}) {
        const session = this.requireSession(id);
        const nextMeta = {
            ...session.meta,
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.args !== undefined ? { args: patch.args } : {}),
            ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
            ...(patch.provider_session_id !== undefined ? { provider_session_id: patch.provider_session_id } : {}),
            ...(patch.allowed_tools !== undefined ? { allowed_tools: patch.allowed_tools } : {}),
            ...(patch.mandible_session_id !== undefined ? { mandible_session_id: patch.mandible_session_id } : {}),
            updated_at: Date.now(),
        };
        session.meta = nextMeta;
        getDb().prepare(`UPDATE console_sessions
         SET label = ?, args_json = ?, cwd = ?, provider_session_id = ?, allowed_tools = ?, mandible_session_id = ?, updated_at = ?
       WHERE id = ?`).run(nextMeta.label, JSON.stringify(nextMeta.args), nextMeta.cwd, nextMeta.provider_session_id, nextMeta.allowed_tools ? JSON.stringify(nextMeta.allowed_tools) : null, nextMeta.mandible_session_id, nextMeta.updated_at, id);
        if (!silent) {
            broadcast("console:session:updated", { session: nextMeta });
        }
        return nextMeta;
    }
    updateOptions(id, options) {
        const session = this.requireSession(id);
        const patch = {};
        if (typeof options.model === "string") {
            const nextArgs = stripModelArgs(session.meta.args);
            const model = options.model.trim();
            if (model) {
                nextArgs.push("--model", model);
            }
            patch.args = nextArgs;
        }
        if (options.allowedTools !== undefined) {
            patch.allowed_tools = [...options.allowedTools];
        }
        const nextSession = Object.keys(patch).length > 0 ? this.updateConfig(id, patch, { silent: true }) : session.meta;
        if (this.isConfigurableBackend(session)) {
            session.updateOptions(options);
        }
        return nextSession;
    }
    getPermissions(id) {
        const session = this.requireSession(id);
        if (this.isPermissionAwareBackend(session)) {
            return session.getPendingPermissions();
        }
        return [];
    }
    resolvePermission(sessionId, requestId, decision) {
        const session = this.requireSession(sessionId);
        if (!this.isPermissionAwareBackend(session)) {
            return false;
        }
        return session.resolvePermission(requestId, decision);
    }
    getUsage(id) {
        const session = this.requireSession(id);
        const rows = getDb()
            .prepare(`SELECT * FROM console_session_usage
         WHERE console_session_id = ?
         ORDER BY recorded_at DESC`)
            .all(id);
        if (rows.length > 0) {
            return rows.map((row) => ({
                id: row.id,
                console_session_id: row.console_session_id,
                provider_session_id: row.provider_session_id,
                recorded_at: row.recorded_at,
                input_tokens: row.input_tokens,
                cache_creation_input_tokens: row.cache_creation_input_tokens,
                cache_read_input_tokens: row.cache_read_input_tokens,
                output_tokens: row.output_tokens,
                web_search_requests: row.web_search_requests,
                cost_usd: row.cost_usd,
                total_cost_usd: row.total_cost_usd,
                duration_ms: row.duration_ms,
                num_turns: row.num_turns,
                is_error: row.is_error === 1,
                result_subtype: row.result_subtype,
                usage: JSON.parse(row.usage_json),
                model_usage: JSON.parse(row.model_usage_json),
                errors: JSON.parse(row.errors_json),
            }));
        }
        if (this.isUsageAwareBackend(session)) {
            return session.getUsage();
        }
        return [];
    }
    startOperator() {
        const db = getDb();
        const settingRow = db
            .prepare("SELECT value FROM settings WHERE key = 'console_operator_session_id'")
            .get();
        const existingId = settingRow?.value ?? "";
        if (existingId) {
            const session = this.sessions.get(existingId);
            if (session) {
                if (session.meta.status !== "running") {
                    session.start();
                }
                return;
            }
        }
        const session = this.create({
            label: "Operator",
            ...OPERATOR_DEFAULTS,
        });
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run("console_operator_session_id", session.id, Date.now());
        this.start(session.id);
    }
    close() {
        for (const session of this.sessions.values()) {
            try {
                session.destroy();
            }
            catch {
                // Best effort
            }
        }
    }
    createBackend(session, type) {
        if (type === "sdk") {
            return new SDKBackend(session, this.logger, this.sessionRegistry ?? undefined);
        }
        return new PTYBackend(session, this.logger);
    }
    wireBackend(backend) {
        backend.on("stream_event", (event) => {
            broadcast("console:stream_event", {
                console_session_id: backend.id,
                event,
            });
            if (event.type === "system" && event.subtype === "subagent_start") {
                broadcast("console:subagent:start", {
                    console_session_id: backend.id,
                    agent_id: event.agent_id,
                    agent_type: event.agent_type,
                    session_id: event.session_id,
                    event,
                });
            }
            if (event.type === "system" && event.subtype === "subagent_stop") {
                broadcast("console:subagent:stop", {
                    console_session_id: backend.id,
                    agent_id: event.agent_id,
                    agent_type: event.agent_type,
                    session_id: event.session_id,
                    event,
                });
            }
            if (event.type === "result") {
                this.recordUsage(backend.id, event);
                broadcast("console:inbox:badge", { count: 1 });
            }
        });
        backend.on("meta_update", (fields) => {
            this.applyMetaUpdate(backend.id, fields);
        });
        backend.on("status", (event) => {
            this.broadcastStatus(backend.id, event);
        });
        backend.on("permission", (request) => {
            broadcast("console:permission:request", {
                console_session_id: backend.id,
                request,
            });
        });
    }
    applyMetaUpdate(id, fields) {
        const session = this.requireSession(id);
        const normalized = {
            ...fields,
            updated_at: fields.updated_at ?? Date.now(),
        };
        session.meta = {
            ...session.meta,
            ...normalized,
        };
        const assignments = [];
        const values = [];
        for (const [key, value] of Object.entries(normalized)) {
            assignments.push(`${key} = ?`);
            values.push(serializeSessionField(key, value));
        }
        if (assignments.length > 0) {
            values.push(id);
            getDb().prepare(`UPDATE console_sessions SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
        }
        broadcast("console:session:updated", { session: session.meta });
    }
    broadcastStatus(id, event) {
        if (event.kind === "started") {
            broadcast("console:session:started", {
                id,
                pid: this.requireSession(id).meta.pid,
                started_at: event.started_at ?? this.requireSession(id).meta.started_at,
            });
            return;
        }
        if (event.kind === "stopped") {
            broadcast("console:session:stopped", {
                id,
                stopped_at: event.stopped_at ?? this.requireSession(id).meta.stopped_at,
            });
            return;
        }
        broadcast("console:session:exit", {
            id,
            exitCode: event.exitCode ?? null,
            signal: event.signal ?? null,
            status: event.status,
        });
    }
    recordUsage(id, event) {
        const usage = asRecord(event.usage) ?? {};
        const modelUsage = asRecord(event.modelUsage) ?? {};
        const errors = Array.isArray(event.errors)
            ? event.errors.filter((value) => typeof value === "string")
            : [];
        getDb().prepare(`INSERT INTO console_session_usage (
        id,
        console_session_id,
        provider_session_id,
        recorded_at,
        input_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        output_tokens,
        web_search_requests,
        cost_usd,
        total_cost_usd,
        duration_ms,
        num_turns,
        is_error,
        result_subtype,
        usage_json,
        model_usage_json,
        errors_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, typeof event.session_id === "string" ? event.session_id : null, Date.now(), readNumber(usage.input_tokens), readNumber(usage.cache_creation_input_tokens), readNumber(usage.cache_read_input_tokens), readNumber(usage.output_tokens), readNumber(usage.web_search_requests), readNumber(usage.cost_usd), readNumber(event.total_cost_usd), readNumber(event.duration_ms), readNumber(event.num_turns), event.is_error === true ? 1 : 0, typeof event.subtype === "string" ? event.subtype : null, JSON.stringify(usage), JSON.stringify(modelUsage), JSON.stringify(errors));
    }
    requireSession(id) {
        const session = this.sessions.get(id);
        if (!session) {
            throw new Error(`session not found: ${id}`);
        }
        return session;
    }
    isPermissionAwareBackend(backend) {
        return "getPendingPermissions" in backend && "resolvePermission" in backend;
    }
    isConfigurableBackend(backend) {
        return "updateOptions" in backend;
    }
    isUsageAwareBackend(backend) {
        return "getUsage" in backend;
    }
}
