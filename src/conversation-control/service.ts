import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
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
import { ConversationControlStore } from "./store.js";
import { AttachmentValidationError, ChatAttachmentStore } from "./attachment-store.js";
import type { ChatAttachment } from "./attachments.js";
import { chatItemIdentityKey, emptyProviderLiveProjection, mergeProviderLiveProjection } from "./provider-live.js";
import type {
  AcceptedConversationSubmission,
  ConversationControlError,
  ConversationControlReconciliationReport,
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
  private readonly onReconciliationDiagnostic: ((details: Record<string, unknown>) => void) | undefined;
  private readonly liveProjection = new Map<string, ProviderLiveProjection>();

  constructor(private readonly db: Db, options: {
    now?: () => number;
    onChange?: (snapshot: ConversationControlSnapshot) => void;
    onProviderEvent?: (event: ProviderAdapterEvent) => void;
    onTerminalTurn?: (input: { conversation_id: string; provider_session_id: string; turn_id: string }) => Promise<{ status: string }>;
    onReconciliationDiagnostic?: (details: Record<string, unknown>) => void;
  } = {}) {
    this.store = new ConversationControlStore(db, options.now);
    this.attachments = new ChatAttachmentStore(db);
    this.onChange = options.onChange;
    this.onProviderEvent = options.onProviderEvent;
    this.onTerminalTurn = options.onTerminalTurn;
    this.onReconciliationDiagnostic = options.onReconciliationDiagnostic;
  }

  registerAdapter(adapter: ConversationControllerAdapter): () => void {
    const unregister = this.adapters.register(adapter);
    const unsubscribe = adapter.subscribe((event): Result<void, ConversationControlError> => {
      const { conversation_id, generation, ...lifecycle } = event;
      const result = lifecycle.kind === "controller-released"
        ? this.store.release(conversation_id, generation)
        : lifecycle.kind === "ownership-unknown"
          ? this.store.markUnknown(conversation_id, generation, lifecycle.reason)
          : lifecycle.kind === "provider-session-bound"
            ? this.store.bindProviderSession(conversation_id, generation, lifecycle.provider_session_id)
            : this.store.publishLifecycle(conversation_id, generation, lifecycle);
      if (result.ok) this.notify(conversation_id);
      if (result.ok && lifecycle.kind === "controller-released") {
        this.retireProviderTransients(conversation_id, generation, "provider-disconnected");
      }
      if (result.ok && lifecycle.kind === "turn-completed") {
        void this.reconcileTerminalTurn(conversation_id, generation, lifecycle.turn_id);
      }
      return result;
    });
    const unsubscribeProviderEvents = adapter.subscribeProviderEvents((event) => {
      if (this.projectProviderEvent(event)) this.onProviderEvent?.(event);
    });
    return () => {
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
    const acquired = await trapAdapterCall(adapter.id, () => adapter.acquire(acquisition));
    if (!acquired.ok) return acquired;
    if (acquired.value.controller_instance_id !== controllerInstanceId
        || !acquired.value.provider_session_id.trim()) {
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
    const stopAcquired = () => trapAdapterCall(adapter.id, () => adapter.stop({
      conversation_id: request.conversation_id,
      provider_session_id: lease.provider_session_id,
      controller_instance_id: lease.controller_instance_id,
      generation: request.generation,
    }));
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
        if (!adopted.ok) throw new Error(JSON.stringify(adopted.error));
      }).immediate();
    } catch (thrown) {
      await stopAcquired();
      return { ok: false, error: {
        kind: "adapter-contract-violation",
        adapter_id: adapter.id,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      } };
    }
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
    const prepared = this.store.prepareSubmission(request, adapter.capabilities, adapter.id);
    if (!prepared.ok) return prepared;
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
      const acquisition: ControllerAcquisitionRequest = request.operation === "resume-message-anchor"
        ? {
          kind: "resume-message-anchor",
          conversation_id: request.conversation_id,
          controller_instance_id: prepared.value.controller_instance_id,
          provider_session_id: prepared.value.provider_session_id,
          generation: prepared.value.snapshot.ownership.generation,
          message_anchor: request.message_anchor!,
          runtime_options: request.runtime_options,
        }
        : {
          kind: "resume-provider-session",
          conversation_id: request.conversation_id,
          controller_instance_id: prepared.value.controller_instance_id,
          provider_session_id: prepared.value.provider_session_id,
          generation: prepared.value.snapshot.ownership.generation,
          runtime_options: request.runtime_options,
        };
      const acquiredCall = await trapAdapterCall(adapter.id, () => adapter.acquire(acquisition));
      const acquired: typeof acquiredCall = acquiredCall.ok && (
        acquiredCall.value.controller_instance_id !== prepared.value.controller_instance_id
        || acquiredCall.value.provider_session_id !== prepared.value.provider_session_id
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
        this.notify(request.conversation_id);
        return acquired;
      }
      const published = this.store.publishAcquired(
        request.conversation_id,
        prepared.value.snapshot.ownership.generation,
        acquired.value.controller_instance_id,
        acquired.value.provider_session_id,
      );
      if (!published.ok) {
        const rolledBack = await trapAdapterCall(adapter.id, () => adapter.stop({
          conversation_id: request.conversation_id,
          provider_session_id: acquired.value.provider_session_id,
          controller_instance_id: acquired.value.controller_instance_id,
          generation: prepared.value.snapshot.ownership.generation,
        }));
        return rolledBack.ok ? published : rolledBack;
      }
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
    const delivered = await trapAdapterCall(adapter.id, () => adapter.deliver(begun.value));
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

  async reconcileAfterRestart(): Promise<ConversationControlReconciliationReport> {
    const claims = this.store.activeOwnedRows();
    const deliveries = this.store.pendingOutbox();
    const errors: ConversationControlError[] = [];
    const record = (result: Result<unknown, ConversationControlError>): void => {
      if (!result.ok) errors.push(result.error);
    };
    const recordControl = (conversationId: string, result: Result<unknown, ConversationControlError>): void => {
      record(result);
      if (result.ok) this.notify(conversationId);
    };
    for (const claim of claims) {
      const adapter = this.adapters.byAdapterId(claim.adapter_id);
      if (!adapter) {
        recordControl(claim.conversation_id, this.store.markUnknown(claim.conversation_id, claim.generation, "adapter-unavailable"));
        continue;
      }
      const probed = await trapAdapterCall(adapter.id, () => adapter.probe(claim));
      if (!probed.ok) {
        recordControl(claim.conversation_id, this.store.markUnknown(claim.conversation_id, claim.generation, "probe-ambiguous"));
        continue;
      }
      if (probed.value.kind === "unknown") {
        recordControl(claim.conversation_id, this.store.markUnknown(claim.conversation_id, claim.generation, probed.value.reason));
        continue;
      }
      if (probed.value.kind === "released") {
        const snapshot = this.getSnapshot(claim.conversation_id);
        if (snapshot.ok && isActiveTurn(snapshot.value.turn)) {
          recordControl(claim.conversation_id, this.store.publishLifecycle(claim.conversation_id, claim.generation, {
            kind: "turn-unknown",
            at: Date.now(),
            turn_id: snapshot.value.turn.turn_id,
            reason: "probe-ambiguous",
          }));
        }
        recordControl(claim.conversation_id, this.store.release(claim.conversation_id, claim.generation));
        continue;
      }
      if (probed.value.kind === "external") {
        recordControl(claim.conversation_id, this.store.replaceWithExternal(claim.conversation_id, claim.generation, {
          kind: probed.value.evidence,
          reference: probed.value.reference,
        }));
        continue;
      }
      if (
        probed.value.controller_instance_id !== claim.controller_instance_id
        || probed.value.provider_session_id !== claim.provider_session_id
      ) {
        recordControl(claim.conversation_id, this.store.markUnknown(claim.conversation_id, claim.generation, "provider-identity-changed"));
        continue;
      }
      recordControl(claim.conversation_id, this.store.publishLifecycle(claim.conversation_id, claim.generation, {
        kind: probed.value.state === "ready"
          ? "controller-ready"
          : probed.value.state === "running"
            ? "controller-running"
            : probed.value.state === "waiting"
              ? "controller-waiting"
              : "controller-stopping",
        at: Date.now(),
      }));
    }

    for (const item of deliveries) {
      if (item.state === "pending") {
        record(await this.dispatch(item.id));
        continue;
      }
      this.notify(item.conversation_id);
      const snapshot = this.getSnapshot(item.conversation_id);
      if (!snapshot.ok || snapshot.value.ownership.kind !== "mandible") {
        record(this.store.markDeliveryUncertain(item.id, item.generation));
        continue;
      }
      const adapter = this.adapters.byAdapterId(snapshot.value.ownership.adapter_id);
      if (!adapter) {
        record(this.store.markDeliveryUncertain(item.id, item.generation));
        continue;
      }
      const probed = await trapAdapterCall(adapter.id, () => adapter.probeDelivery(item));
      if (!probed.ok || probed.value === "unknown") {
        record(this.store.markDeliveryUncertain(item.id, item.generation));
      } else if (probed.value === "delivered") {
        record(this.store.resolveUncertainDelivery(item.id, item.generation, true));
      } else {
        const reset = this.store.resolveUncertainDelivery(item.id, item.generation, false);
        record(reset);
        if (reset.ok) record(await this.dispatch(item.id));
      }
    }
    return { claims_checked: claims.length, deliveries_checked: deliveries.length, errors };
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
    if (!stopped.ok) {
      const unknown = this.store.markUnknown(conversationId, generation, "probe-ambiguous");
      if (unknown.ok) this.notify(conversationId);
      return unknown.ok ? stopped : unknown;
    }
    if (isActiveTurn(snapshot.value.turn)) {
      const cancelled = this.store.publishLifecycle(conversationId, generation, {
        kind: "turn-cancelled",
        at: Date.now(),
        turn_id: snapshot.value.turn.turn_id,
      });
      if (!cancelled.ok) return cancelled;
    }
    const released = this.store.release(conversationId, generation);
    if (released.ok) this.notify(conversationId);
    return released;
  }

  recordExternalOwnership(conversationId: string, evidence: Parameters<ConversationControlStore["observeExternal"]>[1]): Result<void, ConversationControlError> {
    const result = this.store.observeExternal(conversationId, evidence);
    if (result.ok) this.notify(conversationId);
    return result;
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
    if (event.kind === "provider-lineage") this.materializeExactLineage(event);
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
    this.onReconciliationDiagnostic?.({
      conversation_id: conversationId,
      provider_session_id: providerSessionId,
      turn_id: turnId,
      ingest_status: status,
      durable_identity_count: durableIds.size,
      retired_live_count: new Set(coveredIdentities).size,
      retained_live_count: current.events.filter((event) => event.kind === "provisional-content").length - new Set(coveredIdentities).size,
    });
  }

  private materializeExactLineage(event: Extract<ProviderAdapterEvent, { kind: "provider-lineage" }>): void {
    if (!event.sender_provider_session_id || !event.receiver_provider_session_id) return;
    this.db.prepare(`
      UPDATE conversations AS child
         SET parent_conversation_id = (
           SELECT parent.id
             FROM conversations AS parent
            WHERE parent.id = ? AND parent.source = 'codex' AND parent.session_id = ?
            ORDER BY parent.created_at ASC, parent.id ASC
            LIMIT 1
         ),
             is_sidechain = 1,
             updated_at = datetime('now')
       WHERE child.source = 'codex'
         AND child.session_id = ?
         AND child.parent_conversation_id IS NULL
         AND EXISTS (
           SELECT 1 FROM conversations AS parent
            WHERE parent.id = ? AND parent.source = 'codex' AND parent.session_id = ?
         )
    `).run(
      event.conversation_id,
      event.sender_provider_session_id,
      event.receiver_provider_session_id,
      event.conversation_id,
      event.sender_provider_session_id,
    );
  }
}
