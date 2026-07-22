import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type {
  AgenticBackend,
  BackendMetaUpdate,
  BackendStatusEvent,
  BackendType,
  ConfigurableBackend,
  CancellablePromptBackend,
  PermissionAwareBackend,
  PermissionDecision,
  PermissionRequest,
  UsageAwareBackend,
} from "./agentic-backend.js";
import { getDb, type Db } from "./db.js";
import { SessionRegistry } from "./registry.js";
import { broadcast } from "./sse.js";
import { PTYBackend } from "./backends/pty-backend.js";
import { SDKBackend, type SDKBackendOptions } from "./backends/sdk-backend.js";
import { SpawnBackend } from "./backends/spawn-backend.js";
import { AcpBackend, type AcpBackendOptions } from "./backends/acp-backend.js";
import { bridgeChannelEvents, type ChannelBridgeHandle } from "./channel-event-bridge.js";
import {
  defaultCodexThreadArchiver,
  safeUnarchiveCodexThread,
  type CodexThreadArchiver,
} from "./codex-thread-archive.js";
import type {
  ConsoleAttentionState,
  ConsoleInteractionMode,
  ConsoleSession,
  ConsoleSessionInput,
  ConsoleSessionStatus,
  ConsoleStreamEvent,
  ConsoleTransportBadge,
  ConsoleTransportLane,
  Logger,
} from "./types.js";
import { replaceSessionInstructionArtifacts } from "./presets.js";
import type { ClientAuthenticator } from "./client-auth/authenticator.js";
import { getOperator } from "./users/store.js";

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
  transport_lane: string | null;
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
  transport_lane: "sdk",
};

export const TERMINAL_BACKEND_RETENTION_LIMIT = 64;

export interface SessionClientIdentity {
  user_id: string;
  slug: string;
}

/**
 * Resolve the identity a Mandible-owned agent process is allowed to use.
 * Operator consoles bind only to the configured operator. Other agents require
 * exactly one active app_name binding for their command; zero or ambiguous
 * bindings deliberately produce no credential instead of falling back to the
 * operator or daemon-launching caller.
 */
export function resolveSessionClientIdentity(
  db: Db,
  session: Pick<ConsoleSession, "id" | "command" | "is_operator">,
  { allowUnpersistedOperator = false }: { allowUnpersistedOperator?: boolean } = {},
): SessionClientIdentity | null {
  if (session.is_operator) {
    const canonical = db.prepare(
      "SELECT value FROM settings WHERE key = 'console_operator_session_id'",
    ).get() as { value: string } | undefined;
    if (!allowUnpersistedOperator && canonical?.value !== session.id) return null;
    const operator = getOperator(db);
    return operator ? { user_id: operator.id, slug: operator.slug } : null;
  }
  const matches = db.prepare(
    `SELECT DISTINCT u.id, u.slug
       FROM user_bindings b
       JOIN users u ON u.id = b.user_id
      WHERE b.binding_type = 'app_name'
        AND b.status = 'active'
        AND u.status = 'active'
        AND lower(b.value) = lower(?)
      ORDER BY u.id`,
  ).all(session.command) as Array<{ id: string; slug: string }>;
  if (matches.length !== 1) return null;
  return { user_id: matches[0].id, slug: matches[0].slug };
}

/**
 * Lightweight metadata holder for a backend whose process, terminal ring, and
 * diagnostic logs have been evicted. SessionManager transparently rehydrates
 * it before any id-based operation, while list APIs keep returning every row.
 */
class DormantBackend extends EventEmitter implements AgenticBackend {
  readonly id: string;
  meta: ConsoleSession;

  constructor(meta: ConsoleSession) {
    super();
    this.id = meta.id;
    this.meta = { ...meta };
  }

  start(): void {}
  stop(): void {}
  destroy(): void { this.removeAllListeners(); }
  clear(): void {}
  sendPrompt(): void {}
  write(): void {}
  resize(): void {}
  addWsClient(): void {}
  removeWsClient(): void {}
  getBufferSnapshot(): Buffer { return Buffer.alloc(0); }
  getStreamEvents(): ConsoleStreamEvent[] { return []; }
  ingestStructuredEvent(): void {}
  ingestText(): void {}
}

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
  if (command === "claude") return "pty";
  if (command === "gemini" || command === "codex") return "acp";
  // Shell and unknown commands need interactive terminal (SpawnBackend can't
  // execute arbitrary commands — buildPromptInvocation returns null for them)
  return "pty";
}

function isTransportLane(value: unknown): value is ConsoleTransportLane {
  return value === "sdk"
    || value === "pty"
    || value === "channel"
    || value === "acp"
    || value === "spawn";
}

function transportLaneBadge(lane: ConsoleTransportLane): ConsoleTransportBadge {
  if (lane === "sdk") {
    return { label: "SDK", title: "Agent SDK transport" };
  }
  if (lane === "channel") {
    return { label: "Channel", title: "PTY transport with Mandible channel integration" };
  }
  if (lane === "acp") {
    return { label: "ACP", title: "Agent Client Protocol transport" };
  }
  if (lane === "spawn") {
    return { label: "Spawn", title: "Spawned process transport" };
  }
  return { label: "PTY", title: "Mandible-owned PTY transport" };
}

function deriveTransportLane(
  command: string,
  backendType: BackendType,
  channelEnabled: boolean,
): ConsoleTransportLane {
  if (channelEnabled) return "channel";
  if (backendType === "sdk") return "sdk";
  if (backendType === "acp") return "acp";
  if (backendType === "spawn") return "spawn";
  if (command === "gemini" || command === "codex") return "acp";
  return "pty";
}

function normalizeTransportSelection(input: {
  command: string;
  backend_type?: BackendType;
  transport_lane?: ConsoleTransportLane;
  channel_enabled?: boolean;
}): { backend_type: BackendType; transport_lane: ConsoleTransportLane; channel_enabled: boolean } {
  const requestedLane = isTransportLane(input.transport_lane) ? input.transport_lane : null;
  let lane = requestedLane;
  let backendType = input.backend_type ?? defaultBackendType(input.command);
  let channelEnabled = input.channel_enabled === true;

  if (!lane) {
    lane = deriveTransportLane(input.command, backendType, channelEnabled);
    if (lane === "channel") {
      backendType = "pty";
      channelEnabled = true;
    }
    return { backend_type: backendType, transport_lane: lane, channel_enabled: channelEnabled };
  }

  if (lane === "channel") {
    return { backend_type: "pty", transport_lane: "channel", channel_enabled: true };
  }
  if (lane === "sdk") {
    return { backend_type: "sdk", transport_lane: "sdk", channel_enabled: false };
  }
  if (lane === "acp") {
    return { backend_type: "acp", transport_lane: "acp", channel_enabled: false };
  }
  if (lane === "spawn") {
    return { backend_type: "spawn", transport_lane: "spawn", channel_enabled: false };
  }

  return { backend_type: "pty", transport_lane: "pty", channel_enabled: false };
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
  const backend_type = (row.backend_type === "sdk"
    ? "sdk"
    : row.backend_type === "spawn"
      ? "spawn"
      : row.backend_type === "acp"
        ? "acp"
        : "pty") as BackendType;
  const transport_lane = isTransportLane(row.transport_lane)
    ? row.transport_lane
    : deriveTransportLane(row.command, backend_type, Boolean(row.channel_enabled));
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
    backend_type,
    transport_lane,
    transport_badge: transportLaneBadge(transport_lane),
    allowed_tools: parseAllowedTools(row.allowed_tools),
    mandible_session_id: row.mandible_session_id ?? null,
    resume_at_message: row.resume_at_message ?? null,
    channel_enabled: transport_lane === "channel" || Boolean(row.channel_enabled),
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
  // Bug: 7ab2f3e — Track channel bridge handles for cleanup
  private channelBridges: Map<string, ChannelBridgeHandle> = new Map();
  private logger: Logger;
  private sessionRegistry: SessionRegistry | null;
  private codexThreadArchiver: CodexThreadArchiver;
  private clientAuth: ClientAuthenticator | null;
  private clientTokens = new Map<string, string>();

  constructor(
    _db: unknown,
    logger: Logger,
    sessionRegistry?: SessionRegistry,
    codexThreadArchiver: CodexThreadArchiver = defaultCodexThreadArchiver,
    clientAuth?: ClientAuthenticator,
  ) {
    this.logger = logger;
    this.sessionRegistry = sessionRegistry ?? null;
    this.codexThreadArchiver = codexThreadArchiver;
    this.clientAuth = clientAuth ?? null;
  }

  init(): void {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM console_sessions")
      .all() as ConsoleSessionRow[];

    const retainedTerminalIds = new Set(
      rows
        .filter((row) => row.status !== "running")
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, TERMINAL_BACKEND_RETENTION_LIMIT)
        .map((row) => row.id),
    );

    for (const row of rows) {
      const session = rowToSession(row);
      if (session.status !== "running" && !retainedTerminalIds.has(session.id)) {
        this.sessions.set(session.id, new DormantBackend(session));
        continue;
      }
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

    this.evictExcessTerminalBackends();

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

  create(
    input: ConsoleSessionInput,
    { allowOperator = false }: { allowOperator?: boolean } = {},
  ): ConsoleSession {
    if (input.is_operator && !allowOperator) {
      throw new Error("Operator sessions may only be created by SessionManager.startOperator().");
    }
    const db = getDb();
    const id = randomUUID();
    const now = Date.now();

    const args = input.args ?? [];
    const env = { ...(input.env ?? {}) };
    // Raw daemon credentials are never persisted in console_sessions. A fresh
    // token is provisioned from the resolved agent-user binding below.
    delete env.MANDIBLE_TOKEN;
    const cols = input.cols ?? 120;
    const rows = input.rows ?? 30;
    const auto_restart = input.auto_restart ? 1 : 0;
    const is_operator = input.is_operator ? 1 : 0;
    const interaction_mode = input.interaction_mode ?? "both";
    const selection = normalizeTransportSelection(input);
    const backend_type = selection.backend_type;
    const transport_lane = selection.transport_lane;
    const allowed_tools = input.allowed_tools ?? null;

    const provider_session_id = input.provider_session_id ?? null;
    const resume_at_message = input.resume_at_message ?? null;
    const channel_enabled = selection.channel_enabled ? 1 : 0;

    this.unarchiveCodexThread(input.command, provider_session_id);

    db.prepare(
      `INSERT INTO console_sessions
         (id, label, command, args_json, provider_session_id, cwd, env_json, cols, rows,
          status, auto_restart, is_operator, interaction_mode, created_at, updated_at,
          backend_type, allowed_tools, mandible_session_id, resume_at_message, channel_enabled,
          transport_lane)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      channel_enabled,
      transport_lane
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
      transport_lane,
    });

    // Issue 2181ffd — Store instruction attachments as pinned artifact versions.
    if (input.presetIds && input.presetIds.length > 0) {
      replaceSessionInstructionArtifacts(db, id, input.presetIds);
    }

    const backend = this.createBackend(session, backend_type, { allowUnpersistedOperator: allowOperator });

    // Bug: 61bee4e — If presetIds are set, update the SDK backend options
    if (input.presetIds && input.presetIds.length > 0 && backend instanceof SDKBackend) {
      backend.updateOptions({ presetIds: input.presetIds });
    }

    // Bug: 790433d — If presetIds are set on a PTY session, pass them so the
    // preset union is appended at launch via --append-system-prompt
    if (input.presetIds && input.presetIds.length > 0 && backend instanceof PTYBackend) {
      backend.setPresetIds(input.presetIds);
    }

    this.sessions.set(id, backend);
    this.wireBackend(backend);
    this.evictExcessTerminalBackends(id);

    broadcast("console:session:created", { session });
    return session;
  }

  get(id: string): AgenticBackend | undefined {
    const existing = this.sessions.get(id);
    if (!existing || !(existing instanceof DormantBackend)) {
      return existing;
    }
    const backend = this.createBackend(existing.meta, existing.meta.backend_type);
    this.sessions.set(id, backend);
    this.wireBackend(backend);
    this.evictExcessTerminalBackends(id);
    return backend;
  }

  getAll(): AgenticBackend[] {
    return Array.from(this.sessions.values());
  }

  getRetentionStats(): { retainedTerminal: number; dormant: number } {
    let retainedTerminal = 0;
    let dormant = 0;
    for (const backend of this.sessions.values()) {
      if (backend instanceof DormantBackend) {
        dormant += 1;
      } else if (backend.meta.status !== "running") {
        retainedTerminal += 1;
      }
    }
    return { retainedTerminal, dormant };
  }

  start(id: string): void {
    const session = this.requireSession(id);
    this.unarchiveCodexThread(session.meta.command, session.meta.provider_session_id);
    session.start();
  }

  stop(id: string, signal?: string): void {
    this.requireSession(id).stop(signal);
  }

  delete(id: string): void {
    const session = this.requireSession(id);
    session.destroy();
    // Bug: 7ab2f3e — Clean up channel bridge if present
    const bridge = this.channelBridges.get(id);
    if (bridge) {
      bridge.dispose();
      this.channelBridges.delete(id);
    }
    getDb().prepare("DELETE FROM console_sessions WHERE id = ?").run(id);
    this.sessions.delete(id);
    this.revokeClientToken(id);
    broadcast("console:session:deleted", { id });
  }

  resize(id: string, cols: number, rows: number): void {
    this.requireSession(id).resize(cols, rows);
  }

  write(id: string, data: string): void {
    this.requireSession(id).write(data);
  }

  sendPrompt(id: string, prompt: string): void {
    const session = this.requireSession(id);
    this.unarchiveCodexThread(session.meta.command, session.meta.provider_session_id);
    session.sendPrompt(prompt);
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

  updateOptions(id: string, options: SDKBackendOptions | AcpBackendOptions): ConsoleSession {
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
    if (this.isConfigurableBackend<SDKBackendOptions | AcpBackendOptions>(session)) {
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

  cancelPrompt(id: string): boolean {
    const session = this.requireSession(id);
    if (this.isCancellablePromptBackend(session)) {
      return session.cancelActivePrompt();
    }
    return false;
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
    }, { allowOperator: true });

    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run("console_operator_session_id", session.id, Date.now());

    this.start(session.id);
  }

  close(): void {
    // Bug: 7ab2f3e — Dispose all channel bridges before destroying sessions
    for (const bridge of this.channelBridges.values()) {
      try {
        bridge.dispose();
      } catch {
        // Best effort
      }
    }
    this.channelBridges.clear();

    for (const session of this.sessions.values()) {
      try {
        session.destroy();
      } catch {
        // Best effort
      }
    }
    for (const id of this.clientTokens.keys()) this.revokeClientToken(id);
  }

  private createBackend(
    session: ConsoleSession,
    type: BackendType,
    options: { allowUnpersistedOperator?: boolean } = {},
  ): AgenticBackend {
    // The operator bootstrap file is a one-time human/Tauri enrollment proof.
    // Remove it before constructing any non-operator backend so an agent under
    // the same OS uid can never read or race that credential directly.
    if (!session.is_operator) this.clientAuth?.revokeOperatorBootstrap?.();
    const token = () => this.clientTokenFor(session, options);
    if (type === "sdk") {
      return new SDKBackend(session, this.logger, this.sessionRegistry ?? undefined, token);
    }
    if (type === "spawn") {
      return new SpawnBackend(session, this.logger, token);
    }
    if (type === "acp") {
      return new AcpBackend(session, this.logger, token);
    }
    return new PTYBackend(session, this.logger, token);
  }

  private clientTokenFor(
    session: ConsoleSession,
    options: { allowUnpersistedOperator?: boolean } = {},
  ): string | null {
    if (!this.clientAuth) return null;
    const existing = this.clientTokens.get(session.id);
    if (existing) {
      if (this.clientAuth.authenticate(existing, "in_process")) return existing;
      this.clientTokens.delete(session.id);
    }
    const identity = resolveSessionClientIdentity(getDb(), session, options);
    if (!identity) {
      if (this.clientAuth.mode() === "strict") {
        this.logger("warn", "client_auth_agent_identity_unresolved", {
          session_id: session.id,
          command: session.command,
        });
      }
      return null;
    }
    const token = this.clientAuth.issueEphemeralToken(
      identity,
      `agent_session:${session.id}`,
      { ttlMs: null },
    );
    this.clientTokens.set(session.id, token);
    return token;
  }

  private revokeClientToken(id: string): void {
    const token = this.clientTokens.get(id);
    if (!token) return;
    this.clientTokens.delete(id);
    this.clientAuth?.revokeEphemeralToken(token);
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

    backend.on("attention", (attention: ConsoleAttentionState | null) => {
      backend.meta = {
        ...backend.meta,
        attention: attention?.active ? attention : null,
      };
      broadcast("console:attention", {
        console_session_id: backend.id,
        attention,
      });
      broadcast("console:session:updated", { session: backend.meta });
    });

    backend.on("prompt_queue", () => {
      broadcast("console:session:updated", { session: backend.meta });
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

    backend.on("permission_cleared", (event: { request_id: string }) => {
      broadcast("console:permission:cleared", {
        console_session_id: backend.id,
        request_id: event.request_id,
      });
    });

    // Bug: 7ab2f3e — Wire channel event bridge for PTY backends with a
    // mandible_session_id. The bridge listens for ChannelRegistry events
    // and injects them into the backend's stream. Handles late registration
    // (channel session may not exist yet when the PTY starts) with a 30s
    // timeout. Non-channel PTY sessions are unaffected — the bridge simply
    // never receives events for their session ID.
    if (backend instanceof PTYBackend && backend.meta.mandible_session_id) {
      const handle = bridgeChannelEvents(
        backend,
        backend.meta.mandible_session_id,
        this.logger,
      );
      this.channelBridges.set(backend.id, handle);
    }
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
      this.evictExcessTerminalBackends(id);
      return;
    }
    broadcast("console:session:exit", {
      id,
      exitCode: event.exitCode ?? null,
      signal: event.signal ?? null,
      status: event.status,
    });
    this.evictExcessTerminalBackends(id);
  }

  private evictExcessTerminalBackends(excludeId?: string): void {
    const retained = Array.from(this.sessions.values())
      .filter((backend) => !(backend instanceof DormantBackend) && backend.meta.status !== "running")
      .sort((a, b) => a.meta.updated_at - b.meta.updated_at);

    while (retained.length > TERMINAL_BACKEND_RETENTION_LIMIT) {
      const index = retained.findIndex((backend) => backend.id !== excludeId);
      if (index === -1) return;
      const [backend] = retained.splice(index, 1);
      const bridge = this.channelBridges.get(backend.id);
      if (bridge) {
        try {
          bridge.dispose();
        } catch {
          // Best effort
        }
        this.channelBridges.delete(backend.id);
      }
      const meta = { ...backend.meta };
      backend.destroy();
      this.sessions.set(backend.id, new DormantBackend(meta));
    }
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

  private unarchiveCodexThread(command: string, providerSessionId: string | null): void {
    if (command !== "codex" || !providerSessionId) {
      return;
    }
    safeUnarchiveCodexThread(this.codexThreadArchiver, providerSessionId, (message) => {
      this.logger("warn", "codex_thread_unarchive_failed", { message, provider_session_id: providerSessionId });
    });
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

  private isCancellablePromptBackend(backend: AgenticBackend): backend is AgenticBackend & CancellablePromptBackend {
    return "cancelActivePrompt" in backend;
  }
}
