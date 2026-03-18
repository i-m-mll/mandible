import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { IPty, IDisposable } from "node-pty";
import pty from "node-pty";
import type { WebSocket } from "ws";
import type { AgenticBackend, BackendMetaUpdate, BackendStatusEvent } from "../agentic-backend.js";
import { RingBuffer } from "../ring-buffer.js";
import type {
  ConsoleSession,
  ConsoleSessionStatus,
  ConsoleStreamEvent,
  Logger,
} from "../types.js";

const STREAM_EVENTS_LIMIT = 2000;
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
  private logger: Logger;

  constructor(meta: ConsoleSession, logger: Logger) {
    super();
    this.id = meta.id;
    this.meta = meta;
    this.ringBuffer = new RingBuffer();
    this.logger = logger;
  }

  start(): void {
    if (this.ptyProc) {
      this.logger("warn", "pty_already_running", { id: this.id });
      return;
    }

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

    this.logger("info", "pty_started", { id: this.id, pid: this.meta.pid, command: this.meta.command });
  }

  stop(signal?: string): void {
    if (!this.ptyProc) return;

    this.onDataDisposable?.dispose();
    this.onExitDisposable?.dispose();
    this.onDataDisposable = null;
    this.onExitDisposable = null;

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
    if (this.meta.status === "running") {
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
  }

  sendPrompt(text: string): void {
    const prompt = text.trim();
    if (!prompt) return;

    const cwd = this.meta.cwd ?? process.env.HOME ?? "/tmp";
    const invocation = this.buildPromptInvocation(prompt, cwd);
    if (!invocation) {
      throw new Error("unsupported_prompt_backend");
    }

    const env = this.buildPtyEnv(this.meta.env ?? {});
    const existingSessionId = this.meta.provider_session_id ?? this.meta.id;
    if (invocation.injectUserEvent) {
      this.ingestStructuredEvent(this.makeUserEvent(prompt, existingSessionId));
    }

    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let sawResult = false;
    const codexState = {
      threadId: this.meta.provider_session_id,
      turnCount: 0,
      model: this.extractModel(this.meta.args),
    };

    child.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (invocation.normalize === "claude") {
          this.ingestText(line + "\n");
          if (line.includes("\"type\":\"result\"")) {
            sawResult = true;
          }
        } else if (invocation.normalize === "gemini") {
          const event = this.normalizeGeminiStreamLine(line);
          if (event) {
            if (event.type === "result") {
              sawResult = true;
            }
            this.ingestStructuredEvent(event);
          }
        } else {
          const event = this.normalizeCodexStreamLine(line, codexState);
          if (event) {
            if (event.type === "result") {
              sawResult = true;
            }
            this.ingestStructuredEvent(event);
          }
        }
      }
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (lineBuffer.trim()) {
        if (invocation.normalize === "claude") {
          this.ingestText(lineBuffer + "\n");
        } else if (invocation.normalize === "gemini") {
          const event = this.normalizeGeminiStreamLine(lineBuffer);
          if (event) {
            if (event.type === "result") {
              sawResult = true;
            }
            this.ingestStructuredEvent(event);
          }
        } else {
          const event = this.normalizeCodexStreamLine(lineBuffer, codexState);
          if (event) {
            if (event.type === "result") {
              sawResult = true;
            }
            this.ingestStructuredEvent(event);
          }
        }
      }

      if (code !== 0 && stderrBuf.trim() && !sawResult) {
        const errMsg = stderrBuf.trim().slice(0, 500);
        this.ingestStructuredEvent({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [errMsg],
          session_id: this.meta.provider_session_id ?? codexState.threadId ?? existingSessionId,
          duration_ms: 0,
          num_turns: 0,
          total_cost_usd: 0,
        });
      }
    });
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
      }
    }

    try {
      ws.send(JSON.stringify({ type: "init", session: this.meta }));
    } catch (err) {
      this.logger("warn", "ws_init_failed", { id: this.id, error: String(err) });
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
    this.ringBuffer.append(data);

    if (this.wsClients.size > 0) {
      const buf = Buffer.from(data, "utf8");
      for (const ws of this.wsClients) {
        try {
          ws.send(buf);
        } catch {
          // Client disconnected; will be cleaned up on close
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

    if (this.meta.auto_restart && crashed) {
      this.logger("info", "pty_auto_restart_scheduled", { id: this.id, delay: 2000 });
      const timer = setTimeout(() => {
        if (this.meta.auto_restart) {
          this.logger("info", "pty_auto_restart", { id: this.id });
          this.start();
        }
      }, 2000);
      if (timer && typeof timer === "object" && "unref" in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    }
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
        // Ignore send errors on disconnect
      }
    }
  }

  private emitMetaUpdate(fields: BackendMetaUpdate): void {
    this.emit("meta_update", fields);
  }

  private emitStatus(event: BackendStatusEvent): void {
    this.emit("status", event);
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
      const args = this.stripArgValue(this.meta.args, ["-p", "--print", "--resume", "--output-format", "--model"]);
      const sanitized = args.filter((arg) => arg !== "--verbose");
      const model = this.extractModel(this.meta.args);
      if (model) {
        sanitized.push("--model", model);
      }
      if (this.meta.provider_session_id) {
        sanitized.push("--resume", this.meta.provider_session_id);
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
    return cleaned;
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

  private buildPromptInvocation(
    prompt: string,
    cwd: string
  ): {
    command: string;
    args: string[];
    injectUserEvent: boolean;
    normalize: "claude" | "codex" | "gemini";
  } | null {
    const model = this.extractModel(this.meta.args);

    if (this.meta.command === "claude") {
      const args = ["-p", prompt, "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"];
      if (this.meta.provider_session_id) {
        args.splice(2, 0, "--resume", this.meta.provider_session_id);
      }
      if (model) {
        args.push("--model", model);
      }
      return { command: "claude", args, injectUserEvent: true, normalize: "claude" };
    }

    if (this.meta.command === "gemini") {
      const args = ["-p", prompt, "--output-format", "stream-json", "-y"];
      if (this.meta.provider_session_id) {
        args.push("--resume", this.meta.provider_session_id);
      }
      if (model) {
        args.push("--model", model);
      }
      return { command: "gemini", args, injectUserEvent: false, normalize: "gemini" };
    }

    if (this.meta.command === "codex") {
      const args = this.meta.provider_session_id
        ? ["exec", "resume", this.meta.provider_session_id, prompt]
        : ["exec", prompt];
      args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", cwd);
      if (model) {
        args.push("--model", model);
      }
      return { command: "codex", args, injectUserEvent: true, normalize: "codex" };
    }

    return null;
  }

  private normalizeGeminiStreamLine(line: string): ConsoleStreamEvent | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = typeof parsed.type === "string" ? parsed.type : "";
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "";
    if (type === "init") {
      return {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
      };
    }
    if (type === "message") {
      const role = parsed.role === "assistant" ? "assistant" : "user";
      return {
        type: role,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role,
          content: [{ type: "text", text: typeof parsed.content === "string" ? parsed.content : "" }],
          ...(role === "assistant" && typeof parsed.model === "string" ? { model: parsed.model } : {}),
        },
      };
    }
    if (type === "result") {
      const stats = (parsed.stats && typeof parsed.stats === "object") ? parsed.stats as Record<string, unknown> : {};
      const status = parsed.status === "success" ? "success" : "error_during_execution";
      return {
        type: "result",
        subtype: status,
        session_id: sessionId,
        duration_ms: typeof stats.duration_ms === "number" ? stats.duration_ms : 0,
        num_turns: 1,
        total_cost_usd: 0,
        is_error: status !== "success",
        ...(status !== "success" ? { errors: [typeof parsed.status === "string" ? parsed.status : "Gemini request failed"] } : {}),
      };
    }
    return null;
  }

  private normalizeCodexStreamLine(
    line: string,
    state: { threadId: string | null; turnCount: number; model: string | null }
  ): ConsoleStreamEvent | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "thread.started") {
      state.threadId = typeof parsed.thread_id === "string" ? parsed.thread_id : state.threadId;
      return {
        type: "system",
        subtype: "init",
        session_id: state.threadId ?? "",
        ...(state.model ? { model: state.model } : {}),
      };
    }
    if (type === "item.completed") {
      const item = (parsed.item && typeof parsed.item === "object") ? parsed.item as Record<string, unknown> : null;
      if (!item) return null;
      const itemType = typeof item.type === "string" ? item.type : "";
      if (itemType === "agent_message") {
        return {
          type: "assistant",
          session_id: state.threadId ?? "",
          parent_tool_use_id: null,
          message: {
            role: "assistant",
            ...(state.model ? { model: state.model } : {}),
            content: [{ type: "text", text: typeof item.text === "string" ? item.text : "" }],
          },
        };
      }
      return null;
    }
    if (type === "turn.completed") {
      state.turnCount += 1;
      const usage = (parsed.usage && typeof parsed.usage === "object") ? parsed.usage as Record<string, unknown> : {};
      return {
        type: "result",
        subtype: "success",
        session_id: state.threadId ?? "",
        duration_ms: 0,
        num_turns: state.turnCount,
        total_cost_usd: 0,
        is_error: false,
        usage,
      };
    }
    if (type === "error" || type === "turn.failed") {
      const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null;
      const message =
        typeof parsed.message === "string" ? parsed.message
          : typeof error?.message === "string" ? error.message
            : "Codex request failed";
      return {
        type: "result",
        subtype: "error_during_execution",
        session_id: state.threadId ?? "",
        duration_ms: 0,
        num_turns: state.turnCount,
        total_cost_usd: 0,
        is_error: true,
        errors: [message],
      };
    }
    return null;
  }
}
