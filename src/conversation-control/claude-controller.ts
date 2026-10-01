import { randomUUID } from "node:crypto";
import type {
  ActivityItem,
  ActivityKind,
  ChatItem,
  MessageItem,
  ToolCallItem,
} from "../parsers/types.js";
import type {
  AdapterProbe,
  ConversationControllerAdapter,
  ControllerAcquisitionRequest,
  ControllerAdapterCapabilities,
  ControllerLease,
} from "./adapter.js";
import { AdapterLifecycle, AdapterProviderEvents, adapterFailure, type AdapterLifecycleEvent } from "./provider-adapter.js";
import { CLAUDE_SDK_MANAGED_PROFILE } from "./provider-capabilities.js";
import { chatItemIdentityKey } from "./provider-live.js";
import { claudeAttachmentContent } from "./attachment-delivery.js";
import { StructuredJsonProcess, type StructuredProcessExit, type StructuredProcessSpawner } from "./structured-process.js";
import type {
  ConversationControlError,
  ConversationLifecycleEvent,
  ConversationOutboxItem,
  ProviderAdapterEvent,
  ProviderDeliveryReceipt,
  Result,
} from "./types.js";

type PendingClaudeDelivery = {
  item: ConversationOutboxItem;
  resolve: (receipt: ProviderDeliveryReceipt) => void;
  reject: (error: ConversationControlError) => void;
  timer: NodeJS.Timeout;
};

type ClaudeController = {
  conversationId: string;
  generation: number;
  controllerInstanceId: string;
  providerSessionId: string;
  process: StructuredJsonProcess;
  state: "ready" | "running" | "waiting" | "stopping";
  activeTurnId: string | null;
  pending: PendingClaudeDelivery | null;
  delivered: Map<string, ProviderDeliveryReceipt>;
  intentionalStop: boolean;
  providerSequence: number;
  liveMessageId: string | null;
  liveText: Map<string, string>;
};

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

export class ClaudeStreamControllerAdapter implements ConversationControllerAdapter {
  readonly id = CLAUDE_SDK_MANAGED_PROFILE.adapter_id;
  readonly provider = CLAUDE_SDK_MANAGED_PROFILE.provider;
  readonly capabilities: ControllerAdapterCapabilities = CLAUDE_SDK_MANAGED_PROFILE.capabilities;

  private readonly lifecycle = new AdapterLifecycle();
  private readonly providerEvents = new AdapterProviderEvents();
  private readonly controllers = new Map<string, ClaudeController>();
  private readonly spawnProcess: StructuredProcessSpawner | undefined;

  constructor(options: { spawnProcess?: StructuredProcessSpawner } = {}) {
    this.spawnProcess = options.spawnProcess;
  }

  async acquire(input: ControllerAcquisitionRequest): Promise<Result<ControllerLease, ConversationControlError>> {
    if (input.kind === "resume-message-anchor") {
      return { ok: false, error: adapterFailure(this.id, "message-anchor-unsupported", "Claude stream JSON cannot resume an exact message anchor") };
    }
    const providerSessionId = input.kind === "start" ? randomUUID() : input.provider_session_id;
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      ...(input.runtime_options?.model ? ["--model", input.runtime_options.model] : []),
      ...(input.runtime_options?.effort ? ["--effort", input.runtime_options.effort] : []),
      ...(input.runtime_options?.permission_mode
        && ["default", "acceptEdits", "bypassPermissions"].includes(input.runtime_options.permission_mode)
        ? ["--permission-mode", input.runtime_options.permission_mode] : []),
      input.kind === "start" ? "--session-id" : "--resume",
      providerSessionId,
    ];
    let processOwner: StructuredJsonProcess | null = null;
    let aborted = input.kind === "start" && input.signal?.aborted === true;
    const abort = () => {
      aborted = true;
      if (processOwner) void processOwner.close();
    };
    if (input.kind === "start") input.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (aborted) throw new Error("Claude controller acquisition was cancelled");
      processOwner = await StructuredJsonProcess.start("claude", args, {
        cwd: input.kind === "start" ? input.cwd : undefined,
        spawnProcess: this.spawnProcess,
      });
      if (aborted) throw new Error("Claude controller acquisition was cancelled");
      const controller: ClaudeController = {
        conversationId: input.conversation_id,
        generation: input.generation,
        controllerInstanceId: input.controller_instance_id,
        providerSessionId,
        process: processOwner,
        state: "ready",
        activeTurnId: null,
        pending: null,
        delivered: new Map(),
        intentionalStop: false,
        providerSequence: 0,
        liveMessageId: null,
        liveText: new Map(),
      };
      processOwner.onRecord((record) => this.acceptRecord(controller, record));
      processOwner.onMalformed(() => this.markAmbiguous(controller));
      processOwner.onExit((exit) => this.processExited(controller, exit));
      this.controllers.set(input.conversation_id, controller);
      return { ok: true, value: { controller_instance_id: input.controller_instance_id, provider_session_id: providerSessionId } };
    } catch (thrown) {
      if (processOwner) await processOwner.close();
      return { ok: false, error: adapterFailure(this.id, "startup-failed", thrown, { retryable: true }) };
    } finally {
      if (input.kind === "start") input.signal?.removeEventListener("abort", abort);
    }
  }

  async deliver(item: ConversationOutboxItem): Promise<Result<ProviderDeliveryReceipt, ConversationControlError>> {
    const controller = this.current(item);
    if (!controller.ok) return controller;
    const priorReceipt = controller.value.delivered.get(item.id);
    if (priorReceipt) return { ok: true, value: priorReceipt };
    if (controller.value.pending) {
      return { ok: false, error: adapterFailure(this.id, "delivery-in-flight", "Another Claude delivery is awaiting native acknowledgement", { retryable: true }) };
    }
    if (item.operation === "steer" && !controller.value.activeTurnId) {
      return { ok: false, error: adapterFailure(this.id, "no-active-turn", "Claude steering requires the exact active turn") };
    }
    if (item.operation === "queue" || item.operation === "resume-message-anchor") {
      return { ok: false, error: adapterFailure(this.id, "unsupported-operation", item.operation) };
    }

    let content: ReturnType<typeof claudeAttachmentContent>;
    try {
      content = claudeAttachmentContent(item.message, item.attachments ?? [], item.attachment_db_path);
    } catch (error) {
      return { ok: false, error: adapterFailure(this.id, "attachment-custody-failed", error) };
    }

    const acknowledged = new Promise<ProviderDeliveryReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (controller.value.pending?.item.id === item.id) controller.value.pending = null;
        reject({ kind: "delivery-uncertain", delivery_id: item.id } satisfies ConversationControlError);
      }, 15_000);
      timer.unref();
      controller.value.pending = { item, resolve, reject, timer };
    });
    try {
      controller.value.process.write({
        type: "user",
        uuid: item.idempotency_key,
        message: { role: "user", content },
        parent_tool_use_id: null,
      });
      const receipt = await acknowledged;
      controller.value.delivered.set(item.id, receipt);
      return { ok: true, value: receipt };
    } catch (error) {
      return { ok: false, error: this.controlError(error, "delivery-failed", item.id) };
    }
  }

  async probe(input: Parameters<ConversationControllerAdapter["probe"]>[0]): Promise<Result<AdapterProbe, ConversationControlError>> {
    const controller = this.controllers.get(input.conversation_id);
    if (!controller || !controller.process.alive) {
      return { ok: true, value: { kind: "unknown", reason: "probe-ambiguous" } };
    }
    if (
      controller.generation !== input.generation
      || controller.controllerInstanceId !== input.controller_instance_id
      || controller.providerSessionId !== input.provider_session_id
    ) {
      return { ok: true, value: { kind: "unknown", reason: "provider-identity-changed" } };
    }
    return { ok: true, value: {
      kind: "owned",
      controller_instance_id: controller.controllerInstanceId,
      provider_session_id: controller.providerSessionId,
      state: controller.state,
    } };
  }

  async probeDelivery(item: ConversationOutboxItem): Promise<Result<"delivered" | "not-delivered" | "unknown", ConversationControlError>> {
    const controller = this.controllers.get(item.conversation_id);
    return { ok: true, value: controller?.delivered.has(item.id) ? "delivered" : "unknown" };
  }

  async stop(input: Parameters<ConversationControllerAdapter["stop"]>[0]): Promise<Result<void, ConversationControlError>> {
    const controller = this.controllers.get(input.conversation_id);
    if (!controller) return { ok: true, value: undefined };
    if (controller.generation !== input.generation || controller.controllerInstanceId !== input.controller_instance_id) {
      return { ok: false, error: adapterFailure(this.id, "controller-identity-mismatch", "Claude controller identity changed") };
    }
    controller.intentionalStop = true;
    controller.state = "stopping";
    this.rejectPending(controller, adapterFailure(this.id, "controller-stopped", "Claude controller stopped"));
    await controller.process.close();
    this.controllers.delete(input.conversation_id);
    return { ok: true, value: undefined };
  }

  subscribe(listener: (event: AdapterLifecycleEvent) => Result<void, ConversationControlError>): () => void {
    return this.lifecycle.subscribe(listener);
  }

  subscribeProviderEvents(listener: (event: ProviderAdapterEvent) => void): () => void {
    return this.providerEvents.subscribe(listener);
  }

  async close(): Promise<void> {
    const controllers = [...this.controllers.values()];
    this.controllers.clear();
    await Promise.all(controllers.map(async (controller) => {
      controller.intentionalStop = true;
      controller.state = "stopping";
      this.rejectPending(controller, adapterFailure(this.id, "controller-closed", "Claude controller closed"));
      await controller.process.close();
    }));
  }

  private acceptRecord(controller: ClaudeController, value: unknown): void {
    const record = object(value);
    if (!record || typeof record.type !== "string") {
      this.markAmbiguous(controller);
      return;
    }
    const sessionId = typeof record.session_id === "string" ? record.session_id : null;
    if (sessionId && sessionId !== controller.providerSessionId) {
      this.lifecycle.emit(this.event(controller, { kind: "ownership-unknown", at: Date.now(), reason: "provider-identity-changed" }));
      void this.abandon(controller);
      return;
    }
    if (record.type === "user") {
      this.acknowledgeUser(controller, record);
      return;
    }
    if (record.type === "assistant") {
      this.publishClaudeRecord(controller, record);
      return;
    }
    if (record.type === "progress" || record.type === "tool_progress"
        || record.type === "tool_use_summary" || record.type === "system") {
      this.publishClaudeActivity(controller, record);
      return;
    }
    if (record.type === "stream_event") {
      this.acceptStreamDelta(controller, record);
      return;
    }
    if (record.type === "control_request" && controller.activeTurnId) {
      this.lifecycle.emit(this.event(controller, { kind: "turn-waiting-permission", turn_id: controller.activeTurnId, at: Date.now() }));
      return;
    }
    if (record.type === "control_response" && controller.activeTurnId) {
      this.lifecycle.emit(this.event(controller, { kind: "controller-running", at: Date.now() }));
      return;
    }
    if (record.type === "result") {
      this.finishTurn(controller, record);
    }
  }

  private acknowledgeUser(controller: ClaudeController, record: Record<string, unknown>): void {
    const pending = controller.pending;
    if (!pending) return;
    if (record.uuid !== pending.item.idempotency_key) return;
    controller.pending = null;
    clearTimeout(pending.timer);
    if (pending.item.operation !== "steer") {
      controller.activeTurnId = pending.item.turn_id;
      controller.state = "running";
      this.lifecycle.emit(this.event(controller, { kind: "controller-running", at: Date.now() }));
      this.lifecycle.emit(this.event(controller, { kind: "turn-started", turn_id: pending.item.turn_id, at: Date.now() }));
    }
    const providerMessageId = typeof record.uuid === "string" && record.uuid ? record.uuid : null;
    const correlation = {
      intent_id: pending.item.idempotency_key,
      delivery_id: pending.item.id,
      turn_id: pending.item.turn_id,
      ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
    };
    const content = object(record.message)?.content;
    const items = this.claudeContentItems(
      controller,
      pending.item.idempotency_key,
      "user",
      content ?? pending.item.message,
      "complete",
      undefined,
    );
    for (const item of items) this.emitItem(controller, item, correlation);
    pending.resolve({
      provider_receipt_id: providerMessageId
        ? `claude:message:${providerMessageId}`
        : `claude:user-echo:${controller.providerSessionId}:${pending.item.id}`,
      acceptance: {
        kind: "claude-stream-user-echo",
        provider_session_id: controller.providerSessionId,
        provider_message_id: providerMessageId,
      },
    });
  }

  private acceptStreamDelta(controller: ClaudeController, record: Record<string, unknown>): void {
    const stream = object(record.event);
    if (!stream || typeof stream.type !== "string") return;
    if (stream.type === "message_start") {
      const message = object(stream.message);
      controller.liveMessageId = typeof message?.id === "string" && message.id ? message.id : null;
      controller.liveText.clear();
      return;
    }
    if (stream.type === "content_block_start") {
      const messageId = controller.liveMessageId;
      const index = Number(stream.index);
      const content = object(stream.content_block);
      if (!messageId || !Number.isInteger(index) || index < 0 || !content) return;
      const [item] = this.claudeContentItems(
        controller,
        messageId,
        "assistant",
        [content],
        "streaming",
        undefined,
        index,
      );
      if (item) this.emitItem(controller, item);
      return;
    }
    if (stream.type === "content_block_delta") {
      const delta = object(stream.delta);
      const messageId = controller.liveMessageId;
      const index = Number(stream.index ?? 0);
      if (!messageId || !Number.isInteger(index) || index < 0 || !delta) return;
      const activityKind: ActivityKind | null = delta.type === "thinking_delta" ? "thinking" : null;
      const fragment = delta.type === "text_delta" ? delta.text
        : delta.type === "thinking_delta" ? delta.thinking
        : null;
      if (typeof fragment !== "string") return;
      const key = `${activityKind ?? "message"}:${messageId}:${index}`;
      const text = `${controller.liveText.get(key) ?? ""}${fragment}`;
      controller.liveText.set(key, text);
      const item = activityKind
        ? this.activityItem(controller, messageId, activityKind, text, "streaming", index)
        : this.messageItem(controller, messageId, "assistant", text, "streaming", index);
      this.emitItem(controller, item);
    }
  }

  private publishClaudeRecord(controller: ClaudeController, record: Record<string, unknown>): void {
    const messageId = object(record.message)?.id;
    if (typeof messageId !== "string" || !messageId) return;
    const content = object(record.message)?.content;
    for (const item of this.claudeContentItems(
      controller,
      messageId,
      "assistant",
      content,
      "complete",
      undefined,
    )) this.emitItem(controller, item);
  }

  private emitItem(
    controller: ClaudeController,
    item: ChatItem,
    correlation?: Extract<ProviderAdapterEvent, { kind: "provisional-content" }>["correlation"],
  ): void {
    const identity = chatItemIdentityKey(item);
    if (!identity) return;
    this.providerEvents.emit({
      kind: "provisional-content",
      conversation_id: controller.conversationId,
      provider_session_id: controller.providerSessionId,
      generation: controller.generation,
      sequence: ++controller.providerSequence,
      observed_at: Date.now(),
      identity,
      ...(correlation ? { correlation } : {}),
      item,
    });
  }

  private liveIdentity(
    controller: ClaudeController,
    itemId: string,
    contentIndex?: number,
    turnId?: string,
    toolId?: string,
  ): ChatItem["identity"] {
    return {
      provider: "claude_code",
      session_id: controller.providerSessionId,
      native_item_id: itemId,
      ...(turnId ? { native_turn_id: turnId } : {}),
      ...(toolId ? { native_tool_id: toolId } : {}),
      ...(contentIndex !== undefined ? { native_content_index: contentIndex } : {}),
      // Native identity is mandatory for live items, leaving the frozen
      // transcript-coordinate fields inert.
      source_record_ordinal: 0,
      source_sub_block_ordinal: contentIndex ?? 0,
    };
  }

  private messageItem(
    controller: ClaudeController,
    itemId: string,
    role: MessageItem["role"],
    text: string,
    completion: MessageItem["content_completion"],
    contentIndex?: number,
    turnId?: string,
  ): MessageItem {
    return {
      type: "message",
      role,
      identity: this.liveIdentity(controller, itemId, contentIndex, turnId),
      provenance: { source: "live-provider-event", provider: "claude_code", source_event_type: role },
      parts: text ? [{ type: "text", text, ...(contentIndex !== undefined ? { native_index: contentIndex } : {}) }] : [],
      content_completion: completion,
    };
  }

  private activityItem(
    controller: ClaudeController,
    itemId: string,
    activityKind: ActivityKind,
    text: string,
    completion: ActivityItem["content_completion"],
    contentIndex?: number,
    turnId?: string,
    fields: Partial<Pick<ActivityItem, "severity" | "status" | "elapsed_ms" | "tool_name" | "tool_id" | "related_tool_ids">> = {},
  ): ActivityItem {
    return {
      type: "activity",
      role: "assistant",
      activity_kind: activityKind,
      identity: this.liveIdentity(controller, itemId, contentIndex, turnId, fields.tool_id),
      provenance: { source: "live-provider-event", provider: "claude_code", source_event_type: activityKind },
      parts: text ? [{ type: "text", text, ...(contentIndex !== undefined ? { native_index: contentIndex } : {}) }] : [],
      content_completion: completion,
      ...fields,
    };
  }

  private claudeContentItems(
    controller: ClaudeController,
    messageId: string,
    role: "user" | "assistant",
    content: unknown,
    completion: ChatItem["content_completion"],
    turnId?: string,
    contentOffset = 0,
  ): ChatItem[] {
    if (typeof content === "string") {
      return content ? [this.messageItem(controller, messageId, role, content, completion, undefined, turnId)] : [];
    }
    if (!Array.isArray(content)) return [];
    return content.flatMap((value, offset): ChatItem[] => {
      const block = object(value);
      if (!block) return [];
      const contentIndex = contentOffset + offset;
      if (block.type === "text" && typeof block.text === "string") {
        return [this.messageItem(controller, messageId, role, block.text, completion, contentIndex, turnId)];
      }
      if (role === "assistant" && block.type === "thinking" && typeof block.thinking === "string") {
        return [this.activityItem(controller, messageId, "thinking", block.thinking, completion, contentIndex, turnId)];
      }
      if (role === "assistant" && block.type === "tool_use" && typeof block.id === "string" && block.id) {
        const item: ToolCallItem = {
          type: "tool-call",
          role: "assistant",
          phase: "call",
          identity: this.liveIdentity(controller, messageId, contentIndex, turnId, block.id),
          provenance: { source: "live-provider-event", provider: "claude_code", source_event_type: "tool_use" },
          parts: [],
          content_completion: completion,
          tool_id: block.id,
          ...(typeof block.name === "string" && block.name ? { tool_name: block.name } : {}),
          tool_kind: "claude_tool_use",
          ...(block.input !== undefined ? { input: block.input } : {}),
        };
        return [item];
      }
      if (role === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string" && block.tool_use_id) {
        const output = block.content;
        const text = typeof output === "string" ? output
          : Array.isArray(output) ? output.flatMap((part) => {
            const candidate = object(part);
            return typeof candidate?.text === "string" ? [candidate.text] : [];
          }).join("\n") : "";
        const item: ToolCallItem = {
          type: "tool-call",
          role: "tool",
          phase: "result",
          identity: this.liveIdentity(controller, messageId, contentIndex, turnId, block.tool_use_id),
          provenance: { source: "live-provider-event", provider: "claude_code", source_event_type: "tool_result" },
          parts: text ? [{ type: "text", text, native_index: contentIndex }] : [],
          content_completion: completion,
          tool_id: block.tool_use_id,
          tool_kind: "claude_tool_result",
          ...(output !== undefined ? { output } : {}),
        };
        return [item];
      }
      return [];
    });
  }

  private publishClaudeActivity(controller: ClaudeController, record: Record<string, unknown>): void {
    const recordId = typeof record.uuid === "string" && record.uuid ? record.uuid : null;
    if (!recordId) return;
    const type = String(record.type);
    const data = object(record.data);
    const progress = type === "progress" || type === "tool_progress";
    const sourceType = progress
      ? `progress.${type === "tool_progress" ? "tool_progress" : String(data?.type ?? "progress")}`
      : type === "system" ? String(record.subtype ?? "system")
      : type;
    const activityKind: ActivityKind | null = progress ? "tool-progress"
      : sourceType === "tool_use_summary" ? "tool-summary"
      : sourceType === "informational" ? "information"
      : sourceType === "status" ? "status"
      : null;
    if (!activityKind) return;
    const text = type === "tool_use_summary" && typeof record.summary === "string" ? record.summary
      : typeof record.content === "string" ? record.content
      : typeof data?.message === "string" ? data.message
      : "";
    const toolId = typeof record.tool_use_id === "string" ? record.tool_use_id
      : typeof record.toolUseID === "string" ? record.toolUseID
      : typeof record.parent_tool_use_id === "string" ? record.parent_tool_use_id
      : undefined;
    const toolName = typeof record.tool_name === "string" ? record.tool_name
      : typeof data?.tool_name === "string" ? data.tool_name
      : typeof data?.toolName === "string" ? data.toolName
      : undefined;
    const elapsedSeconds = typeof record.elapsed_time_seconds === "number" ? record.elapsed_time_seconds
      : typeof data?.elapsed_time_seconds === "number" ? data.elapsed_time_seconds
      : typeof data?.elapsedTimeSeconds === "number" ? data.elapsedTimeSeconds
      : undefined;
    const related = Array.isArray(record.precedingToolUseIDs) ? record.precedingToolUseIDs
      : Array.isArray(record.preceding_tool_use_ids) ? record.preceding_tool_use_ids
      : [];
    const item = this.activityItem(controller, recordId, activityKind, text, "complete", undefined,
      undefined, {
        ...(record.level === "error" ? { severity: "error" as const }
          : record.level === "warning" ? { severity: "warning" as const } : {}),
        ...(progress ? { status: sourceType.slice("progress.".length) } : {}),
        ...(elapsedSeconds !== undefined ? { elapsed_ms: elapsedSeconds * 1000 } : {}),
        ...(toolId ? { tool_id: toolId } : {}),
        ...(toolName ? { tool_name: toolName } : {}),
        ...(related.length > 0
          ? { related_tool_ids: related.filter((value): value is string => typeof value === "string") }
          : {}),
      });
    item.role = "system";
    item.provenance.source_event_type = sourceType;
    this.emitItem(controller, item);
  }

  private finishTurn(controller: ClaudeController, record: Record<string, unknown>): void {
    if (!controller.activeTurnId) {
      this.markAmbiguous(controller);
      return;
    }
    const turnId = controller.activeTurnId;
    controller.activeTurnId = null;
    const now = Date.now();
    if (record.is_error === false && record.subtype === "success") {
      this.lifecycle.emit(this.event(controller, { kind: "turn-completed", turn_id: turnId, at: now }));
    } else if (record.is_error === true && record.subtype !== "success") {
      this.lifecycle.emit(this.event(controller, {
        kind: "turn-failed",
        turn_id: turnId,
        at: now,
        error: adapterFailure(this.id, String(record.subtype ?? "claude-result-error"), String(record.result ?? "Claude turn failed")),
      }));
    } else {
      this.lifecycle.emit(this.event(controller, { kind: "turn-unknown", turn_id: turnId, at: now, reason: "probe-ambiguous" }));
    }
    controller.state = "waiting";
    this.lifecycle.emit(this.event(controller, { kind: "controller-waiting", at: now }));
  }

  private markAmbiguous(controller: ClaudeController): void {
    if (controller.activeTurnId) {
      this.lifecycle.emit(this.event(controller, {
        kind: "turn-unknown",
        turn_id: controller.activeTurnId,
        at: Date.now(),
        reason: "probe-ambiguous",
      }));
      controller.activeTurnId = null;
    } else {
      this.lifecycle.emit(this.event(controller, { kind: "ownership-unknown", at: Date.now(), reason: "probe-ambiguous" }));
      void this.abandon(controller);
    }
  }

  private processExited(controller: ClaudeController, exit: StructuredProcessExit): void {
    this.controllers.delete(controller.conversationId);
    this.rejectPending(controller, adapterFailure(this.id, "process-exited", exit.stderr || `Claude exited with ${exit.code ?? exit.signal}`));
    if (controller.intentionalStop) return;
    const now = Date.now();
    if (controller.activeTurnId) {
      this.lifecycle.emit(this.event(controller, { kind: "turn-unknown", turn_id: controller.activeTurnId, at: now, reason: "probe-ambiguous" }));
      controller.activeTurnId = null;
    }
    if (exit.code !== 0) {
      this.lifecycle.emit(this.event(controller, {
        kind: "controller-failed",
        at: now,
        error: adapterFailure(this.id, "process-exited", exit.stderr || `Claude exited with ${exit.code ?? exit.signal}`, { retryable: true }),
      }));
    }
    this.lifecycle.emit(this.event(controller, { kind: "controller-released", at: now }));
  }

  private current(item: ConversationOutboxItem): Result<ClaudeController, ConversationControlError> {
    const controller = this.controllers.get(item.conversation_id);
    if (!controller || controller.generation !== item.generation || !controller.process.alive) {
      return { ok: false, error: adapterFailure(this.id, "controller-unavailable", "Claude controller is unavailable", { retryable: true }) };
    }
    return { ok: true, value: controller };
  }

  private event(controller: ClaudeController, event: ConversationLifecycleEvent): AdapterLifecycleEvent {
    return { ...event, conversation_id: controller.conversationId, generation: controller.generation };
  }

  private rejectPending(controller: ClaudeController, error: ConversationControlError): void {
    if (!controller.pending) return;
    clearTimeout(controller.pending.timer);
    controller.pending.reject(error);
    controller.pending = null;
  }

  private controlError(error: unknown, code: string, deliveryId: string): ConversationControlError {
    const candidate = object(error);
    if (candidate?.kind === "delivery-uncertain") return { kind: "delivery-uncertain", delivery_id: deliveryId };
    if (candidate?.kind === "adapter-failure") return error as ConversationControlError;
    return adapterFailure(this.id, code, error, { retryable: true });
  }

  private async abandon(controller: ClaudeController): Promise<void> {
    controller.intentionalStop = true;
    this.controllers.delete(controller.conversationId);
    this.rejectPending(controller, adapterFailure(this.id, "ambiguous-protocol", "Claude emitted an ambiguous protocol record"));
    await controller.process.close();
  }
}
