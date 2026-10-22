import { SessionExecutionStore } from "../session-execution.js";
import type { ProviderExecutionEvent } from "./types.js";
import { providerRuntimeSettingsError } from "./runtime-options.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "../db.js";
import type { Logger, Session } from "../types.js";
import { processLiveness, readPidStartTime } from "../registry.js";
import { ConversationSourceReader } from "../conversations/source-reader.js";
import {
  getConversationStructureCache,
  sparseConversationBlockId,
} from "../conversations/structure-cache.js";
import {
  ConversationControllerRegistry,
  trapAdapterCall,
  type ControllerAcquisitionRequest,
  type ControllerLease,
  type ConversationControllerAdapter,
} from "./adapter.js";
import { ConversationControlStore, type ControllerProcess } from "./store.js";
import { AttachmentValidationError, ChatAttachmentStore } from "./attachment-store.js";
import type { ChatAttachment } from "./attachments.js";
import { chatItemIdentityKey, emptyProviderLiveProjection, mergeProviderLiveProjection } from "./provider-live.js";
import type {
  AcceptedConversationSubmission,
  ConversationControlError,
  ConversationControlSnapshot,
  ConversationSubmitRequest,
  ProviderAdapterEvent,
  ProviderDeliveryReceipt,
  ProviderLiveProjection,
  Result,
  TurnState,
} from "./types.js";

type ActiveTurn = Extract<TurnState, { kind: "queued" | "running" | "waiting-user" | "waiting-permission" }>;

export type NewConversationControllerRequest = {
  conversation_id: string;
  provider: "claude_code" | "codex";
  generation: number;
  cwd: string;
  runtime_options: import("./types.js").ConversationRuntimeOptions;
  signal?: AbortSignal;
};

export type NewConversationControllerLease = ControllerLease & { adapter_id: string };

/**
 * End a provider process that outlived the controller driving it; nothing can
 * write to its stdin any more. "unverified" means a process holds the pid but
 * its start time cannot be compared, so it is left running.
 */
async function endControllerProcess({ pid, pid_start }: ControllerProcess, adapterId: string): Promise<Result<"ended" | "unverified", ConversationControlError>> {
  const signal = (name: NodeJS.Signals): ConversationControlError | null => {
    try { process.kill(pid, name); return null; } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? null
        : { kind: "adapter-failure", adapter_id: adapterId, code: "orphan-signal-failed", message: `${name} to pid ${pid}: ${String(error)}`, retryable: false };
    }
  };
  const liveness = processLiveness(pid, pid_start);
  if (liveness !== "alive") return { ok: true, value: liveness === "dead" ? "ended" : "unverified" };
  const terminated = signal("SIGTERM");
  if (terminated) return { ok: false, error: terminated };
  for (let waited = 0; waited < 2_000 && processLiveness(pid, pid_start) === "alive"; waited += 50) await delay(50);
  const killed = processLiveness(pid, pid_start) === "alive" ? signal("SIGKILL") : null;
  return killed ? { ok: false, error: killed } : { ok: true, value: "ended" };
}

function isActiveTurn(turn: TurnState): turn is ActiveTurn {
  return turn.kind === "queued"
    || turn.kind === "running"
    || turn.kind === "waiting-user"
    || turn.kind === "waiting-permission";
}

export class ConversationControlService {
  readonly adapters = new ConversationControllerRegistry();
  private readonly store: ConversationControlStore;
  private readonly attachments: ChatAttachmentStore;

  private readonly onChange: ((snapshot: ConversationControlSnapshot) => void) | undefined;
  private readonly onProviderEvent: ((event: ProviderAdapterEvent) => void) | undefined;
  private readonly onTerminalTurn: ((input: {
    conversation_id: string;
    provider_session_id: string;
    turn_id: string;
  }) => Promise<{ status: string }>) | undefined;
  private readonly liveProjection = new Map<string, ProviderLiveProjection>();
  private readonly logger: Logger;
  private readonly pendingExecution = new Map<string, { adapter: ConversationControllerAdapter; request: ControllerAcquisitionRequest; events: ProviderExecutionEvent[] }>();

  constructor(private readonly db: Db, options: {
    now?: () => number;
    onChange?: (snapshot: ConversationControlSnapshot) => void;
    onProviderEvent?: (event: ProviderAdapterEvent) => void;
    onTerminalTurn?: (input: { conversation_id: string; provider_session_id: string; turn_id: string }) => Promise<{ status: string }>;
    logger?: Logger;
  } = {}) {
    this.store = new ConversationControlStore(db, options.now);
    this.attachments = new ChatAttachmentStore(db);
    this.onChange = options.onChange;
    this.onProviderEvent = options.onProviderEvent;
    this.onTerminalTurn = options.onTerminalTurn;
    this.logger = options.logger ?? (() => undefined);
  }

  registerAdapter(adapter: ConversationControllerAdapter): () => void {
    const unregister = this.adapters.register(adapter);
    const unsubscribe = adapter.subscribe((event): Result<void, ConversationControlError> => {
      const { conversation_id, generation, ...lifecycle } = event;
      if (lifecycle.kind === "controller-released") this.endExecution(conversation_id, generation, lifecycle.reason === "protocol-ambiguous" ? "mandible:protocol-ambiguous" : "mandible:controller-released", adapter);
      const result = lifecycle.kind === "controller-released"
        ? this.store.release(conversation_id, generation)
        : lifecycle.kind === "provider-session-bound"
          ? this.store.bindProviderSession(conversation_id, generation, lifecycle.provider_session_id)
          : lifecycle.kind === "controller-process"
            ? this.recordControllerProcess(conversation_id, generation, lifecycle.pid)
            : this.store.publishLifecycle(conversation_id, generation, lifecycle);
      if (result.ok && lifecycle.kind === "provider-session-bound") this.flushExecution(conversation_id, generation);
      if (result.ok) this.notify(conversation_id);
      if (result.ok && lifecycle.kind === "controller-released") {
        this.retireProviderTransients(conversation_id, generation, "provider-disconnected");
      }
      if (result.ok && lifecycle.kind === "turn-completed") {
        void this.reconcileTerminalTurn(conversation_id, generation, lifecycle.turn_id);
      }
      return result;
    });
    const unsubscribeRuntime = adapter.subscribeRuntimeEvents?.((event) => {
      if (event.kind === "execution") {
        const pending = this.pendingExecution.get(event.controller_instance_id);
        if (pending && pending.adapter === adapter && pending.request.conversation_id === event.conversation_id
            && pending.request.generation === event.generation) {
          pending.events.push(event);
          return;
        }
        this.applyExecution(adapter, event);
        return;
      }
      const owned = this.ownedAdapter(event.conversation_id, event.generation);
      if (!owned.ok || owned.value !== adapter) return;
      const snapshot = this.getSnapshot(event.conversation_id);
      if (!snapshot.ok || snapshot.value.provider_session_id !== event.provider_session_id) return;
      this.db.prepare(`INSERT INTO conversation_provider_usage (conversation_id, generation, provider_session_id, provider_record_id, snapshot_json, observed_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, generation) DO UPDATE SET provider_record_id = excluded.provider_record_id,
        snapshot_json = excluded.snapshot_json, observed_at = excluded.observed_at WHERE excluded.observed_at >= conversation_provider_usage.observed_at`)
        .run(event.conversation_id, event.generation, event.provider_session_id, event.provider_record_id, JSON.stringify(event.snapshot), event.observed_at);
      this.notify(event.conversation_id);
    });
    const unsubscribeProviderEvents = adapter.subscribeProviderEvents((event) => {
      if (this.projectProviderEvent(event)) this.onProviderEvent?.(event);
    });
    return () => {
      unsubscribeRuntime?.();
      unsubscribeProviderEvents();
      unsubscribe();
      unregister();
    };
  }

  getSnapshot(conversationId: string): Result<ConversationControlSnapshot, ConversationControlError> {
    const boundary = this.store.getBoundary(conversationId);
    if (!boundary.ok) return boundary;
    const adapter = this.adapters.forProvider(boundary.value.source);
    return this.store.snapshot(conversationId, adapter?.capabilities ?? null, adapter?.id ?? null);
  }

  private ownedAdapter(conversationId: string, generation: number): Result<ConversationControllerAdapter, ConversationControlError> {
    const snapshot = this.getSnapshot(conversationId);
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.ownership.kind !== "mandible" || snapshot.value.ownership.generation !== generation) {
      return { ok: false, error: { kind: "stale-generation", expected_generation: generation, actual_generation: snapshot.value.ownership.generation } };
    }
    const adapter = this.adapters.byAdapterId(snapshot.value.ownership.adapter_id);
    return adapter ? { ok: true, value: adapter } : { ok: false, error: { kind: "adapter-unavailable", adapter_id: snapshot.value.ownership.adapter_id, provider: snapshot.value.provider } };
  }

  async interrupt(conversationId: string, generation: number): Promise<Result<void, ConversationControlError>> {
    const owned = this.ownedAdapter(conversationId, generation);
    if (!owned.ok) return owned;
    if (!owned.value.interrupt) return { ok: false, error: { kind: "invalid-request", field: "interrupt", message: "Provider does not support interrupt" } };
    return trapAdapterCall(owned.value.id, () => owned.value.interrupt!({ conversation_id: conversationId, generation }));
  }

  permissions(conversationId: string): Result<import("./types.js").ManagedPermissionRequest[], ConversationControlError> {
    const snapshot = this.getSnapshot(conversationId);
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.ownership.kind !== "mandible") return { ok: true, value: [] };
    const owned = this.ownedAdapter(conversationId, snapshot.value.ownership.generation);
    if (!owned.ok) return owned;
    return { ok: true, value: owned.value.permissions?.(conversationId) ?? [] };
  }

  async decidePermission(input: { conversation_id: string; generation: number; request_id: string; decision: "allow" | "deny" | "allow_always" }): Promise<Result<void, ConversationControlError>> {
    const owned = this.ownedAdapter(input.conversation_id, input.generation);
    if (!owned.ok) return owned;
    if (!owned.value.decidePermission) return { ok: false, error: { kind: "invalid-request", field: "permission", message: "Provider does not support permission decisions" } };
    return trapAdapterCall(owned.value.id, () => owned.value.decidePermission!(input));
  }

  private retainedRuntimeOptions(conversationId: string): import("./types.js").ConversationRuntimeOptions {
    const conversation = this.db.prepare("SELECT session_id, model FROM conversations WHERE id = ?").get(conversationId) as { session_id: string; model: string | null } | undefined;
    const legacy = conversation ? this.db.prepare("SELECT run_options_json, allowed_tools FROM console_sessions WHERE provider_session_id = ? ORDER BY updated_at DESC LIMIT 1").get(conversation.session_id) as { run_options_json: string; allowed_tools: string | null } | undefined : undefined;
    const result: import("./types.js").ConversationRuntimeOptions = conversation?.model ? { model: conversation.model } : {};
    if (legacy) {
      const old = JSON.parse(legacy.run_options_json) as Record<string, unknown>;
      const names = { model: "model", thinking_effort: "effort", permission_mode: "permission_mode", system_prompt: "system_prompt", max_turns: "max_turns", max_cost_usd: "max_cost_usd", setting_sources: "setting_sources" } as const;
      for (const [oldName, name] of Object.entries(names)) if (old[oldName] !== null && old[oldName] !== undefined) Object.assign(result, { [name]: old[oldName] });
      if (legacy.allowed_tools) result.allowed_tools = JSON.parse(legacy.allowed_tools);
    }
    const rows = this.db.prepare("SELECT runtime_options_json FROM conversation_control_outbox WHERE conversation_id = ? AND state = 'delivered' ORDER BY created_at, id").all(conversationId) as { runtime_options_json: string }[];
    for (const row of rows) Object.assign(result, JSON.parse(row.runtime_options_json));
    const saved = this.db.prepare("SELECT options_json FROM conversation_runtime_settings WHERE conversation_id = ?").get(conversationId) as { options_json: string } | undefined;
    return saved ? JSON.parse(saved.options_json) : result;
  }

  getRuntimeSettings(conversationId: string) {
    const snapshot = this.getSnapshot(conversationId);
    if (!snapshot.ok) return snapshot;
    const saved = this.db.prepare("SELECT revision FROM conversation_runtime_settings WHERE conversation_id = ?").get(conversationId) as { revision: number } | undefined;
    const usage = this.db.prepare("SELECT generation, provider_session_id, snapshot_json, observed_at FROM conversation_provider_usage WHERE conversation_id = ? ORDER BY generation").all(conversationId) as { generation: number; provider_session_id: string; snapshot_json: string; observed_at: number }[];
    return { ok: true as const, value: { revision: saved?.revision ?? 0, runtime_options: this.retainedRuntimeOptions(conversationId), usage: usage.map(({ snapshot_json, ...row }) => ({ ...row, snapshot: JSON.parse(snapshot_json) })) } };
  }

  saveRuntimeSettings(conversationId: string, expectedRevision: number, settings: import("./types.js").ConversationRuntimeOptions): Result<{ revision: number; runtime_options: import("./types.js").ConversationRuntimeOptions }, ConversationControlError> {
    const snapshot = this.getSnapshot(conversationId);
    if (!snapshot.ok) return snapshot;
    const invalid = providerRuntimeSettingsError(snapshot.value.provider, settings);
    if (invalid) return { ok: false, error: { kind: "invalid-request", field: "runtime_options", message: invalid } };
    const current = this.getRuntimeSettings(conversationId);
    if (!current.ok) return current;
    if (current.value.revision !== expectedRevision) return { ok: false, error: { kind: "capability-drift", expected_revision: expectedRevision, actual_revision: current.value.revision } };
    return this.db.transaction(() => {
      const revision = expectedRevision + 1;
      const changed = this.db.prepare(`INSERT INTO conversation_runtime_settings (conversation_id, revision, options_json, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET revision = excluded.revision, options_json = excluded.options_json,
        updated_at = excluded.updated_at WHERE conversation_runtime_settings.revision = ?`)
        .run(conversationId, revision, JSON.stringify(settings), Date.now(), expectedRevision);
      if (changed.changes !== 1) return { ok: false as const, error: { kind: "capability-drift" as const, expected_revision: expectedRevision, actual_revision: (this.db.prepare("SELECT revision FROM conversation_runtime_settings WHERE conversation_id = ?").get(conversationId) as { revision: number }).revision } };
      this.notify(conversationId);
      return { ok: true as const, value: { revision, runtime_options: settings } };
    }).immediate();
  }

  async ownsController(conversationId: string, generation: number): Promise<boolean> {
    const snapshot = this.getSnapshot(conversationId);
    if (!snapshot.ok || snapshot.value.ownership.kind !== "mandible"
        || snapshot.value.ownership.generation !== generation) return false;
    const ownership = snapshot.value.ownership;
    const adapter = this.adapters.byAdapterId(ownership.adapter_id);
    if (!adapter) return false;
    const probed = await trapAdapterCall(adapter.id, () => adapter.probe({
      conversation_id: conversationId,
      provider_session_id: ownership.provider_session_id,
      controller_instance_id: ownership.controller_instance_id,
      generation,
    }));
    return probed.ok
      && probed.value.kind === "owned"
      && probed.value.provider_session_id === ownership.provider_session_id
      && probed.value.controller_instance_id === ownership.controller_instance_id;
  }

  async resume(input: { conversation_id: string; expected_revision: number; expected_generation: number; cwd: string; signal?: AbortSignal }): Promise<Result<ConversationControlSnapshot, ConversationControlError>> {
    const snapshot = this.getSnapshot(input.conversation_id);
    if (!snapshot.ok) return snapshot;
    const adapter = this.adapters.forProvider(snapshot.value.provider);
    if (!adapter) return { ok: false, error: { kind: "adapter-unavailable", provider: snapshot.value.provider, adapter_id: null } };
    const claimed = this.store.claimResume(input.conversation_id, input.expected_revision, input.expected_generation, adapter.capabilities, adapter.id);
    if (!claimed.ok) return claimed;
    this.notify(input.conversation_id);
    const acquired = await this.acquireWithExecution(adapter, { kind: "resume-provider-session", conversation_id: input.conversation_id,
      ...claimed.value, cwd: input.cwd, signal: input.signal, runtime_options: this.retainedRuntimeOptions(input.conversation_id) });
    if (!acquired.ok) {
      const failed = this.store.publishLifecycle(input.conversation_id, claimed.value.generation, { kind: "controller-failed", at: Date.now(), error: acquired.error });
      if (!failed.ok) return failed;
      const released = this.store.release(input.conversation_id, claimed.value.generation);
      if (!released.ok) return released;
      this.notify(input.conversation_id);
      return acquired;
    }
    if (input.signal?.aborted || acquired.value.provider_session_id !== claimed.value.provider_session_id || acquired.value.controller_instance_id !== claimed.value.controller_instance_id) {
      this.pendingExecution.delete(claimed.value.controller_instance_id);
      const stopped = await trapAdapterCall(adapter.id, () => adapter.stop({ conversation_id: input.conversation_id, ...claimed.value }));
      if (!stopped.ok) return stopped;
      const released = this.store.release(input.conversation_id, claimed.value.generation);
      if (!released.ok) return released;
      return { ok: false, error: { kind: "adapter-contract-violation", adapter_id: adapter.id, message: "Resume did not establish the requested native identity" } };
    }
    const acquiredIdentity = this.store.publishAcquired(input.conversation_id, claimed.value.generation, acquired.value.controller_instance_id, acquired.value.provider_session_id);
    const published = acquiredIdentity.ok ? this.recordControllerProcess(input.conversation_id, claimed.value.generation, acquired.value.pid) : acquiredIdentity;
    if (!published.ok) {
      this.pendingExecution.delete(claimed.value.controller_instance_id);
      const stopped = await trapAdapterCall(adapter.id, () => adapter.stop({ conversation_id: input.conversation_id, ...claimed.value }));
      return stopped.ok ? published : stopped;
    }
    this.flushExecution(input.conversation_id, claimed.value.generation);
    this.notify(input.conversation_id);
    return this.getSnapshot(input.conversation_id);
  }

  async acquireNew(
    request: NewConversationControllerRequest,
    commit: (lease: NewConversationControllerLease) => void,
  ): Promise<Result<NewConversationControllerLease, ConversationControlError>> {
    const adapter = this.adapters.forProvider(request.provider);
    if (!adapter) {
      return { ok: false, error: { kind: "adapter-unavailable", adapter_id: null, provider: request.provider } };
    }
    const controllerInstanceId = randomUUID();
    const acquisition: ControllerAcquisitionRequest = {
      kind: "start",
      conversation_id: request.conversation_id,
      generation: request.generation,
      controller_instance_id: controllerInstanceId,
      cwd: request.cwd,
      runtime_options: request.runtime_options,
      ...(request.signal ? { signal: request.signal } : {}),
    };
    const acquired = await this.acquireWithExecution(adapter, acquisition);
    if (!acquired.ok) return acquired;
    if (acquired.value.controller_instance_id !== controllerInstanceId
        || acquired.value.provider_session_id === null && adapter.provider !== "claude_code"
        || acquired.value.provider_session_id !== null && !acquired.value.provider_session_id.trim()) {
      this.pendingExecution.delete(controllerInstanceId);
      await trapAdapterCall(adapter.id, () => adapter.stop({
        conversation_id: request.conversation_id,
        provider_session_id: acquired.value.provider_session_id,
        controller_instance_id: controllerInstanceId,
        generation: request.generation,
      }));
      return { ok: false, error: {
        kind: "adapter-contract-violation" as const,
        adapter_id: adapter.id,
        message: "Adapter returned identity outside the new controller claim",
      } };
    }
    const lease: NewConversationControllerLease = { ...acquired.value, adapter_id: adapter.id };
    const stopAcquired = () => {
      this.pendingExecution.delete(controllerInstanceId);
      return trapAdapterCall(adapter.id, () => adapter.stop({
        conversation_id: request.conversation_id,
        provider_session_id: lease.provider_session_id,
        controller_instance_id: lease.controller_instance_id,
        generation: request.generation,
      }));
    };
    if (request.signal?.aborted) {
      await stopAcquired();
      return { ok: false, error: {
        kind: "adapter-failure",
        adapter_id: adapter.id,
        code: "acquisition-aborted",
        message: "Native conversation controller acquisition was cancelled",
        retryable: true,
      } };
    }
    try {
      this.db.transaction(() => {
        commit(lease);
        const adopted = this.store.adoptNewController(
          request.conversation_id,
          request.generation,
          adapter.id,
          lease.controller_instance_id,
          lease.provider_session_id,
        );
        const recorded = adopted.ok ? this.recordControllerProcess(request.conversation_id, request.generation, lease.pid) : adopted;
        if (!recorded.ok) throw new Error(JSON.stringify(recorded.error));
      }).immediate();
    } catch (thrown) {
      await stopAcquired();
      return { ok: false, error: {
        kind: "adapter-contract-violation",
        adapter_id: adapter.id,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      } };
    }
    this.flushExecution(request.conversation_id, request.generation);
    this.notify(request.conversation_id);
    return { ok: true, value: lease };
  }

  async submit(request: ConversationSubmitRequest): Promise<Result<AcceptedConversationSubmission, ConversationControlError>> {
    let resolvedAttachments: ChatAttachment[];
    try {
      resolvedAttachments = this.attachments.resolve(request.attachments);
    } catch (error) {
      if (!(error instanceof AttachmentValidationError)) throw error;
      return { ok: false, error: { kind: "invalid-request", field: "attachments", message: error.message } };
    }
    request = { ...request, attachments: resolvedAttachments,
      message: !request.message.trim() && resolvedAttachments.length > 0 ? "Please review the attached context." : request.message };
    const boundary = this.store.getBoundary(request.conversation_id);
    if (!boundary.ok) return boundary;
    const adapter = this.adapters.forProvider(boundary.value.source);
    if (!adapter) {
      return { ok: false, error: { kind: "adapter-unavailable", adapter_id: null, provider: boundary.value.source } };
    }
    if (!boundary.value.session_id) {
      const location = this.db.prepare("SELECT cwd FROM conversations WHERE id = ?").get(request.conversation_id) as { cwd: string | null };
      if (!location.cwd || !isAbsolute(location.cwd) || !existsSync(location.cwd)) return { ok: false, error: { kind: "invalid-request", field: "cwd", message: "Restore this conversation's exact checkout before sending" } };
    }
    const effectiveOptions = request.operation === "queue" || request.operation === "steer" ? {} : { ...this.retainedRuntimeOptions(request.conversation_id), ...request.runtime_options };
    const invalidOptions = providerRuntimeSettingsError(adapter.provider, effectiveOptions);
    if (invalidOptions) return { ok: false, error: { kind: "invalid-request", field: "runtime_options", message: invalidOptions } };
    const prepared = this.store.prepareSubmission(request, adapter.capabilities, adapter.id);
    if (!prepared.ok) return prepared;
    this.db.prepare("INSERT OR IGNORE INTO conversation_delivery_settings (delivery_id, options_json) VALUES (?, ?)")
      .run(prepared.value.delivery_id, JSON.stringify(effectiveOptions));
    if (prepared.value.already_delivered) {
      return { ok: true, value: {
        kind: "accepted",
        delivery_id: prepared.value.delivery_id,
        turn_id: prepared.value.turn_id,
        provider_receipt: null,
        snapshot: prepared.value.snapshot,
      } };
    }
    this.notify(request.conversation_id);
    if (prepared.value.acquisition_required) {
      const location = this.db.prepare("SELECT cwd FROM conversations WHERE id = ?").get(request.conversation_id) as { cwd: string | null };
      const frozen = this.db.prepare("SELECT options_json FROM conversation_delivery_settings WHERE delivery_id = ?").get(prepared.value.delivery_id) as { options_json: string };
      const settings = JSON.parse(frozen.options_json) as import("./types.js").ConversationRuntimeOptions;
      const acquisition: ControllerAcquisitionRequest = !prepared.value.provider_session_id
        ? { kind: "start", conversation_id: request.conversation_id, controller_instance_id: prepared.value.controller_instance_id, generation: prepared.value.snapshot.ownership.generation, cwd: location.cwd!, runtime_options: settings }
        : request.operation === "resume-message-anchor"
        ? {
          kind: "resume-message-anchor",
          conversation_id: request.conversation_id,
          controller_instance_id: prepared.value.controller_instance_id,
          provider_session_id: prepared.value.provider_session_id!,
          generation: prepared.value.snapshot.ownership.generation,
          message_anchor: request.message_anchor!,
          runtime_options: settings,
          cwd: location.cwd ?? undefined,
        }
        : {
          kind: "resume-provider-session",
          conversation_id: request.conversation_id,
          controller_instance_id: prepared.value.controller_instance_id,
          provider_session_id: prepared.value.provider_session_id!,
          generation: prepared.value.snapshot.ownership.generation,
          runtime_options: settings,
          cwd: location.cwd ?? undefined,
        };
      const acquiredCall = await this.acquireWithExecution(adapter, acquisition);
      const acquired: typeof acquiredCall = acquiredCall.ok && (
        acquiredCall.value.controller_instance_id !== prepared.value.controller_instance_id
        || (prepared.value.provider_session_id !== null && acquiredCall.value.provider_session_id !== prepared.value.provider_session_id)
      )
        ? {
          ok: false,
          error: {
            kind: "adapter-contract-violation",
            adapter_id: adapter.id,
            message: "Adapter returned controller or provider-session identity outside the acquired claim",
          },
        }
        : acquiredCall;
      if (!acquired.ok) {
        this.pendingExecution.delete(acquisition.controller_instance_id);
        const controllerFailed = this.store.publishLifecycle(request.conversation_id, prepared.value.snapshot.ownership.generation, {
          kind: "controller-failed",
          at: Date.now(),
          error: acquired.error,
        });
        if (!controllerFailed.ok) return controllerFailed;
        const turnFailed = this.store.publishLifecycle(request.conversation_id, prepared.value.snapshot.ownership.generation, {
          kind: "turn-failed",
          at: Date.now(),
          turn_id: prepared.value.turn_id,
          error: acquired.error,
        });
        if (!turnFailed.ok) return turnFailed;
        const deliveryFailed = this.store.finishDelivery(prepared.value.delivery_id, acquired);
        if (!deliveryFailed.ok) return deliveryFailed;
        const released = this.store.recoverFailedAcquisition(request.conversation_id, prepared.value.snapshot.ownership.generation);
        if (!released.ok) return released;
        this.notify(request.conversation_id);
        return acquired;
      }
      const acquiredIdentity = this.store.publishAcquired(
        request.conversation_id,
        prepared.value.snapshot.ownership.generation,
        acquired.value.controller_instance_id,
        acquired.value.provider_session_id,
      );
      const published = acquiredIdentity.ok
        ? this.recordControllerProcess(request.conversation_id, prepared.value.snapshot.ownership.generation, acquired.value.pid)
        : acquiredIdentity;
      if (!published.ok) {
        this.pendingExecution.delete(acquisition.controller_instance_id);
        const rolledBack = await trapAdapterCall(adapter.id, () => adapter.stop({
          conversation_id: request.conversation_id,
          provider_session_id: acquired.value.provider_session_id,
          controller_instance_id: acquired.value.controller_instance_id,
          generation: prepared.value.snapshot.ownership.generation,
        }));
        return rolledBack.ok ? published : rolledBack;
      }
      this.flushExecution(request.conversation_id, prepared.value.snapshot.ownership.generation);
      this.notify(request.conversation_id);
    }
    const delivered = await this.dispatch(prepared.value.delivery_id);
    if (!delivered.ok) return delivered;
    const snapshot = this.getSnapshot(request.conversation_id);
    if (!snapshot.ok) return snapshot;
    this.onChange?.(snapshot.value);
    return { ok: true, value: {
      kind: "accepted",
      delivery_id: prepared.value.delivery_id,
      turn_id: prepared.value.turn_id,
      provider_receipt: delivered.value,
      snapshot: snapshot.value,
    } };
  }

  async dispatch(deliveryId: string): Promise<Result<ProviderDeliveryReceipt | null, ConversationControlError>> {
    const begun = this.store.beginDelivery(deliveryId);
    if (!begun.ok) return begun;
    if (begun.value.state === "delivered") return { ok: true, value: null };
    const snapshot = this.getSnapshot(begun.value.conversation_id);
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.ownership.kind !== "mandible") {
      return { ok: false, error: { kind: "stale-generation", expected_generation: begun.value.generation, actual_generation: snapshot.value.ownership.generation } };
    }
    const adapter = this.adapters.byAdapterId(snapshot.value.ownership.adapter_id);
    if (!adapter) {
      this.store.markDeliveryUncertain(deliveryId, begun.value.generation);
      return { ok: false, error: { kind: "adapter-unavailable", adapter_id: snapshot.value.ownership.adapter_id, provider: snapshot.value.provider } };
    }
    const savedSettings = this.db.prepare("SELECT options_json FROM conversation_delivery_settings WHERE delivery_id = ?").get(deliveryId) as { options_json: string } | undefined;
    const item = { ...begun.value, runtime_options: savedSettings ? JSON.parse(savedSettings.options_json) : begun.value.runtime_options };
    const invalidSettings = providerRuntimeSettingsError(adapter.provider, item.runtime_options);
    const delivered = invalidSettings
      ? { ok: false as const, error: { kind: "invalid-request" as const, field: "runtime_options", message: invalidSettings } }
      : await trapAdapterCall(adapter.id, () => adapter.deliver(item));
    if (!delivered.ok && delivered.error.kind === "delivery-uncertain") {
      const uncertain = this.store.markDeliveryUncertain(deliveryId, begun.value.generation);
      return uncertain.ok ? delivered : uncertain;
    }
    const finished = this.store.finishDelivery(deliveryId, delivered);
    if (!finished.ok) return finished;
    if (!delivered.ok && ["send", "resume-provider-session", "resume-message-anchor"].includes(begun.value.operation)) {
      const failed = this.store.publishLifecycle(begun.value.conversation_id, begun.value.generation, {
        kind: "turn-failed",
        at: Date.now(),
        turn_id: begun.value.turn_id,
        error: delivered.error,
      });
      if (!failed.ok) return failed;
      const controllerFailed = this.store.publishLifecycle(begun.value.conversation_id, begun.value.generation, {
        kind: "controller-failed",
        at: Date.now(),
        error: delivered.error,
      });
      if (!controllerFailed.ok) return controllerFailed;
      this.notify(begun.value.conversation_id);
    }
    return delivered;
  }

  /** The one path that records a controller's process, whether it was spawned at acquisition or later. */
  private recordControllerProcess(conversationId: string, generation: number, pid: number | undefined): Result<void, ConversationControlError> {
    return pid
      ? this.store.recordControllerProcess(conversationId, generation, { pid, pid_start: readPidStartTime(pid) })
      : { ok: true, value: undefined };
  }

  private async acquireWithExecution(adapter: ConversationControllerAdapter, request: ControllerAcquisitionRequest): Promise<Result<ControllerLease, ConversationControlError>> {
    this.pendingExecution.set(request.controller_instance_id, { adapter, request, events: [] });
    const acquired = await trapAdapterCall(adapter.id, () => adapter.acquire(request));
    if (!acquired.ok) this.pendingExecution.delete(request.controller_instance_id);
    return acquired;
  }

  private applyExecution(adapter: ConversationControllerAdapter, event: ProviderExecutionEvent): void {
    if (adapter.provider !== "claude_code" && adapter.provider !== "codex") return;
    const owned = this.ownedAdapter(event.conversation_id, event.generation);
    const snapshot = this.getSnapshot(event.conversation_id);
    if (!owned.ok || owned.value !== adapter || !snapshot.ok || snapshot.value.ownership.kind !== "mandible"
        || snapshot.value.ownership.controller_instance_id !== event.controller_instance_id
        || snapshot.value.provider_session_id !== event.provider_session_id
        || (adapter.provider === "claude_code" ? "claude_sdk_hook" : "codex_app_server") !== event.source) return;
    new SessionExecutionStore(this.db).apply({ ...event, provider: adapter.provider === "claude_code" ? "claude" : "codex",
      controller_generation: event.generation });
  }

  private flushExecution(conversationId: string, generation: number): void {
    const snapshot = this.getSnapshot(conversationId);
    if (!snapshot.ok || snapshot.value.ownership.kind !== "mandible" || snapshot.value.ownership.generation !== generation
        || !snapshot.value.provider_session_id) return;
    const ownership = snapshot.value.ownership;
    const pending = this.pendingExecution.get(ownership.controller_instance_id);
    if (!pending) return;
    this.pendingExecution.delete(ownership.controller_instance_id);
    this.applyExecution(pending.adapter, { kind: "execution", conversation_id: conversationId, generation,
      controller_instance_id: ownership.controller_instance_id, provider_session_id: snapshot.value.provider_session_id,
      source: pending.adapter.provider === "claude_code" ? "claude_sdk_hook" : "codex_app_server",
      event: "mandible:controller-acquired", turn_id: null, state: { kind: "unknown" } });
    for (const event of pending.events) this.applyExecution(pending.adapter, event);
  }

  private endExecution(conversationId: string, generation: number, reason: string, adapter?: ConversationControllerAdapter): void {
    const owned = this.ownedAdapter(conversationId, generation);
    const snapshot = this.getSnapshot(conversationId);
    if (!owned.ok || adapter && owned.value !== adapter || !snapshot.ok || snapshot.value.ownership.kind !== "mandible") return;
    if (!snapshot.value.provider_session_id) {
      this.pendingExecution.delete(snapshot.value.ownership.controller_instance_id);
      return;
    }
    this.flushExecution(conversationId, generation);
    this.applyExecution(owned.value, { kind: "execution", conversation_id: conversationId, generation,
      controller_instance_id: snapshot.value.ownership.controller_instance_id, provider_session_id: snapshot.value.provider_session_id,
      source: owned.value.provider === "claude_code" ? "claude_sdk_hook" : "codex_app_server",
      event: reason, turn_id: null, state: reason === "mandible:protocol-ambiguous" ? { kind: "unknown" } : { kind: "ended", reason } });
  }

  /** No controller survives a daemon restart, so every Mandible claim is ended and released. */
  async reconcileAfterRestart(): Promise<ConversationControlError[]> {
    const errors: ConversationControlError[] = [];
    for (const claim of this.store.activeOwnedRows()) {
      const recovered = this.store.recoverFailedAcquisition(claim.conversation_id, claim.generation);
      const ended = !recovered.ok || recovered.value ? recovered
        : await this.relinquish(claim.conversation_id, claim.generation, claim.adapter_id, "turn-unknown");
      if (ended.ok) this.notify(claim.conversation_id);
      else errors.push(ended.error);
    }
    return errors;
  }

  /** End a claim whose controller is gone: its orphaned process, its deliveries, its active turn, then its ownership. */
  private async relinquish(
    conversationId: string,
    generation: number,
    adapterId: string,
    turnOutcome: "turn-cancelled" | "turn-unknown",
  ): Promise<Result<void, ConversationControlError>> {
    const controller = this.store.activeOwnedRows(conversationId)[0]?.controller_process;
    if (controller) {
      const ended = await endControllerProcess(controller, adapterId);
      if (!ended.ok) return ended;
      if (ended.value === "unverified") {
        this.logger("warn", "conversation_controller_unverified", { conversation_id: conversationId, ...controller });
      }
    }
    const lost: ConversationControlError = { kind: "adapter-failure", adapter_id: adapterId, code: "controller-lost",
      message: "The controller ended before this message was sent", retryable: true };
    for (const item of this.store.pendingOutbox()) {
      if (item.conversation_id !== conversationId || item.generation !== generation) continue;
      const settled = item.state === "pending"
        ? this.store.finishDelivery(item.id, { ok: false, error: lost })
        : this.store.markDeliveryUncertain(item.id, generation);
      if (!settled.ok) return settled;
    }
    const snapshot = this.getSnapshot(conversationId);
    if (snapshot.ok && isActiveTurn(snapshot.value.turn)) {
      const turn = this.store.publishLifecycle(conversationId, generation, turnOutcome === "turn-cancelled"
        ? { kind: turnOutcome, at: Date.now(), turn_id: snapshot.value.turn.turn_id }
        : { kind: turnOutcome, at: Date.now(), turn_id: snapshot.value.turn.turn_id, reason: "probe-ambiguous" });
      if (!turn.ok) return turn;
    }
    this.endExecution(conversationId, generation, "mandible:controller-relinquished");
    return this.store.release(conversationId, generation);
  }

  async stop(conversationId: string, generation: number): Promise<Result<void, ConversationControlError>> {
    const snapshot = this.getSnapshot(conversationId);
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.ownership.kind !== "mandible" || snapshot.value.ownership.generation !== generation) {
      return { ok: false, error: { kind: "stale-generation", expected_generation: generation, actual_generation: snapshot.value.ownership.generation } };
    }
    const ownership = snapshot.value.ownership;
    const adapter = this.adapters.byAdapterId(ownership.adapter_id);
    if (!adapter || !adapter.capabilities.stop) {
      return { ok: false, error: { kind: "unsupported-operation", operation: "stop", capability: snapshot.value.capability } };
    }
    const stopping = this.store.publishLifecycle(conversationId, generation, { kind: "controller-stopping", at: Date.now() });
    if (!stopping.ok) return stopping;
    this.notify(conversationId);
    const stopped = await trapAdapterCall(adapter.id, () => adapter.stop({
      conversation_id: conversationId,
      provider_session_id: ownership.provider_session_id,
      controller_instance_id: ownership.controller_instance_id,
      generation,
    }));
    const released = await this.relinquish(conversationId, generation, adapter.id, stopped.ok ? "turn-cancelled" : "turn-unknown");
    if (released.ok) this.notify(conversationId);
    return released.ok ? stopped : released;
  }

  /** Follow the session registry for every provider session, or for the one a registered session drives. */
  syncRegisteredOwnership(session?: Pick<Session, "id" | "conversation_id">): void {
    const providerSessionId = session ? session.conversation_id ?? session.id : null;
    for (const conversationId of this.store.syncRegisteredOwnership(providerSessionId)) this.notify(conversationId);
  }

  getLiveProjection(conversationId: string): Result<ProviderLiveProjection, ConversationControlError> {
    const boundary = this.store.getBoundary(conversationId);
    if (!boundary.ok) return boundary;
    return { ok: true, value: this.liveProjection.get(conversationId) ?? emptyProviderLiveProjection(conversationId) };
  }

  async close(): Promise<void> {
    await Promise.all(this.adapters.all().map((adapter) => adapter.close()));
  }

  private notify(conversationId: string): void {
    if (!this.onChange) return;
    const snapshot = this.getSnapshot(conversationId);
    if (snapshot.ok) this.onChange(snapshot.value);
  }

  private projectProviderEvent(event: ProviderAdapterEvent): boolean {
    if (event.kind !== "durable-reconciliation" && event.kind !== "transient-retirement") {
      const snapshot = this.getSnapshot(event.conversation_id);
      if (!snapshot.ok || snapshot.value.ownership.kind !== "mandible"
          || snapshot.value.ownership.generation !== event.generation
          || snapshot.value.provider_session_id !== event.provider_session_id) return false;
    }
    const current = this.liveProjection.get(event.conversation_id) ?? null;
    const next = mergeProviderLiveProjection(current, event);
    if (next === current) return false;
    this.liveProjection.set(event.conversation_id, next);
    return true;
  }

  private retireProviderTransients(
    conversationId: string,
    generation: number,
    reason: "provider-disconnected" | "generation-replaced",
  ): void {
    const current = this.liveProjection.get(conversationId);
    if (!current || current.events.length === 0) return;
    const providerSessionId = current.events.find((event) => event.generation === generation)?.provider_session_id;
    if (!providerSessionId) return;
    const sequence = current.events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    const retirement: ProviderAdapterEvent = {
      kind: "transient-retirement",
      conversation_id: conversationId,
      provider_session_id: providerSessionId,
      generation,
      sequence,
      observed_at: Date.now(),
      provider_event_id: `${reason}:${generation}`,
      reason,
    };
    if (this.projectProviderEvent(retirement)) this.onProviderEvent?.(retirement);
  }

  private async reconcileTerminalTurn(conversationId: string, generation: number, turnId: string): Promise<void> {
    const snapshot = this.getSnapshot(conversationId);
    const providerSessionId = snapshot.ok ? snapshot.value.provider_session_id : null;
    if (!providerSessionId || !this.onTerminalTurn) return;
    let status = "failed";
    try {
      status = (await this.onTerminalTurn({
        conversation_id: conversationId,
        provider_session_id: providerSessionId,
        turn_id: turnId,
      })).status;
    } catch {
      // The live projection remains authoritative until durable evidence exists.
    }

    const durableIds = new Set<string>();
    const current = this.liveProjection.get(conversationId) ?? emptyProviderLiveProjection(conversationId);
    let coveredIdentities: string[] = [];
    try {
      const durableUserTurnIds = new Set<string>();
      const delivery = this.db.prepare(`
        SELECT id, idempotency_key, provider_receipt_id
          FROM conversation_control_outbox
         WHERE conversation_id = ? AND generation = ? AND turn_id = ?
      `).get(conversationId, generation, turnId) as {
        id: string;
        idempotency_key: string;
        provider_receipt_id: string | null;
      } | undefined;
      const addDurableIdentity = (metadataJson: string): void => {
        try {
          const metadata = JSON.parse(metadataJson) as { chat_item?: unknown; client_intent_id?: unknown };
          if (!metadata.chat_item || typeof metadata.chat_item !== "object") return;
          const item = metadata.chat_item as Parameters<typeof chatItemIdentityKey>[0];
          if (item.type === "message" && item.role === "user" && item.identity.native_turn_id) {
            durableUserTurnIds.add(item.identity.native_turn_id);
          }
          const key = chatItemIdentityKey(
            item,
            { allowTranscriptCoordinates: true },
          );
          if (key) durableIds.add(key);
          // Codex writes its exact echoed client identity in the following
          // user_message event, after the response_item was normalized. Cover
          // that same durable Chat item without guessing from prose or turns.
          if (item.type === "message" && item.role === "user"
              && typeof metadata.client_intent_id === "string" && metadata.client_intent_id) {
            const clientItem = {
              ...item,
              identity: { ...item.identity, native_item_id: metadata.client_intent_id },
            };
            const clientKey = chatItemIdentityKey(clientItem);
            if (clientKey) durableIds.add(clientKey);
          }
        } catch {
          // Invalid metadata cannot establish durable coverage.
        }
      };
      const rows = this.db.prepare(`
        SELECT metadata_json
          FROM conversation_blocks
         WHERE conversation_id = ?
           AND metadata_json LIKE '%"chat_item"%'
         ORDER BY position DESC
         LIMIT 512
      `).all(conversationId) as Array<{ metadata_json: string }>;
      for (const row of rows) addDurableIdentity(row.metadata_json);

      const reader = new ConversationSourceReader(this.db);
      const recentBlockIds = (this.db.prepare(`
        SELECT id
          FROM conversation_structural_blocks
         WHERE conversation_id = ? AND status = 'current'
         ORDER BY position DESC
         LIMIT 256
      `).all(conversationId) as Array<{ id: string }>).map((row) => row.id);

      // Source-backed conversations reclaim dense rows, so exact terminal
      // reconciliation reads the same bounded tail from the sparse index.
      const source = this.db.prepare(`
        SELECT current_version_id
          FROM conversation_sources
         WHERE conversation_id = ? AND availability = 'available'
      `).get(conversationId) as { current_version_id: string | null } | undefined;
      if (source?.current_version_id) {
        const cache = getConversationStructureCache(this.db);
        const head = cache.readPage(conversationId, source.current_version_id, {
          offset: 0,
          limit: 1,
        });
        if (head && head.total > 0) {
          const tail = cache.readPage(conversationId, source.current_version_id, {
            offset: Math.max(0, head.total - 256),
            limit: 256,
          });
          for (const row of tail?.rows ?? []) {
            recentBlockIds.push(sparseConversationBlockId(conversationId, row.position));
          }
        }
      }

      for (const blockId of new Set(recentBlockIds)) {
        const read = await reader.readBlock(blockId);
        if (read.status !== "source" && read.status !== "legacy") continue;
        addDurableIdentity(read.value.metadata_json);
      }

      coveredIdentities = current.events.flatMap((event) => {
        if (event.kind !== "provisional-content") return [];
        if (durableIds.has(event.identity)) return [event.identity];
        const receiptTurnId = delivery?.provider_receipt_id?.startsWith("codex:turn:")
          ? delivery.provider_receipt_id.slice("codex:turn:".length)
          : null;
        const exactTurnCoverage = Boolean(receiptTurnId
          && delivery
          && event.correlation
          && durableUserTurnIds.has(receiptTurnId)
          && event.item.type === "message"
          && event.item.role === "user"
          && event.correlation.intent_id === delivery.idempotency_key
          && event.correlation.delivery_id === delivery.id);
        return exactTurnCoverage ? [event.identity] : [];
      });
      const terminalRetiredIdentities = status.endsWith(":fresh")
        ? current.events.flatMap((event) => event.kind === "provisional-content"
          && event.item.content_completion === "complete"
          && !coveredIdentities.includes(event.identity)
          ? [event.identity]
          : [])
        : [];
      const retiredIdentities = new Set([...coveredIdentities, ...terminalRetiredIdentities]);
      if (retiredIdentities.size > 0) {
        const sequence = current.events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
        const event: ProviderAdapterEvent = {
          kind: "durable-reconciliation",
          conversation_id: conversationId,
          provider_session_id: providerSessionId,
          generation,
          sequence,
          observed_at: Date.now(),
          provider_event_id: `turn:${turnId}`,
          covered_identities: [...new Set(coveredIdentities)],
          ...(terminalRetiredIdentities.length > 0
            ? { terminal_retired_identities: [...new Set(terminalRetiredIdentities)] }
            : {}),
        };
        if (this.projectProviderEvent(event)) this.onProviderEvent?.(event);
      }
      coveredIdentities = [...retiredIdentities];
    } catch {
      status = `${status}:projection_error`;
    }
    this.logger("info", "conversation_terminal_reconciliation", {
      conversation_id: conversationId,
      provider_session_id: providerSessionId,
      turn_id: turnId,
      ingest_status: status,
      durable_identity_count: durableIds.size,
      retired_live_count: new Set(coveredIdentities).size,
      retained_live_count: current.events.filter((event) => event.kind === "provisional-content").length - new Set(coveredIdentities).size,
    });
  }
}
