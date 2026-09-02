import type {
  AdapterProbe,
  ConversationControllerAdapter,
  ControllerAcquisitionRequest,
  ControllerAdapterCapabilities,
  ControllerLease,
} from "./adapter.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import type { TurnStartParams, TurnSteerParams } from "./generated/codex-app-server/index.js";
import { AdapterLifecycle, adapterFailure, type AdapterLifecycleEvent } from "./provider-adapter.js";
import type { StructuredProcessExit, StructuredProcessSpawner } from "./structured-process.js";
import type { ConversationControlError, ConversationLifecycleEvent, ConversationOutboxItem, Result } from "./types.js";

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
  delivered: Set<string>;
  intentionalStop: boolean;
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

export class CodexAppServerControllerAdapter implements ConversationControllerAdapter {
  readonly id = "codex-app-server-v2";
  readonly provider = "codex";
  readonly capabilities: ControllerAdapterCapabilities = {
    resume_provider_session: true,
    resume_message_anchor: false,
    send: true,
    steer: true,
    queue: false,
    stop: true,
  };

  private readonly lifecycle = new AdapterLifecycle();
  private readonly controllers = new Map<string, CodexController>();
  private readonly spawnProcess: StructuredProcessSpawner | undefined;

  constructor(options: { spawnProcess?: StructuredProcessSpawner } = {}) {
    this.spawnProcess = options.spawnProcess;
  }

  async acquire(input: ControllerAcquisitionRequest): Promise<Result<ControllerLease, ConversationControlError>> {
    if (input.kind === "resume-message-anchor") {
      return { ok: false, error: adapterFailure(this.id, "message-anchor-unsupported", "Codex App Server cannot resume an exact message anchor") };
    }
    let client: CodexAppServerClient | null = null;
    try {
      client = await this.connectedClient();
      const result = input.kind === "start"
        ? await client.request("thread/start", { cwd: process.cwd(), ephemeral: false })
        : await client.request("thread/resume", { threadId: input.provider_session_id });
      const thread = responseThread(result);
      const providerSessionId = stringField(thread, "id");
      if (!providerSessionId) throw new Error("Codex App Server returned no thread identity");
      if (input.kind !== "start" && providerSessionId !== input.provider_session_id) {
        throw new Error("Codex App Server resumed a different thread identity");
      }
      const status = threadStatus(thread);
      if (status === "active") throw new Error("Codex thread already has an active provider controller");
      if (status !== "idle") {
        throw new Error(`Codex thread is not controllable from status ${status ?? "unknown"}`);
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
        delivered: new Set(),
        intentionalStop: false,
      };
      this.attach(controller);
      this.controllers.set(input.conversation_id, controller);
      return { ok: true, value: { controller_instance_id: input.controller_instance_id, provider_session_id: providerSessionId } };
    } catch (thrown) {
      if (client) await client.close();
      return { ok: false, error: adapterFailure(this.id, "startup-failed", thrown, { retryable: true }) };
    }
  }

  async deliver(item: ConversationOutboxItem): Promise<Result<{ provider_receipt_id: string }, ConversationControlError>> {
    const current = this.current(item);
    if (!current.ok) return current;
    const controller = current.value;
    if (controller.delivered.has(item.id)) {
      return { ok: true, value: { provider_receipt_id: `codex:user:${item.id}` } };
    }
    try {
      if (item.operation === "steer") {
        if (!controller.activeNativeTurnId || !controller.activeControlTurnId) {
          return { ok: false, error: adapterFailure(this.id, "no-active-turn", "Codex steering requires the exact active App Server turn") };
        }
        const expectedTurnId = controller.activeNativeTurnId;
        const params: TurnSteerParams = {
          threadId: controller.providerSessionId,
          clientUserMessageId: item.idempotency_key,
          expectedTurnId,
          input: [{ type: "text", text: item.message, text_elements: [] }],
        };
        const result = await controller.client.request("turn/steer", params);
        const turnId = stringField(result, "turnId");
        if (turnId !== expectedTurnId) throw new Error("Codex steering acknowledged a different active turn");
      } else {
        if (item.operation === "queue" || item.operation === "resume-message-anchor") {
          return { ok: false, error: adapterFailure(this.id, "unsupported-operation", item.operation) };
        }
        const params: TurnStartParams = {
          threadId: controller.providerSessionId,
          clientUserMessageId: item.idempotency_key,
          input: [{ type: "text", text: item.message, text_elements: [] }],
        };
        const result = await controller.client.request("turn/start", params);
        const turn = responseTurn(result);
        const nativeTurnId = stringField(turn, "id");
        if (!nativeTurnId) throw new Error("Codex App Server returned no turn identity");
        controller.activeNativeTurnId = nativeTurnId;
        controller.activeControlTurnId = item.turn_id;
        controller.state = "running";
        this.lifecycle.emit(this.event(controller, { kind: "controller-running", at: Date.now() }));
        this.lifecycle.emit(this.event(controller, { kind: "turn-started", turn_id: item.turn_id, at: Date.now() }));
        const status = stringField(turn, "status");
        if (status && status !== "inProgress") this.finishTurn(controller, turn);
      }
      controller.delivered.add(item.id);
      return { ok: true, value: { provider_receipt_id: `codex:user:${item.id}` } };
    } catch (thrown) {
      return { ok: false, error: adapterFailure(this.id, "delivery-failed", thrown, { retryable: true }) };
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

  subscribe(listener: (event: AdapterLifecycleEvent) => Result<void, ConversationControlError>): () => void {
    return this.lifecycle.subscribe(listener);
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
    const client = await CodexAppServerClient.connect({ spawnProcess: this.spawnProcess });
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
    if (record.id !== undefined && record.method.includes("requestApproval") && controller.activeControlTurnId) {
      this.lifecycle.emit(this.event(controller, {
        kind: "turn-waiting-permission",
        turn_id: controller.activeControlTurnId,
        at: Date.now(),
      }));
      return;
    }
    if (record.method === "turn/started") {
      const params = object(record.params);
      const threadId = stringField(params, "threadId");
      const nativeTurnId = stringField(object(params?.turn), "id");
      if (threadId !== controller.providerSessionId || !nativeTurnId) this.markAmbiguous(controller);
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
