import { DOMAIN_EVENTS } from "./contracts.js";
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
  ToolPolicyBackend,
} from "./agentic-backend.js";
import { getDb, type Db } from "./db.js";
import {
  assertClaudeLaneAllowed,
  ClaudeLaneDisabledError,
  DEFAULT_CLAUDE_BACKEND_TYPE,
  describeAnthropicBilling,
  isClaudeCommand,
} from "./claude-lane-policy.js";
import { SessionRegistry } from "./registry.js";
import { broadcast } from "./sse.js";
import { PTYBackend } from "./backends/pty-backend.js";
import { SDKBackend, getSdkRunOptionDeclaration, type SDKBackendOptions } from "./backends/sdk-backend.js";
import { SpawnBackend } from "./backends/spawn-backend.js";
import { AcpBackend, getAcpRunOptionDeclaration } from "./backends/acp-backend.js";
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
import type { ClientAuthenticator } from "./client-auth/authenticator.js";
import { getOperator } from "./users/store.js";
import { resolveSessionOwnerUserId } from "./session-ownership.js";
import { AttributionReadResolver } from "./identity/read-projection.js";
import {
  declaredRunOptionsSnapshot,
  type AppliedSessionRunOption,
  type BackendRunOptionDeclaration,
  type SessionRunOptionValue,
  type SessionRunOptionsSnapshot,
} from "./session-run-options.js";
import {
  ProviderStartupError,
  normalizeProviderStartupError,
  type ProviderStartupProvenance,
} from "./provider-startup.js";
import { ConversationSpawnService } from "./conversation-spawn/service.js";

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
  run_options_json: string;
  mandible_session_id: string | null;
  resume_at_message: string | null;
  channel_enabled: number;
  transport_lane: string | null;
  owner_user_id: string | null;
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

// Issue 8aadf70 — the operator console runs on the SDK lane with the default
// permission posture. `--dangerously-skip-permissions` is no longer a shipped
// default: SDK sessions gate through `canUseTool` and Mandible's permission
// cards, and an operator who wants to bypass sets `permissionMode` explicitly
// on the session via `PATCH /api/console/sessions/:id/options`.
const OPERATOR_DEFAULTS: Omit<ConsoleSessionInput, "label"> = {
  command: "claude",
  args: [],
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
  // Issue 8aadf70 — Claude defaults to the Agent SDK lane, the documented
  // embedding surface. The Mandible-owned Claude PTY lane is local-only and
  // gated behind `claude_pty_lane_enabled`; it is never a default.
  if (command === "claude") return DEFAULT_CLAUDE_BACKEND_TYPE;
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

function parseRunOptions(raw: string | null | undefined): Record<string, SessionRunOptionValue> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, SessionRunOptionValue>
      : {};
  } catch { return {}; }
}

function rowToSession(
  row: ConsoleSessionRow,
  attributionResolver: AttributionReadResolver,
): ConsoleSession {
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
  const sessionEnv = JSON.parse(row.env_json) as Record<string, string>;
  return {
    id: row.id,
    label: row.label,
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    provider_session_id: row.provider_session_id ?? null,
    cwd: row.cwd,
    env: sessionEnv,
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
    run_options: parseRunOptions(row.run_options_json),
    mandible_session_id: row.mandible_session_id ?? null,
    resume_at_message: row.resume_at_message ?? null,
    channel_enabled: transport_lane === "channel" || Boolean(row.channel_enabled),
    agent_type: computeAgentType(row.command, is_operator),
    // Issue 8aadf70 — never let API-key vs subscription billing be a silent
    // inheritance of the daemon environment. Derived at read time (the daemon
    // env can change between restarts), not persisted.
    anthropic_billing: isClaudeCommand(row.command)
      ? describeAnthropicBilling({ ...process.env, ...sessionEnv })
      : null,
    owner_user_id: row.owner_user_id ?? null,
    owner: attributionResolver.user(row.owner_user_id),
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
  // Credential eligibility and identity are pinned when a session backend is
  // constructed. Binding edits must never turn previously admitted plain work
  // into credential-bearing work (or create a temporary unbound auth window).
  private clientIdentities = new Map<string, SessionClientIdentity | null>();
  private initialRunOptionApplications = new Map<string, Promise<SessionRunOptionsSnapshot>>();

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

  init({ readOnly = false }: { readOnly?: boolean } = {}): void {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM console_sessions")
      .all() as ConsoleSessionRow[];

    if (readOnly) {
      const attributionResolver = new AttributionReadResolver(db);
      for (const row of rows) {
        const session = rowToSession(row, attributionResolver);
        this.pinClientIdentity(session);
        this.sessions.set(session.id, new DormantBackend(session));
      }
      return;
    }

    const retainedTerminalIds = new Set(
      rows
        .filter((row) => row.status !== "running")
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, TERMINAL_BACKEND_RETENTION_LIMIT)
        .map((row) => row.id),
    );

    const attributionResolver = new AttributionReadResolver(db);
    for (const row of rows) {
      const session = rowToSession(row, attributionResolver);
      this.pinClientIdentity(session);
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
        try {
          backend.start();
        } catch (error) {
          // Issue 8aadf70 — an operator console recorded on the old Claude PTY
          // default must not take daemon startup down when the lane is off. Leave
          // it stopped and say why; the operator can recreate it on the SDK lane.
          if (error instanceof ClaudeLaneDisabledError) {
            this.logger("warn", "operator_auto_start_skipped", {
              id: operatorRow.id,
              reason: error.code,
              message: error.message,
            });
          } else {
            throw error;
          }
        }
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
    const id = input.id ?? randomUUID();
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
    // Issue 8aadf70 — the Claude PTY/Channel lane is local-only and off by
    // default. Reject before anything is persisted so a disabled lane never
    // leaves a half-created session row behind.
    assertClaudeLaneAllowed(input.command, selection.backend_type, db);
    const backend_type = selection.backend_type;
    const transport_lane = selection.transport_lane;
    const allowed_tools = input.allowed_tools ?? null;

    const provider_session_id = input.provider_session_id ?? null;
    const resume_at_message = input.resume_at_message ?? null;
    const channel_enabled = selection.channel_enabled ? 1 : 0;
    const operator = input.is_operator ? getOperator(db) : null;
    const ownerUserId = resolveSessionOwnerUserId(
      db,
      {
        explicit_user_id: operator?.id ?? null,
        app_names: input.is_operator ? [] : [input.command],
      },
      this.logger,
      { source: "console_session", entity_id: id },
    );

    this.unarchiveCodexThread(input.command, provider_session_id);

    db.prepare(
      `INSERT INTO console_sessions
         (id, label, command, args_json, provider_session_id, cwd, env_json, cols, rows,
          status, auto_restart, is_operator, interaction_mode, created_at, updated_at,
          backend_type, allowed_tools, mandible_session_id, resume_at_message, channel_enabled,
          transport_lane, owner_user_id, run_options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      transport_lane,
      ownerUserId,
      JSON.stringify({}),
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
      owner_user_id: ownerUserId,
      run_options_json: JSON.stringify({}),
    }, new AttributionReadResolver(db));

    const backend = this.createBackend(session, backend_type, { allowUnpersistedOperator: allowOperator });

    this.sessions.set(id, backend);
    this.wireBackend(backend);
    this.evictExcessTerminalBackends(id);

    if (input.runOptions && Object.keys(input.runOptions).length > 0 && this.isConfigurableBackend(backend)) {
      const promise = backend.applyRunOptions({ values: input.runOptions }, { phase: "initial" })
        .then((result) => {
          this.persistAppliedRunOptions(id, result.applied);
          return result.snapshot;
        });
      this.initialRunOptionApplications.set(id, promise);
      void promise.finally(() => this.initialRunOptionApplications.delete(id)).catch(() => undefined);
    }

    broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_CREATED, { session });
    return session;
  }

  async waitForInitialRunOptions(id: string): Promise<SessionRunOptionsSnapshot> {
    const pending = this.initialRunOptionApplications.get(id);
    if (pending) return pending;
    return this.getRunOptions(id);
  }

  async startConversation(
    id: string,
    options: { timeoutMs: number; signal?: AbortSignal; provenance?: ProviderStartupProvenance },
  ): Promise<{ provider_session_id: string | null; provenance: ProviderStartupProvenance }> {
    const provenance = options.provenance ?? this.getStartupProvenance(id);
    const backend = this.requireSession(id);
    const readinessController = new AbortController();
    let phase: ProviderStartupError["phase"] = "configuration";
    const abortReadiness = () => {
      if (!readinessController.signal.aborted) {
        readinessController.abort(new ProviderStartupError(
          "client_aborted",
          "The client disconnected during provider startup.",
          phase,
        ));
      }
    };
    options.signal?.addEventListener("abort", abortReadiness, { once: true });
    if (options.signal?.aborted) abortReadiness();
    const timeout = setTimeout(() => {
      if (!readinessController.signal.aborted) {
        readinessController.abort(new ProviderStartupError(
          "provider_startup_timeout",
          "The provider did not become ready before the startup deadline.",
          phase,
        ));
      }
    }, Math.max(0, options.timeoutMs));
    const providerSession = backend.prepare
      ? null
      : this.waitForProviderSession(id, readinessController.signal).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    try {
      if (readinessController.signal.aborted) {
        throw this.startupAbortError(readinessController.signal, phase);
      }
      this.start(id);
      await this.awaitStartupStep(
        this.waitForInitialRunOptions(id),
        readinessController.signal,
        "configuration",
      );
      phase = "readiness";
      if (backend.prepare) {
        await this.awaitStartupStep(
          backend.prepare(readinessController.signal),
          readinessController.signal,
          "readiness",
        );
        return { provider_session_id: null, provenance };
      }
      const providerSessionResult = await providerSession!;
      if (!providerSessionResult.ok) throw providerSessionResult.error;
      return { provider_session_id: providerSessionResult.value, provenance };
    } catch (error) {
      if (!readinessController.signal.aborted) {
        readinessController.abort(normalizeProviderStartupError(error, phase));
      }
      if (providerSession) await providerSession;
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortReadiness);
    }
  }

  getStartupProvenance(id: string): ProviderStartupProvenance {
    const backend = this.get(id);
    if (!backend) {
      throw new ProviderStartupError(
        "provider_startup_failed",
        "The reserved provider session is no longer available.",
        "configuration",
      );
    }
    try {
      if (!backend.getStartupProvenance) {
        throw new Error(`Backend ${backend.meta.backend_type} does not declare startup provenance`);
      }
      return backend.getStartupProvenance();
    } catch (error) {
      this.logger("error", "provider_startup_provenance_failed", { id, error: String(error) });
      throw new ProviderStartupError(
        "provider_startup_failed",
        "The selected provider implementation could not be resolved.",
        "configuration",
      );
    }
  }

  private awaitStartupStep<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    phase: "configuration" | "readiness",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(this.startupAbortError(signal, phase));
        return;
      }
      const onAbort = () => {
        cleanup();
        reject(this.startupAbortError(signal, phase));
      };
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => { cleanup(); resolve(value); },
        (error) => { cleanup(); reject(normalizeProviderStartupError(error, phase)); },
      );
    });
  }

  private waitForProviderSession(
    id: string,
    signal: AbortSignal,
  ): Promise<string> {
    const backend = this.requireSession(id);
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        backend.removeListener("meta_update", onMetaUpdate);
        backend.removeListener("status", onStatus);
        backend.removeListener("startup_error", onStartupError);
      };
      const settleValue = (value: string) => { cleanup(); resolve(value); };
      const settleError = (error: ProviderStartupError) => { cleanup(); reject(error); };
      const onMetaUpdate = (fields: BackendMetaUpdate) => {
        const providerSessionId = fields.provider_session_id?.trim()
          || backend.meta.provider_session_id?.trim();
        if (!providerSessionId) return;
        settleValue(providerSessionId);
      };
      const onStatus = (event: BackendStatusEvent) => {
        if (event.status !== "crashed" && event.status !== "stopped") return;
        settleError(new ProviderStartupError(
          "provider_exited_before_ready",
          "The provider exited before its native conversation was ready.",
          "readiness",
        ));
      };
      const onStartupError = (error: unknown) => {
        settleError(normalizeProviderStartupError(error));
      };
      const onAbort = () => settleError(this.startupAbortError(signal, "readiness"));
      backend.on("meta_update", onMetaUpdate);
      backend.on("status", onStatus);
      backend.on("startup_error", onStartupError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else onMetaUpdate({});
    });
  }

  private startupAbortError(signal: AbortSignal, phase: ProviderStartupError["phase"]): ProviderStartupError {
    return signal.reason instanceof ProviderStartupError
      ? signal.reason
      : new ProviderStartupError("client_aborted", "The client disconnected during provider startup.", phase);
  }

  describeRunOptions(backendType: BackendType, command: string): SessionRunOptionsSnapshot {
    return declaredRunOptionsSnapshot(this.describeRunOptionDeclaration(backendType, command));
  }

  describeRunOptionDeclaration(backendType: BackendType, command: string): BackendRunOptionDeclaration {
    return backendType === "acp"
      ? getAcpRunOptionDeclaration(command)
      : backendType === "sdk"
        ? getSdkRunOptionDeclaration(command)
        : { backendType, command, options: [] };
  }

  getRunOptions(id: string): SessionRunOptionsSnapshot {
    const backend = this.requireSession(id);
    return this.isConfigurableBackend(backend)
      ? backend.getRunOptions()
      : declaredRunOptionsSnapshot({ backendType: backend.meta.backend_type, command: backend.meta.command, options: [] });
  }

  getSessionOptionsControls(id: string): { allowedTools: string[] | null } {
    const backend = this.requireSession(id);
    return { allowedTools: backend.meta.allowed_tools };
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

  /** Whether controlling this session can activate its pinned client credential. */
  isCredentialBearing(id: string): boolean {
    const session = this.sessions.get(id)?.meta;
    if (!session) return false;
    if (session.is_operator) return true;
    this.pinClientIdentity(session);
    return this.clientIdentities.get(id) !== null;
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
    this.clientIdentities.delete(id);
    broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_DELETED, { id });
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
      broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_UPDATED, { session: nextMeta });
    }
    return nextMeta;
  }

  async updateOptions(
    id: string,
    options: {
      runOptions?: Record<string, SessionRunOptionValue>;
      allowedTools?: string[];
      model?: string;
      thinkingEffort?: SDKBackendOptions["thinkingEffort"];
      permissionMode?: SDKBackendOptions["permissionMode"];
      maxTurns?: number;
      maxCostUsd?: number;
      systemPrompt?: string;
      settingSourcesOverride?: string[];
    },
  ): Promise<{
    session: ConsoleSession;
    runOptions: SessionRunOptionsSnapshot;
    applied: readonly AppliedSessionRunOption[];
    mandibleControls: { allowedTools: string[] | null };
  }> {
    const session = this.requireSession(id);
    if (options.allowedTools !== undefined && this.isToolPolicyBackend(session)) {
      await session.setAllowedTools(options.allowedTools);
    }
    const values: Record<string, SessionRunOptionValue> = { ...(options.runOptions ?? {}) };
    if (options.model !== undefined) values.model = options.model;
    if (session.meta.backend_type === "sdk") {
      if (options.thinkingEffort !== undefined) values.thinking_effort = options.thinkingEffort ?? null;
      if (options.permissionMode !== undefined) values.permission_mode = options.permissionMode;
      if (options.maxTurns !== undefined) values.max_turns = options.maxTurns;
      if (options.maxCostUsd !== undefined) values.max_cost_usd = options.maxCostUsd;
      if (options.systemPrompt !== undefined) values.system_prompt = options.systemPrompt;
      if (options.settingSourcesOverride !== undefined) values.setting_sources = options.settingSourcesOverride;
    }
    let applied: readonly AppliedSessionRunOption[] = [];
    let snapshot = this.getRunOptions(id);
    if (Object.keys(values).length > 0) {
      if (!this.isConfigurableBackend(session)) {
        throw new Error(`unsupported_session_option:*:${session.meta.backend_type}/${session.meta.command}`);
      }
      const result = await session.applyRunOptions({ values }, { phase: "runtime" });
      applied = result.applied;
      snapshot = result.snapshot;
      this.persistAppliedRunOptions(id, applied);
    }
    const nextSession = this.requireSession(id).meta;
    broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_UPDATED, { session: nextSession });
    return {
      session: nextSession,
      runOptions: snapshot,
      applied,
      mandibleControls: this.getSessionOptionsControls(id),
    };
  }

  private persistAppliedRunOptions(id: string, applied: readonly AppliedSessionRunOption[]): void {
    if (applied.length === 0) return;
    const backend = this.requireSession(id);
    const runOptions = { ...backend.meta.run_options };
    for (const option of applied) runOptions[option.id] = option.currentValue;
    let args = backend.meta.args;
    const model = applied.find((option) => option.id === "model");
    if (model) {
      args = stripModelArgs(args);
      if (typeof model.currentValue === "string" && model.currentValue.trim()) {
        args.push("--model", model.currentValue.trim());
      }
    }
    backend.meta = { ...backend.meta, run_options: runOptions, args, updated_at: Date.now() };
    getDb().prepare(
      "UPDATE console_sessions SET run_options_json = ?, args_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(runOptions), JSON.stringify(args), backend.meta.updated_at, id);
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
    this.clientIdentities.clear();
  }

  private createBackend(
    session: ConsoleSession,
    type: BackendType,
    options: { allowUnpersistedOperator?: boolean } = {},
  ): AgenticBackend {
    this.pinClientIdentity(session, options);
    // Issue 8aadf70 — surface, never silently inherit, the Anthropic billing
    // path a Claude session will run on. `warn` for the API-key case because it
    // spends money outside the operator's subscription.
    if (isClaudeCommand(session.command)) {
      const billing = session.anthropic_billing
        ?? describeAnthropicBilling({ ...process.env, ...session.env });
      this.logger(billing.mode === "api_key" ? "warn" : "info", "claude_session_billing", {
        id: session.id,
        backend_type: type,
        billing_mode: billing.mode,
        billing_source: billing.source,
        note: billing.note,
      });
    }
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
    this.pinClientIdentity(session, options);
    const identity = this.clientIdentities.get(session.id) ?? null;
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

  private pinClientIdentity(
    session: ConsoleSession,
    options: { allowUnpersistedOperator?: boolean } = {},
  ): void {
    if (this.clientIdentities.has(session.id)) return;
    this.clientIdentities.set(
      session.id,
      resolveSessionClientIdentity(getDb(), session, options),
    );
  }

  private revokeClientToken(id: string): void {
    const token = this.clientTokens.get(id);
    if (!token) return;
    this.clientTokens.delete(id);
    this.clientAuth?.revokeEphemeralToken(token);
  }

  private wireBackend(backend: AgenticBackend): void {
    backend.on("stream_event", (event: ConsoleStreamEvent) => {
      broadcast(DOMAIN_EVENTS.CONSOLE_STREAM_EVENT, {
        console_session_id: backend.id,
        event,
      });
      if (event.type === "system" && event.subtype === "subagent_start") {
        broadcast(DOMAIN_EVENTS.CONSOLE_SUBAGENT_START, {
          console_session_id: backend.id,
          agent_id: event.agent_id,
          agent_type: event.agent_type,
          session_id: event.session_id,
          event,
        });
      }
      if (event.type === "system" && event.subtype === "subagent_stop") {
        broadcast(DOMAIN_EVENTS.CONSOLE_SUBAGENT_STOP, {
          console_session_id: backend.id,
          agent_id: event.agent_id,
          agent_type: event.agent_type,
          session_id: event.session_id,
          event,
        });
      }
      if (event.type === "result") {
        this.recordUsage(backend.id, event);
        broadcast(DOMAIN_EVENTS.CONSOLE_INBOX_BADGE, { count: 1 });
      }
    });

    backend.on("attention", (attention: ConsoleAttentionState | null) => {
      backend.meta = {
        ...backend.meta,
        attention: attention?.active ? attention : null,
      };
      broadcast(DOMAIN_EVENTS.CONSOLE_ATTENTION, {
        console_session_id: backend.id,
        attention,
      });
      broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_UPDATED, { session: backend.meta });
    });

    backend.on("prompt_queue", () => {
      broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_UPDATED, { session: backend.meta });
    });

    backend.on("meta_update", (fields: BackendMetaUpdate) => {
      this.applyMetaUpdate(backend.id, fields);
      if (fields.provider_session_id) {
        new ConversationSpawnService(getDb(), Date.now, false)
          .observeProviderSession(backend.id, fields.provider_session_id);
      }
    });

    backend.on("status", (event: BackendStatusEvent) => {
      this.broadcastStatus(backend.id, event);
    });

    backend.on("permission", (request: PermissionRequest) => {
      broadcast(DOMAIN_EVENTS.CONSOLE_PERMISSION_REQUEST, {
        console_session_id: backend.id,
        request,
      });
    });

    backend.on("permission_cleared", (event: { request_id: string }) => {
      broadcast(DOMAIN_EVENTS.CONSOLE_PERMISSION_CLEARED, {
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

    broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_UPDATED, { session: session.meta });
  }

  private broadcastStatus(id: string, event: BackendStatusEvent): void {
    if (event.kind === "started") {
      broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_STARTED, {
        id,
        pid: this.requireSession(id).meta.pid,
        started_at: event.started_at ?? this.requireSession(id).meta.started_at,
      });
      return;
    }
    if (event.kind === "stopped") {
      broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_STOPPED, {
        id,
        stopped_at: event.stopped_at ?? this.requireSession(id).meta.stopped_at,
      });
      this.evictExcessTerminalBackends(id);
      return;
    }
    broadcast(DOMAIN_EVENTS.CONSOLE_SESSION_EXIT, {
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
    // Issue 75f52ac — safeUnarchiveCodexThread is now async (promisified codex
    // CLI spawn). Fire-and-forget here preserves the previous non-blocking
    // behaviour; failures are logged via the callback.
    void safeUnarchiveCodexThread(this.codexThreadArchiver, providerSessionId, (message) => {
      this.logger("warn", "codex_thread_unarchive_failed", { message, provider_session_id: providerSessionId });
    });
  }

  private isPermissionAwareBackend(backend: AgenticBackend): backend is AgenticBackend & PermissionAwareBackend {
    return "getPendingPermissions" in backend && "resolvePermission" in backend;
  }

  private isConfigurableBackend(backend: AgenticBackend): backend is AgenticBackend & ConfigurableBackend {
    return "applyRunOptions" in backend && "getRunOptions" in backend;
  }

  private isToolPolicyBackend(backend: AgenticBackend): backend is AgenticBackend & ToolPolicyBackend {
    return "setAllowedTools" in backend;
  }

  private isUsageAwareBackend<TUsage>(backend: AgenticBackend): backend is AgenticBackend & UsageAwareBackend<TUsage> {
    return "getUsage" in backend;
  }

  private isCancellablePromptBackend(backend: AgenticBackend): backend is AgenticBackend & CancellablePromptBackend {
    return "cancelActivePrompt" in backend;
  }
}
