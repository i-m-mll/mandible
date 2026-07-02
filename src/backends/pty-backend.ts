import { EventEmitter } from "node:events";
import type { IPty, IDisposable } from "node-pty";
import pty from "node-pty";
import type { WebSocket } from "ws";
import type { AgenticBackend, BackendMetaUpdate, BackendStatusEvent } from "../agentic-backend.js";
import { RingBuffer } from "../ring-buffer.js";
import { computePresetUnion } from "../presets.js";
import { getDb } from "../db.js";
import { PtyScreenObserver, shouldEnablePtyScreenModel } from "../screen-model.js";
import type {
  ConsoleAttentionState,
  ConsolePromptQueueBlockedBy,
  ConsolePromptQueueItem,
  ConsolePromptQueueState,
  ConsoleSession,
  ConsoleSessionStatus,
  ConsoleStreamEvent,
  Logger,
} from "../types.js";

const STREAM_EVENTS_LIMIT = 2000;
const MAX_RESTART_ATTEMPTS = 5;
const BASE_RESTART_DELAY_MS = 2000;
const DEFAULT_PROMPT_QUIET_FALLBACK_MS = 1_500;
const ANSI_STRIP_RE =
  /\x1b\[[0-9;]*[mGKHFABCDJu]|\x1b\][^\x07]*\x07|\x0f|\x1b[()][AB012]/g;

const POLLUTED_ENV_KEYS_PREFIX = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];
const POLLUTED_ENV_KEYS_EXACT = new Set([
  "CLAUDECODE",
  "GIT_CONFIG_COUNT",
]);

export class PTYBackend extends EventEmitter implements AgenticBackend {
  readonly id: string;
  meta: ConsoleSession;

  private ptyProc: IPty | null = null;
  private ringBuffer: RingBuffer;
  private streamEvents: ConsoleStreamEvent[] = [];
  private wsClients: Set<WebSocket> = new Set();
  private lineBuffer = "";
  private onDataDisposable: IDisposable | null = null;
  private onExitDisposable: IDisposable | null = null;
  private restartAttempts = 0;
  private logger: Logger;
  /** Bug: 790433d — Preset IDs for PTY sessions, applied at launch via --append-system-prompt */
  private presetIds: string[] = [];
  private promptQueue: ConsolePromptQueueItem[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private promptQuietFallbackTimer: NodeJS.Timeout | null = null;
  private screenObserver: PtyScreenObserver | null = null;
  private lastPtyOutputAt = 0;
  private lastPromptFlushedAt: number | null = null;
  private destroyed = false;

  constructor(meta: ConsoleSession, logger: Logger) {
    super();
    this.id = meta.id;
    this.meta = meta;
    this.ringBuffer = new RingBuffer();
    this.logger = logger;
    if (shouldEnablePtyScreenModel(meta)) {
      this.screenObserver = new PtyScreenObserver({
        sessionId: meta.id,
        provider: meta.agent_type,
        cols: meta.cols,
        rows: meta.rows,
        onAttentionChange: (attention) => this.publishAttention(attention),
      });
    }
  }

  /** Bug: 790433d — Set preset IDs before start(). PTY presets are locked for session lifetime. */
  setPresetIds(ids: string[]): void {
    this.presetIds = [...ids];
  }

  start(): void {
    if (this.destroyed) {
      return;
    }
    if (this.ptyProc) {
      this.logger("warn", "pty_already_running", { id: this.id });
      return;
    }
    this.clearRestartTimer();

    const env = this.buildPtyEnv(this.meta.env);

    try {
      this.ptyProc = pty.spawn(this.meta.command, this.buildLaunchArgs(), {
        name: "xterm-256color",
        cols: this.meta.cols,
        rows: this.meta.rows,
        cwd: this.meta.cwd ?? process.env.HOME ?? "/tmp",
        env,
      });
    } catch (err) {
      this.logger("error", "pty_spawn_failed", { id: this.id, error: String(err) });
      const now = Date.now();
      this.meta = { ...this.meta, status: "crashed", pid: null, updated_at: now };
      this.emitMetaUpdate({ status: "crashed", pid: null, updated_at: now });
      this.emitStatus({
        kind: "exit",
        status: "crashed",
        exitCode: -1,
        signal: null,
        stopped_at: now,
      });
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
    this.emitMetaUpdate({ status: "running", pid: this.ptyProc.pid, started_at: now, updated_at: now });

    this.onDataDisposable = this.ptyProc.onData((data: string) => {
      this.handleData(data);
    });

    this.onExitDisposable = this.ptyProc.onExit(({ exitCode, signal }) => {
      this.handleExit({ exitCode: exitCode ?? 0, signal: signal ?? null });
    });

    this.emitStatus({
      kind: "started",
      status: "running",
      started_at: this.meta.started_at,
    });

    this.restartAttempts = 0;
    this.logger("info", "pty_started", { id: this.id, pid: this.meta.pid, command: this.meta.command });
  }

  stop(signal?: string): void {
    this.clearRestartTimer();
    this.clearPromptQuietFallbackTimer();

    if (!this.ptyProc) return;

    this.onDataDisposable?.dispose();
    this.onExitDisposable?.dispose();
    this.onDataDisposable = null;
    this.onExitDisposable = null;
    this.screenObserver?.clear("process_exit");

    try {
      this.ptyProc.kill(signal ?? "SIGHUP");
    } catch {
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
    this.emitMetaUpdate({ status: "stopped", pid: null, stopped_at: now, updated_at: now });
    this.broadcastWsStatus("stopped");
    this.emitStatus({
      kind: "stopped",
      status: "stopped",
      stopped_at: now,
    });

    this.logger("info", "pty_stopped", { id: this.id });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.screenObserver?.destroy();
    this.clearRestartTimer();
    this.clearPromptQuietFallbackTimer();
    if (this.ptyProc) {
      this.stop("SIGHUP");
    }
    this.wsClients.clear();
  }

  resize(cols: number, rows: number): void {
    if (this.ptyProc) {
      try {
        this.ptyProc.resize(cols, rows);
      } catch (err) {
        this.logger("warn", "pty_resize_failed", { id: this.id, error: String(err) });
      }
    }
    this.meta = { ...this.meta, cols, rows };
    this.screenObserver?.resize(cols, rows);
    this.emitMetaUpdate({ cols, rows, updated_at: Date.now() });
  }

  write(data: string): void {
    if (!this.ptyProc) return;
    try {
      this.ptyProc.write(data);
    } catch (err) {
      this.logger("warn", "pty_write_failed", { id: this.id, error: String(err) });
    }
  }

  clear(): void {
    this.ringBuffer.clear();
    this.streamEvents = [];
    this.lineBuffer = "";
    this.screenObserver?.clear("manual_clear");
  }

  sendPrompt(text: string): void {
    const prompt = text.trim();
    if (!prompt) return;
    if (!this.supportsPtyPromptInput()) {
      throw new Error("unsupported_prompt_backend");
    }
    if (!this.ptyProc || this.meta.status !== "running") {
      throw new Error("pty_prompt_not_running");
    }

    const blockedBy = this.promptBlockedBy();
    if (blockedBy) {
      this.queuePrompt(prompt, blockedBy);
      return;
    }

    this.flushPromptToPty(prompt);
    this.publishPromptQueueState();
  }

  addWsClient(ws: WebSocket): void {
    if (this.meta.status !== "running") {
      try {
        ws.send(
          Buffer.from(
            `\r\n\x1b[33m[Session ${this.meta.status} — create a new session]\x1b[0m\r\n`,
            "utf8"
          )
        );
      } catch {
        // ignore send errors on already-closing sockets
      }
      ws.close(1001, "session ended");
      return;
    }

    this.wsClients.add(ws);

    const snapshot = this.ringBuffer.snapshot();
    if (snapshot.length > 0) {
      try {
        ws.send(snapshot);
      } catch (err) {
        this.logger("warn", "ws_replay_failed", { id: this.id, error: String(err) });
        this.removeWsClient(ws);
        try { ws.close(1011, "replay failed"); } catch { /* already closed */ }
        return;
      }
    }

    try {
      ws.send(JSON.stringify({ type: "init", session: this.meta }));
    } catch (err) {
      this.logger("warn", "ws_init_failed", { id: this.id, error: String(err) });
      this.removeWsClient(ws);
      try { ws.close(1011, "init failed"); } catch { /* already closed */ }
      return;
    }

    ws.on("close", () => {
      this.removeWsClient(ws);
    });

    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        this.write(typeof data === "string" ? data : data.toString("utf8"));
        return;
      }

      const text = typeof data === "string" ? data : data.toString("utf8");
      try {
        const msg = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
        if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          this.resize(msg.cols, msg.rows);
        }
      } catch {
        // Not valid JSON
      }
    });
  }

  removeWsClient(ws: WebSocket): void {
    this.wsClients.delete(ws);
  }

  getBufferSnapshot(): Buffer {
    return this.ringBuffer.snapshot();
  }

  getStreamEvents(): ConsoleStreamEvent[] {
    return [...this.streamEvents];
  }

  ingestStructuredEvent(event: ConsoleStreamEvent): void {
    this.storeStructuredEvent(event);
  }

  ingestText(data: string): void {
    this.feedLineParser(data);
  }

  private handleData(data: string): void {
    this.lastPtyOutputAt = Date.now();
    this.ringBuffer.append(data);
    this.screenObserver?.feed(data);

    if (this.wsClients.size > 0) {
      const buf = Buffer.from(data, "utf8");
      for (const ws of this.wsClients) {
        try {
          ws.send(buf);
        } catch {
          this.removeWsClient(ws);
        }
      }
    }

    this.feedLineParser(data);
  }

  private feedLineParser(raw: string): void {
    this.lineBuffer += raw;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        this.parseStreamJsonLine(line);
      }
    }
  }

  private parseStreamJsonLine(line: string): void {
    const stripped = line.replace(ANSI_STRIP_RE, "").trim();
    if (!stripped.startsWith("{")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return;
    }

    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      return;
    }

    this.storeStructuredEvent(parsed as ConsoleStreamEvent);
  }

  private storeStructuredEvent(event: ConsoleStreamEvent): void {
    this.screenObserver?.markStructuredActivity();
    this.streamEvents.push(event);
    if (this.streamEvents.length > STREAM_EVENTS_LIMIT) {
      this.streamEvents = this.streamEvents.slice(this.streamEvents.length - STREAM_EVENTS_LIMIT);
    }

    const providerSessionId =
      "session_id" in event && typeof event.session_id === "string" && event.session_id.trim()
        ? event.session_id.trim()
        : null;
    if (providerSessionId && providerSessionId !== this.meta.provider_session_id) {
      const updatedAt = Date.now();
      this.meta = {
        ...this.meta,
        provider_session_id: providerSessionId,
        updated_at: updatedAt,
      };
      this.emitMetaUpdate({ provider_session_id: providerSessionId, updated_at: updatedAt });
    }

    this.emit("stream_event", event);
  }

  private handleExit({ exitCode, signal }: { exitCode: number; signal: number | null }): void {
    this.onDataDisposable?.dispose();
    this.onExitDisposable?.dispose();
    this.onDataDisposable = null;
    this.onExitDisposable = null;
    this.ptyProc = null;
    this.screenObserver?.clear("process_exit");
    this.clearPromptQuietFallbackTimer();

    const crashed = exitCode > 0;
    const status: ConsoleSessionStatus = crashed ? "crashed" : "stopped";
    const now = Date.now();

    this.meta = {
      ...this.meta,
      status,
      pid: null,
      exit_code: exitCode,
      stopped_at: now,
      updated_at: now,
    };
    this.emitMetaUpdate({
      status,
      pid: null,
      exit_code: exitCode,
      stopped_at: now,
      updated_at: now,
    });

    this.broadcastWsStatus(status, exitCode);
    this.emitStatus({
      kind: "exit",
      status,
      exitCode,
      signal,
      stopped_at: now,
    });

    this.logger("info", "pty_exited", { id: this.id, exitCode, signal, status });
    this.wsClients.clear();

    if (this.meta.auto_restart && crashed && !this.destroyed) {
      this.restartAttempts += 1;
      if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
        this.logger("warn", "pty_restart_limit_reached", {
          id: this.id,
          attempts: this.restartAttempts - 1,
        });
        // Mark as failed and stop retrying.
        const failNow = Date.now();
        this.meta = { ...this.meta, status: "crashed", auto_restart: false, updated_at: failNow };
        this.emitMetaUpdate({ status: "crashed", updated_at: failNow });
        return;
      }
      const delay = BASE_RESTART_DELAY_MS * Math.pow(2, this.restartAttempts - 1);
      this.logger("info", "pty_auto_restart_scheduled", {
        id: this.id,
        delay,
        attempt: this.restartAttempts,
      });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.meta.auto_restart && !this.destroyed) {
          this.logger("info", "pty_auto_restart", { id: this.id, attempt: this.restartAttempts });
          this.start();
        }
      }, delay);
      if (this.restartTimer && typeof this.restartTimer === "object" && "unref" in this.restartTimer) {
        this.restartTimer.unref();
      }
    }
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) {
      return;
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private broadcastWsStatus(status: ConsoleSessionStatus, exitCode?: number): void {
    if (this.wsClients.size === 0) return;
    const msg = JSON.stringify({
      type: "status",
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
    for (const ws of this.wsClients) {
      try {
        ws.send(msg);
      } catch {
        this.removeWsClient(ws);
      }
    }
  }

  private emitMetaUpdate(fields: BackendMetaUpdate): void {
    this.emit("meta_update", fields);
  }

  private emitStatus(event: BackendStatusEvent): void {
    this.emit("status", event);
  }

  private publishAttention(attention: ConsoleAttentionState | null): void {
    this.meta = {
      ...this.meta,
      attention: attention?.active ? attention : null,
      updated_at: Date.now(),
    };
    this.emit("attention", attention);
    if (attention?.active && attention.kind === "input_prompt") {
      this.flushQueuedPrompts();
    }
  }

  private extractModel(args: string[]): string | null {
    for (let i = args.length - 2; i >= 0; i -= 1) {
      const arg = args[i];
      if ((arg === "--model" || arg === "-m") && typeof args[i + 1] === "string" && args[i + 1].trim()) {
        return args[i + 1].trim();
      }
    }
    return null;
  }

  private stripArgValue(args: string[], flags: string[]): string[] {
    const sanitized: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (flags.includes(arg)) {
        i += 1;
        continue;
      }
      sanitized.push(arg);
    }

    return sanitized;
  }

  private buildLaunchArgs(): string[] {
    if (this.meta.command === "claude") {
      const args = this.stripArgValue(this.meta.args, ["-p", "--print", "--resume", "--output-format", "--model", "--append-system-prompt"]);
      const sanitized = args.filter((arg) => arg !== "--verbose");
      const model = this.extractModel(this.meta.args);
      if (model) {
        sanitized.push("--model", model);
      }
      if (this.meta.provider_session_id) {
        sanitized.push("--resume", this.meta.provider_session_id);
      }
      // Bug: b5aba0e — channel-enabled PTY: inject MCP channel server flag
      if (this.meta.channel_enabled) {
        sanitized.push("--dangerously-load-development-channels", "server:mandible");
      }
      // Bug: 790433d — Append preset union as system prompt for PTY sessions
      if (this.presetIds.length > 0) {
        try {
          const db = getDb();
          const union = computePresetUnion(this.presetIds, db);
          if (union.text) {
            sanitized.push("--append-system-prompt", union.text);
          }
        } catch (err) {
          this.logger("warn", "pty_preset_union_failed", { id: this.id, error: String(err) });
        }
      }
      return sanitized;
    }
    if (this.meta.command === "gemini") {
      const args = this.stripArgValue(this.meta.args, ["-p", "--prompt", "--resume", "--output-format", "--model"]);
      const model = this.extractModel(this.meta.args);
      if (model) {
        args.push("--model", model);
      }
      if (this.meta.provider_session_id) {
        args.push("--resume", this.meta.provider_session_id);
      }
      return args;
    }
    if (this.meta.command === "codex") {
      const args = this.stripArgValue(this.meta.args, ["-m", "--model"]);
      const model = this.extractModel(this.meta.args);
      if (this.meta.provider_session_id) {
        const resumeArgs = ["resume", this.meta.provider_session_id, ...args];
        if (model) {
          resumeArgs.push("--model", model);
        }
        return resumeArgs;
      }
      if (model) {
        args.push("--model", model);
      }
      return args;
    }
    return this.meta.args;
  }

  private buildPtyEnv(extraEnv: Record<string, string>): Record<string, string> {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (POLLUTED_ENV_KEYS_EXACT.has(k)) continue;
      if (POLLUTED_ENV_KEYS_PREFIX.some((prefix) => k.startsWith(prefix))) continue;
      cleaned[k] = v;
    }
    Object.assign(cleaned, extraEnv);
    // Bug: b5aba0e — channel-enabled PTY: expose session ID for channel server discovery
    if (this.meta.channel_enabled) {
      cleaned["MANDIBLE_SESSION_ID"] = this.meta.mandible_session_id ?? this.id;
    }
    return cleaned;
  }

  private supportsPtyPromptInput(): boolean {
    return this.meta.backend_type === "pty" && ["claude", "codex", "gemini"].includes(this.meta.command);
  }

  private promptBlockedBy(): ConsolePromptQueueBlockedBy | null {
    const attention = this.meta.attention;
    if (attention?.active) {
      return attention.kind === "input_prompt" ? null : attention.kind;
    }
    if (!this.screenObserver && this.isPromptQuietFallbackReady()) {
      return null;
    }
    return "no_attention_state";
  }

  private queuePrompt(prompt: string, blockedBy: ConsolePromptQueueBlockedBy): void {
    this.promptQueue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: prompt,
      queued_at: Date.now(),
      blocked_by: blockedBy,
    });
    this.schedulePromptQuietFallback();
    this.publishPromptQueueState();
  }

  private flushQueuedPrompts(): void {
    if (this.promptQueue.length === 0) {
      return;
    }
    const queued = this.promptQueue.splice(0);
    for (const item of queued) {
      this.flushPromptToPty(item.text);
    }
    this.clearPromptQuietFallbackTimer();
    this.publishPromptQueueState();
  }

  private flushPromptToPty(prompt: string): void {
    this.write(formatPtyPromptInput(prompt));
    this.lastPromptFlushedAt = Date.now();
    this.ingestStructuredEvent(this.makeUserEvent(prompt, this.meta.provider_session_id ?? this.meta.id));
  }

  private publishPromptQueueState(): void {
    const state = this.buildPromptQueueState();
    this.meta = {
      ...this.meta,
      prompt_queue: state,
      updated_at: Date.now(),
    };
    this.emit("prompt_queue", state);
  }

  private buildPromptQueueState(): ConsolePromptQueueState | null {
    if (this.promptQueue.length === 0 && this.lastPromptFlushedAt === null) {
      return null;
    }
    return {
      pending_count: this.promptQueue.length,
      items: this.promptQueue.map((item) => ({ ...item })),
      fallback_enabled: this.isPromptQuietFallbackEnabled(),
      fallback_quiet_ms: this.promptQuietFallbackMs(),
      last_flushed_at: this.lastPromptFlushedAt,
    };
  }

  private schedulePromptQuietFallback(): void {
    if (!this.isPromptQuietFallbackEnabled() || this.screenObserver || this.promptQueue.length === 0) {
      return;
    }
    const quietMs = this.promptQuietFallbackMs();
    const elapsed = Date.now() - this.lastPtyOutputAt;
    if (elapsed >= quietMs) {
      this.flushQueuedPrompts();
      return;
    }
    this.clearPromptQuietFallbackTimer();
    this.promptQuietFallbackTimer = setTimeout(() => {
      this.promptQuietFallbackTimer = null;
      if (this.isPromptQuietFallbackReady()) {
        this.flushQueuedPrompts();
      } else {
        this.schedulePromptQuietFallback();
      }
    }, quietMs - elapsed);
    if (
      this.promptQuietFallbackTimer &&
      typeof this.promptQuietFallbackTimer === "object" &&
      "unref" in this.promptQuietFallbackTimer
    ) {
      this.promptQuietFallbackTimer.unref();
    }
  }

  private clearPromptQuietFallbackTimer(): void {
    if (!this.promptQuietFallbackTimer) {
      return;
    }
    clearTimeout(this.promptQuietFallbackTimer);
    this.promptQuietFallbackTimer = null;
  }

  private isPromptQuietFallbackReady(): boolean {
    return (
      this.isPromptQuietFallbackEnabled() &&
      Date.now() - this.lastPtyOutputAt >= this.promptQuietFallbackMs()
    );
  }

  private isPromptQuietFallbackEnabled(): boolean {
    return (
      readBooleanSwitch(this.meta.env.MANDIBLE_PTY_PROMPT_QUIET_FALLBACK) ??
      readBooleanSwitch(process.env.MANDIBLE_PTY_PROMPT_QUIET_FALLBACK) ??
      false
    );
  }

  private promptQuietFallbackMs(): number {
    const raw = this.meta.env.MANDIBLE_PTY_PROMPT_QUIET_MS ?? process.env.MANDIBLE_PTY_PROMPT_QUIET_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 250 ? parsed : DEFAULT_PROMPT_QUIET_FALLBACK_MS;
  }

  private makeUserEvent(prompt: string, sessionId: string): ConsoleStreamEvent {
    return {
      type: "user",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    };
  }

}

export function formatPtyPromptInput(prompt: string): string {
  return prompt.includes("\n")
    ? `\x1b[200~${prompt}\x1b[201~\r`
    : `${prompt}\r`;
}

function readBooleanSwitch(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  return null;
}
