// Bug: 9bf8b4c — Claude Agent SDK backend for Console
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookInput,
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
} from "../agentic-backend.js";
import type {
  ConsoleContentBlock,
  ConsoleSession,
  ConsoleStreamEvent,
  Logger,
} from "../types.js";
import { SessionRegistry } from "../registry.js";

const EVENT_LOG_LIMIT = 2000;
const PERMISSION_TIMEOUT_MS = 120_000;

type UsageRow = Record<string, unknown>;

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
  systemPrompt?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  allowedTools?: string[];
  maxTurns?: number;
  maxCostUsd?: number;
  /** Bug: 61bee4e — Preset IDs to compute union system prompt from */
  presetIds?: string[];
  /** Bug: 61bee4e — Override settingSources based on active preset sources */
  settingSourcesOverride?: string[];
}

export class SDKBackend extends EventEmitter
implements
  AgenticBackend,
  PermissionAwareBackend,
  ConfigurableBackend<SDKBackendOptions>,
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
  private destroyed = false;

  /** Bug: 81c9d85 — expose processing state for is_processing on ConsoleSession */
  get isProcessing(): boolean {
    return this.processing;
  }

  constructor(meta: ConsoleSession, logger: Logger, sessionRegistry?: SessionRegistry) {
    super();
    this.id = meta.id;
    this.meta = meta;
    this.logger = logger;
    this.sessionRegistry = sessionRegistry;
    this.autoAllowedTools = new Set(meta.allowed_tools ?? []);
    this.options = {
      model: this.extractModel(meta.args) ?? undefined,
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

  stop(_signal?: string): void {
    this.promptQueue = [];
    this.resolveAllPendingPermissions("deny");
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

  updateOptions(options: SDKBackendOptions): void {
    this.options = {
      ...this.options,
      ...options,
      ...(options.allowedTools !== undefined ? { allowedTools: [...options.allowedTools] } : {}),
    };

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

    if (this.activeQuery && typeof options.permissionMode === "string") {
      void this.activeQuery.setPermissionMode(options.permissionMode as ClaudePermissionMode).catch(() => {
        this.logger("warn", "sdk_set_permission_mode_failed", { id: this.id });
      });
    }

    if (this.activeQuery && typeof options.model === "string") {
      void this.activeQuery.setModel(options.model || undefined).catch(() => {
        this.logger("warn", "sdk_set_model_failed", { id: this.id, model: options.model });
      });
    }
  }

  getPendingPermissions(): PermissionRequest[] {
    return Array.from(this.pendingPermissions.values())
      .map((entry) => entry.request)
      .sort((left, right) => left.created_at - right.created_at);
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
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
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const abortController = new AbortController();
    const queryOptions = this.buildQueryOptions(abortController);
    const query = sdk.query({
      prompt,
      options: queryOptions,
    });

    this.abortController = abortController;
    this.activeQuery = query;

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

    try {
      for await (const message of query) {
        const events = this.normalizeSDKEvent(message);
        for (const event of events) {
          this.storeAndBroadcast(event);
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        this.storeAndBroadcast({
          type: "result",
          subtype: "error_during_execution",
          session_id: this.meta.provider_session_id ?? this.id,
          duration_ms: 0,
          num_turns: 0,
          total_cost_usd: 0,
          is_error: true,
          errors: [String(error)],
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

      try {
        query.close();
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private buildQueryOptions(abortController: AbortController): ClaudeSDKOptions {
    const cwd = this.meta.cwd ?? process.cwd();
    const permissionMode = this.options.permissionMode ?? "default";
    const allowedTools = [...this.autoAllowedTools];
    const hooks = this.buildHooks();

    // Bug: 73c06e8 — Thread resume_at_message to SDK for DAG branching
    const resumeOpts: Record<string, unknown> = {};
    if (this.meta.resume_at_message && this.meta.provider_session_id) {
      resumeOpts.resume = this.meta.provider_session_id;
      resumeOpts.resumeSessionAt = this.meta.resume_at_message;
    }

    // Bug: 61bee4e — Compute system prompt from presets if presetIds are set
    let systemPrompt = this.options.systemPrompt;
    if (this.options.presetIds && this.options.presetIds.length > 0 && !systemPrompt) {
      try {
        const { computePresetUnion } = require("../presets.js") as typeof import("../presets.js");
        const { getDb } = require("../db.js") as typeof import("../db.js");
        const db = getDb();
        const result = computePresetUnion(this.options.presetIds, db);
        if (result.text) {
          systemPrompt = result.text;
        }
      } catch {
        // Presets module not available — fall through to default
      }
    }

    // Bug: 61bee4e — Determine settingSources based on active preset sources
    type SettingSource = "user" | "project" | "local";
    let settingSources: SettingSource[] = (this.options.settingSourcesOverride ?? ["user", "project", "local"]) as SettingSource[];
    if (this.options.presetIds && this.options.presetIds.length > 0 && !this.options.settingSourcesOverride) {
      try {
        const { getDb } = require("../db.js") as typeof import("../db.js");
        const db = getDb();
        const presetSources = this.options.presetIds.map((id) => {
          const row = db.prepare("SELECT source FROM presets WHERE id = ?").get(id) as { source: string } | undefined;
          return row?.source;
        }).filter(Boolean) as string[];

        // If a preset is sourced from claude_md_global, exclude "user" from settingSources
        // (the preset replaces the user-level CLAUDE.md)
        if (presetSources.includes("claude_md_global")) {
          settingSources = settingSources.filter((s): s is SettingSource => s !== "user");
        }
        if (presetSources.includes("claude_md_project")) {
          settingSources = settingSources.filter((s): s is SettingSource => s !== "project");
        }
        if (presetSources.includes("claude_md_local")) {
          settingSources = settingSources.filter((s): s is SettingSource => s !== "local");
        }
      } catch {
        // Fall through to defaults
      }
    }

    return {
      abortController,
      cwd,
      env: {
        ...process.env,
        ...this.meta.env,
      },
      model: this.options.model ?? this.extractModel(this.meta.args) ?? undefined,
      systemPrompt,
      permissionMode,
      ...(permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      allowedTools,
      maxTurns: this.options.maxTurns,
      maxBudgetUsd: this.options.maxCostUsd,
      includePartialMessages: true,
      settingSources,
      canUseTool: this.handleToolPermission,
      hooks,
      agentProgressSummaries: true,
      ...resumeOpts,
    };
  }

  private buildHooks(): Partial<Record<HookInput["hook_event_name"], HookCallbackMatcher[]>> {
    return {
      SessionStart: [{
        hooks: [async (input) => {
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
      }
    }

    const payload = JSON.stringify(event);
    for (const ws of this.wsClients) {
      try {
        ws.send(payload);
      } catch {
        // Ignore disconnected clients.
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

  private extractModel(args: string[]): string | null {
    for (let i = args.length - 2; i >= 0; i -= 1) {
      const arg = args[i];
      if ((arg === "--model" || arg === "-m") && typeof args[i + 1] === "string" && args[i + 1].trim()) {
        return args[i + 1].trim();
      }
    }
    return null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  }

  private readNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
}
