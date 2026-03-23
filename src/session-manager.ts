import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  AgenticBackend,
  BackendMetaUpdate,
  BackendStatusEvent,
  BackendType,
  ConfigurableBackend,
  PermissionAwareBackend,
  PermissionDecision,
  PermissionRequest,
  UsageAwareBackend,
} from "./agentic-backend.js";
import { getDb } from "./db.js";
import { SessionRegistry } from "./registry.js";
import { broadcast } from "./sse.js";
import { PTYBackend } from "./backends/pty-backend.js";
import { SDKBackend, type SDKBackendOptions } from "./backends/sdk-backend.js";
import { SpawnBackend } from "./backends/spawn-backend.js";
import type {
  ConsoleInteractionMode,
  ConsoleSession,
  ConsoleSessionInput,
  ConsoleSessionStatus,
  ConsoleStreamEvent,
  Logger,
} from "./types.js";

interface ConsoleSessionRow {
  id: string;
  label: string;
  command: string;
  args_json: string;
  provider_session_id: string | null;
  cwd: string | null;
  env_json: string;
  cols: number;
  rows: number;
  status: string;
  pid: number | null;
  exit_code: number | null;
  auto_restart: number;
  is_operator: number;
  interaction_mode: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  stopped_at: number | null;
  backend_type: string | null;
  allowed_tools: string | null;
  mandible_session_id: string | null;
  resume_at_message: string | null;
  channel_enabled: number;
}

interface ConsoleSessionUsageRow {
  id: string;
  console_session_id: string;
  provider_session_id: string | null;
  recorded_at: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  web_search_requests: number;
  cost_usd: number;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  is_error: number;
  result_subtype: string | null;
  usage_json: string;
  model_usage_json: string;
  errors_json: string;
}

const OPERATOR_DEFAULTS: Omit<ConsoleSessionInput, "label"> = {
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

function computeAgentType(
  command: string,
  is_operator: boolean
): ConsoleSession["agent_type"] {
  if (is_operator) return "operator";
  if (command === "claude") return "claude";
  if (command === "codex") return "codex";
  if (command === "gemini") return "gemini";
  return "shell";
}

function defaultBackendType(command: string): BackendType {
  if (command === "claude") return "sdk";
  // Bug: 8d3328c — Codex, Gemini use spawn (structured JSON stdout parsing)
  if (command === "codex" || command === "gemini") return "spawn";
  // Shell and unknown commands need interactive terminal (SpawnBackend can't
  // execute arbitrary commands — buildPromptInvocation returns null for them)
  return "pty";
}

function parseAllowedTools(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    // Ignore malformed legacy data.
  }
  return null;
}

function rowToSession(row: ConsoleSessionRow): ConsoleSession {
  const is_operator = row.is_operator === 1;
  return {
    id: row.id,
    label: row.label,
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    provider_session_id: row.provider_session_id ?? null,
    cwd: row.cwd,
    env: JSON.parse(row.env_json) as Record<string, string>,
    cols: row.cols,
    rows: row.rows,
    status: row.status as ConsoleSessionStatus,
    pid: row.pid,
    exit_code: row.exit_code,
    auto_restart: row.auto_restart === 1,
    is_operator,
    interaction_mode: (row.interaction_mode ?? "both") as ConsoleInteractionMode,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    stopped_at: row.stopped_at,
    backend_type: (row.backend_type === "sdk" ? "sdk" : row.backend_type === "spawn" ? "spawn" : "pty") as BackendType,
    allowed_tools: parseAllowedTools(row.allowed_tools),
    mandible_session_id: row.mandible_session_id ?? null,
    resume_at_message: row.resume_at_message ?? null,
    channel_enabled: Boolean(row.channel_enabled),
    agent_type: computeAgentType(row.command, is_operator),
  };
}

function stripModelArgs(args: string[]): string[] {
  const next: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--model" || args[i] === "-m") {
      i += 1;
      continue;
    }
    next.push(args[i]);
  }
  return next;
}

function serializeSessionField(key: keyof BackendMetaUpdate, value: unknown): unknown {
  if (key === "allowed_tools") {
    return Array.isArray(value) ? JSON.stringify(value) : null;
  }
  // Bug: b5aba0e — boolean fields stored as INTEGER in SQLite
  if (key === "channel_enabled") {
    return value ? 1 : 0;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class SessionManager {
  private sessions: Map<string, AgenticBackend> = new Map();
  private logger: Logger;
  private sessionRegistry: SessionRegistry | null;

  constructor(_db: unknown, logger: Logger, sessionRegistry?: SessionRegistry) {
    this.logger = logger;
    this.sessionRegistry = sessionRegistry ?? null;
  }

  init(): void {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM console_sessions")
      .all() as ConsoleSessionRow[];

    for (const row of rows) {
      const session = rowToSession(row);
      const backend = this.createBackend(session, session.backend_type);
      this.sessions.set(session.id, backend);
      this.wireBackend(backend);

      if (session.status === "running") {
        db.prepare(
          "UPDATE console_sessions SET status = 'stopped', pid = NULL, updated_at = ? WHERE id = ?"
        ).run(Date.now(), session.id);
        backend.meta = { ...backend.meta, status: "stopped", pid: null };
      }
    }

    const operatorRow = db
      .prepare("SELECT * FROM console_sessions WHERE is_operator = 1 LIMIT 1")
      .get() as ConsoleSessionRow | undefined;

    if (operatorRow && operatorRow.auto_restart === 1) {
      const backend = this.sessions.get(operatorRow.id);
      if (backend) {
        this.logger("info", "operator_auto_start", { id: operatorRow.id });
        backend.start();
      }
    }
  }

  create(input: ConsoleSessionInput): ConsoleSession {
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

    const provider_session_id = input.provider_session_id ?? null;
    const resume_at_message = input.resume_at_message ?? null;
    const channel_enabled = input.channel_enabled ? 1 : 0;

    db.prepare(
      `INSERT INTO console_sessions
         (id, label, command, args_json, provider_session_id, cwd, env_json, cols, rows,
          status, auto_restart, is_operator, interaction_mode, created_at, updated_at,
          backend_type, allowed_tools, mandible_session_id, resume_at_message, channel_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.label,
      input.command,
      JSON.stringify(args),
      provider_session_id,
      input.cwd ?? null,
      JSON.stringify(env),
      cols,
      rows,
      auto_restart,
      is_operator,
      interaction_mode,
      now,
      now,
      backend_type,
      allowed_tools ? JSON.stringify(allowed_tools) : null,
      input.mandible_session_id ?? null,
      resume_at_message,
      channel_enabled
    );

    const session = rowToSession({
      id,
      label: input.label,
      command: input.command,
      args_json: JSON.stringify(args),
      provider_session_id,
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
      resume_at_message,
      channel_enabled,
    });

    // Bug: 61bee4e — Store preset associations and pass presetIds to backend
    if (input.presetIds && input.presetIds.length > 0) {
      const insertPreset = db.prepare(
        `INSERT OR IGNORE INTO session_presets (session_id, preset_id, preset_version, position)
         VALUES (?, ?, ?, ?)`,
      );
      const presetTx = db.transaction(() => {
        for (let i = 0; i < input.presetIds!.length; i++) {
          const presetRow = db.prepare("SELECT version FROM presets WHERE id = ?")
            .get(input.presetIds![i]) as { version: number } | undefined;
          if (presetRow) {
            insertPreset.run(id, input.presetIds![i], presetRow.version, i);
          }
        }
      });
      presetTx();
    }

    const backend = this.createBackend(session, backend_type);

    // Bug: 61bee4e — If presetIds are set, update the SDK backend options
    if (input.presetIds && input.presetIds.length > 0 && backend instanceof SDKBackend) {
      backend.updateOptions({ presetIds: input.presetIds });
    }

    this.sessions.set(id, backend);
    this.wireBackend(backend);

    broadcast("console:session:created", { session });
    return session;
  }

  get(id: string): AgenticBackend | undefined {
    return this.sessions.get(id);
  }

  getAll(): AgenticBackend[] {
    return Array.from(this.sessions.values());
  }

  start(id: string): void {
    this.requireSession(id).start();
  }

  stop(id: string, signal?: string): void {
    this.requireSession(id).stop(signal);
  }

  delete(id: string): void {
    const session = this.requireSession(id);
    session.destroy();
    getDb().prepare("DELETE FROM console_sessions WHERE id = ?").run(id);
    this.sessions.delete(id);
    broadcast("console:session:deleted", { id });
  }

  resize(id: string, cols: number, rows: number): void {
    this.requireSession(id).resize(cols, rows);
  }

  write(id: string, data: string): void {
    this.requireSession(id).write(data);
  }

  sendPrompt(id: string, prompt: string): void {
    this.requireSession(id).sendPrompt(prompt);
  }

  addWsClient(id: string, ws: WebSocket): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.addWsClient(ws);
    return true;
  }

  updateConfig(
    id: string,
    patch: Partial<
      Pick<
        ConsoleSession,
        "label" | "args" | "cwd" | "provider_session_id" | "allowed_tools" | "mandible_session_id"
      >
    >,
    { silent = false }: { silent?: boolean } = {},
  ): ConsoleSession {
    const session = this.requireSession(id);
    const nextMeta: ConsoleSession = {
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

    getDb().prepare(
      `UPDATE console_sessions
         SET label = ?, args_json = ?, cwd = ?, provider_session_id = ?, allowed_tools = ?, mandible_session_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      nextMeta.label,
      JSON.stringify(nextMeta.args),
      nextMeta.cwd,
      nextMeta.provider_session_id,
      nextMeta.allowed_tools ? JSON.stringify(nextMeta.allowed_tools) : null,
      nextMeta.mandible_session_id,
      nextMeta.updated_at,
      id,
    );

    if (!silent) {
      broadcast("console:session:updated", { session: nextMeta });
    }
    return nextMeta;
  }

  updateOptions(id: string, options: SDKBackendOptions): ConsoleSession {
    const session = this.requireSession(id);
    const patch: Partial<Pick<ConsoleSession, "args" | "allowed_tools">> = {};

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
    if (this.isConfigurableBackend<SDKBackendOptions>(session)) {
      session.updateOptions(options);
    }
    return nextSession;
  }

  getPermissions(id: string): PermissionRequest[] {
    const session = this.requireSession(id);
    if (this.isPermissionAwareBackend(session)) {
      return session.getPendingPermissions();
    }
    return [];
  }

  resolvePermission(sessionId: string, requestId: string, decision: PermissionDecision): boolean {
    const session = this.requireSession(sessionId);
    if (!this.isPermissionAwareBackend(session)) {
      return false;
    }
    return session.resolvePermission(requestId, decision);
  }

  getUsage(id: string): Array<Record<string, unknown>> {
    const session = this.requireSession(id);
    const rows = getDb()
      .prepare(
        `SELECT * FROM console_session_usage
         WHERE console_session_id = ?
         ORDER BY recorded_at DESC`
      )
      .all(id) as ConsoleSessionUsageRow[];

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

    if (this.isUsageAwareBackend<Record<string, unknown>>(session)) {
      return session.getUsage();
    }
    return [];
  }

  startOperator(): void {
    const db = getDb();
    const settingRow = db
      .prepare("SELECT value FROM settings WHERE key = 'console_operator_session_id'")
      .get() as { value: string } | undefined;

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

    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run("console_operator_session_id", session.id, Date.now());

    this.start(session.id);
  }

  close(): void {
    for (const session of this.sessions.values()) {
      try {
        session.destroy();
      } catch {
        // Best effort
      }
    }
  }

  private createBackend(session: ConsoleSession, type: BackendType): AgenticBackend {
    if (type === "sdk") {
      return new SDKBackend(session, this.logger, this.sessionRegistry ?? undefined);
    }
    if (type === "spawn") {
      return new SpawnBackend(session, this.logger);
    }
    return new PTYBackend(session, this.logger);
  }

  private wireBackend(backend: AgenticBackend): void {
    backend.on("stream_event", (event: ConsoleStreamEvent) => {
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

    backend.on("meta_update", (fields: BackendMetaUpdate) => {
      this.applyMetaUpdate(backend.id, fields);
    });

    backend.on("status", (event: BackendStatusEvent) => {
      this.broadcastStatus(backend.id, event);
    });

    backend.on("permission", (request: PermissionRequest) => {
      broadcast("console:permission:request", {
        console_session_id: backend.id,
        request,
      });
    });
  }

  private applyMetaUpdate(id: string, fields: BackendMetaUpdate): void {
    const session = this.requireSession(id);
    const normalized: BackendMetaUpdate = {
      ...fields,
      updated_at: fields.updated_at ?? Date.now(),
    };

    session.meta = {
      ...session.meta,
      ...normalized,
    };

    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(normalized) as Array<[keyof BackendMetaUpdate, unknown]>) {
      assignments.push(`${key} = ?`);
      values.push(serializeSessionField(key, value));
    }

    if (assignments.length > 0) {
      values.push(id);
      getDb().prepare(`UPDATE console_sessions SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    }

    broadcast("console:session:updated", { session: session.meta });
  }

  private broadcastStatus(id: string, event: BackendStatusEvent): void {
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

  private recordUsage(id: string, event: ConsoleStreamEvent): void {
    const usage = asRecord(event.usage) ?? {};
    const modelUsage = asRecord(event.modelUsage) ?? {};
    const errors = Array.isArray(event.errors)
      ? event.errors.filter((value): value is string => typeof value === "string")
      : [];

    getDb().prepare(
      `INSERT INTO console_session_usage (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      id,
      typeof event.session_id === "string" ? event.session_id : null,
      Date.now(),
      readNumber(usage.input_tokens),
      readNumber(usage.cache_creation_input_tokens),
      readNumber(usage.cache_read_input_tokens),
      readNumber(usage.output_tokens),
      readNumber(usage.web_search_requests),
      readNumber(usage.cost_usd),
      readNumber(event.total_cost_usd),
      readNumber(event.duration_ms),
      readNumber(event.num_turns),
      event.is_error === true ? 1 : 0,
      typeof event.subtype === "string" ? event.subtype : null,
      JSON.stringify(usage),
      JSON.stringify(modelUsage),
      JSON.stringify(errors),
    );
  }

  private requireSession(id: string): AgenticBackend {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`session not found: ${id}`);
    }
    return session;
  }

  private isPermissionAwareBackend(backend: AgenticBackend): backend is AgenticBackend & PermissionAwareBackend {
    return "getPendingPermissions" in backend && "resolvePermission" in backend;
  }

  private isConfigurableBackend<TOptions>(backend: AgenticBackend): backend is AgenticBackend & ConfigurableBackend<TOptions> {
    return "updateOptions" in backend;
  }

  private isUsageAwareBackend<TUsage>(backend: AgenticBackend): backend is AgenticBackend & UsageAwareBackend<TUsage> {
    return "getUsage" in backend;
  }
}
