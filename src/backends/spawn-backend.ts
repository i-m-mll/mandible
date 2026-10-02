import { needsManagedHttpCredential, projectManagedProviderIdentity } from "./mandible-transport.js";
/**
 * SpawnBackend — process-based backend for Codex/Gemini/shell.
 * Bug: 8d3328c — Uses child_process.spawn() with JSON stdout parsing.
 * No terminal emulation (no node-pty, no RingBuffer, no WebSocket xterm.js).
 *
 * Architectural reflection: This backend does NOT interact with worktree conventions,
 * issue tracking, merge protocols, or the auth queue. It is purely a process lifecycle
 * manager for non-Claude agents in the Console. No CLAUDE.md updates needed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { AgenticBackend, BackendMetaUpdate, BackendStatusEvent } from "../agentic-backend.js";
import type {
  ConsoleSession,
  ConsoleStreamEvent,
  Logger,
} from "../types.js";
import {
  normalizeCodexStreamLine,
  normalizeGeminiStreamLine,
  type CodexNormalizerState,
} from "./normalizers.js";
import { extractModel } from "./cli-args.js";

const STREAM_EVENTS_LIMIT = 2000;
const MAX_RESTART_ATTEMPTS = 5;
const BASE_RESTART_DELAY_MS = 2000;

const POLLUTED_ENV_KEYS_PREFIX = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];
const POLLUTED_ENV_KEYS_EXACT = new Set([
  "CLAUDECODE",
  "GIT_CONFIG_COUNT",
]);

export class SpawnBackend extends EventEmitter implements AgenticBackend {
  readonly id: string;
  meta: ConsoleSession;

  private childProc: ChildProcess | null = null;
  private eventLog: ConsoleStreamEvent[] = [];
  private wsClients: Set<WebSocket> = new Set();
  private restartAttempts = 0;
  private logger: Logger;
  private promptQueue: string[] = [];
  private processing = false;
  private destroyed = false;
  private readonly mandibleTokenSource: string | (() => string | null) | null;

  constructor(
    meta: ConsoleSession,
    logger: Logger,
    mandibleToken: string | (() => string | null) | null = null,
  ) {
    super();
    this.id = meta.id;
    this.meta = meta;
    this.logger = logger;
    this.mandibleTokenSource = mandibleToken;
  }

  // SpawnBackend is prompt-driven: start() makes the backend ready to receive
  // prompts, but no child process is spawned until sendPrompt() is called.
  // This matches SDKBackend's lifecycle where query() is called per-prompt.
  start(): void {
    if (this.destroyed || this.meta.status === "running") {
      return;
    }

    const now = Date.now();
    this.meta = {
      ...this.meta,
      status: "running",
      pid: null,
      exit_code: null,
      started_at: this.meta.started_at ?? now,
      stopped_at: null,
      updated_at: now,
    };
    this.emitMetaUpdate({
      status: "running",
      pid: null,
      exit_code: null,
      started_at: this.meta.started_at,
      stopped_at: null,
      updated_at: now,
    });
    this.emitStatus({
      kind: "started",
      status: "running",
      started_at: this.meta.started_at,
    });

    this.restartAttempts = 0;
    this.logger("info", "spawn_started", { id: this.id, command: this.meta.command });
  }

  stop(signal?: string): void {
    this.promptQueue = [];

    if (this.childProc) {
      try {
        this.childProc.kill((signal || "SIGTERM") as NodeJS.Signals);
      } catch {
        // Process may already be gone
      }
      this.childProc = null;
    }

    if (this.meta.status !== "running") {
      return;
    }

    const now = Date.now();
    this.meta = {
      ...this.meta,
      status: "stopped",
      pid: null,
      stopped_at: now,
      updated_at: now,
    };
    this.emitMetaUpdate({
      status: "stopped",
      pid: null,
      stopped_at: now,
      updated_at: now,
    });
    this.emitStatus({
      kind: "stopped",
      status: "stopped",
      stopped_at: now,
    });

    this.logger("info", "spawn_stopped", { id: this.id });
  }

  destroy(signal?: string): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.promptQueue = [];

    if (this.childProc) {
      try {
        this.childProc.kill((signal || "SIGTERM") as NodeJS.Signals);
      } catch {
        // Process may already be gone
      }
      this.childProc = null;
    }

    this.wsClients.clear();
  }

  clear(): void {
    this.eventLog = [];
  }

  sendPrompt(text: string): void {
    const prompt = text.trim();
    if (!prompt || this.destroyed) {
      return;
    }
    this.promptQueue.push(prompt);
    if (!this.processing) {
      void this.processPromptQueue();
    }
  }

  write(data: string): void {
    // SpawnBackend has no interactive terminal.
    // Treat newline-terminated input as a prompt submission.
    if (!/[\r\n]/.test(data)) {
      return;
    }
    const prompt = data.trim();
    if (prompt) {
      this.sendPrompt(prompt);
    }
  }

  resize(_cols: number, _rows: number): void {
    // No terminal to resize — no-op.
    this.meta = { ...this.meta, cols: _cols, rows: _rows, updated_at: Date.now() };
    this.emitMetaUpdate({ cols: _cols, rows: _rows, updated_at: this.meta.updated_at });
  }

  addWsClient(ws: WebSocket): void {
    this.wsClients.add(ws);

    // Send init message and replay event log
    try {
      ws.send(JSON.stringify({ type: "init", session: this.meta }));
      for (const event of this.eventLog) {
        ws.send(JSON.stringify(event));
      }
    } catch (error) {
      this.logger("warn", "spawn_ws_init_failed", { id: this.id, error: String(error) });
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
        const parsed = JSON.parse(text) as { type?: string; prompt?: string };
        if (parsed.type === "prompt" && typeof parsed.prompt === "string") {
          this.sendPrompt(parsed.prompt);
          return;
        }
      } catch {
        // Fall through to plain text handling
      }
      this.write(text);
    });
  }

  removeWsClient(ws: WebSocket): void {
    this.wsClients.delete(ws);
  }

  getBufferSnapshot(): Buffer {
    return Buffer.alloc(0);
  }

  getStreamEvents(): ConsoleStreamEvent[] {
    return [...this.eventLog];
  }

  ingestStructuredEvent(event: ConsoleStreamEvent): void {
    this.storeAndBroadcast(event);
  }

  ingestText(data: string): void {
    this.write(data);
  }

  // ---- Private implementation ----

  private async processPromptQueue(): Promise<void> {
    if (this.processing || this.destroyed) {
      return;
    }

    this.processing = true;
    try {
      if (this.meta.status !== "running") {
        this.start();
      }

      while (this.promptQueue.length > 0 && !this.destroyed) {
        if (this.meta.status === "crashed" || this.meta.status === "stopped") {
          this.promptQueue = [];
          break;
        }
        const prompt = this.promptQueue.shift();
        if (!prompt) {
          continue;
        }
        await this.runPrompt(prompt);
      }
    } finally {
      this.processing = false;
      // Transition to stopped when queue is fully drained (mirrors SDK backend behavior)
      if (!this.destroyed && this.promptQueue.length === 0 && this.meta.status === "running") {
        const now = Date.now();
        this.meta = { ...this.meta, status: "stopped", stopped_at: now, updated_at: now };
        this.emitMetaUpdate({ status: "stopped", stopped_at: now, updated_at: now });
        this.emitStatus({ kind: "stopped", status: "stopped", stopped_at: now });
      }
    }
  }

  private runPrompt(prompt: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const cwd = this.meta.cwd ?? process.env.HOME ?? "/tmp";
      const invocation = this.buildPromptInvocation(prompt, cwd);
      if (!invocation) {
        this.storeAndBroadcast({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [`Unsupported command for spawn backend: ${this.meta.command}`],
          session_id: this.meta.provider_session_id ?? this.id,
          duration_ms: 0,
          num_turns: 0,
          total_cost_usd: 0,
        });
        resolve();
        return;
      }

      const env = this.buildCleanEnv(this.meta.env ?? {});
      const existingSessionId = this.meta.provider_session_id ?? this.id;

      if (invocation.injectUserEvent) {
        this.storeAndBroadcast(this.makeUserEvent(prompt, existingSessionId));
      }

      const child = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.childProc = child;

      if (child.pid) {
        this.meta = { ...this.meta, pid: child.pid, updated_at: Date.now() };
        this.emitMetaUpdate({ pid: child.pid, updated_at: this.meta.updated_at });
      }

      let lineBuffer = "";
      let sawResult = false;
      const codexState: CodexNormalizerState = {
        threadId: this.meta.provider_session_id,
        turnCount: 0,
        model: extractModel(this.meta.args),
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString("utf8");
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          if (invocation.normalize === "claude") {
            // Claude stream-json lines are ingested as structured events
            this.parseAndIngestJsonLine(line);
            if (line.includes("\"type\":\"result\"")) {
              sawResult = true;
            }
          } else if (invocation.normalize === "gemini") {
            const event = normalizeGeminiStreamLine(line);
            if (event) {
              if (event.type === "result") sawResult = true;
              this.storeAndBroadcast(event);
            }
          } else {
            const event = normalizeCodexStreamLine(line, codexState);
            if (event) {
              if (event.type === "result") sawResult = true;
              this.storeAndBroadcast(event);
            }
          }
        }
      });

      let stderrBuf = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
      });

      let completed = false;
      const complete = () => {
        if (completed) {
          return false;
        }
        completed = true;
        return true;
      };

      child.on("close", (code) => {
        if (!complete()) {
          return;
        }
        // Flush remaining line buffer
        if (lineBuffer.trim()) {
          if (invocation.normalize === "claude") {
            this.parseAndIngestJsonLine(lineBuffer);
            if (lineBuffer.includes("\"type\":\"result\"")) {
              sawResult = true;
            }
          } else if (invocation.normalize === "gemini") {
            const event = normalizeGeminiStreamLine(lineBuffer);
            if (event) {
              if (event.type === "result") sawResult = true;
              this.storeAndBroadcast(event);
            }
          } else {
            const event = normalizeCodexStreamLine(lineBuffer, codexState);
            if (event) {
              if (event.type === "result") sawResult = true;
              this.storeAndBroadcast(event);
            }
          }
        }

        // Emit error result if process failed and no result was emitted
        if (code !== 0 && stderrBuf.trim() && !sawResult) {
          const errMsg = stderrBuf.trim().slice(0, 500);
          this.storeAndBroadcast({
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

        if (this.childProc === child) {
          this.childProc = null;
          this.meta = { ...this.meta, pid: null, updated_at: Date.now() };
          this.emitMetaUpdate({ pid: null, updated_at: this.meta.updated_at });
        }

        // Handle crash/restart
        if (code !== null && code > 0 && this.meta.auto_restart && !this.destroyed) {
          this.handleCrashedRestart(code);
        }

        resolve();
      });

      child.on("error", (err) => {
        if (!complete()) {
          return;
        }
        this.logger("error", "spawn_child_error", { id: this.id, error: String(err) });
        if (!sawResult) {
          this.storeAndBroadcast({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: [String(err)],
            session_id: existingSessionId,
            duration_ms: 0,
            num_turns: 0,
            total_cost_usd: 0,
          });
        }
        if (this.childProc === child) {
          this.childProc = null;
          this.meta = { ...this.meta, pid: null, updated_at: Date.now() };
          this.emitMetaUpdate({ pid: null, updated_at: this.meta.updated_at });
        }
        resolve();
      });
    });
  }

  private handleCrashedRestart(exitCode: number): void {
    this.restartAttempts += 1;
    if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
      this.logger("warn", "spawn_restart_limit_reached", {
        id: this.id,
        attempts: this.restartAttempts - 1,
      });
      const now = Date.now();
      this.meta = {
        ...this.meta,
        status: "crashed",
        exit_code: exitCode,
        auto_restart: false,
        updated_at: now,
      };
      this.emitMetaUpdate({ status: "crashed", exit_code: exitCode, updated_at: now });
      this.emitStatus({
        kind: "exit",
        status: "crashed",
        exitCode,
        signal: null,
        stopped_at: now,
      });
      return;
    }

    const delay = BASE_RESTART_DELAY_MS * Math.pow(2, this.restartAttempts - 1);
    this.logger("info", "spawn_auto_restart_scheduled", {
      id: this.id,
      delay,
      attempt: this.restartAttempts,
    });
    const timer = setTimeout(() => {
      if (this.meta.auto_restart && !this.destroyed) {
        this.logger("info", "spawn_auto_restart", { id: this.id, attempt: this.restartAttempts });
        this.start();
      }
    }, delay);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }
  }

  private parseAndIngestJsonLine(line: string): void {
    const stripped = line.trim();
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
    this.storeAndBroadcast(parsed as ConsoleStreamEvent);
  }

  private storeAndBroadcast(event: ConsoleStreamEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > STREAM_EVENTS_LIMIT) {
      this.eventLog = this.eventLog.slice(this.eventLog.length - STREAM_EVENTS_LIMIT);
    }

    // Track provider_session_id from events
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

    // Broadcast to WebSocket clients
    const payload = JSON.stringify(event);
    for (const ws of this.wsClients) {
      try {
        ws.send(payload);
      } catch {
        this.removeWsClient(ws);
      }
    }

    this.emit("stream_event", event);
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
    cwd: string,
  ): {
    command: string;
    args: string[];
    injectUserEvent: boolean;
    normalize: "claude" | "codex" | "gemini";
  } | null {
    const model = extractModel(this.meta.args);

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

  private buildCleanEnv(extraEnv: Record<string, string>): Record<string, string> {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (POLLUTED_ENV_KEYS_EXACT.has(k)) continue;
      if (POLLUTED_ENV_KEYS_PREFIX.some((prefix) => k.startsWith(prefix))) continue;
      cleaned[k] = v;
    }
    Object.assign(cleaned, extraEnv);
    projectManagedProviderIdentity(cleaned, this.meta.command, this.meta.provider_session_id, this.meta.mandible_session_id ?? this.id);
    delete cleaned.MANDIBLE_TOKEN;
    cleaned.MANDIBLE_MANAGED_CLIENT = "1";
    if (needsManagedHttpCredential(cleaned)) {
      const mandibleToken = typeof this.mandibleTokenSource === "function"
        ? this.mandibleTokenSource()
        : this.mandibleTokenSource;
      if (mandibleToken) cleaned.MANDIBLE_TOKEN = mandibleToken;
    }
    return cleaned;
  }


  private emitMetaUpdate(fields: BackendMetaUpdate): void {
    this.emit("meta_update", fields);
  }

  private emitStatus(event: BackendStatusEvent): void {
    this.emit("status", event);
  }
}
