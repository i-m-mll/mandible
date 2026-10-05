import type {
  ActivityItem,
  ActivityKind,
  ChatItem,
  MessageItem,
  PlanItem,
  ToolCallItem,
} from "../parsers/types.js";
import { chatItemIdentityKey } from "./provider-live.js";
import { codexAttachmentInput } from "./attachment-delivery.js";
import type {
  AdapterProbe,
  ConversationControllerAdapter,
  ControllerAcquisitionRequest,
  ControllerAdapterCapabilities,
  ControllerLease,
} from "./adapter.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import type { TurnStartParams, TurnSteerParams } from "./generated/codex-app-server/index.js";
import { AdapterLifecycle, AdapterProviderEvents, adapterFailure, type AdapterLifecycleEvent } from "./provider-adapter.js";
import { CODEX_APP_SERVER_PROFILE } from "./provider-capabilities.js";
import type { StructuredProcessExit, StructuredProcessSpawner } from "./structured-process.js";
import type {
  ConversationControlError,
  ConversationLifecycleEvent,
  ConversationOutboxItem,
  ProviderAdapterEvent,
  ProviderDeliveryReceipt,
  ManagedPermissionRequest,
  ProviderRuntimeEvent,
  Result,
} from "./types.js";

type CodexController = {
  conversationId: string;
  generation: number;
  controllerInstanceId: string;
  providerSessionId: string;
  client: CodexAppServerClient;
  state: "ready" | "running" | "waiting" | "stopping";
  activeNativeTurnId: string | null;
  activeControlTurnId: string | null;
  terminalNativeTurnIds: Set<string>;
  delivered: Map<string, ProviderDeliveryReceipt>;
  intentionalStop: boolean;
  providerSequence: number;
  liveText: Map<string, string>;
  activeDelivery: ConversationOutboxItem | null;
  userMessageIds: Map<string, string>;
  permissions: Map<string, { request: ManagedPermissionRequest; protocolId: string | number; method: string }>;
};

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function stringField(value: unknown, field: string): string | null {
  const record = object(value);
  return typeof record?.[field] === "string" ? record[field] as string : null;
}

function responseThread(value: unknown): Record<string, unknown> | null {
  return object(object(value)?.thread);
}

function threadStatus(thread: Record<string, unknown> | null): string | null {
  return stringField(thread?.status, "type");
}

function responseTurn(value: unknown): Record<string, unknown> | null {
  return object(object(value)?.turn);
}

class UncertainCodexAcquisition extends Error {}

export class CodexAppServerControllerAdapter implements ConversationControllerAdapter {
  readonly id = CODEX_APP_SERVER_PROFILE.adapter_id;
  readonly provider = CODEX_APP_SERVER_PROFILE.provider;
  readonly capabilities: ControllerAdapterCapabilities = CODEX_APP_SERVER_PROFILE.capabilities;

  private readonly lifecycle = new AdapterLifecycle();
  private readonly providerEvents = new AdapterProviderEvents();
  private readonly runtimeListeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly controllers = new Map<string, CodexController>();
  private readonly acquiring = new Set<string>();
  private readonly spawnProcess: StructuredProcessSpawner | undefined;
  private readonly codexExecutable: string | undefined;

  constructor(options: { spawnProcess?: StructuredProcessSpawner; codexExecutable?: string } = {}) {
    this.spawnProcess = options.spawnProcess;
    this.codexExecutable = options.codexExecutable;
  }

  async acquire(input: ControllerAcquisitionRequest): Promise<Result<ControllerLease, ConversationControlError>> {
    if (input.kind === "resume-message-anchor") {
      return { ok: false, error: adapterFailure(this.id, "message-anchor-unsupported", "Codex App Server cannot resume an exact message anchor") };
    }
    if (this.controllers.has(input.conversation_id) || this.acquiring.has(input.conversation_id)) return { ok: false, error: adapterFailure(this.id, "controller-already-owned", "This conversation already has a controller acquisition") };
    this.acquiring.add(input.conversation_id);
    let client: CodexAppServerClient | null = null;
    let aborted = input.signal?.aborted === true;
    const abort = () => {
      aborted = true;
      if (client) void client.close();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (aborted) throw new Error("Codex controller acquisition was cancelled");
      client = await this.connectedClient();
      if (aborted) throw new Error("Codex controller acquisition was cancelled");
      const result = input.kind === "start"
        ? await client.request("thread/start", {
          cwd: input.cwd,
          ephemeral: false,
          model: input.runtime_options?.model,
          ...(input.runtime_options?.permission_mode === "agent-full-access"
            ? { approvalPolicy: "never" as const, sandbox: "danger-full-access" as const }
            : {}),
        })
        : await client.request("thread/resume", { threadId: input.provider_session_id, cwd: input.cwd, model: input.runtime_options?.model });
      if (aborted) throw new Error("Codex controller acquisition was cancelled");
      const thread = responseThread(result);
      const providerSessionId = stringField(thread, "id");
      if (!providerSessionId) throw new UncertainCodexAcquisition("Codex App Server returned no thread identity");
      if (input.kind !== "start" && providerSessionId !== input.provider_session_id) {
        throw new UncertainCodexAcquisition("Codex App Server resumed a different thread identity");
      }
      const status = threadStatus(thread);
      if (status === "active") throw new UncertainCodexAcquisition("Codex thread already has an active provider controller");
      if (status !== "idle") {
        throw new UncertainCodexAcquisition(`Codex thread is not controllable from status ${status ?? "unknown"}`);
      }
      const controller: CodexController = {
        conversationId: input.conversation_id,
        generation: input.generation,
        controllerInstanceId: input.controller_instance_id,
        providerSessionId,
        client,
        state: "ready",
        activeNativeTurnId: null,
        activeControlTurnId: null,
        terminalNativeTurnIds: new Set(),
        delivered: new Map(),
        intentionalStop: false,
        providerSequence: 0,
        liveText: new Map(),
        activeDelivery: null,
        userMessageIds: new Map(),
        permissions: new Map(),
      };
      this.attach(controller);
      this.controllers.set(input.conversation_id, controller);
      return { ok: true, value: { controller_instance_id: input.controller_instance_id, provider_session_id: providerSessionId } };
    } catch (thrown) {
      if (client) await client.close();
      return { ok: false, error: adapterFailure(this.id,
        thrown instanceof UncertainCodexAcquisition ? "acquisition-ambiguous" : "startup-failed",
        thrown, { retryable: true }) };
    } finally {
      this.acquiring.delete(input.conversation_id);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  async deliver(item: ConversationOutboxItem): Promise<Result<ProviderDeliveryReceipt, ConversationControlError>> {
    const current = this.current(item);
    if (!current.ok) return current;
    const controller = current.value;
    const priorReceipt = controller.delivered.get(item.id);
    if (priorReceipt) return { ok: true, value: priorReceipt };
    let input: TurnStartParams["input"];
    try {
      input = codexAttachmentInput(item.message, item.attachments ?? [], item.attachment_db_path);
    } catch (error) {
      return { ok: false, error: adapterFailure(this.id, "attachment-custody-failed", error) };
    }
    controller.activeDelivery = item;
    try {
      let providerTurnId: string;
      if (item.operation === "steer") {
        if (!controller.activeNativeTurnId || !controller.activeControlTurnId) {
          return { ok: false, error: adapterFailure(this.id, "no-active-turn", "Codex steering requires the exact active App Server turn") };
        }
        const expectedTurnId = controller.activeNativeTurnId;
        const params: TurnSteerParams = {
          threadId: controller.providerSessionId,
          clientUserMessageId: item.idempotency_key,
          expectedTurnId,
          input,
        };
        const result = await controller.client.request("turn/steer", params);
        const turnId = stringField(result, "turnId");
        if (turnId !== expectedTurnId) throw new Error("Codex steering acknowledged a different active turn");
        providerTurnId = turnId;
      } else {
        if (item.operation === "queue" || item.operation === "resume-message-anchor") {
          return { ok: false, error: adapterFailure(this.id, "unsupported-operation", item.operation) };
        }
        const params: TurnStartParams = {
          threadId: controller.providerSessionId,
          clientUserMessageId: item.idempotency_key,
          input,
          ...(item.runtime_options?.model ? { model: item.runtime_options.model } : {}),
          ...(item.runtime_options?.effort ? { effort: item.runtime_options.effort } : {}),
          ...(item.runtime_options?.permission_mode === "read-only" ? {
            approvalPolicy: "on-request" as const,
            sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
          } : item.runtime_options?.permission_mode === "agent-full-access" ? {
            approvalPolicy: "never" as const,
            sandboxPolicy: { type: "dangerFullAccess" as const },
          } : item.runtime_options?.permission_mode === "agent" ? {
            approvalPolicy: "on-request" as const,
            sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [], networkAccess: false,
              excludeTmpdirEnvVar: false, excludeSlashTmp: false },
          } : {}),
        };
        const result = await controller.client.request("turn/start", params);
        const turn = responseTurn(result);
        const nativeTurnId = stringField(turn, "id");
        if (!nativeTurnId) throw new Error("Codex App Server returned no turn identity");
        providerTurnId = nativeTurnId;
        controller.activeNativeTurnId = nativeTurnId;
        controller.activeControlTurnId = item.turn_id;
        controller.state = "running";
        this.lifecycle.emit(this.event(controller, { kind: "controller-running", at: Date.now() }));
        this.lifecycle.emit(this.event(controller, { kind: "turn-started", turn_id: item.turn_id, at: Date.now() }));
        const status = stringField(turn, "status");
        if (status && status !== "inProgress") this.finishTurn(controller, turn);
      }
      const receipt: ProviderDeliveryReceipt = {
        provider_receipt_id: `codex:turn:${providerTurnId}`,
        acceptance: {
          kind: "codex-turn-response",
          provider_session_id: controller.providerSessionId,
          provider_turn_id: providerTurnId,
        },
      };
      this.emitUserContent(controller, item, controller.userMessageIds.get(item.idempotency_key) ?? item.idempotency_key);
      controller.delivered.set(item.id, receipt);
      return { ok: true, value: receipt };
    } catch (thrown) {
      if (controller.activeDelivery?.id === item.id) controller.activeDelivery = null;
      return { ok: false, error: { kind: "delivery-uncertain", delivery_id: item.id } };
    }
  }

  async probe(input: Parameters<ConversationControllerAdapter["probe"]>[0]): Promise<Result<AdapterProbe, ConversationControlError>> {
    const controller = this.controllers.get(input.conversation_id);
    if (controller?.client.alive) {
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
    if (input.provider_session_id === null) return { ok: true, value: { kind: "released" } };
    let client: CodexAppServerClient | null = null;
    try {
      client = await this.connectedClient();
      const result = await client.request("thread/read", { threadId: input.provider_session_id, includeTurns: false });
      const status = threadStatus(responseThread(result));
      if (status === "idle") return { ok: true, value: { kind: "released" } };
      if (status === "active") {
        return { ok: true, value: { kind: "external", evidence: "provider-controller", reference: input.provider_session_id } };
      }
      return { ok: true, value: { kind: "unknown", reason: "probe-ambiguous" } };
    } catch (thrown) {
      return { ok: false, error: adapterFailure(this.id, "probe-failed", thrown, { retryable: true }) };
    } finally {
      if (client) await client.close();
    }
  }

  async probeDelivery(item: ConversationOutboxItem): Promise<Result<"delivered" | "not-delivered" | "unknown", ConversationControlError>> {
    const controller = this.controllers.get(item.conversation_id);
    return { ok: true, value: controller?.delivered.has(item.id) ? "delivered" : "unknown" };
  }

  async stop(input: Parameters<ConversationControllerAdapter["stop"]>[0]): Promise<Result<void, ConversationControlError>> {
    const controller = this.controllers.get(input.conversation_id);
    if (!controller) return { ok: true, value: undefined };
    if (controller.generation !== input.generation || controller.controllerInstanceId !== input.controller_instance_id) {
      return { ok: false, error: adapterFailure(this.id, "controller-identity-mismatch", "Codex controller identity changed") };
    }
    controller.intentionalStop = true;
    controller.state = "stopping";
    let interruptError: unknown = null;
    try {
      if (controller.activeNativeTurnId) {
        try {
          await controller.client.request("turn/interrupt", {
            threadId: controller.providerSessionId,
            turnId: controller.activeNativeTurnId,
          });
        } catch (error) {
          interruptError = error;
        }
      }
      await controller.client.close();
      this.controllers.delete(input.conversation_id);
      return { ok: true, value: undefined };
    } catch (thrown) {
      this.controllers.delete(input.conversation_id);
      return { ok: false, error: adapterFailure(this.id, "stop-failed", interruptError ?? thrown, { retryable: true }) };
    }
  }

  async interrupt(input: { conversation_id: string; generation: number }): Promise<Result<void, ConversationControlError>> {
    const controller = this.controllers.get(input.conversation_id);
    if (!controller || controller.generation !== input.generation || !controller.activeNativeTurnId) {
      return { ok: false, error: adapterFailure(this.id, "no-active-turn", "Codex has no owned active turn") };
    }
    try {
      await controller.client.request("turn/interrupt", { threadId: controller.providerSessionId, turnId: controller.activeNativeTurnId });
      return { ok: true, value: undefined };
    } catch (error) { return { ok: false, error: adapterFailure(this.id, "interrupt-failed", error) }; }
  }

  permissions(conversationId: string): ManagedPermissionRequest[] {
    return [...(this.controllers.get(conversationId)?.permissions.values() ?? [])].map(({ request }) => request);
  }

  async decidePermission(input: { conversation_id: string; generation: number; request_id: string; decision: "allow" | "deny" | "allow_always" }): Promise<Result<void, ConversationControlError>> {
    const controller = this.controllers.get(input.conversation_id);
    const pending = controller?.permissions.get(input.request_id);
    if (!controller || controller.generation !== input.generation || !pending) {
      return { ok: false, error: adapterFailure(this.id, "permission-not-found", "Permission request is no longer pending on this controller") };
    }
    if (input.decision === "allow_always") return { ok: false, error: adapterFailure(this.id, "unsupported-permission-decision", "Codex approval is scoped to this request") };
    try {
      if (pending.request.expires_at < Date.now()) return { ok: false, error: adapterFailure(this.id, "permission-expired", "This approval request expired") };
      const response = pending.method === "item/permissions/requestApproval"
        ? { permissions: input.decision === "allow" ? object(pending.request.tool_input)?.permissions ?? {} : {}, scope: "turn" }
        : { decision: input.decision === "allow" ? "accept" : "decline" };
      controller.client.respond(pending.protocolId, response);
      controller.permissions.delete(input.request_id);
      this.lifecycle.emit(this.event(controller, { kind: "controller-running", at: Date.now() }));
      return { ok: true, value: undefined };
    } catch (error) { return { ok: false, error: adapterFailure(this.id, "permission-response-failed", error) }; }
  }

  subscribe(listener: (event: AdapterLifecycleEvent) => Result<void, ConversationControlError>): () => void {
    return this.lifecycle.subscribe(listener);
  }

  subscribeRuntimeEvents(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.runtimeListeners.add(listener); return () => { this.runtimeListeners.delete(listener); };
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
      await controller.client.close();
    }));
  }

  private async connectedClient(): Promise<CodexAppServerClient> {
    const client = await CodexAppServerClient.connect({ spawnProcess: this.spawnProcess, executable: this.codexExecutable });
    try {
      const account = object(await client.request("account/read", { refreshToken: false }));
      if (!object(account?.account)) {
        throw new Error("Codex managed account authentication is unavailable");
      }
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private attach(controller: CodexController): void {
    controller.client.onNotification((record) => this.acceptNotification(controller, record));
    controller.client.onMalformed(() => this.markAmbiguous(controller));
    controller.client.onExit((exit) => this.processExited(controller, exit));
  }

  private acceptNotification(controller: CodexController, record: { method: string; params?: unknown; id?: string | number }): void {
    const params = object(record.params);
    if (record.method === "thread/tokenUsage/updated") {
      if (stringField(params, "threadId") !== controller.providerSessionId) return;
      const usage = object(params?.tokenUsage);
      if (!usage) return this.markAmbiguous(controller);
      const event: ProviderRuntimeEvent = { kind: "usage", conversation_id: controller.conversationId, generation: controller.generation,
        provider_session_id: controller.providerSessionId, provider_record_id: `${controller.providerSessionId}:${stringField(params, "turnId") ?? "usage"}`,
        observed_at: Date.now(), snapshot: { usage } };
      for (const listener of this.runtimeListeners) listener(event);
      return;
    }
    if (record.method === "serverRequest/resolved") {
      if (stringField(params, "threadId") === controller.providerSessionId) controller.permissions.delete(String(params?.requestId));
      return;
    }
    if (record.id !== undefined && ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(record.method)) {
      if (!controller.activeControlTurnId || stringField(params, "threadId") !== controller.providerSessionId
        || stringField(params, "turnId") !== controller.activeNativeTurnId) return this.markAmbiguous(controller);
      const id = String(record.id);
      controller.permissions.set(id, { protocolId: record.id, method: record.method,
        request: { id, tool_name: record.method, tool_input: params, description: stringField(params, "reason") ?? undefined,
          created_at: Date.now(), expires_at: Date.now() + 120_000 } });
      this.lifecycle.emit(this.event(controller, { kind: "turn-waiting-permission", turn_id: controller.activeControlTurnId, at: Date.now() }));
      return;
    }
    if (record.method === "turn/started") {
      const params = object(record.params);
      const threadId = stringField(params, "threadId");
      const nativeTurnId = stringField(object(params?.turn), "id");
      if (
        threadId !== controller.providerSessionId
        || !nativeTurnId
        || (controller.activeNativeTurnId !== null && nativeTurnId !== controller.activeNativeTurnId)
      ) this.markAmbiguous(controller);
      return;
    }
    if (record.method === "item/agentMessage/delta") {
      const params = object(record.params);
      const threadId = stringField(params, "threadId");
      const turnId = stringField(params, "turnId");
      const itemId = stringField(params, "itemId");
      const delta = stringField(params, "delta");
      if (threadId !== controller.providerSessionId || !turnId || !itemId || delta === null) {
        this.markAmbiguous(controller);
        return;
      }
      if (controller.activeNativeTurnId && turnId !== controller.activeNativeTurnId) {
        this.markAmbiguous(controller);
        return;
      }
      const text = `${controller.liveText.get(`message:${itemId}`) ?? ""}${delta}`;
      controller.liveText.set(`message:${itemId}`, text);
      this.emitItem(controller, this.messageItem(controller, itemId, "assistant", text, "streaming", turnId));
      return;
    }
    if (record.method === "item/reasoning/summaryTextDelta" || record.method === "item/reasoning/textDelta") {
      const params = object(record.params);
      const threadId = stringField(params, "threadId");
      const turnId = stringField(params, "turnId");
      const itemId = stringField(params, "itemId");
      const delta = stringField(params, "delta");
      const nativeIndex = Number(record.method === "item/reasoning/summaryTextDelta"
        ? params?.summaryIndex
        : params?.contentIndex);
      if (threadId !== controller.providerSessionId || !turnId || !itemId || delta === null
          || !Number.isInteger(nativeIndex) || nativeIndex < 0
          || (controller.activeNativeTurnId && turnId !== controller.activeNativeTurnId)) {
        this.markAmbiguous(controller);
        return;
      }
      const activityKind: ActivityKind = record.method === "item/reasoning/summaryTextDelta"
        ? "reasoning-summary"
        : "thinking";
      const prefix = `${activityKind}:${itemId}:`;
      const key = `${prefix}${nativeIndex}`;
      const text = `${controller.liveText.get(key) ?? ""}${delta}`;
      controller.liveText.set(key, text);
      const parts = [...controller.liveText.entries()].flatMap(([candidate, value]) => {
        if (!candidate.startsWith(prefix)) return [];
        const index = Number(candidate.slice(prefix.length));
        return Number.isInteger(index) ? [{ type: "text" as const, text: value, native_index: index }] : [];
      }).sort((left, right) => left.native_index - right.native_index);
      this.emitItem(controller, this.activityItem(
        controller,
        itemId,
        activityKind,
        parts,
        "streaming",
        turnId,
      ));
      return;
    }
    if (record.method === "item/commandExecution/outputDelta") {
      const params = object(record.params);
      const threadId = stringField(params, "threadId");
      const turnId = stringField(params, "turnId");
      const itemId = stringField(params, "itemId");
      const delta = stringField(params, "delta");
      if (threadId !== controller.providerSessionId || !turnId || !itemId || delta === null
          || (controller.activeNativeTurnId && turnId !== controller.activeNativeTurnId)) {
        this.markAmbiguous(controller);
        return;
      }
      const key = `command:${itemId}`;
      const output = `${controller.liveText.get(key) ?? ""}${delta}`;
      controller.liveText.set(key, output);
      this.emitItem(controller, this.toolItem(controller, itemId, "streaming", turnId, {
        tool_name: "command",
        tool_kind: "commandExecution",
        output,
      }));
      return;
    }
    if (record.method === "item/mcpToolCall/progress") {
      const params = object(record.params);
      const threadId = stringField(params, "threadId");
      const turnId = stringField(params, "turnId");
      const itemId = stringField(params, "itemId");
      const message = stringField(params, "message");
      if (threadId !== controller.providerSessionId || !turnId || !itemId || message === null
          || (controller.activeNativeTurnId && turnId !== controller.activeNativeTurnId)) {
        this.markAmbiguous(controller);
        return;
      }
      this.emitItem(controller, this.activityItem(
        controller,
        itemId,
        "tool-progress",
        message ? [{ type: "text", text: message }] : [],
        "streaming",
        turnId,
      ));
      return;
    }
    if (record.method === "item/started" || record.method === "item/completed") {
      this.acceptItem(controller, object(record.params), record.method === "item/completed");
      return;
    }
    if (record.method === "turn/completed") {
      const params = object(record.params);
      if (stringField(params, "threadId") !== controller.providerSessionId) {
        this.markAmbiguous(controller);
        return;
      }
      this.finishTurn(controller, object(params?.turn));
      return;
    }
    if (record.method === "error" && controller.activeControlTurnId) this.markAmbiguous(controller);
  }

  private acceptItem(controller: CodexController, params: Record<string, unknown> | null, complete: boolean): void {
    if (!params || stringField(params, "threadId") !== controller.providerSessionId) return;
    const turnId = stringField(params, "turnId");
    if (!turnId || (controller.activeNativeTurnId && turnId !== controller.activeNativeTurnId)) {
      this.markAmbiguous(controller);
      return;
    }
    const item = object(params.item);
    const itemId = stringField(item, "id");
    const itemType = stringField(item, "type");
    if (!item || !itemId || !itemType) return;
    if (itemType === "userMessage") {
      const delivery = controller.activeDelivery;
      if (!delivery) return;
      controller.userMessageIds.set(delivery.idempotency_key, itemId);
      this.emitUserContent(controller, delivery, itemId, item, complete);
      return;
    }
    for (const liveItem of this.codexItems(controller, item, complete, turnId)) {
      this.emitItem(controller, liveItem);
    }
    if (itemType === "collabAgentToolCall" && stringField(item, "tool") === "spawnAgent") {
      const sender = stringField(item, "senderThreadId");
      const receivers = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((value): value is string => typeof value === "string" && Boolean(value))
        : [];
      if (sender !== controller.providerSessionId || receivers.length === 0) return;
      for (const receiver of receivers) {
        this.providerEvents.emit({
          kind: "provider-lineage",
          conversation_id: controller.conversationId,
          provider_session_id: controller.providerSessionId,
          generation: controller.generation,
          sequence: ++controller.providerSequence,
          observed_at: Date.now(),
          provider_event_id: itemId,
          relation: "spawned-child",
          sender_provider_session_id: sender,
          receiver_provider_session_id: receiver,
        });
      }
    }
  }

  private emitItem(
    controller: CodexController,
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

  private emitUserContent(
    controller: CodexController,
    delivery: ConversationOutboxItem,
    providerMessageId: string,
    item?: Record<string, unknown>,
    complete = true,
  ): void {
    const rawContent = item?.content;
    const content = Array.isArray(rawContent) && rawContent.length > 0
      ? rawContent
      : [{ type: "text", text: delivery.message }];
    const text = content.flatMap((part) => {
      const candidate = object(part);
      return typeof candidate?.text === "string" ? [candidate.text] : [];
    }).join("");
    this.emitItem(controller, this.messageItem(
      controller,
      delivery.idempotency_key,
      "user",
      text || delivery.message,
      complete ? "complete" : "streaming",
      controller.activeNativeTurnId ?? undefined,
    ), {
        intent_id: delivery.idempotency_key,
        delivery_id: delivery.id,
        turn_id: delivery.turn_id,
        provider_message_id: providerMessageId,
    });
  }

  private liveIdentity(
    controller: CodexController,
    itemId: string,
    turnId?: string,
    contentIndex?: number,
  ): ChatItem["identity"] {
    return {
      provider: "codex",
      session_id: controller.providerSessionId,
      native_item_id: itemId,
      ...(turnId ? { native_turn_id: turnId } : {}),
      ...(contentIndex !== undefined ? { native_content_index: contentIndex } : {}),
      // Live identities always carry native identity; transcript coordinates
      // are therefore deliberately inert placeholders in the frozen shape.
      source_record_ordinal: 0,
      source_sub_block_ordinal: contentIndex ?? 0,
    };
  }

  private messageItem(
    controller: CodexController,
    itemId: string,
    role: MessageItem["role"],
    value: string,
    completion: MessageItem["content_completion"],
    turnId?: string,
  ): MessageItem {
    return {
      type: "message",
      role,
      identity: this.liveIdentity(controller, itemId, turnId),
      provenance: { source: "live-provider-event", provider: "codex", source_event_type: "message" },
      parts: value ? [{ type: "text", text: value }] : [],
      content_completion: completion,
    };
  }

  private activityItem(
    controller: CodexController,
    itemId: string,
    activityKind: ActivityKind,
    parts: ActivityItem["parts"],
    completion: ActivityItem["content_completion"],
    turnId?: string,
    fields: Partial<Pick<ActivityItem, "severity" | "status" | "elapsed_ms" | "tool_name" | "tool_id" | "related_tool_ids">> = {},
  ): ActivityItem {
    return {
      type: "activity",
      role: "assistant",
      activity_kind: activityKind,
      identity: this.liveIdentity(controller, itemId, turnId),
      provenance: { source: "live-provider-event", provider: "codex", source_event_type: activityKind },
      parts,
      content_completion: completion,
      ...fields,
    };
  }

  private toolItem(
    controller: CodexController,
    itemId: string,
    completion: ToolCallItem["content_completion"],
    turnId: string,
    fields: Partial<ToolCallItem>,
  ): ToolCallItem {
    return {
      type: "tool-call",
      role: "assistant",
      phase: "call",
      identity: this.liveIdentity(controller, itemId, turnId),
      provenance: { source: "live-provider-event", provider: "codex", source_event_type: String(fields.tool_kind ?? "tool") },
      parts: [],
      content_completion: completion,
      ...fields,
    };
  }

  private codexItems(
    controller: CodexController,
    item: Record<string, unknown>,
    complete: boolean,
    turnId: string,
  ): ChatItem[] {
    const itemId = stringField(item, "id");
    const type = stringField(item, "type");
    if (!itemId || !type) return [];
    const completion = complete ? "complete" as const : "streaming" as const;
    if (type === "agentMessage") {
      const value = stringField(item, "text");
      return value === null ? [] : [this.messageItem(controller, itemId, "assistant", value, completion, turnId)];
    }
    if (type === "plan") {
      const value = stringField(item, "text");
      if (value === null) return [];
      const plan: PlanItem = {
        type: "plan",
        role: "assistant",
        identity: this.liveIdentity(controller, itemId, turnId),
        provenance: { source: "live-provider-event", provider: "codex", source_event_type: "plan" },
        parts: value ? [{ type: "text", text: value }] : [],
        content_completion: completion,
      };
      return [plan];
    }
    if (type === "reasoning") {
      const parts = (value: unknown) => Array.isArray(value)
        ? value.flatMap((text, nativeIndex) => typeof text === "string" && text
          ? [{ type: "text" as const, text, native_index: nativeIndex }]
          : [])
        : [];
      const summary = parts(item.summary);
      const content = parts(item.content);
      return [
        ...(summary.length > 0
          ? [this.activityItem(controller, itemId, "reasoning-summary", summary, completion, turnId)]
          : []),
        ...(content.length > 0
          ? [this.activityItem(controller, itemId, "thinking", content, completion, turnId)]
          : []),
      ];
    }

    const status = stringField(item, "status");
    const executionOutcome = status === "completed" ? "succeeded" as const
      : status === "failed" || status === "declined" ? "failed" as const
      : undefined;
    if (type === "commandExecution") {
      const output = stringField(item, "aggregatedOutput");
      const command = stringField(item, "command");
      return [this.toolItem(controller, itemId, completion, turnId, {
        tool_name: "command",
        tool_kind: type,
        ...(command !== null ? { input: command } : {}),
        ...(output !== null ? { output, parts: output ? [{ type: "text", text: output }] : [] } : {}),
        ...(executionOutcome ? { execution_outcome: executionOutcome } : {}),
      })];
    }
    if (type === "mcpToolCall" || type === "dynamicToolCall") {
      const tool = stringField(item, "tool");
      return [this.toolItem(controller, itemId, completion, turnId, {
        ...(tool ? { tool_name: tool } : {}),
        tool_kind: type,
        ...(item.arguments !== undefined ? { input: item.arguments } : {}),
        ...(item.result !== undefined && item.result !== null ? { output: item.result } : {}),
        ...(executionOutcome ? { execution_outcome: executionOutcome } : {}),
      })];
    }
    if (type === "fileChange" || type === "collabAgentToolCall" || type === "webSearch"
        || type === "imageGeneration") {
      const tool = type === "collabAgentToolCall" ? stringField(item, "tool") : type;
      return [this.toolItem(controller, itemId, completion, turnId, {
        tool_name: tool ?? type,
        tool_kind: type,
        ...(type === "fileChange" ? { input: item.changes } : {}),
        ...(executionOutcome ? { execution_outcome: executionOutcome } : {}),
      })];
    }
    if (type === "contextCompaction" || type === "enteredReviewMode" || type === "exitedReviewMode"
        || type === "sleep" || type === "subAgentActivity") {
      return [this.activityItem(controller, itemId, "status", [], completion, turnId, {
        status: type,
        ...(typeof item.durationMs === "number" ? { elapsed_ms: item.durationMs } : {}),
      })];
    }
    return [];
  }

  private finishTurn(controller: CodexController, turn: Record<string, unknown> | null): void {
    const nativeTurnId = stringField(turn, "id");
    const status = stringField(turn, "status");
    if (nativeTurnId && controller.terminalNativeTurnIds.has(nativeTurnId)) return;
    if (!controller.activeControlTurnId || !nativeTurnId || nativeTurnId !== controller.activeNativeTurnId) {
      this.markAmbiguous(controller);
      return;
    }
    const controlTurnId = controller.activeControlTurnId;
    controller.terminalNativeTurnIds.add(nativeTurnId);
    if (controller.terminalNativeTurnIds.size > 128) {
      controller.terminalNativeTurnIds.delete(controller.terminalNativeTurnIds.values().next().value!);
    }
    controller.activeControlTurnId = null;
    controller.activeNativeTurnId = null;
    controller.activeDelivery = null;
    const now = Date.now();
    if (status === "completed") {
      this.lifecycle.emit(this.event(controller, { kind: "turn-completed", turn_id: controlTurnId, at: now }));
    } else if (status === "interrupted") {
      this.lifecycle.emit(this.event(controller, { kind: "turn-cancelled", turn_id: controlTurnId, at: now }));
    } else if (status === "failed") {
      const error = object(turn?.error);
      this.lifecycle.emit(this.event(controller, {
        kind: "turn-failed",
        turn_id: controlTurnId,
        at: now,
        error: adapterFailure(this.id, "turn-failed", stringField(error, "message") ?? "Codex turn failed"),
      }));
    } else {
      this.lifecycle.emit(this.event(controller, { kind: "turn-unknown", turn_id: controlTurnId, at: now, reason: "probe-ambiguous" }));
    }
    controller.state = "waiting";
    this.lifecycle.emit(this.event(controller, { kind: "controller-waiting", at: now }));
  }

  private markAmbiguous(controller: CodexController): void {
    if (controller.activeControlTurnId) {
      this.lifecycle.emit(this.event(controller, {
        kind: "turn-unknown",
        turn_id: controller.activeControlTurnId,
        at: Date.now(),
        reason: "probe-ambiguous",
      }));
      controller.activeControlTurnId = null;
      controller.activeNativeTurnId = null;
      controller.state = "waiting";
    } else {
      this.lifecycle.emit(this.event(controller, { kind: "ownership-unknown", at: Date.now(), reason: "probe-ambiguous" }));
      void this.abandon(controller);
    }
  }

  private processExited(controller: CodexController, exit: StructuredProcessExit): void {
    this.controllers.delete(controller.conversationId);
    if (controller.intentionalStop) return;
    const now = Date.now();
    if (controller.activeControlTurnId) {
      this.lifecycle.emit(this.event(controller, { kind: "turn-unknown", turn_id: controller.activeControlTurnId, at: now, reason: "probe-ambiguous" }));
      controller.activeControlTurnId = null;
      controller.activeNativeTurnId = null;
    }
    if (exit.code !== 0) {
      this.lifecycle.emit(this.event(controller, {
        kind: "controller-failed",
        at: now,
        error: adapterFailure(this.id, "process-exited", exit.stderr || `Codex App Server exited with ${exit.code ?? exit.signal}`, { retryable: true }),
      }));
    }
    this.lifecycle.emit(this.event(controller, { kind: "controller-released", at: now }));
  }

  private current(item: ConversationOutboxItem): Result<CodexController, ConversationControlError> {
    const controller = this.controllers.get(item.conversation_id);
    if (!controller || controller.generation !== item.generation || !controller.client.alive) {
      return { ok: false, error: adapterFailure(this.id, "controller-unavailable", "Codex App Server controller is unavailable", { retryable: true }) };
    }
    return { ok: true, value: controller };
  }

  private event(controller: CodexController, event: ConversationLifecycleEvent): AdapterLifecycleEvent {
    return { ...event, conversation_id: controller.conversationId, generation: controller.generation };
  }

  private async abandon(controller: CodexController): Promise<void> {
    controller.intentionalStop = true;
    this.controllers.delete(controller.conversationId);
    await controller.client.close();
  }
}
