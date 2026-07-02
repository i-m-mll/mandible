import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type {
  AgenticBackend,
  BackendMetaUpdate,
  BackendStatusEvent,
  ConfigurableBackend,
  PermissionAwareBackend,
  PermissionDecision,
  PermissionRequest,
  UsageAwareBackend,
} from "../agentic-backend.js";
import type { ConsoleSession, ConsoleStreamEvent, Logger } from "../types.js";
import {
  acpPermissionOutcome,
  createAcpMapperState,
  makeAcpUserEvent,
  normalizeAcpIncoming,
  normalizeAcpUsage,
  parseAcpNdjsonLine,
  type AcpJsonRpcMessage,
  type AcpMapperState,
  type JsonRpcId,
} from "./acp-protocol.js";
import { suppressAcpIngestForSession } from "../ingestion.js";

const EVENT_LOG_LIMIT = 2000;
const PERMISSION_TIMEOUT_MS = 120_000;

const POLLUTED_ENV_KEYS_PREFIX = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];
const POLLUTED_ENV_KEYS_EXACT = new Set([
  "CLAUDECODE",
  "GIT_CONFIG_COUNT",
]);

interface PendingPermission {
  request: PermissionRequest;
  responseId: JsonRpcId;
  timeout: NodeJS.Timeout;
}

export interface AcpBackendOptions {
  model?: string;
  allowedTools?: string[];
}

export class AcpBackend extends EventEmitter
implements
  AgenticBackend,
  PermissionAwareBackend,
  ConfigurableBackend<AcpBackendOptions>,
  UsageAwareBackend<Record<string, unknown>> {
  readonly id: string;
  meta: ConsoleSession;

  private childProc: ChildProcess | null = null;
  private wsClients: Set<WebSocket> = new Set();
  private eventLog: ConsoleStreamEvent[] = [];
  private usageLog: Record<string, unknown>[] = [];
  private logger: Logger;
  private lineBuffer = "";
  private nextRequestId = 1;
  private promptQueue: string[] = [];
  private processing = false;
  private ready = false;
  private starting = false;
  private destroyed = false;
  private stopping = false;
  private mapper: AcpMapperState;
  private autoAllowedTools: Set<string>;
  private pendingPermissions: Map<string, PendingPermission> = new Map();

  get isProcessing(): boolean {
    return this.processing;
  }

  constructor(meta: ConsoleSession, logger: Logger) {
    super();
    this.id = meta.id;
    this.meta = meta;
    this.logger = logger;
    this.autoAllowedTools = new Set(meta.allowed_tools ?? []);
    this.mapper = createAcpMapperState({
      sessionId: meta.provider_session_id,
      model: this.extractModel(meta.args),
    });
  }

  start(): void {
    if (this.destroyed || this.meta.status === "running" || this.starting) {
      return;
    }

    this.starting = true;
    void this.launch().finally(() => {
      this.starting = false;
    });
  }

  stop(_signal?: string): void {
    this.promptQueue = [];
    this.resolveAllPendingPermissions("deny");
    this.cancelActivePrompt();
    this.stopping = true;

    if (this.childProc) {
      try {
        this.childProc.kill("SIGTERM");
      } catch {
        // Process may already be gone.
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
    this.emitMetaUpdate({ status: "stopped", pid: null, stopped_at: now, updated_at: now });
    this.emitStatus({ kind: "stopped", status: "stopped", stopped_at: now });
    this.logger("info", "acp_stopped", { id: this.id });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.promptQueue = [];
    this.resolveAllPendingPermissions("deny");
    this.stop("SIGTERM");
    this.wsClients.clear();
  }

  clear(): void {
    this.eventLog = [];
    this.usageLog = [];
    this.lineBuffer = "";
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
    if (!/[\r\n]/.test(data)) {
      return;
    }
    const prompt = data.trim();
    if (prompt) {
      this.sendPrompt(prompt);
    }
  }

  resize(cols: number, rows: number): void {
    this.meta = { ...this.meta, cols, rows, updated_at: Date.now() };
    this.emitMetaUpdate({ cols, rows, updated_at: this.meta.updated_at });
  }

  addWsClient(ws: WebSocket): void {
    this.wsClients.add(ws);

    try {
      ws.send(JSON.stringify({ type: "init", session: this.meta }));
      for (const event of this.eventLog) {
        ws.send(JSON.stringify(event));
      }
    } catch (error) {
      this.logger("warn", "acp_ws_init_failed", { id: this.id, error: String(error) });
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
        // Fall through to newline prompt handling.
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

  updateOptions(options: AcpBackendOptions): void {
    if (options.allowedTools !== undefined) {
      this.autoAllowedTools = new Set(options.allowedTools);
      this.meta = {
        ...this.meta,
        allowed_tools: [...this.autoAllowedTools],
        updated_at: Date.now(),
      };
      this.emitMetaUpdate({
        allowed_tools: [...this.autoAllowedTools],
        updated_at: this.meta.updated_at,
      });
    }

    if (typeof options.model === "string") {
      this.mapper.model = options.model.trim() || null;
    }
  }

  getPendingPermissions(): PermissionRequest[] {
    return Array.from(this.pendingPermissions.values())
      .map((entry) => entry.request)
      .sort((left, right) => left.created_at - right.created_at);
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    if (decision.startsWith("option:")) {
      return false;
    }
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return false;
    }
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timeout);

    if (decision === "allow_always") {
      this.autoAllowedTools.add(pending.request.tool_name);
      this.meta = {
        ...this.meta,
        allowed_tools: [...this.autoAllowedTools],
        updated_at: Date.now(),
      };
      this.emitMetaUpdate({
        allowed_tools: [...this.autoAllowedTools],
        updated_at: this.meta.updated_at,
      });
    }

    this.respondToPermission(pending.responseId, decision);
    return true;
  }

  getUsage(): Record<string, unknown>[] {
    return [...this.usageLog];
  }

  private async launch(): Promise<void> {
    if (this.meta.command !== "gemini") {
      this.markCrashed(`Unsupported ACP command: ${this.meta.command}`);
      return;
    }

    const flag = await probeGeminiAcpFlag(this.meta.command, this.buildCleanEnv(this.meta.env));
    if (!flag) {
      this.markCrashed("Gemini CLI does not advertise --acp or --experimental-acp");
      return;
    }

    const args = this.buildLaunchArgs(flag);
    const cwd = this.meta.cwd ?? process.env.HOME ?? "/tmp";

    try {
      this.childProc = spawn(this.meta.command, args, {
        cwd,
        env: this.buildCleanEnv(this.meta.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.markCrashed(String(error));
      return;
    }

    const child = this.childProc;
    child.stdout?.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.logger("debug", "acp_stderr", { id: this.id, text: text.slice(0, 1000) });
      }
    });
    child.on("close", (code, signal) => this.handleClose(code, signal));
    child.on("error", (error) => this.markCrashed(String(error)));

    const now = Date.now();
    this.meta = {
      ...this.meta,
      status: "running",
      pid: child.pid ?? null,
      exit_code: null,
      started_at: this.meta.started_at ?? now,
      stopped_at: null,
      updated_at: now,
    };
    this.emitMetaUpdate({
      status: "running",
      pid: child.pid ?? null,
      exit_code: null,
      started_at: this.meta.started_at,
      stopped_at: null,
      updated_at: now,
    });
    this.emitStatus({ kind: "started", status: "running", started_at: this.meta.started_at });

    this.sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "Mandible", version: "0.1.0" },
      capabilities: { fs: false, terminal: false },
    });
    this.sendRequest("authenticate", { methodId: "oauth-personal" });
    this.sendRequest("session/new", {
      cwd,
      ...(this.meta.provider_session_id ? { sessionId: this.meta.provider_session_id } : {}),
    });
    this.ready = true;
    if (this.processing) {
      this.sendNextPrompt();
    }
  }

  private async processPromptQueue(): Promise<void> {
    if (this.processing || this.destroyed) {
      return;
    }
    this.setProcessing(true);
    if (this.meta.status !== "running") {
      this.start();
    }
    if (this.ready) {
      this.sendNextPrompt();
    }
  }

  private sendNextPrompt(): void {
    if (!this.ready || !this.childProc || this.destroyed) {
      return;
    }
    const prompt = this.promptQueue.shift();
    if (!prompt) {
      this.setProcessing(false);
      return;
    }

    const sessionId = this.meta.provider_session_id ?? this.mapper.sessionId ?? this.id;
    this.storeAndBroadcast(makeAcpUserEvent(prompt, sessionId));
    this.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
      cwd: this.meta.cwd ?? process.cwd(),
    });
  }

  private cancelActivePrompt(): void {
    if (!this.childProc || !this.ready) {
      return;
    }
    const sessionId = this.meta.provider_session_id ?? this.mapper.sessionId ?? this.id;
    this.sendRequest("session/cancel", { sessionId });
    this.storeAndBroadcast({
      type: "result",
      subtype: "cancelled",
      session_id: sessionId,
      duration_ms: 0,
      num_turns: this.mapper.turnCount,
      total_cost_usd: 0,
      is_error: true,
      errors: ["cancelled"],
      stopReason: "cancelled",
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.lineBuffer += chunk.toString("utf8");
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = parseAcpNdjsonLine(line);
      if (message) {
        this.handleMessage(message);
      }
    }
  }

  private handleMessage(message: AcpJsonRpcMessage): void {
    const normalized = normalizeAcpIncoming(message, this.mapper, this.id);
    for (const event of normalized.events) {
      this.storeAndBroadcast(event);
      if (event.type === "result") {
        if (this.promptQueue.length > 0) {
          this.sendNextPrompt();
        } else {
          this.setProcessing(false);
        }
      }
    }

    if (normalized.permission) {
      const toolName = normalized.permission.request.tool_name;
      if (this.autoAllowedTools.has(toolName)) {
        this.respondToPermission(normalized.permission.responseId, "allow_always");
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingPermissions.delete(normalized.permission!.request.id);
        this.respondToPermission(normalized.permission!.responseId, "deny");
      }, PERMISSION_TIMEOUT_MS);
      if (typeof timeout === "object" && "unref" in timeout) {
        timeout.unref();
      }
      this.pendingPermissions.set(normalized.permission.request.id, {
        request: normalized.permission.request,
        responseId: normalized.permission.responseId,
        timeout,
      });
      this.emit("permission", normalized.permission.request);
    }

    if (this.mapper.cumulativeUsage) {
      this.usageLog = [{
        console_session_id: this.id,
        provider_session_id: this.meta.provider_session_id ?? this.mapper.sessionId,
        recorded_at: Date.now(),
        usage: this.mapper.cumulativeUsage,
        ...normalizeAcpUsage(this.mapper.cumulativeUsage),
      }];
    }
  }

  private respondToPermission(responseId: JsonRpcId, decision: PermissionDecision): void {
    if (responseId === null || responseId === undefined) {
      return;
    }
    this.writeJson({
      jsonrpc: "2.0",
      id: responseId,
      result: { outcome: acpPermissionOutcome(decision) },
    });
  }

  private resolveAllPendingPermissions(decision: PermissionDecision): void {
    for (const [id, pending] of this.pendingPermissions) {
      clearTimeout(pending.timeout);
      this.respondToPermission(pending.responseId, decision);
      this.pendingPermissions.delete(id);
    }
  }

  private setProcessing(processing: boolean): void {
    if (this.processing === processing) {
      return;
    }
    this.processing = processing;
    this.meta = { ...this.meta, is_processing: processing, updated_at: Date.now() };
    this.emitMetaUpdate({ updated_at: this.meta.updated_at });
  }

  private sendRequest(method: string, params?: Record<string, unknown>): number {
    const id = this.nextRequestId++;
    this.writeJson({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  private writeJson(payload: Record<string, unknown>): void {
    if (!this.childProc?.stdin?.writable) {
      return;
    }
    this.childProc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private storeAndBroadcast(event: ConsoleStreamEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > EVENT_LOG_LIMIT) {
      this.eventLog = this.eventLog.slice(this.eventLog.length - EVENT_LOG_LIMIT);
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
      suppressAcpIngestForSession(this.meta.command, providerSessionId);
      this.emitMetaUpdate({ provider_session_id: providerSessionId, updated_at: updatedAt });
    }

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

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.ready = false;
    this.childProc = null;
    this.resolveAllPendingPermissions("deny");

    if (this.destroyed) {
      return;
    }

    const now = Date.now();
    const status = this.stopping || code === 0 ? "stopped" : "crashed";
    this.meta = {
      ...this.meta,
      status,
      pid: null,
      exit_code: code,
      stopped_at: now,
      updated_at: now,
    };
    this.emitMetaUpdate({ status, pid: null, exit_code: code, stopped_at: now, updated_at: now });
    this.emitStatus({
      kind: status === "stopped" ? "stopped" : "exit",
      status,
      exitCode: code ?? undefined,
      signal,
      stopped_at: now,
    });
  }

  private markCrashed(message: string): void {
    this.logger("error", "acp_failed", { id: this.id, error: message });
    const now = Date.now();
    this.meta = {
      ...this.meta,
      status: "crashed",
      pid: null,
      exit_code: -1,
      stopped_at: now,
      updated_at: now,
    };
    this.emitMetaUpdate({ status: "crashed", pid: null, exit_code: -1, stopped_at: now, updated_at: now });
    this.emitStatus({ kind: "exit", status: "crashed", exitCode: -1, signal: null, stopped_at: now });
    this.storeAndBroadcast({
      type: "result",
      subtype: "error_during_execution",
      session_id: this.meta.provider_session_id ?? this.id,
      duration_ms: 0,
      num_turns: 0,
      total_cost_usd: 0,
      is_error: true,
      errors: [message],
    });
  }

  private buildLaunchArgs(flag: string): string[] {
    const args = [flag];
    const model = this.extractModel(this.meta.args);
    if (model) {
      args.push("--model", model);
    }
    return args;
  }

  private buildCleanEnv(extraEnv: Record<string, string>): Record<string, string> {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (POLLUTED_ENV_KEYS_EXACT.has(key)) continue;
      if (POLLUTED_ENV_KEYS_PREFIX.some((prefix) => key.startsWith(prefix))) continue;
      cleaned[key] = value;
    }
    Object.assign(cleaned, extraEnv);
    return cleaned;
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

  private emitMetaUpdate(fields: BackendMetaUpdate): void {
    this.emit("meta_update", fields);
  }

  private emitStatus(event: BackendStatusEvent): void {
    this.emit("status", event);
  }
}

export async function probeGeminiAcpFlag(
  command = "gemini",
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, ["--help"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const done = (flag: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(flag);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => done(null));
    child.on("close", () => {
      const flags = new Set(output.match(/--[a-z0-9-]+/gi) ?? []);
      if (flags.has("--acp")) {
        done("--acp");
        return;
      }
      if (flags.has("--experimental-acp")) {
        done("--experimental-acp");
        return;
      }
      done(null);
    });
  });
}
