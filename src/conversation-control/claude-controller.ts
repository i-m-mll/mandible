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
import { ClaudeSdkTransport, type ClaudeSdk } from "./claude-sdk-transport.js";
import type { ExecutionTransition } from "../session-execution.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ConversationControlError,
  ConversationLifecycleEvent,
  ConversationOutboxItem,
  ProviderAdapterEvent,
  ProviderRuntimeEvent,
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
  nativeIdentityBound: boolean;
  identityPendingRecords: unknown[];
  process: ClaudeSdkTransport;
  queuedTurns: string[];
  consumedTogether: string[];
  messageTurns: Map<string, string>;
  acquisition: ControllerAcquisitionRequest;
  interrupting: boolean;
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

export class ClaudeSdkControllerAdapter implements ConversationControllerAdapter {
  readonly id = CLAUDE_SDK_MANAGED_PROFILE.adapter_id;
  readonly provider = CLAUDE_SDK_MANAGED_PROFILE.provider;
  readonly capabilities: ControllerAdapterCapabilities = CLAUDE_SDK_MANAGED_PROFILE.capabilities;

  private readonly lifecycle = new AdapterLifecycle();
  private readonly providerEvents = new AdapterProviderEvents();
  private readonly runtimeListeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly controllers = new Map<string, ClaudeController>();
  private readonly acquiring = new Set<string>();
  constructor(private readonly options: { sdk?: ClaudeSdk } = {}) {}

  async acquire(input: ControllerAcquisitionRequest): Promise<Result<ControllerLease, ConversationControlError>> {
    if (this.controllers.has(input.conversation_id) || this.acquiring.has(input.conversation_id)) {
      return { ok: false, error: adapterFailure(this.id, "controller-already-owned", "A Claude controller already owns this conversation") };
    }
    this.acquiring.add(input.conversation_id);
    let processOwner: ClaudeSdkTransport | null = null;
    try {
      const sdk = this.options.sdk ?? await import("@anthropic-ai/claude-agent-sdk");
      processOwner = new ClaudeSdkTransport(input, sdk);
      await processOwner.start();
      const controller: ClaudeController = {
        conversationId: input.conversation_id,
        generation: input.generation,
        controllerInstanceId: input.controller_instance_id,
        providerSessionId: processOwner.reservedSessionId,
        nativeIdentityBound: processOwner.providerSessionId !== null,
        identityPendingRecords: [],
        process: processOwner,
        state: "ready",
        activeTurnId: null,
        queuedTurns: [],
        consumedTogether: [],
        messageTurns: new Map(),
        acquisition: input,
        interrupting: false,
        pending: null,
        delivered: new Map(),
        intentionalStop: false,
        providerSequence: 0,
        liveMessageId: null,
        liveText: new Map(),
      };
      this.controllers.set(input.conversation_id, controller);
      processOwner.onRecord((record) => this.acceptRecord(controller, record));
      processOwner.onExit((exit) => this.processExited(controller, exit));
      return { ok: true, value: { controller_instance_id: input.controller_instance_id, provider_session_id: controller.nativeIdentityBound ? controller.providerSessionId : null, pid: processOwner.pid } };
    } catch (thrown) {
      if (processOwner) await processOwner.close();
      return { ok: false, error: adapterFailure(this.id, "startup-failed", thrown, { retryable: true }) };
    } finally { this.acquiring.delete(input.conversation_id); }
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
    if (item.operation === "steer") {
      return { ok: false, error: adapterFailure(this.id, "unsupported-operation", item.operation) };
    }

    let content: ReturnType<typeof claudeAttachmentContent>;
    try {
      content = claudeAttachmentContent(item.message, item.attachments ?? [], item.attachment_db_path);
    } catch (error) {
      return { ok: false, error: adapterFailure(this.id, "attachment-custody-failed", error) };
    }

    try {
      const owned = controller.value;
      const settings = item.operation === "queue" ? owned.acquisition.runtime_options ?? {} : item.runtime_options;
      const immutable = ["effort", "system_prompt", "max_turns", "max_cost_usd", "setting_sources", "allowed_tools"] as const;
      const changed = immutable.some((key) => JSON.stringify(settings[key]) !== JSON.stringify(owned.acquisition.runtime_options?.[key]));
      if (changed) {
        if (owned.activeTurnId) throw new Error("Startup settings can change only between turns");
        await owned.process.close();
        const acquisition: ControllerAcquisitionRequest = owned.nativeIdentityBound
          ? { kind: "resume-provider-session", conversation_id: owned.conversationId, generation: owned.generation, controller_instance_id: owned.controllerInstanceId, provider_session_id: owned.providerSessionId, cwd: owned.acquisition.cwd, runtime_options: settings }
          : { kind: "start", conversation_id: owned.conversationId, generation: owned.generation, controller_instance_id: owned.controllerInstanceId, cwd: owned.acquisition.cwd!, runtime_options: settings };
        const sdk = this.options.sdk ?? await import("@anthropic-ai/claude-agent-sdk");
        const replacement = new ClaudeSdkTransport(acquisition, sdk);
        await replacement.start();
        if (replacement.pid) this.lifecycle.emit(this.event(owned, { kind: "controller-process", at: Date.now(), pid: replacement.pid }));
        owned.process = replacement;
        owned.providerSessionId = replacement.reservedSessionId;
        owned.nativeIdentityBound = replacement.providerSessionId !== null;
        replacement.onRecord((record) => this.acceptRecord(owned, record));
        replacement.onExit((exit) => this.processExited(owned, exit));
        owned.acquisition = acquisition;
      } else {
        await owned.process.configure(settings);
        owned.acquisition.runtime_options = settings;
      }
    }
    catch (error) { return { ok: false, error: adapterFailure(this.id, "configuration-failed", error) }; }

    controller.value.messageTurns.set(item.id, item.turn_id);

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
        uuid: item.id as `${string}-${string}-${string}-${string}-${string}`,
        session_id: controller.value.providerSessionId,
        message: { role: "user", content: content as SDKUserMessage["message"]["content"] },
        parent_tool_use_id: null,
      });
      const receipt = await acknowledged;
      controller.value.delivered.set(item.id, receipt);
      return { ok: true, value: receipt };
    } catch (error) {
      this.rejectPending(controller.value, { kind: "delivery-uncertain", delivery_id: item.id });
      return { ok: false, error: { kind: "delivery-uncertain", delivery_id: item.id } };
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
      || (controller.nativeIdentityBound ? controller.providerSessionId : null) !== input.provider_session_id
    ) {
      return { ok: true, value: { kind: "unknown", reason: "provider-identity-changed" } };
    }
    return { ok: true, value: {
      kind: "owned",
      controller_instance_id: controller.controllerInstanceId,
      provider_session_id: controller.nativeIdentityBound ? controller.providerSessionId : null,
      state: controller.state,
    } };
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

  async interrupt(input: { conversation_id: string; generation: number }): Promise<Result<void, ConversationControlError>> {
    const controller = this.controllers.get(input.conversation_id);
    if (!controller || controller.generation !== input.generation || !controller.activeTurnId) {
      return { ok: false, error: adapterFailure(this.id, "no-active-turn", "Claude has no owned active turn") };
    }
    try { controller.interrupting = true; await controller.process.interrupt(); return { ok: true, value: undefined }; }
    catch (error) { return { ok: false, error: adapterFailure(this.id, "interrupt-failed", error) }; }
  }

  permissions(conversationId: string) { return this.controllers.get(conversationId)?.process.pendingPermissions() ?? []; }

  async decidePermission(input: { conversation_id: string; generation: number; request_id: string; decision: "allow" | "deny" | "allow_always" }): Promise<Result<void, ConversationControlError>> {
    const controller = this.controllers.get(input.conversation_id);
    if (!controller || controller.generation !== input.generation || !controller.process.decidePermission(input.request_id, input.decision)) {
      return { ok: false, error: adapterFailure(this.id, "permission-not-found", "Permission request is no longer pending on this controller") };
    }
    this.lifecycle.emit(this.event(controller, { kind: "controller-running", at: Date.now() }));
    return { ok: true, value: undefined };
  }

  subscribeRuntimeEvents(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.runtimeListeners.add(listener); return () => this.runtimeListeners.delete(listener);
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
      this.lifecycle.emit(this.event(controller, { kind: "controller-released", at: Date.now() }));
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
      void this.abandon(controller);
      return;
    }
    if ((record.type === "execution_hook" || record.type === "system" && record.subtype === "init") && sessionId && !controller.nativeIdentityBound) {
      const bound = this.lifecycle.emit(this.event(controller, { kind: "provider-session-bound", provider_session_id: sessionId, at: Date.now() }));
      if (!bound.ok) { void this.abandon(controller); return; }
      controller.nativeIdentityBound = true;
      for (const pendingRecord of controller.identityPendingRecords.splice(0)) this.acceptRecord(controller, pendingRecord);
    }
    if (!controller.nativeIdentityBound) { controller.identityPendingRecords.push(value); return; }
    if (record.type === "execution_hook") {
      const transition = record.transition as ExecutionTransition;
      const event: ProviderRuntimeEvent = { kind: "execution", conversation_id: controller.conversationId,
        generation: controller.generation, controller_instance_id: controller.controllerInstanceId,
        provider_session_id: controller.providerSessionId, source: "claude_sdk_hook",
        state: transition.state, event: transition.event, turn_id: transition.turn_id,
        preserve_existing: transition.preserve_existing };
      for (const listener of this.runtimeListeners) listener(event);
      return;
    }
    if (record.type === "user") {
      this.acknowledgeUser(controller, record);
      return;
    }
    // The SDK may consume several queued prompts in one native turn. Track
    // that native evidence instead of inventing one result per queued message.
    const consumed = Array.isArray(record.user_message_uuids) ? record.user_message_uuids
      : typeof record.user_message_uuid === "string" ? [record.user_message_uuid] : [];
    for (const uuid of consumed) {
      const turn = typeof uuid === "string" ? controller.messageTurns.get(uuid) : undefined;
      if (turn && turn !== controller.activeTurnId && controller.queuedTurns.includes(turn)) {
        controller.queuedTurns = controller.queuedTurns.filter(value => value !== turn);
        if (!controller.consumedTogether.includes(turn)) controller.consumedTogether.push(turn);
      }
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
    if (record.uuid !== pending.item.id) return;
    controller.pending = null;
    clearTimeout(pending.timer);
    if (controller.activeTurnId) {
      controller.queuedTurns.push(pending.item.turn_id);
    } else {
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
    const usage: ProviderRuntimeEvent = {
      kind: "usage", conversation_id: controller.conversationId, generation: controller.generation, provider_session_id: controller.providerSessionId,
      provider_record_id: typeof record.uuid === "string" ? record.uuid : `${controller.providerSessionId}:${controller.activeTurnId}`,
      observed_at: Date.now(), snapshot: {
        ...(object(record.usage) ? { usage: object(record.usage)! } : {}),
        ...(object(record.modelUsage) ? { model_usage: object(record.modelUsage)! } : {}),
        ...(typeof record.total_cost_usd === "number" ? { total_cost_usd: record.total_cost_usd } : {}),
        ...(typeof record.duration_ms === "number" ? { duration_ms: record.duration_ms } : {}),
        ...(typeof record.num_turns === "number" ? { num_turns: record.num_turns } : {}),
      },
    };
    for (const listener of this.runtimeListeners) listener(usage);
    const turnId = controller.activeTurnId;
    controller.activeTurnId = null;
    const now = Date.now();
    if (controller.interrupting) {
      controller.interrupting = false;
      this.lifecycle.emit(this.event(controller, { kind: "turn-cancelled", turn_id: turnId, at: now }));
    } else if (record.is_error === false && record.subtype === "success") {
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
    for (const consumedTurn of controller.consumedTogether.splice(0)) {
      this.lifecycle.emit(this.event(controller, { kind: "turn-started", turn_id: consumedTurn, at: now }));
      this.lifecycle.emit(this.event(controller, record.is_error === false && record.subtype === "success"
        ? { kind: "turn-completed", turn_id: consumedTurn, at: now }
        : { kind: "turn-unknown", turn_id: consumedTurn, at: now, reason: "probe-ambiguous" }));
    }
    const queued = controller.queuedTurns.shift();
    if (queued) {
      controller.activeTurnId = queued;
      controller.state = "running";
      this.lifecycle.emit(this.event(controller, { kind: "turn-started", turn_id: queued, at: now }));
    } else {
      controller.state = "waiting";
      this.lifecycle.emit(this.event(controller, { kind: "controller-waiting", at: now }));
    }
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
      void this.abandon(controller);
    }
  }

  private processExited(controller: ClaudeController, exit: { code: number | null; signal: string | null; stderr: string }): void {
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

  /** Stop a controller whose protocol Mandible can no longer trust, and give up its claim. */
  private async abandon(controller: ClaudeController): Promise<void> {
    if (controller.activeTurnId) {
      this.lifecycle.emit(this.event(controller, { kind: "turn-unknown", turn_id: controller.activeTurnId, at: Date.now(), reason: "probe-ambiguous" }));
    }
    this.lifecycle.emit(this.event(controller, { kind: "controller-released", at: Date.now(), reason: "protocol-ambiguous" }));
    controller.intentionalStop = true;
    this.controllers.delete(controller.conversationId);
    this.rejectPending(controller, adapterFailure(this.id, "ambiguous-protocol", "Claude emitted an ambiguous protocol record"));
    await controller.process.close();
  }
}
