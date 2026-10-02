import { needsManagedHttpCredential, projectManagedProviderIdentity } from "./mandible-transport.js";
// Bug: 9bf8b4c — Claude Agent SDK backend for Console
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookInput,
  McpStdioServerConfig,
  Options as ClaudeSDKOptions,
  PermissionMode as ClaudePermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query as ClaudeQuery,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKUserMessage,
  WarmQuery as ClaudeWarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
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
  ToolPolicyBackend,
} from "../agentic-backend.js";
import type {
  ConsoleContentBlock,
  ConsoleSession,
  ConsoleStreamEvent,
  Logger,
} from "../types.js";
import { SessionRegistry } from "../registry.js";
import { getDb } from "../db.js";
import {
  DEFAULT_SDK_PERMISSION_MODE,
  describeAnthropicBilling,
} from "../claude-lane-policy.js";
import { withMandibleInstructionsFragment } from "../instructions/fragment.js";
import {
  composeRunOptions,
  declaredRunOptionsSnapshot,
  validateRunOptionsPatch,
  type BackendRunOptionDeclaration,
  type ProviderRunOption,
  type SessionRunOptionValue,
  type SessionRunOptionsPatch,
  type SessionRunOptionsSnapshot,
  type SessionRunOptionsUpdateResult,
} from "../session-run-options.js";
import {
  CLAUDE_CODE_BOOTSTRAP_EFFORTS,
  CLAUDE_CODE_BOOTSTRAP_MODELS,
} from "../provider-run-option-catalog.js";
import { extractModel } from "./cli-args.js";
import { claudeSdkProvenance } from "../provider-provenance.js";
import { ProviderStartupError } from "../provider-startup.js";

const EVENT_LOG_LIMIT = 2000;
export const SDK_USAGE_LOG_LIMIT = EVENT_LOG_LIMIT;
const PERMISSION_TIMEOUT_MS = 120_000;

type UsageRow = Record<string, unknown>;
type SDKThinkingEffort = ClaudeSDKOptions["effort"];

interface PendingPermission {
  request: PermissionRequest;
  suggestions?: PermissionUpdate[];
  resolve: (decision: PermissionDecision) => void;
  timeout: NodeJS.Timeout;
}

interface SubagentInfo {
  agent_id: string;
  agent_type: string;
  started_at: number;
}

export interface SDKBackendOptions {
  model?: string;
  thinkingEffort?: SDKThinkingEffort;
  systemPrompt?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  allowedTools?: string[];
  maxTurns?: number;
  maxCostUsd?: number;
  /** Bug: 61bee4e — Explicit settingSources override for this session */
  settingSourcesOverride?: string[];
}

const SDK_RUN_OPTIONS: BackendRunOptionDeclaration["options"] = [
  {
    id: "model", label: "Model", category: "model", kind: "select", nullable: true,
    discovery: {
      kind: "static_then_provider", protocol: "sdk_supported_models", providerOptionId: "model",
      staticAllowedValues: CLAUDE_CODE_BOOTSTRAP_MODELS,
    },
    support: { status: "supported", owner: "provider", effectiveFrom: "next_prompt" }, applyOrder: 10,
    legacyRequestKeys: ["model"],
  },
  {
    id: "thinking_effort", label: "Thinking effort", category: "thought_level", kind: "select", nullable: true,
    discovery: {
      kind: "static_then_provider", protocol: "sdk_supported_models", providerOptionId: "thinking_effort",
      staticAllowedValues: CLAUDE_CODE_BOOTSTRAP_EFFORTS,
    },
    support: { status: "supported", owner: "backend", effectiveFrom: "next_prompt" }, applyOrder: 20,
    applyAfter: ["model"], legacyRequestKeys: ["thinkingEffort"],
  },
  {
    id: "permission_mode", label: "Permission mode", category: "mode", kind: "select", nullable: true,
    defaultValue: "default",
    discovery: { kind: "static", allowedValues: [
      { value: "default", label: "Ask for approval" }, { value: "acceptEdits", label: "Accept edits" },
      { value: "bypassPermissions", label: "Bypass permissions" },
    ] },
    support: { status: "supported", owner: "backend", effectiveFrom: "immediate" }, applyOrder: 30,
    legacyRequestKeys: ["permissionMode"],
  },
  {
    id: "max_turns", label: "Maximum turns", category: "limit", kind: "integer", nullable: true,
    discovery: { kind: "static", allowedValues: null },
    support: { status: "supported", owner: "backend", effectiveFrom: "next_prompt" }, applyOrder: 40,
    legacyRequestKeys: ["maxTurns"],
  },
  {
    id: "max_cost_usd", label: "Maximum cost (USD)", category: "limit", kind: "number", nullable: true,
    discovery: { kind: "static", allowedValues: null },
    support: { status: "supported", owner: "backend", effectiveFrom: "next_prompt" }, applyOrder: 50,
    legacyRequestKeys: ["maxCostUsd"],
  },
  {
    id: "system_prompt", label: "System prompt", category: "prompt", kind: "text", nullable: true,
    discovery: { kind: "static", allowedValues: null },
    support: { status: "supported", owner: "backend", effectiveFrom: "next_prompt" }, applyOrder: 60,
    legacyRequestKeys: ["systemPrompt"],
  },
  {
    id: "setting_sources", label: "Claude settings", category: "settings", kind: "multi_select", nullable: true,
    description: "Choose which Claude Code settings files to load. User is your global settings; Project is the shared project settings; Local is this checkout's unshared settings. These sources can affect permissions, hooks, plugins, and other SDK behavior; they do not add instruction files to the system prompt.",
    discovery: { kind: "static", allowedValues: [
      { value: "user", label: "User" },
      { value: "project", label: "Project" },
      { value: "local", label: "Local" },
    ] },
    support: { status: "supported", owner: "backend", effectiveFrom: "next_prompt" }, applyOrder: 70,
    legacyRequestKeys: ["settingSourcesOverride"],
  },
];

export function getSdkRunOptionDeclaration(command: string): BackendRunOptionDeclaration {
  return { backendType: "sdk", command, options: SDK_RUN_OPTIONS };
}

export function buildMandibleChannelEnvironment(
  sessionId: string,
  cwd: string,
  providerSessionId: string,
  mandibleToken: string | null,
  transportEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    MANDIBLE_SESSION_ID: sessionId,
    MANDIBLE_MANAGED_APP: "claude",
    CLAUDE_CODE_SESSION_ID: providerSessionId,
    MANDIBLE_MANAGED_CLIENT: "1",
    CLAUDE_CWD: cwd,
    ...(transportEnv.MANDIBLE_BASE ? { MANDIBLE_BASE: transportEnv.MANDIBLE_BASE } : {}),
    ...(transportEnv.MANDIBLE_SOCKET ? { MANDIBLE_SOCKET: transportEnv.MANDIBLE_SOCKET } : {}),
    ...(transportEnv.MANDIBLE_TRANSPORT ? { MANDIBLE_TRANSPORT: transportEnv.MANDIBLE_TRANSPORT } : {}),
    ...(needsManagedHttpCredential(transportEnv) && mandibleToken ? { MANDIBLE_TOKEN: mandibleToken } : {}),
  };
}

export class SDKBackend extends EventEmitter
implements
  AgenticBackend,
  PermissionAwareBackend,
  ConfigurableBackend,
  ToolPolicyBackend,
  UsageAwareBackend<UsageRow> {
  readonly id: string;
  meta: ConsoleSession;

  private logger: Logger;
  private sessionRegistry?: SessionRegistry;
  private wsClients: Set<WebSocket> = new Set();
  private eventLog: ConsoleStreamEvent[] = [];
  private usageLog: UsageRow[] = [];
  private options: SDKBackendOptions;
  private autoAllowedTools: Set<string>;
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private subagentTree: Map<string, SubagentInfo> = new Map();
  private promptQueue: string[] = [];
  private processing = false;
  private activeQuery: ClaudeQuery | null = null;
  private abortController: AbortController | null = null;
  private warmQuery: ClaudeWarmQuery | null = null;
  private warmAbortController: AbortController | null = null;
  private destroyed = false;
  private expectedProviderSessionId: string | null = null;
  /** Issue 8aadf70 — log the API-key/subscription posture once per backend. */
  private billingPostureLogged = false;
  private readonly mandibleTokenSource: string | (() => string | null) | null;
  /** Bug: 790433d — Message index counter for parameter snapshots */
  private messageIndex = 0;
  readonly runOptionDeclaration: BackendRunOptionDeclaration;
  private runOptionsSnapshot: SessionRunOptionsSnapshot;

  /** Bug: 81c9d85 — expose processing state for is_processing on ConsoleSession */
  get isProcessing(): boolean {
    return this.processing;
  }

  getStartupProvenance() {
    return claudeSdkProvenance();
  }

  constructor(
    meta: ConsoleSession,
    logger: Logger,
    sessionRegistry?: SessionRegistry,
    mandibleToken: string | (() => string | null) | null = null,
  ) {
    super();
    this.id = meta.id;
    this.meta = meta;
    this.logger = logger;
    this.sessionRegistry = sessionRegistry;
    this.mandibleTokenSource = mandibleToken;
    this.autoAllowedTools = new Set(meta.allowed_tools ?? []);
    this.runOptionDeclaration = getSdkRunOptionDeclaration(meta.command);
    this.runOptionsSnapshot = declaredRunOptionsSnapshot(this.runOptionDeclaration, "ready");
    this.options = {
      model: extractModel(meta.args) ?? undefined,
      allowedTools: meta.allowed_tools ?? undefined,
    };
  }

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
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    if (this.destroyed) throw new ProviderStartupError(
      "provider_startup_failed",
      "Claude startup was discarded before it became ready.",
      "readiness",
    );
    if (this.warmQuery) return;
    this.start();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.warmAbortController = abortController;
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const warmQuery = await sdk.startup({ options: this.buildQueryOptions(abortController) });
      if (this.destroyed || abortController.signal.aborted) {
        warmQuery.close();
        throw new ProviderStartupError(
          "client_aborted",
          "The client disconnected during provider startup.",
          "readiness",
        );
      }
      this.warmQuery = warmQuery;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (!this.warmQuery) this.warmAbortController = null;
    }
  }

  stop(_signal?: string): void {
    this.promptQueue = [];
    this.resolveAllPendingPermissions("deny");
    this.discardWarmQuery();
    void this.cancelActiveQuery();

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
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.promptQueue = [];
    this.discardWarmQuery();

    // Reject all pending permission promises immediately so callers don't
    // hang for up to PERMISSION_TIMEOUT_MS after the session is gone.
    for (const [id, pending] of this.pendingPermissions) {
      clearTimeout(pending.timeout);
      pending.resolve("deny");
      this.pendingPermissions.delete(id);
    }

    void this.cancelActiveQuery();
    this.wsClients.clear();
  }

  clear(): void {
    this.eventLog = [];
    this.usageLog = [];
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
    this.meta = {
      ...this.meta,
      cols,
      rows,
      updated_at: Date.now(),
    };
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
      this.logger("warn", "sdk_ws_init_failed", { id: this.id, error: String(error) });
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
        if (parsed.type === "resize") {
          return;
        }
      } catch {
        // Fall back to newline-based prompt detection for plain text frames.
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

  getRunOptions(): SessionRunOptionsSnapshot {
    const values: Record<string, SessionRunOptionValue> = {
      model: this.options.model ?? null,
      thinking_effort: this.options.thinkingEffort ?? null,
      permission_mode: this.options.permissionMode ?? null,
      max_turns: this.options.maxTurns ?? null,
      max_cost_usd: this.options.maxCostUsd ?? null,
      system_prompt: this.options.systemPrompt ?? null,
      setting_sources: this.options.settingSourcesOverride ?? null,
    };
    return { ...this.runOptionsSnapshot, options: this.runOptionsSnapshot.options.map((option) => ({
      ...option, currentValue: values[option.id] ?? option.currentValue,
    })) };
  }

  async applyRunOptions(patch: SessionRunOptionsPatch): Promise<SessionRunOptionsUpdateResult> {
    const snapshot = this.getRunOptions();
    const ordered = validateRunOptionsPatch(this.runOptionDeclaration, snapshot, patch);
    const next = { ...this.options };
    const applied: SessionRunOptionsUpdateResult["applied"][number][] = [];
    for (const declaration of ordered) {
      const value = patch.values[declaration.id];
      if (declaration.id === "model") {
        if (this.activeQuery) await this.activeQuery.setModel(typeof value === "string" ? value || undefined : undefined);
        next.model = typeof value === "string" ? value : undefined;
        if (this.activeQuery) await this.refreshSupportedModels(this.activeQuery, next.model);
      } else if (declaration.id === "permission_mode") {
        if (this.activeQuery && typeof value === "string") await this.activeQuery.setPermissionMode(value as ClaudePermissionMode);
        next.permissionMode = typeof value === "string" ? value as SDKBackendOptions["permissionMode"] : undefined;
      } else if (declaration.id === "thinking_effort") next.thinkingEffort = value as SDKThinkingEffort;
      else if (declaration.id === "max_turns") next.maxTurns = typeof value === "number" ? value : undefined;
      else if (declaration.id === "max_cost_usd") next.maxCostUsd = typeof value === "number" ? value : undefined;
      else if (declaration.id === "system_prompt") next.systemPrompt = typeof value === "string" ? value : undefined;
      else if (declaration.id === "setting_sources") next.settingSourcesOverride = Array.isArray(value) ? value : undefined;
      applied.push({ id: declaration.id, requestedValue: value, currentValue: value,
        effectiveFrom: declaration.support.status === "supported" ? declaration.support.effectiveFrom : "next_prompt", status: "enforced" });
    }
    this.options = next;
    this.runOptionsSnapshot = { ...this.getRunOptions(), phase: "ready", revision: this.runOptionsSnapshot.revision + 1 };
    return { applied, snapshot: this.getRunOptions() };
  }

  setAllowedTools(tools: readonly string[]): void {
    this.autoAllowedTools = new Set(tools);
    this.options.allowedTools = [...tools];
    this.meta = { ...this.meta, allowed_tools: [...tools], updated_at: Date.now() };
    this.emitMetaUpdate({ allowed_tools: [...tools], updated_at: this.meta.updated_at });
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
      this.options.allowedTools = [...this.autoAllowedTools];
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

    pending.resolve(decision);
    return true;
  }

  getUsage(): UsageRow[] {
    return [...this.usageLog];
  }

  cancelActivePrompt(): boolean {
    const hadWork = this.processing || this.promptQueue.length > 0 || this.activeQuery !== null || this.abortController !== null;
    this.promptQueue = [];
    this.resolveAllPendingPermissions("deny");
    void this.cancelActiveQuery();

    if (hadWork) {
      this.storeAndBroadcast({
        type: "result",
        subtype: "cancelled",
        session_id: this.meta.provider_session_id ?? this.id,
        duration_ms: 0,
        num_turns: 0,
        total_cost_usd: 0,
        is_error: true,
        errors: ["cancelled"],
        stopReason: "cancelled",
      });
    }

    return hadWork;
  }

  getActiveSubagents(): SubagentInfo[] {
    return Array.from(this.subagentTree.values());
  }

  private async processPromptQueue(): Promise<void> {
    if (this.processing || this.destroyed) {
      return;
    }

    this.processing = true;
    // Bug: 81c9d85 — set Mandible session to active when processing starts
    if (this.sessionRegistry && this.meta.mandible_session_id) {
      this.sessionRegistry.setActive(this.meta.mandible_session_id);
    }
    // Bug: 81c9d85 — broadcast is_processing change
    this.meta = { ...this.meta, is_processing: true, updated_at: Date.now() };
    this.emitMetaUpdate({ updated_at: this.meta.updated_at });
    try {
      if (this.meta.status !== "running") {
        this.start();
      }

      while (this.promptQueue.length > 0 && !this.destroyed) {
        // Stop processing if the backend has entered a terminal state.
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
      // Bug: 81c9d85 — set Mandible session to idle when processing finishes
      if (this.sessionRegistry && this.meta.mandible_session_id) {
        this.sessionRegistry.setIdle(this.meta.mandible_session_id);
      }
      // Bug: 81c9d85 — broadcast is_processing change
      this.meta = { ...this.meta, is_processing: false, updated_at: Date.now() };
      this.emitMetaUpdate({ updated_at: this.meta.updated_at });
      // Bug: 2a04856 — Transition to "stopped" when the queue is fully drained so the
      // session status in the DB and SSE broadcasts reflects completion. The next
      // sendPrompt() call will re-enter processPromptQueue which calls this.start(),
      // transitioning back to "running".
      if (!this.destroyed && this.promptQueue.length === 0 && this.meta.status === "running") {
        const now = Date.now();
        this.meta = { ...this.meta, status: "stopped", stopped_at: now, updated_at: now };
        this.emitMetaUpdate({ status: "stopped", stopped_at: now, updated_at: now });
        this.emitStatus({ kind: "stopped", status: "stopped", stopped_at: now });
      }
    }
  }

  private async runPrompt(prompt: string): Promise<void> {
    const warmQuery = this.warmQuery;
    const abortController = this.warmAbortController ?? new AbortController();
    this.warmQuery = null;
    this.warmAbortController = null;
    let query: ClaudeQuery | null = null;

    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const queryOptions = this.buildQueryOptions(abortController);
      query = warmQuery ? warmQuery.query(prompt) : sdk.query({ prompt, options: queryOptions });

      this.abortController = abortController;
      this.activeQuery = query;
      void this.refreshSupportedModels(query, this.options.model);

      // Bug: 790433d — Snapshot the effective parameters for this prompt (keyframe model)
      this.snapshotMessageParams();
      this.messageIndex++;

      // Bug: 6634023 — The SDK event stream does not echo the user's prompt back.
      // Synthesize a user event so the prompt appears in the event log for hydration,
      // replay, and "View history" consistency.
      this.storeAndBroadcast({
        type: "user",
        session_id: this.meta.provider_session_id ?? this.id,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      });

      for await (const message of query) {
        const events = this.normalizeSDKEvent(message);
        for (const event of events) {
          this.storeAndBroadcast(event);
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const startupFailure = this.meta.provider_session_id === null
          ? new ProviderStartupError(
            "provider_startup_failed",
            "Claude failed before its native conversation was ready.",
            "readiness",
          )
          : null;
        if (startupFailure) {
          this.logger("error", "sdk_provider_startup_failed", { id: this.id, error: String(error) });
          this.emit("startup_error", startupFailure);
        }
        this.storeAndBroadcast({
          type: "result",
          subtype: "error_during_execution",
          session_id: this.meta.provider_session_id ?? this.id,
          duration_ms: 0,
          num_turns: 0,
          total_cost_usd: 0,
          is_error: true,
          errors: [startupFailure?.message ?? String(error)],
        });
      }
    } finally {
      this.activeQuery = null;
      this.abortController = null;

      // Bug: 73c06e8 — Clear resume_at_message after first prompt so subsequent
      // prompts don't re-use the resume point.
      if (this.meta.resume_at_message) {
        this.meta = { ...this.meta, resume_at_message: null };
        this.emitMetaUpdate({ resume_at_message: null });
      }

      if (query) {
        try {
          query.close();
        } catch {
          // Best effort cleanup.
        }
      }
    }
  }

  private discardWarmQuery(): void {
    this.warmAbortController?.abort();
    this.warmAbortController = null;
    if (!this.warmQuery) return;
    this.warmQuery.close();
    this.warmQuery = null;
  }

  private async refreshSupportedModels(query: ClaudeQuery, selectedModel?: string): Promise<void> {
    try {
      const models = await query.supportedModels();
      const selected = models.find((model) => model.value === selectedModel) ?? models[0];
      const efforts = selected?.supportedEffortLevels
        ?? Array.from(new Set(models.flatMap((model) => model.supportedEffortLevels ?? [])));
      const provider: ProviderRunOption[] = [
        {
          id: "model", label: "Model", category: "model", kind: "select",
          currentValue: selectedModel ?? selected?.value ?? null,
          allowedValues: models.map((model) => ({
            value: model.value, label: model.displayName, description: model.description,
          })),
        },
        {
          id: "thinking_effort", label: "Thinking effort", category: "thought_level", kind: "select",
          currentValue: this.options.thinkingEffort ?? null,
          allowedValues: efforts.map((effort) => ({ value: effort, label: effort[0].toUpperCase() + effort.slice(1) })),
        },
      ];
      this.runOptionsSnapshot = composeRunOptions(this.runOptionDeclaration, provider, {
        phase: "ready", revision: this.runOptionsSnapshot.revision + 1,
      });
    } catch (error) {
      this.logger("warn", "sdk_supported_models_failed", { id: this.id, error: String(error) });
    }
  }

  private buildQueryOptions(abortController: AbortController): ClaudeSDKOptions {
    const cwd = this.meta.cwd ?? process.cwd();
    // Issue 8aadf70 — the shipped default is real permission gating: mode
    // "default" plus the `canUseTool` callback below, which drives Mandible's
    // permission cards. `bypassPermissions` is only ever an explicit
    // per-session operator override, never a default.
    const permissionMode = this.options.permissionMode ?? DEFAULT_SDK_PERMISSION_MODE;
    const allowedTools = [...this.autoAllowedTools];
    const hooks = this.buildHooks();

    // Bug: 73c06e8 — Thread resume_at_message to SDK for DAG branching
    // Bug: bce7370 — Fix 4: Always pass `resume` with provider_session_id for
    // subsequent prompts so the SDK continues the same session instead of creating
    // a new one per prompt.
    const resumeOpts: Record<string, unknown> = {};
    const providerSessionId = this.meta.provider_session_id ?? randomUUID();
    this.expectedProviderSessionId = providerSessionId;
    if (this.meta.provider_session_id) {
      resumeOpts.resume = this.meta.provider_session_id;
      if (this.meta.resume_at_message) {
        resumeOpts.resumeSessionAt = this.meta.resume_at_message;
      }
    }

    let systemPrompt = this.options.systemPrompt;
    try {
      systemPrompt = withMandibleInstructionsFragment(systemPrompt);
    } catch (error) {
      this.logger(
        "warn",
        `Could not render Mandible instructions fragment for session ${this.id}: ${String(error)}`,
      );
    }

    // Bug: 61bee4e — settingSources controls more than just CLAUDE.md loading in the SDK.
    // Removing a source (e.g., "user") would prevent ALL user-level settings from loading.
    // If settingSourcesOverride is explicitly provided, honour it (the caller knows what
    // they're doing). Otherwise, always use the full set.
    type SettingSource = "user" | "project" | "local";
    const settingSources: SettingSource[] = (this.options.settingSourcesOverride ?? ["user", "project", "local"]) as SettingSource[];

    // Bug: a432b63 — Inject Mandible channel MCP server into SDK sessions
    // for inside-out integration (agent queries Mandible via channel tools).
    // Complementary to SDK hooks which provide outside-in control.
    const mcpServers = this.buildChannelMcpServers(providerSessionId);

    const provenance = this.getStartupProvenance();
    return {
      abortController,
      pathToClaudeCodeExecutable: provenance.implementation.entrypoint,
      cwd,
      env: this.buildClientEnv(providerSessionId),
      ...(!this.meta.provider_session_id ? { sessionId: providerSessionId } : {}),
      model: this.options.model ?? extractModel(this.meta.args) ?? undefined,
      systemPrompt,
      permissionMode,
      ...(permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      allowedTools,
      maxTurns: this.options.maxTurns,
      maxBudgetUsd: this.options.maxCostUsd,
      effort: this.options.thinkingEffort,
      includePartialMessages: true,
      settingSources,
      canUseTool: this.handleToolPermission,
      hooks,
      agentProgressSummaries: true,
      ...(mcpServers ? { mcpServers } : {}),
      ...resumeOpts,
    };
  }

  /**
   * Bug: a432b63 — Build MCP server configs for the Mandible channel server.
   *
   * The channel server provides inside-out integration: the agent can query
   * Mandible for inbox items, work units, issues, and submit auth requests.
   * This is complementary to SDK hooks which provide outside-in control
   * (permissions, abort, cost tracking).
   *
   * The channel server is spawned as a stdio subprocess by the SDK. It reads
   * MANDIBLE_SESSION_ID from env to link itself to the existing SDK session.
   * The ChannelRegistry uses upsert semantics, so double-registration from
   * both the SDK hook (ensureMandibleSession) and the channel server startup
   * is safe — the channel server's registration becomes a no-op update.
   */
  private buildChannelMcpServers(providerSessionId: string): Record<string, McpStdioServerConfig> | null {
    // Resolve the channel server path relative to the compiled output.
    // At runtime, __dirname is dist/backends/ and the channel server is at
    // dist/channel-server/index.js.
    const channelServerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../channel-server/index.js");

    if (!existsSync(channelServerPath)) {
      this.logger(
        "warn",
        `Channel server not found at ${channelServerPath} — skipping MCP injection for session ${this.id}`,
      );
      return null;
    }

    const sessionId = this.meta.mandible_session_id ?? this.id;
    const cwd = this.meta.cwd ?? process.cwd();
    const transportEnv = { ...process.env, ...this.meta.env };

    return {
      mandible: {
        type: "stdio",
        command: process.execPath,
        args: [channelServerPath],
        env: buildMandibleChannelEnvironment(sessionId, cwd, providerSessionId,
          needsManagedHttpCredential(transportEnv) ? this.currentMandibleToken() : null, transportEnv),
      },
    };
  }

  private buildClientEnv(providerSessionId?: string): Record<string, string | undefined> {
    const env = { ...process.env, ...this.meta.env };
    projectManagedProviderIdentity(env, this.meta.command, providerSessionId, this.meta.mandible_session_id ?? this.id);
    // The daemon may itself have been launched from a token-bearing CLI. Never
    // leak that credential into an SDK child; only the session's provisioned
    // agent credential may cross this boundary.
    delete env.MANDIBLE_TOKEN;
    env.MANDIBLE_MANAGED_CLIENT = "1";
    if (needsManagedHttpCredential(env)) {
      const mandibleToken = this.currentMandibleToken();
      if (mandibleToken) env.MANDIBLE_TOKEN = mandibleToken;
    }
    // Issue 8aadf70 — the environment we are about to hand the SDK decides
    // whether this session bills to the Anthropic API or to the operator's
    // Claude subscription. Say so once per backend rather than inheriting it
    // silently; the same posture is projected onto the session as
    // `anthropic_billing`.
    if (!this.billingPostureLogged) {
      this.billingPostureLogged = true;
      const billing = describeAnthropicBilling(env);
      this.logger(
        billing.mode === "api_key" ? "warn" : "info",
        `SDK session ${this.id} Anthropic billing: ${billing.mode}. ${billing.note}`,
      );
    }
    return env;
  }

  private currentMandibleToken(): string | null {
    return typeof this.mandibleTokenSource === "function"
      ? this.mandibleTokenSource()
      : this.mandibleTokenSource;
  }

  private buildHooks(): Partial<Record<HookInput["hook_event_name"], HookCallbackMatcher[]>> {
    return {
      SessionStart: [{
        hooks: [async (input) => {
          if (this.expectedProviderSessionId && input.session_id !== this.expectedProviderSessionId) {
            throw new Error(`Claude SDK session ID differed from the one supplied to its channel (${input.session_id} != ${this.expectedProviderSessionId})`);
          }
          const now = Date.now();
          const mandibleSessionId = this.ensureMandibleSession(input.session_id);
          this.meta = {
            ...this.meta,
            provider_session_id: input.session_id,
            mandible_session_id: mandibleSessionId,
            updated_at: now,
          };
          this.emitMetaUpdate({
            provider_session_id: input.session_id,
            mandible_session_id: mandibleSessionId,
            updated_at: now,
          });
          this.storeAndBroadcast({
            type: "system",
            subtype: "session_start",
            session_id: input.session_id,
            model: "model" in input && typeof input.model === "string" ? input.model : undefined,
            event: input as unknown as Record<string, unknown>,
          });
          return {};
        }],
      }],
      PostToolUse: [{
        hooks: [async () => {
          // TODO: verify whether Mandible needs updatedMCPToolOutput handling here. Bug: 781f473
          return {};
        }],
      }],
      SubagentStart: [{
        hooks: [async (input) => {
          const agentId = "agent_id" in input && typeof input.agent_id === "string"
            ? input.agent_id
            : null;
          const agentType = "agent_type" in input && typeof input.agent_type === "string"
            ? input.agent_type
            : null;
          if (agentId && agentType) {
            const subagent: SubagentInfo = {
              agent_id: agentId,
              agent_type: agentType,
              started_at: Date.now(),
            };
            this.subagentTree.set(agentId, subagent);
            this.storeAndBroadcast({
              type: "system",
              subtype: "subagent_start",
              session_id: input.session_id,
              agent_id: agentId,
              agent_type: agentType,
              event: input as unknown as Record<string, unknown>,
            });
          }
          return {};
        }],
      }],
      SubagentStop: [{
        hooks: [async (input) => {
          const agentId = "agent_id" in input && typeof input.agent_id === "string"
            ? input.agent_id
            : null;
          const agentType = "agent_type" in input && typeof input.agent_type === "string"
            ? input.agent_type
            : null;
          if (agentId && agentType) {
            this.subagentTree.delete(agentId);
            this.storeAndBroadcast({
              type: "system",
              subtype: "subagent_stop",
              session_id: input.session_id,
              agent_id: agentId,
              agent_type: agentType,
              event: input as unknown as Record<string, unknown>,
            });
          }
          return {};
        }],
      }],
    };
  }

  private handleToolPermission: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    if (
      this.autoAllowedTools.has(toolName) ||
      this.options.permissionMode === "bypassPermissions"
    ) {
      return { behavior: "allow" };
    }

    const created_at = Date.now();
    const request: PermissionRequest = {
      id: randomUUID(),
      session_id: this.id,
      tool_name: toolName,
      tool_input: input,
      created_at,
      expires_at: created_at + PERMISSION_TIMEOUT_MS,
      title: options.title,
      display_name: options.displayName,
      description: options.description,
      blocked_path: options.blockedPath,
      decision_reason: options.decisionReason,
      agent_id: options.agentID,
    };

    const decision = await new Promise<PermissionDecision>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingPermissions.delete(request.id);
        resolve("deny");
      }, PERMISSION_TIMEOUT_MS);

      if (typeof timeout === "object" && "unref" in timeout) {
        timeout.unref();
      }

      const onAbort = () => {
        this.pendingPermissions.delete(request.id);
        clearTimeout(timeout);
        resolve("deny");
      };

      options.signal.addEventListener("abort", onAbort, { once: true });

      this.pendingPermissions.set(request.id, {
        request,
        suggestions: options.suggestions,
        resolve: (nextDecision) => {
          options.signal.removeEventListener("abort", onAbort);
          clearTimeout(timeout);
          resolve(nextDecision);
        },
        timeout,
      });
    });

    const pending = this.pendingPermissions.get(request.id);
    if (pending) {
      this.pendingPermissions.delete(request.id);
      clearTimeout(pending.timeout);
    }

    if (decision === "deny") {
      return { behavior: "deny", message: "Permission denied by Mandible" };
    }

    return {
      behavior: "allow",
      ...(decision === "allow_always" && options.suggestions && options.suggestions.length > 0
        ? { updatedPermissions: options.suggestions }
        : {}),
    };
  };

  private normalizeSDKEvent(message: SDKMessage): ConsoleStreamEvent[] {
    switch (message.type) {
      case "system":
        return [this.normalizeSystemMessage(message)];
      case "assistant":
        return [this.normalizeAssistantMessage(message)];
      case "user":
        return [this.normalizeUserMessage(message)];
      case "result":
        return [this.normalizeResultMessage(message)];
      case "tool_progress":
        return [this.normalizeToolProgressMessage(message)];
      case "tool_use_summary":
        return [this.normalizeToolUseSummaryMessage(message)];
      case "stream_event":
        return this.normalizePartialAssistantMessage(message);
      default:
        return [message as unknown as ConsoleStreamEvent];
    }
  }

  private normalizeSystemMessage(message: Extract<SDKMessage, { type: "system" }>): ConsoleStreamEvent {
    if (message.subtype === "init") {
      return {
        type: "system",
        subtype: "init",
        session_id: message.session_id,
        model: "model" in message ? message.model : undefined,
        tools: "tools" in message ? message.tools : undefined,
        cwd: "cwd" in message ? message.cwd : undefined,
        permissionMode: "permissionMode" in message ? message.permissionMode : undefined,
        event: message as unknown as Record<string, unknown>,
      };
    }

    return {
      type: "system",
      subtype: message.subtype,
      session_id: message.session_id,
      event: message as unknown as Record<string, unknown>,
    };
  }

  private normalizeAssistantMessage(message: SDKAssistantMessage): ConsoleStreamEvent {
    return {
      type: "assistant",
      session_id: message.session_id,
      parent_tool_use_id: message.parent_tool_use_id,
      message: {
        id: message.message.id,
        role: "assistant",
        model: message.message.model,
        content: this.normalizeContentBlocks(message.message.content),
        stop_reason: message.message.stop_reason ?? null,
        usage: this.normalizeUsage(message.message.usage),
      },
      ...(message.error ? { error: message.error } : {}),
    };
  }

  private normalizeUserMessage(message: SDKUserMessage): ConsoleStreamEvent {
    return {
      type: "user",
      session_id: message.session_id,
      parent_tool_use_id: message.parent_tool_use_id,
      isSynthetic: message.isSynthetic,
      message: {
        role: "user",
        content: this.normalizeUserBlocks(message.message.content, message.tool_use_result),
      },
    };
  }

  private normalizeResultMessage(message: SDKResultMessage): ConsoleStreamEvent {
    return {
      type: "result",
      subtype: message.subtype,
      session_id: message.session_id,
      duration_ms: message.duration_ms,
      num_turns: message.num_turns,
      ...(message.type === "result" && "result" in message ? { result: message.result } : {}),
      total_cost_usd: message.total_cost_usd,
      is_error: message.is_error,
      ...("errors" in message ? { errors: message.errors } : {}),
      usage: this.normalizeRawUsage(message.usage),
      modelUsage: message.modelUsage,
      event: message as unknown as Record<string, unknown>,
    };
  }

  private normalizeToolProgressMessage(message: SDKToolProgressMessage): ConsoleStreamEvent {
    return {
      type: "tool_use",
      session_id: message.session_id,
      parent_tool_use_id: message.parent_tool_use_id,
      tool_use_id: message.tool_use_id,
      name: message.tool_name,
      elapsed_time_seconds: message.elapsed_time_seconds,
      task_id: message.task_id,
      event: message as unknown as Record<string, unknown>,
    };
  }

  private normalizeToolUseSummaryMessage(message: SDKToolUseSummaryMessage): ConsoleStreamEvent {
    return {
      type: "tool_result",
      session_id: message.session_id,
      summary: message.summary,
      preceding_tool_use_ids: message.preceding_tool_use_ids,
      event: message as unknown as Record<string, unknown>,
    };
  }

  private normalizePartialAssistantMessage(message: SDKPartialAssistantMessage): ConsoleStreamEvent[] {
    const event = message.event as unknown as Record<string, unknown>;
    const eventType = typeof event.type === "string" ? event.type : "";

    if (eventType === "content_block_start") {
      const block = this.asRecord(event.content_block);
      const blockType = typeof block?.type === "string" ? block.type : "";
      if (blockType === "thinking") {
        return [{
          type: "thinking",
          session_id: message.session_id,
          content: typeof block?.thinking === "string" ? block.thinking : "",
          event,
        }];
      }
      if (blockType === "tool_use") {
        return [{
          type: "tool_use",
          session_id: message.session_id,
          id: typeof block?.id === "string" ? block.id : "",
          name: typeof block?.name === "string" ? block.name : "",
          input: this.asRecord(block?.input) ?? {},
          event,
        }];
      }
    }

    if (eventType === "content_block_delta") {
      const delta = this.asRecord(event.delta);
      const deltaType = typeof delta?.type === "string" ? delta.type : "";
      if (deltaType === "thinking_delta") {
        return [{
          type: "thinking",
          session_id: message.session_id,
          content:
            typeof delta?.thinking === "string" ? delta.thinking
              : typeof delta?.text === "string" ? delta.text
                : "",
          event,
        }];
      }
      if (deltaType === "input_json_delta") {
        return [{
          type: "tool_use",
          session_id: message.session_id,
          partial_json: delta?.partial_json,
          event,
        }];
      }
    }

    return [{
      type: "stream_event",
      session_id: message.session_id,
      event,
    }];
  }

  private normalizeContentBlocks(content: unknown): ConsoleContentBlock[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) {
      return [];
    }

    const blocks: ConsoleContentBlock[] = [];
    for (const item of content) {
      const block = this.asRecord(item);
      const type = typeof block?.type === "string" ? block.type : "";
      if (type === "text" && typeof block?.text === "string") {
        blocks.push({ type: "text", text: block.text });
        continue;
      }
      if (type === "thinking" && typeof block?.thinking === "string") {
        blocks.push({ type: "thinking", thinking: block.thinking });
        continue;
      }
      if (type === "redacted_thinking") {
        blocks.push({ type: "thinking", thinking: "[redacted thinking]" });
        continue;
      }
      if (type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: typeof block?.id === "string" ? block.id : "",
          name: typeof block?.name === "string" ? block.name : "tool",
          input: this.asRecord(block?.input) ?? {},
        });
        continue;
      }
      if (type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: typeof block?.tool_use_id === "string" ? block.tool_use_id : "",
          content: this.normalizeToolResultContent(block?.content),
        });
      }
    }
    return blocks;
  }

  private normalizeUserBlocks(content: unknown, toolUseResult: unknown): ConsoleContentBlock[] {
    const blocks = this.normalizeContentBlocks(content);
    if (blocks.length > 0) {
      return blocks;
    }
    if (toolUseResult !== undefined) {
      return [{
        type: "tool_result",
        tool_use_id: "",
        content: this.normalizeToolResultContent(toolUseResult),
      }];
    }
    return [];
  }

  private normalizeToolResultContent(content: unknown): string | ConsoleContentBlock[] {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return typeof content === "object" && content !== null
        ? JSON.stringify(content)
        : String(content ?? "");
    }
    const blocks: ConsoleContentBlock[] = [];
    for (const item of content) {
      const block = this.asRecord(item);
      if (block?.type === "text" && typeof block.text === "string") {
        blocks.push({ type: "text", text: block.text });
      }
    }
    return blocks;
  }

  private normalizeUsage(usage: unknown): {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  } | undefined {
    const raw = this.asRecord(usage);
    if (!raw) {
      return undefined;
    }
    return {
      input_tokens: this.readNumber(raw.input_tokens),
      cache_creation_input_tokens: this.readNumber(raw.cache_creation_input_tokens),
      cache_read_input_tokens: this.readNumber(raw.cache_read_input_tokens),
      output_tokens: this.readNumber(raw.output_tokens),
    };
  }

  private normalizeRawUsage(usage: unknown): Record<string, unknown> {
    const raw = this.asRecord(usage);
    return raw ?? {};
  }

  private storeAndBroadcast(event: ConsoleStreamEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > EVENT_LOG_LIMIT) {
      this.eventLog = this.eventLog.slice(this.eventLog.length - EVENT_LOG_LIMIT);
    }

    if (typeof event.session_id === "string" && event.session_id && event.session_id !== this.meta.provider_session_id) {
      this.meta = {
        ...this.meta,
        provider_session_id: event.session_id,
        updated_at: Date.now(),
      };
      this.emitMetaUpdate({
        provider_session_id: event.session_id,
        updated_at: this.meta.updated_at,
      });
    }

    // Bug: 81c9d85 — update last_active on assistant/tool_use activity events
    if (
      (event.type === "assistant" || event.type === "tool_use") &&
      this.sessionRegistry &&
      this.meta.mandible_session_id
    ) {
      this.sessionRegistry.updateLastActive(this.meta.mandible_session_id);
    }

    if (event.type === "result") {
      const usageRow = this.buildUsageRow(event);
      if (usageRow) {
        this.usageLog.push(usageRow);
        if (this.usageLog.length > SDK_USAGE_LOG_LIMIT) {
          this.usageLog = this.usageLog.slice(this.usageLog.length - SDK_USAGE_LOG_LIMIT);
        }
      }
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

  private buildUsageRow(event: ConsoleStreamEvent): UsageRow | null {
    const usage = this.asRecord(event.usage);
    if (!usage) {
      return null;
    }

    return {
      id: randomUUID(),
      console_session_id: this.id,
      provider_session_id: event.session_id ?? this.meta.provider_session_id,
      recorded_at: Date.now(),
      input_tokens: this.readNumber(usage.input_tokens),
      cache_creation_input_tokens: this.readNumber(usage.cache_creation_input_tokens),
      cache_read_input_tokens: this.readNumber(usage.cache_read_input_tokens),
      output_tokens: this.readNumber(usage.output_tokens),
      web_search_requests: this.readNumber(usage.web_search_requests),
      cost_usd: this.readNumber(usage.cost_usd),
      total_cost_usd: this.readNumber(event.total_cost_usd),
      duration_ms: this.readNumber(event.duration_ms),
      num_turns: this.readNumber(event.num_turns),
      is_error: event.is_error === true,
      result_subtype: typeof event.subtype === "string" ? event.subtype : null,
      usage,
      errors: Array.isArray(event.errors) ? event.errors : [],
      model_usage: this.asRecord(event.modelUsage) ?? {},
    };
  }

  private async cancelActiveQuery(): Promise<void> {
    const query = this.activeQuery;
    const abortController = this.abortController;
    this.activeQuery = null;
    this.abortController = null;

    abortController?.abort();

    if (!query) {
      return;
    }

    try {
      await query.interrupt();
    } catch {
      // Ignore interrupt failures during shutdown.
    }

    try {
      query.close();
    } catch {
      // Ignore close failures during shutdown.
    }
  }

  /**
   * Bug: 790433d — Snapshot the effective config for the current message index.
   * Uses a keyframe/delta model: only writes a row when the parameters differ
   * from the last snapshot (or on the first prompt).
   */
  private snapshotMessageParams(): void {
    try {
      const db = getDb();
      const model = this.options.model ?? extractModel(this.meta.args) ?? null;
      const thinkingEffort = this.options.thinkingEffort ?? null;
      const permissionMode = this.options.permissionMode ?? DEFAULT_SDK_PERMISSION_MODE;
      const maxTurns = this.options.maxTurns ?? null;
      const maxCostUsd = this.options.maxCostUsd ?? null;
      const allowedTools = [...this.autoAllowedTools];

      // Check if params differ from the last snapshot
      const lastRow = db.prepare(
        `SELECT model, thinking_effort, permission_mode, max_turns, max_cost_usd, allowed_tools
         FROM message_params
         WHERE session_id = ?
         ORDER BY message_index DESC
         LIMIT 1`,
      ).get(this.id) as {
        model: string | null;
        thinking_effort: string | null;
        permission_mode: string | null;
        max_turns: number | null;
        max_cost_usd: number | null;
        allowed_tools: string | null;
      } | undefined;

      const allowedToolsJson = JSON.stringify(allowedTools);

      if (lastRow) {
        const same =
          lastRow.model === model &&
          lastRow.thinking_effort === thinkingEffort &&
          lastRow.permission_mode === permissionMode &&
          lastRow.max_turns === maxTurns &&
          lastRow.max_cost_usd === maxCostUsd &&
          lastRow.allowed_tools === allowedToolsJson;
        if (same) return; // Inherit from previous — no new row needed
      }

      db.prepare(
        `INSERT OR REPLACE INTO message_params
         (session_id, message_index, model, thinking_effort, permission_mode, max_turns, max_cost_usd, allowed_tools, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        this.id,
        this.messageIndex,
        model,
        thinkingEffort,
        permissionMode,
        maxTurns,
        maxCostUsd,
        allowedToolsJson,
        Math.floor(Date.now() / 1000),
      );
    } catch (err) {
      this.logger("warn", "sdk_snapshot_params_failed", { id: this.id, error: String(err) });
    }
  }

  private resolveAllPendingPermissions(decision: PermissionDecision): void {
    const ids = Array.from(this.pendingPermissions.keys());
    for (const id of ids) {
      this.resolvePermission(id, decision);
    }
  }

  private emitMetaUpdate(fields: BackendMetaUpdate): void {
    this.emit("meta_update", fields);
  }

  private emitStatus(event: BackendStatusEvent): void {
    this.emit("status", event);
  }

  private ensureMandibleSession(providerSessionId: string): string | null {
    if (!this.sessionRegistry || !providerSessionId) {
      return this.meta.mandible_session_id ?? null;
    }

    try {
      const existing = this.sessionRegistry.getSession(providerSessionId);
      if (existing) {
        return existing.id;
      }

      const session = this.sessionRegistry.registerSession({
        id: providerSessionId,
        app: "claude-sdk",
        cwd: this.meta.cwd,
        status: "active",
        agent_type: "claude",
        description: this.meta.label,
      });
      return session.id;
    } catch (error) {
      this.logger("warn", "sdk_registry_link_failed", {
        id: this.id,
        provider_session_id: providerSessionId,
        error: String(error),
      });
      return this.meta.mandible_session_id ?? null;
    }
  }


  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  }

  private readNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
}
