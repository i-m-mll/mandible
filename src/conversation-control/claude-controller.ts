import { randomUUID } from "node:crypto";
import type {
  AdapterProbe,
  ConversationControllerAdapter,
  ControllerAcquisitionRequest,
  ControllerAdapterCapabilities,
  ControllerLease,
} from "./adapter.js";
import { AdapterLifecycle, AdapterProviderEvents, adapterFailure, type AdapterLifecycleEvent } from "./provider-adapter.js";
import { CLAUDE_SDK_MANAGED_PROFILE } from "./provider-capabilities.js";
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
  liveText: string;
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
    try {
      processOwner = await StructuredJsonProcess.start("claude", args, { spawnProcess: this.spawnProcess });
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
        liveText: "",
      };
      processOwner.onRecord((record) => this.acceptRecord(controller, record));
      processOwner.onMalformed(() => this.markAmbiguous(controller));
      processOwner.onExit((exit) => this.processExited(controller, exit));
      this.controllers.set(input.conversation_id, controller);
      return { ok: true, value: { controller_instance_id: input.controller_instance_id, provider_session_id: providerSessionId } };
    } catch (thrown) {
      if (processOwner) await processOwner.close();
      return { ok: false, error: adapterFailure(this.id, "startup-failed", thrown, { retryable: true }) };
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
        message: { role: "user", content: [{ type: "text", text: item.message }] },
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
      this.publishClaudeRecord(controller, record);
      this.acknowledgeUser(controller, record);
      return;
    }
    if (record.type === "assistant") {
      this.publishClaudeRecord(controller, record);
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
    const message = object(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const echoedText = content.map((block) => object(block)?.text).filter((text): text is string => typeof text === "string").join("\n");
    if (echoedText !== pending.item.message) return;
    controller.pending = null;
    clearTimeout(pending.timer);
    if (pending.item.operation !== "steer") {
      controller.activeTurnId = pending.item.turn_id;
      controller.state = "running";
      this.lifecycle.emit(this.event(controller, { kind: "controller-running", at: Date.now() }));
      this.lifecycle.emit(this.event(controller, { kind: "turn-started", turn_id: pending.item.turn_id, at: Date.now() }));
    }
    const providerMessageId = typeof record.uuid === "string" && record.uuid ? record.uuid : null;
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
      controller.liveMessageId = typeof message?.id === "string" ? message.id : controller.activeTurnId;
      controller.liveText = "";
      return;
    }
    if (stream.type === "content_block_delta") {
      const delta = object(stream.delta);
      if (delta?.type !== "text_delta" || typeof delta.text !== "string") return;
      controller.liveText += delta.text;
      const identity = controller.liveMessageId ?? controller.activeTurnId;
      if (!identity) return;
      this.emitContent(controller, `message:${identity}`, {
        type: "assistant",
        uuid: identity,
        session_id: controller.providerSessionId,
        parent_tool_use_id: null,
        message: {
          id: identity,
          role: "assistant",
          content: [{ type: "text", text: controller.liveText }],
        },
      });
    }
  }

  private publishClaudeRecord(controller: ClaudeController, record: Record<string, unknown>): void {
    const messageId = object(record.message)?.id;
    const uuid = typeof record.uuid === "string" && record.uuid ? record.uuid : null;
    const identity = typeof messageId === "string" && messageId
      ? `message:${messageId}`
      : uuid
        ? `event:${uuid}`
        : null;
    if (!identity) return;
    this.emitContent(controller, identity, record as { type: string; [key: string]: unknown });
  }

  private emitContent(controller: ClaudeController, identity: string, event: { type: string; [key: string]: unknown }): void {
    this.providerEvents.emit({
      kind: "provisional-content",
      conversation_id: controller.conversationId,
      provider_session_id: controller.providerSessionId,
      generation: controller.generation,
      sequence: ++controller.providerSequence,
      observed_at: Date.now(),
      identity,
      event,
    });
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
