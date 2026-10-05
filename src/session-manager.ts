import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { TerminalBackend, BackendMetaUpdate, BackendType } from "./agentic-backend.js";
import { getDb, type Db } from "./db.js";
import { isClaudeCommand, describeAnthropicBilling } from "./claude-lane-policy.js";
import type { SessionRegistry } from "./registry.js";
import type { ClientAuthenticator } from "./client-auth/authenticator.js";
import type { CodexThreadArchiver } from "./codex-thread-archive.js";
import { broadcast } from "./sse.js";
import { PTYBackend } from "./backends/pty-backend.js";
import { getOperator } from "./users/store.js";
import { AttributionReadResolver } from "./identity/read-projection.js";
import type { ConsoleSession, ConsoleSessionInput, ConsoleSessionStatus, ConsoleInteractionMode, ConsoleTransportLane, ConsoleTransportBadge, ConsoleStreamEvent, Logger } from "./types.js";
import { declaredRunOptionsSnapshot, type SessionRunOptionValue, type BackendRunOptionDeclaration } from "./session-run-options.js";

export const TERMINAL_BACKEND_RETENTION_LIMIT = 64;
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

class DormantBackend extends EventEmitter implements TerminalBackend {
  readonly id: string;
  meta: ConsoleSession;

  constructor(meta: ConsoleSession) {
    super();
    this.id = meta.id;
    this.meta = { ...meta };
  }

  start(): void { throw new Error("Historical managed session must resume through conversation control"); }
  stop(): void { throw new Error("Historical managed session has no owned terminal"); }
  destroy(): void { this.removeAllListeners(); }
  clear(): void { throw new Error("Historical managed session has no terminal buffer"); }
  write(): void { throw new Error("Historical managed session has no owned terminal"); }
  resize(): void { throw new Error("Historical managed session has no owned terminal"); }
  addWsClient(): void { throw new Error("Historical managed session has no owned terminal"); }
  removeWsClient(): void { throw new Error("Historical managed session has no owned terminal"); }
  getBufferSnapshot(): Buffer { return Buffer.alloc(0); }
  getStreamEvents(): ConsoleStreamEvent[] { return []; }

}

function computeAgentType(command: string, operator: boolean): ConsoleSession["agent_type"] {
  if (operator) return "operator";
  return command === "claude" || command === "codex" || command === "gemini" ? command : "shell";
}
function isTransportLane(value: unknown): value is ConsoleTransportLane {
  return ["pty", "sdk", "acp", "spawn", "channel"].includes(String(value));
}
function deriveTransportLane(_command: string, backend: BackendType, channel: boolean): ConsoleTransportLane { return channel ? "channel" : backend; }
function transportLaneBadge(lane: ConsoleTransportLane): ConsoleTransportBadge {
  return { label: ({ pty: "PTY", sdk: "SDK", acp: "ACP", spawn: "Spawn", channel: "Channel" } as const)[lane], title: lane === "pty" ? "Interactive terminal" : "Historical managed conversation" };
}
function parseAllowedTools(value: string | null): string[] | null { return value ? JSON.parse(value) : null; }
function parseRunOptions(value: string | null | undefined): Record<string, SessionRunOptionValue> { return value ? JSON.parse(value) : {}; }
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

export class SessionManager {
  private readonly sessions = new Map<string, TerminalBackend>();
  private readOnly = false;
  constructor(_db: unknown, private readonly logger: Logger, _registry?: SessionRegistry, _archiver?: CodexThreadArchiver, _auth?: ClientAuthenticator) {}

  init({ readOnly = false }: { readOnly?: boolean } = {}): void {
    this.readOnly = readOnly;
    const db = getDb();
    const resolver = new AttributionReadResolver(db);
    for (const row of db.prepare("SELECT * FROM console_sessions").all() as ConsoleSessionRow[]) {
      const meta = rowToSession(row, resolver);
      if (!readOnly && meta.status === "running") {
        db.prepare("UPDATE console_sessions SET status = 'stopped', pid = NULL, updated_at = ? WHERE id = ?").run(Date.now(), meta.id);
        meta.status = "stopped"; meta.pid = null;
      }
      this.sessions.set(meta.id, new DormantBackend(meta));
    }
  }

  create(input: ConsoleSessionInput, { allowOperator = false }: { allowOperator?: boolean } = {}): ConsoleSession {
    if (this.readOnly) throw new Error("Read-only instance cannot create a terminal");
    if (input.is_operator && !allowOperator) throw new Error("Operator terminals use startOperator");
    if (input.backend_type && input.backend_type !== "pty" || input.transport_lane && input.transport_lane !== "pty" || input.channel_enabled || input.provider_session_id || input.resume_at_message || Object.keys(input.runOptions ?? {}).length) {
      throw new Error("Managed conversations use ConversationControlService");
    }
    const db = getDb();
    const id = input.id ?? randomUUID();
    const now = Date.now();
    const env = { ...input.env }; delete env.MANDIBLE_TOKEN;
    const operator = input.is_operator ? getOperator(db) : null;
    db.prepare(`INSERT INTO console_sessions (id, label, command, args_json, cwd, env_json, cols, rows, status,
      auto_restart, is_operator, interaction_mode, created_at, updated_at, backend_type, transport_lane, owner_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, 'pty', 'pty', ?)`)
      .run(id, input.label, input.command, JSON.stringify(input.args ?? []), input.cwd ?? null, JSON.stringify(env),
        input.cols ?? 120, input.rows ?? 30, input.auto_restart ? 1 : 0, input.is_operator ? 1 : 0, input.interaction_mode ?? "direct", now, now, operator?.id ?? null);
    const row = db.prepare("SELECT * FROM console_sessions WHERE id = ?").get(id) as ConsoleSessionRow;
    const meta = rowToSession(row, new AttributionReadResolver(db));
    this.sessions.set(id, this.terminal(meta));
    broadcast("console:session:created", { session: meta });
    this.evict();
    return meta;
  }

  get(id: string): TerminalBackend | undefined {
    const current = this.sessions.get(id);
    if (!current || !(current instanceof DormantBackend) || current.meta.backend_type !== "pty" || this.readOnly) return current;
    const terminal = this.terminal(current.meta); this.sessions.set(id, terminal); this.evict(id); return terminal;
  }
  getAll(): TerminalBackend[] { return [...this.sessions.values()]; }
  isCredentialBearing(id: string): boolean { const session = this.sessions.get(id); return Boolean(session?.meta.is_operator); }
  getRetentionStats(): { retainedTerminal: number; dormant: number } {
    return { retainedTerminal: [...this.sessions.values()].filter((value) => value instanceof PTYBackend).length,
      dormant: [...this.sessions.values()].filter((value) => value instanceof DormantBackend).length };
  }
  start(id: string): void { this.requireTerminal(id).start(); }
  stop(id: string, signal?: string): void { this.requireTerminal(id).stop(signal); }
  async restart(id: string): Promise<void> {
    const terminal = this.requireTerminal(id);
    if (terminal.meta.status === "running") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { terminal.removeListener("status", exited); reject(new Error("Terminal did not exit before restart")); }, 5_000);
        const exited = (event: { kind: string }) => { if (event.kind === "exit") { clearTimeout(timer); terminal.removeListener("status", exited); resolve(); } };
        terminal.on("status", exited);
        terminal.stop();
      });
    }
    terminal.start();
  }
  write(id: string, data: string): void { this.requireTerminal(id).write(data); }
  resize(id: string, cols: number, rows: number): void { this.requireTerminal(id).resize(cols, rows); }
  addWsClient(id: string, ws: WebSocket): boolean {
    const terminal = this.get(id);
    if (!(terminal instanceof PTYBackend)) return false;
    terminal.addWsClient(ws); return true;
  }
  delete(id: string): void {
    const terminal = this.requireTerminal(id);
    terminal.destroy(); this.sessions.delete(id);
    getDb().prepare("DELETE FROM console_sessions WHERE id = ?").run(id);
    broadcast("console:session:deleted", { id });
  }
  updateConfig(id: string, patch: Partial<Pick<ConsoleSession, "label" | "args" | "cwd" | "provider_session_id" | "allowed_tools" | "mandible_session_id">>, { silent = false } = {}): ConsoleSession {
    const terminal = this.requireTerminal(id);
    if (patch.provider_session_id !== undefined || patch.allowed_tools !== undefined || patch.mandible_session_id !== undefined) throw new Error("Provider settings use conversation control");
    const meta = { ...terminal.meta, ...patch, updated_at: Date.now() };
    getDb().prepare("UPDATE console_sessions SET label = ?, args_json = ?, cwd = ?, updated_at = ? WHERE id = ?")
      .run(meta.label, JSON.stringify(meta.args), meta.cwd, meta.updated_at, id);
    terminal.meta = meta;
    if (!silent) broadcast("console:session:updated", { session: meta });
    return meta;
  }
  describeRunOptionDeclaration(backendType: BackendType, command: string): BackendRunOptionDeclaration { return { backendType, command, options: [] }; }
  describeRunOptions(backendType: BackendType, command: string) { return declaredRunOptionsSnapshot(this.describeRunOptionDeclaration(backendType, command)); }
  getRunOptions(id: string) { const meta = this.sessions.get(id)?.meta; if (!meta) throw new Error("Terminal not found"); return this.describeRunOptions(meta.backend_type, meta.command); }
  getSessionOptionsControls(id: string) { const meta = this.sessions.get(id)?.meta; if (!meta) throw new Error("Terminal not found"); return { allowedTools: meta.allowed_tools }; }
  getUsage(id: string): Record<string, unknown>[] {
    const rows = getDb().prepare("SELECT * FROM console_session_usage WHERE console_session_id = ? ORDER BY recorded_at DESC").all(id) as Record<string, unknown>[];
    return rows.map(({ usage_json, model_usage_json, errors_json, ...row }) => ({ ...row, is_error: row.is_error === 1,
      usage: JSON.parse(String(usage_json)), model_usage: JSON.parse(String(model_usage_json)), errors: JSON.parse(String(errors_json)) }));
  }
  startOperator(): void {
    if (this.readOnly) throw new Error("Read-only instance cannot start an operator terminal");
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'console_operator_session_id'").get() as { value: string } | undefined;
    let terminal = row ? this.get(row.value) : undefined;
    if (!terminal || terminal.meta.backend_type !== "pty") {
      const meta = this.create({ label: "Operator terminal", command: process.env.SHELL ?? "/bin/zsh", args: ["-l"], cwd: process.env.HOME ?? "/tmp",
        is_operator: true, backend_type: "pty", transport_lane: "pty", cols: 220, rows: 50 }, { allowOperator: true });
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('console_operator_session_id', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(meta.id, Date.now());
      terminal = this.get(meta.id)!;
    }
    if (terminal.meta.status !== "running") terminal.start();
  }
  operator(): TerminalBackend | undefined {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'console_operator_session_id'").get() as { value: string } | undefined;
    return row ? this.get(row.value) : undefined;
  }
  close(): void { for (const session of this.sessions.values()) session.destroy(); }

  private requireTerminal(id: string): PTYBackend {
    const terminal = this.get(id);
    if (!(terminal instanceof PTYBackend)) throw new Error("Session has no owned terminal; open its conversation in Chats");
    return terminal;
  }
  private terminal(meta: ConsoleSession): PTYBackend {
    const terminal = new PTYBackend(meta, this.logger);
    terminal.on("meta_update", (patch: BackendMetaUpdate) => {
      const next = { ...terminal.meta, ...patch };
      getDb().prepare("UPDATE console_sessions SET cols = ?, rows = ?, status = ?, pid = ?, exit_code = ?, started_at = ?, stopped_at = ?, updated_at = ? WHERE id = ?")
        .run(next.cols, next.rows, next.status, next.pid, next.exit_code, next.started_at, next.stopped_at, next.updated_at, next.id);
      broadcast("console:session:updated", { session: next });
    });
    terminal.on("status", (event) => broadcast("console:status", { console_session_id: terminal.id, ...event }));
    return terminal;
  }
  private evict(exclude?: string): void {
    const stopped = [...this.sessions.values()].filter((session) => session instanceof PTYBackend && session.meta.status !== "running" && session.id !== exclude)
      .sort((a, b) => b.meta.updated_at - a.meta.updated_at);
    for (const session of stopped.slice(TERMINAL_BACKEND_RETENTION_LIMIT - (exclude ? 1 : 0))) {
      const meta = { ...session.meta }; session.destroy(); this.sessions.set(session.id, new DormantBackend(meta));
    }
  }
}
