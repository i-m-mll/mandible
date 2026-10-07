import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { ControllerAdapterCapabilities } from "./adapter.js";
import type {
  AcceptedConversationSubmission,
  ConversationContinuationCapability,
  ConversationControlError,
  ConversationControlOperation,
  ConversationControlSnapshot,
  ConversationLifecycleEvent,
  ConversationOutboxItem,
  ConversationSubmitRequest,
  ControllerOwnership,
  ControllerState,
  ExternalControllerEvidence,
  ReconciliationUnknownReason,
  Result,
  TurnState,
} from "./types.js";

type ConversationBoundary = {
  id: string;
  source: string;
  session_id: string | null;
  parent_conversation_id: string | null;
  has_message_anchor: number;
  local_draft: number;
};

type ControlRow = {
  conversation_id: string;
  provider: string;
  provider_session_id: string | null;
  revision: number;
  generation: number;
  owner_kind: ControllerOwnership["kind"];
  controller_state: ControllerState["kind"];
  controller_instance_id: string | null;
  adapter_id: string | null;
  owner_detail_json: string;
  last_authoritative_signal: number | null;
  turn_state: TurnState["kind"];
  turn_id: string | null;
  delivery_id: string | null;
  state_detail_json: string;
  updated_at: number;
};

type StoredDetail = {
  controller_error?: ConversationControlError;
  turn_error?: ConversationControlError;
  unknown_reason?: ReconciliationUnknownReason;
  unknown_prior_owner?: "mandible" | "external" | "unknown";
};

type PreparedSubmission = Omit<AcceptedConversationSubmission, "provider_receipt"> & {
  acquisition_required: boolean;
  already_delivered: boolean;
  adapter_id: string;
  provider_session_id: string | null;
  controller_instance_id: string;
};

function failedAcquisition(error: ConversationControlError | null, adapterId: string): boolean {
  return error?.kind === "adapter-failure" && error.adapter_id === adapterId && error.code === "startup-failed";
}

class RecoveryTransitionError extends Error {
  constructor(readonly controlError: ConversationControlError) { super(controlError.kind); }
}

function parseObject<T extends object>(json: string): T {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted conversation control object");
  }
  return value as T;
}

function controllerState(row: ControlRow, detail: StoredDetail): ControllerState {
  const at = row.updated_at;
  switch (row.controller_state) {
    case "stopped": return { kind: "stopped", at };
    case "starting": return { kind: "starting", since: at };
    case "ready": return { kind: "ready", since: at };
    case "running": return { kind: "running", since: at };
    case "waiting": return { kind: "waiting", since: at };
    case "stopping": return { kind: "stopping", since: at };
    case "failed":
      if (!detail.controller_error) throw new Error("Persisted failed controller has no error");
      return { kind: "failed", at, error: detail.controller_error };
    case "unknown": return { kind: "unknown", since: at, reason: detail.unknown_reason ?? "probe-ambiguous" };
  }
}

function turnState(row: ControlRow, detail: StoredDetail): TurnState {
  const at = row.updated_at;
  switch (row.turn_state) {
    case "none": return { kind: "none" };
    case "queued": return { kind: "queued", turn_id: row.turn_id!, delivery_id: row.delivery_id!, since: at };
    case "running": return { kind: "running", turn_id: row.turn_id!, since: at };
    case "waiting-user": return { kind: "waiting-user", turn_id: row.turn_id!, since: at };
    case "waiting-permission": return { kind: "waiting-permission", turn_id: row.turn_id!, since: at };
    case "completed": return { kind: "completed", turn_id: row.turn_id!, at };
    case "failed":
      if (!detail.turn_error) throw new Error("Persisted failed turn has no error");
      return { kind: "failed", turn_id: row.turn_id!, at, error: detail.turn_error };
    case "cancelled": return { kind: "cancelled", turn_id: row.turn_id!, at };
    case "unknown": return { kind: "unknown", turn_id: row.turn_id, since: at, reason: detail.unknown_reason ?? "probe-ambiguous" };
  }
}

function ownership(row: ControlRow, detail: StoredDetail): ControllerOwnership {
  switch (row.owner_kind) {
    case "none": return { kind: "none", generation: row.generation };
    case "mandible":
      return {
        kind: "mandible",
        generation: row.generation,
        controller_instance_id: row.controller_instance_id!,
        adapter_id: row.adapter_id!,
        provider_session_id: row.provider_session_id,
        last_authoritative_signal: row.last_authoritative_signal!,
      };
    case "external":
      return {
        kind: "external",
        generation: row.generation,
        evidence: parseObject<ExternalControllerEvidence>(row.owner_detail_json),
        last_authoritative_signal: row.last_authoritative_signal!,
      };
    case "unknown":
      return {
        kind: "unknown",
        generation: row.generation,
        prior_owner: detail.unknown_prior_owner ?? "unknown",
        reason: detail.unknown_reason ?? "probe-ambiguous",
      };
  }
}

function unavailable(revision: number, reason: Extract<ConversationContinuationCapability, { kind: "unavailable" }>["reason"]): ConversationContinuationCapability {
  return { kind: "unavailable", revision, reason };
}

export class ConversationControlStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  getBoundary(conversationId: string): Result<ConversationBoundary, ConversationControlError> {
    const row = this.db.prepare(`
      SELECT c.id, c.source, NULLIF(c.session_id, '') AS session_id, c.parent_conversation_id,
        EXISTS(SELECT 1 FROM conversation_spawn_requests s WHERE s.id = c.id AND s.schema_version = 'mandible-conversation-spawn-request@3' AND s.state = 'ready' AND s.provider_session_id IS NULL) AS local_draft,
        EXISTS(
          SELECT 1 FROM conversation_structural_blocks b
          WHERE b.conversation_id = c.id AND b.status = 'current'
            AND b.dag_uuid IS NOT NULL AND b.dag_uuid != ''
        ) AS has_message_anchor
      FROM conversations c WHERE c.id = ?
    `).get(conversationId) as ConversationBoundary | undefined;
    return row
      ? { ok: true, value: row }
      : { ok: false, error: { kind: "conversation-not-found", conversation_id: conversationId } };
  }

  ensure(conversationId: string): Result<ControlRow, ConversationControlError> {
    const boundary = this.getBoundary(conversationId);
    if (!boundary.ok) return boundary;
    const now = this.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO conversation_control_state (
        conversation_id, provider, provider_session_id, revision, generation,
        owner_kind, controller_state, owner_detail_json, turn_state,
        state_detail_json, updated_at
      ) VALUES (?, ?, ?, 0, 0, 'none', 'stopped', '{}', 'none', '{}', ?)
    `).run(conversationId, boundary.value.source, boundary.value.session_id || null, now);
    return { ok: true, value: this.row(conversationId)! };
  }

  snapshot(conversationId: string, capabilities: ControllerAdapterCapabilities | null, adapterId: string | null): Result<ConversationControlSnapshot, ConversationControlError> {
    const boundary = this.getBoundary(conversationId);
    if (!boundary.ok) return boundary;
    const persisted = this.row(conversationId);
    const row = persisted ?? {
      conversation_id: conversationId,
      provider: boundary.value.source,
      provider_session_id: boundary.value.session_id || null,
      revision: 0,
      generation: 0,
      owner_kind: "none" as const,
      controller_state: "stopped" as const,
      controller_instance_id: null,
      adapter_id: null,
      owner_detail_json: "{}",
      last_authoritative_signal: null,
      turn_state: "none" as const,
      turn_id: null,
      delivery_id: null,
      state_detail_json: "{}",
      updated_at: 0,
    };
    return { ok: true, value: this.toSnapshot(row, boundary.value, capabilities, adapterId) };
  }

  claimResume(conversationId: string, expectedRevision: number, expectedGeneration: number, capabilities: ControllerAdapterCapabilities, adapterId: string): Result<{ generation: number; controller_instance_id: string; provider_session_id: string }, ConversationControlError> {
    return this.db.transaction(() => {
      const boundary = this.getBoundary(conversationId);
      if (!boundary.ok) return boundary;
      const ensured = this.ensure(conversationId);
      if (!ensured.ok) return ensured;
      const row = ensured.value;
      if (row.revision !== expectedRevision) return { ok: false as const, error: { kind: "capability-drift" as const, expected_revision: expectedRevision, actual_revision: row.revision } };
      if (row.generation !== expectedGeneration) return { ok: false as const, error: { kind: "stale-generation" as const, expected_generation: expectedGeneration, actual_generation: row.generation } };
      const snapshot = this.toSnapshot(row, boundary.value, capabilities, adapterId);
      if (row.owner_kind !== "none" || !capabilities.resume_provider_session || boundary.value.parent_conversation_id || !boundary.value.session_id) {
        return { ok: false as const, error: { kind: "unsupported-operation" as const, operation: "resume-provider-session" as const, capability: snapshot.capability } };
      }
      const generation = row.generation + 1;
      const controllerInstanceId = randomUUID();
      const now = this.now();
      this.db.prepare(`UPDATE conversation_control_state SET generation = ?, revision = revision + 1,
        owner_kind = 'mandible', controller_state = 'starting', controller_instance_id = ?, adapter_id = ?,
        owner_detail_json = '{}', last_authoritative_signal = ?, state_detail_json = '{}', updated_at = ?
        WHERE conversation_id = ?`).run(generation, controllerInstanceId, adapterId, now, now, conversationId);
      this.journal(conversationId, row.revision + 1, generation, "controller-acquired", { adapter_id: adapterId, controller_instance_id: controllerInstanceId }, now);
      return { ok: true as const, value: { generation, controller_instance_id: controllerInstanceId, provider_session_id: boundary.value.session_id } };
    }).immediate();
  }

  prepareSubmission(request: ConversationSubmitRequest, capabilities: ControllerAdapterCapabilities, adapterId: string): Result<PreparedSubmission, ConversationControlError> {
    const transaction = this.db.transaction((): Result<PreparedSubmission, ConversationControlError> => {
      const runtimeOptionsJson = JSON.stringify(request.runtime_options ?? {});
      const attachmentsJson = JSON.stringify(request.attachments ?? []);
      const boundaryResult = this.getBoundary(request.conversation_id);
      if (!boundaryResult.ok) return boundaryResult;
      const boundary = boundaryResult.value;
      const ensured = this.ensure(request.conversation_id);
      if (!ensured.ok) return ensured;
      const existing = this.db.prepare(
        "SELECT * FROM conversation_control_outbox WHERE conversation_id = ? AND idempotency_key = ?",
      ).get(request.conversation_id, request.idempotency_key) as Record<string, unknown> | undefined;
      let retry: Record<string, unknown> | undefined;
      if (existing) {
        if (existing.message !== request.message || existing.operation !== request.operation
            || (existing.message_anchor ?? null) !== (request.message_anchor ?? null)
            || String(existing.runtime_options_json ?? "{}") !== runtimeOptionsJson
            || String(existing.attachments_json ?? "[]") !== attachmentsJson) {
          return { ok: false, error: { kind: "invalid-request", field: "idempotency_key", message: "Idempotency key was already used for a different submission" } };
        }
        const current = this.row(request.conversation_id)!;
        const priorError = existing.error_json ? parseObject<ConversationControlError>(String(existing.error_json)) : null;
        if (existing.state === "failed" && existing.attempts === 0
            && failedAcquisition(priorError, adapterId)
            && current.owner_kind === "none" && current.generation === existing.generation
            && current.turn_state === "failed" && current.turn_id === existing.turn_id) {
          retry = existing;
        } else return {
          ok: true,
          value: {
            kind: "accepted",
            delivery_id: String(existing.id),
            turn_id: String(existing.turn_id),
            snapshot: this.toSnapshot(current, boundary, capabilities, adapterId),
            acquisition_required: false,
            already_delivered: existing.state === "delivered",
            adapter_id: current.adapter_id ?? adapterId,
            provider_session_id: current.provider_session_id ?? boundary.session_id,
            controller_instance_id: current.controller_instance_id ?? "",
          },
        };
      }
      const row = ensured.value;
      if (!retry && request.expected_revision !== row.revision) {
        return { ok: false, error: { kind: "capability-drift", expected_revision: request.expected_revision, actual_revision: row.revision } };
      }
      if (!retry && request.expected_generation !== row.generation) {
        return { ok: false, error: { kind: "stale-generation", expected_generation: request.expected_generation, actual_generation: row.generation } };
      }
      const snapshot = this.toSnapshot(row, boundary, capabilities, adapterId);
      if (!this.operationMatches(request.operation, snapshot.capability.kind)) {
        if (snapshot.capability.kind === "blocked-external" || snapshot.capability.kind === "blocked-ownership-unknown") {
          return { ok: false, error: { kind: "ownership-conflict", owner: snapshot.capability.kind === "blocked-external" ? "external" : "unknown", capability: snapshot.capability } };
        }
        return { ok: false, error: { kind: "unsupported-operation", operation: request.operation, capability: snapshot.capability } };
      }
      if (!request.message.trim()) {
        return { ok: false, error: { kind: "invalid-request", field: "message", message: "Message must not be empty" } };
      }
      if (request.operation === "resume-message-anchor" && !request.message_anchor) {
        return { ok: false, error: { kind: "invalid-request", field: "message_anchor", message: "Message-anchor resume requires an exact anchor" } };
      }
      if ((request.operation === "steer" || request.operation === "queue") && Object.keys(request.runtime_options ?? {}).length > 0) {
        return { ok: false, error: { kind: "invalid-request", field: "runtime_options", message: "Runtime options apply only when starting a new provider turn" } };
      }

      const acquisitionRequired = row.owner_kind === "none";
      const generation = acquisitionRequired ? row.generation + 1 : row.generation;
      const controllerInstanceId = acquisitionRequired ? randomUUID() : row.controller_instance_id!;
      const deliveryId = retry ? String(retry.id) : randomUUID();
      const turnId = retry ? String(retry.turn_id) : randomUUID();
      let revision = row.revision;
      const now = this.now();
      if (acquisitionRequired) {
        revision += 1;
        this.db.prepare(`UPDATE conversation_control_state SET
          revision = ?, generation = ?, owner_kind = 'mandible', controller_state = 'starting',
          controller_instance_id = ?, adapter_id = ?, owner_detail_json = ?,
          last_authoritative_signal = ?, state_detail_json = '{}', updated_at = ?
          WHERE conversation_id = ? AND revision = ?
        `).run(revision, generation, controllerInstanceId, adapterId, boundary.session_id ? "{}" : JSON.stringify({ native_identity_pending: true }), now, now, request.conversation_id, row.revision);
        this.journal(request.conversation_id, revision, generation, "controller-acquired", { adapter_id: adapterId, controller_instance_id: controllerInstanceId }, now);
      }
      revision += 1;
      if (request.operation === "steer" || request.operation === "queue") {
        this.db.prepare(`UPDATE conversation_control_state SET revision = ?, updated_at = ?
          WHERE conversation_id = ? AND generation = ?
        `).run(revision, now, request.conversation_id, generation);
      } else {
        this.db.prepare(`UPDATE conversation_control_state SET
          revision = ?, turn_state = 'queued', turn_id = ?, delivery_id = ?, state_detail_json = '{}', updated_at = ?
          WHERE conversation_id = ? AND generation = ?
        `).run(revision, turnId, deliveryId, now, request.conversation_id, generation);
      }
      if (retry) {
        this.db.prepare(`UPDATE conversation_control_outbox SET generation = ?, state = 'pending',
          error_json = NULL, updated_at = ? WHERE id = ? AND state = 'failed' AND attempts = 0
        `).run(generation, now, deliveryId);
      } else {
        this.db.prepare(`INSERT INTO conversation_control_outbox (
          id, conversation_id, generation, turn_id, operation, message, message_anchor, runtime_options_json, attachments_json,
          idempotency_key, state, attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
        `).run(deliveryId, request.conversation_id, generation, turnId, request.operation, request.message,
          request.message_anchor ?? null, runtimeOptionsJson, attachmentsJson, request.idempotency_key, now, now);
      }
      this.journal(request.conversation_id, revision, generation, "turn-queued", { turn_id: turnId, delivery_id: deliveryId, operation: request.operation }, now);
      const current = this.row(request.conversation_id)!;
      return {
        ok: true,
        value: {
          kind: "accepted",
          delivery_id: deliveryId,
          turn_id: turnId,
          snapshot: this.toSnapshot(current, boundary, capabilities, adapterId),
          acquisition_required: acquisitionRequired,
          already_delivered: false,
          adapter_id: adapterId,
          provider_session_id: boundary.session_id,
          controller_instance_id: controllerInstanceId,
        },
      };
    });
    return transaction.immediate();
  }

  publishAcquired(conversationId: string, generation: number, controllerInstanceId: string, providerSessionId: string | null): Result<void, ConversationControlError> {
    return this.mutateOwned(conversationId, generation, "controller-ready", (row, revision, now) => {
      const invalid = this.controllerTransitionError(row.controller_state, "ready");
      if (invalid) return invalid;
      this.db.prepare(`UPDATE conversation_control_state SET revision = ?, controller_state = 'ready',
        controller_instance_id = ?, provider_session_id = ?, owner_detail_json = ?, last_authoritative_signal = ?, updated_at = ?
        WHERE conversation_id = ? AND generation = ? AND owner_kind = 'mandible'
      `).run(revision, controllerInstanceId, providerSessionId, providerSessionId ? "{}" : JSON.stringify({ native_identity_pending: true }), now, now, conversationId, generation);
      return null;
    });
  }

  adoptNewController(
    conversationId: string,
    generation: number,
    adapterId: string,
    controllerInstanceId: string,
    providerSessionId: string | null,
  ): Result<void, ConversationControlError> {
    const transaction = this.db.transaction((): Result<void, ConversationControlError> => {
      const ensured = this.ensure(conversationId);
      if (!ensured.ok) return ensured;
      const row = ensured.value;
      if (row.owner_kind !== "none" || row.controller_state !== "stopped") {
        return { ok: false, error: {
          kind: "invalid-request",
          field: "ownership",
          message: "A new provider controller requires an unowned conversation",
        } };
      }
      if (generation <= row.generation) {
        return { ok: false, error: {
          kind: "stale-generation",
          expected_generation: generation,
          actual_generation: row.generation,
        } };
      }
      const acquiredRevision = row.revision + 1;
      const readyRevision = acquiredRevision + 1;
      const now = this.now();
      this.db.prepare(`UPDATE conversation_control_state SET
        revision = ?, generation = ?, owner_kind = 'mandible', controller_state = 'ready',
        controller_instance_id = ?, adapter_id = ?, provider_session_id = ?, owner_detail_json = ?,
        last_authoritative_signal = ?, turn_state = 'none', turn_id = NULL, delivery_id = NULL,
        state_detail_json = '{}', updated_at = ? WHERE conversation_id = ?
      `).run(
        readyRevision,
        generation,
        controllerInstanceId,
        adapterId,
        providerSessionId,
        providerSessionId === null ? JSON.stringify({ native_identity_pending: true }) : "{}",
        now,
        now,
        conversationId,
      );
      this.journal(conversationId, acquiredRevision, generation, "controller-acquired", {
        adapter_id: adapterId,
        controller_instance_id: controllerInstanceId,
      }, now);
      this.journal(conversationId, readyRevision, generation, "controller-ready", {
        provider_session_id: providerSessionId,
      }, now);
      return { ok: true, value: undefined };
    });
    return transaction.immediate();
  }

  publishLifecycle(conversationId: string, generation: number, event: ConversationLifecycleEvent): Result<void, ConversationControlError> {
    return this.mutateOwned(conversationId, generation, event.kind, (row, revision, now) => {
      const detail = parseObject<StoredDetail>(row.state_detail_json);
      let controller = row.controller_state;
      let turn = row.turn_state;
      let turnId = row.turn_id;
      switch (event.kind) {
        case "controller-ready": {
          const invalid = this.controllerTransitionError(row.controller_state, "ready"); if (invalid) return invalid;
          controller = "ready"; break;
        }
        case "controller-running": {
          const invalid = this.controllerTransitionError(row.controller_state, "running"); if (invalid) return invalid;
          controller = "running"; break;
        }
        case "controller-waiting": {
          const invalid = this.controllerTransitionError(row.controller_state, "waiting"); if (invalid) return invalid;
          controller = "waiting"; break;
        }
        case "controller-stopping": {
          const invalid = this.controllerTransitionError(row.controller_state, "stopping"); if (invalid) return invalid;
          controller = "stopping"; break;
        }
        case "controller-failed": {
          const invalid = this.controllerTransitionError(row.controller_state, "failed"); if (invalid) return invalid;
          controller = "failed"; detail.controller_error = event.error; break;
        }
        case "turn-started": {
          const invalid = this.turnStartError(row, event.turn_id); if (invalid) return invalid;
          turn = "running"; turnId = event.turn_id; break;
        }
        case "turn-waiting-user": {
          const invalid = this.currentTurnError(row, event.turn_id, ["running", "waiting-user", "waiting-permission"]); if (invalid) return invalid;
          turn = "waiting-user"; break;
        }
        case "turn-waiting-permission": {
          const invalid = this.currentTurnError(row, event.turn_id, ["running", "waiting-permission", "waiting-user"]); if (invalid) return invalid;
          turn = "waiting-permission"; break;
        }
        case "turn-completed": {
          const invalid = this.currentTurnError(row, event.turn_id, ["running", "waiting-user", "waiting-permission", "completed"]); if (invalid) return invalid;
          turn = "completed"; break;
        }
        case "turn-failed": {
          const invalid = this.currentTurnError(row, event.turn_id, ["queued", "running", "waiting-user", "waiting-permission", "failed"]); if (invalid) return invalid;
          turn = "failed"; detail.turn_error = event.error; break;
        }
        case "turn-cancelled": {
          const invalid = this.currentTurnError(row, event.turn_id, ["queued", "running", "waiting-user", "waiting-permission", "cancelled"]); if (invalid) return invalid;
          turn = "cancelled"; break;
        }
        case "turn-unknown":
          if (event.turn_id !== null) {
            const invalid = this.currentTurnError(row, event.turn_id, ["queued", "running", "waiting-user", "waiting-permission", "unknown"]); if (invalid) return invalid;
          }
          turn = "unknown"; turnId = event.turn_id; detail.unknown_reason = event.reason; break;
        case "ownership-unknown":
        case "controller-released":
        case "provider-session-bound":
          throw new Error(`${event.kind} requires its dedicated store transition`);
      }
      this.db.prepare(`UPDATE conversation_control_state SET revision = ?, controller_state = ?,
        turn_state = ?, turn_id = ?, state_detail_json = ?, last_authoritative_signal = ?, updated_at = ?
        WHERE conversation_id = ? AND generation = ? AND owner_kind = 'mandible'
      `).run(revision, controller, turn, turnId, JSON.stringify(detail), now, now, conversationId, generation);
      return null;
    }, event);
  }

  bindProviderSession(conversationId: string, generation: number, providerSessionId: string): Result<void, ConversationControlError> {
    const existing = this.row(conversationId);
    if (existing?.provider_session_id === providerSessionId && existing.generation === generation && existing.owner_kind === "mandible") return { ok: true, value: undefined };
    return this.mutateOwned(conversationId, generation, "provider-session-bound", (row, revision, now) => {
      if (!providerSessionId.trim() || row.provider_session_id && row.provider_session_id !== providerSessionId) {
        return { kind: "adapter-contract-violation", adapter_id: row.adapter_id!, message: "The controller native identity is already bound" };
      }
      this.db.prepare(`UPDATE conversation_control_state SET revision = ?, provider_session_id = ?, owner_detail_json = '{}',
        last_authoritative_signal = ?, updated_at = ? WHERE conversation_id = ? AND generation = ? AND owner_kind = 'mandible'`)
        .run(revision, providerSessionId, now, now, conversationId, generation);
      this.db.prepare("UPDATE conversations SET session_id = ? WHERE id = ? AND (session_id IS NULL OR session_id = '')").run(providerSessionId, conversationId);
      this.db.prepare("UPDATE conversation_spawn_requests SET provider_session_id = ?, updated_at = ? WHERE id = ? AND attempt_count = ? AND state = 'ready' AND provider_session_id IS NULL")
        .run(providerSessionId, now, conversationId, generation);
      return null;
    }, { provider_session_id: providerSessionId });
  }

  release(conversationId: string, generation: number): Result<void, ConversationControlError> {
    return this.mutateOwned(conversationId, generation, "controller-released", (row, revision, now) => {
      if (["queued", "running", "waiting-user", "waiting-permission"].includes(row.turn_state)) {
        return { kind: "invalid-request", field: "turn_state", message: "An active turn must become cancelled or unknown before controller release" };
      }
      this.db.prepare(`UPDATE conversation_control_state SET revision = ?, owner_kind = 'none',
        controller_state = 'stopped', controller_instance_id = NULL, adapter_id = NULL,
        owner_detail_json = '{}', last_authoritative_signal = NULL, updated_at = ?
        WHERE conversation_id = ? AND generation = ? AND owner_kind = 'mandible'
      `).run(revision, now, conversationId, generation);
      return null;
    });
  }

  recoverUnsentDraft(conversationId: string, generation: number): Result<boolean, ConversationControlError> {
    const row = this.row(conversationId);
    const boundary = this.getBoundary(conversationId);
    if (!boundary.ok) return boundary;
    if (!row || row.owner_kind !== "mandible" || row.generation !== generation || row.provider_session_id || !boundary.value.local_draft || row.turn_state !== "none") return { ok: true, value: false };
    const attempted = this.db.prepare("SELECT 1 FROM conversation_control_outbox WHERE conversation_id = ? LIMIT 1").get(conversationId);
    if (attempted) return { ok: true, value: false };
    const released = this.release(conversationId, generation);
    return released.ok ? { ok: true, value: true } : released;
  }

  recoverFailedAcquisition(conversationId: string, generation: number): Result<boolean, ConversationControlError> {
    const requireSuccess = (result: Result<void, ConversationControlError>): void => {
      if (!result.ok) throw new RecoveryTransitionError(result.error);
    };
    const transaction = this.db.transaction((): Result<boolean, ConversationControlError> => {
      const row = this.row(conversationId);
      if (!row || row.owner_kind !== "mandible" || row.generation !== generation
          || !row.adapter_id || row.controller_state !== "failed"
          || !row.delivery_id || !row.turn_id || !["queued", "failed"].includes(row.turn_state)) {
        return { ok: true, value: false };
      }
      const detail = parseObject<StoredDetail>(row.state_detail_json);
      const error = detail.controller_error;
      if (!error || !failedAcquisition(error, row.adapter_id)) {
        return { ok: true, value: false };
      }
      const item = this.db.prepare("SELECT * FROM conversation_control_outbox WHERE id = ?").get(row.delivery_id) as Record<string, unknown> | undefined;
      if (!item || item.conversation_id !== conversationId || item.generation !== generation
          || item.turn_id !== row.turn_id || item.attempts !== 0
          || !["pending", "failed"].includes(String(item.state))) {
        return { ok: true, value: false };
      }
      if (row.turn_state === "queued") {
        requireSuccess(this.publishLifecycle(conversationId, generation, {
          kind: "turn-failed", at: this.now(), turn_id: row.turn_id, error,
        }));
      }
      if (item.state === "pending") {
        requireSuccess(this.finishDelivery(row.delivery_id, { ok: false, error }));
      }
      requireSuccess(this.release(conversationId, generation));
      return { ok: true, value: true };
    });
    try {
      return transaction.immediate();
    } catch (error) {
      if (error instanceof RecoveryTransitionError) return { ok: false, error: error.controlError };
      throw error;
    }
  }

  markUnknown(conversationId: string, generation: number, reason: ReconciliationUnknownReason): Result<void, ConversationControlError> {
    const transaction = this.db.transaction((): Result<void, ConversationControlError> => {
      const ensured = this.ensure(conversationId);
      if (!ensured.ok) return ensured;
      const row = ensured.value;
      if (row.owner_kind === "none") return { ok: true, value: undefined };
      if (row.generation !== generation) {
        return { ok: false, error: { kind: "stale-generation", expected_generation: generation, actual_generation: row.generation } };
      }
      if (row.owner_kind !== "mandible") {
        return { ok: false, error: { kind: "invalid-request", field: "ownership", message: "Only the current Mandible controller can publish unknown ownership" } };
      }
      const revision = row.revision + 1;
      const now = this.now();
      const prior = "mandible" as const;
      const detail = parseObject<StoredDetail>(row.state_detail_json);
      detail.unknown_reason = reason;
      detail.unknown_prior_owner = prior;
      const turnState = ["queued", "running", "waiting-user", "waiting-permission"].includes(row.turn_state)
        ? "unknown"
        : row.turn_state;
      this.db.prepare(`UPDATE conversation_control_state SET revision = ?, owner_kind = 'unknown',
        controller_state = 'unknown', controller_instance_id = NULL, adapter_id = NULL,
        owner_detail_json = '{}', last_authoritative_signal = NULL, turn_state = ?,
        state_detail_json = ?, updated_at = ? WHERE conversation_id = ?
      `).run(revision, turnState, JSON.stringify(detail), now, conversationId);
      this.journal(conversationId, revision, row.generation, "ownership-unknown", { reason, prior_owner: prior }, now);
      return { ok: true, value: undefined };
    });
    return transaction.immediate();
  }

  observeExternal(conversationId: string, evidence: ExternalControllerEvidence): Result<void, ConversationControlError> {
    const transaction = this.db.transaction((): Result<void, ConversationControlError> => {
      const ensured = this.ensure(conversationId);
      if (!ensured.ok) return ensured;
      const row = ensured.value;
      const generation = row.generation + 1;
      const revision = row.revision + 1;
      const now = this.now();
      this.db.prepare(`UPDATE conversation_control_state SET revision = ?, generation = ?, owner_kind = 'external',
        controller_state = 'unknown', controller_instance_id = NULL, adapter_id = NULL,
        owner_detail_json = ?, last_authoritative_signal = ?, turn_state = 'unknown', turn_id = NULL,
        delivery_id = NULL, state_detail_json = ?, updated_at = ? WHERE conversation_id = ?
      `).run(revision, generation, JSON.stringify(evidence), now, JSON.stringify({ unknown_reason: "probe-ambiguous" }), now, conversationId);
      this.journal(conversationId, revision, generation, "external-ownership-observed", { evidence }, now);
      return { ok: true, value: undefined };
    });
    return transaction.immediate();
  }

  replaceWithExternal(conversationId: string, generation: number, evidence: ExternalControllerEvidence): Result<void, ConversationControlError> {
    const row = this.row(conversationId);
    if (!row) return { ok: false, error: { kind: "conversation-not-found", conversation_id: conversationId } };
    if (row.owner_kind !== "mandible" || row.generation !== generation) {
      return { ok: false, error: { kind: "stale-generation", expected_generation: generation, actual_generation: row.generation } };
    }
    return this.observeExternal(conversationId, evidence);
  }

  activeOwnedRows(): Array<{ conversation_id: string; generation: number; adapter_id: string; provider_session_id: string; controller_instance_id: string }> {
    return this.db.prepare(`SELECT conversation_id, generation, adapter_id, provider_session_id, controller_instance_id
      FROM conversation_control_state WHERE owner_kind = 'mandible' AND controller_state != 'stopped'
    `).all() as Array<{ conversation_id: string; generation: number; adapter_id: string; provider_session_id: string; controller_instance_id: string }>;
  }

  pendingOutbox(): ConversationOutboxItem[] {
    return (this.db.prepare(`SELECT * FROM conversation_control_outbox
      WHERE state IN ('pending','delivering','uncertain') ORDER BY created_at, id`).all() as Array<Record<string, unknown>>)
      .map((row) => this.outboxItem(row));
  }

  beginDelivery(deliveryId: string): Result<ConversationOutboxItem, ConversationControlError> {
    const transaction = this.db.transaction((): Result<ConversationOutboxItem, ConversationControlError> => {
      const row = this.db.prepare("SELECT * FROM conversation_control_outbox WHERE id = ?").get(deliveryId) as Record<string, unknown> | undefined;
      if (!row) return { ok: false, error: { kind: "invalid-request", field: "delivery_id", message: "Unknown delivery" } };
      const item = this.outboxItem(row);
      const control = this.row(item.conversation_id)!;
      if (control.owner_kind !== "mandible" || control.generation !== item.generation) {
        return { ok: false, error: { kind: "stale-generation", expected_generation: item.generation, actual_generation: control.generation } };
      }
      if (item.state === "delivered") return { ok: true, value: item };
      if (item.state !== "pending") return { ok: false, error: { kind: "delivery-uncertain", delivery_id: item.id } };
      const now = this.now();
      this.db.prepare("UPDATE conversation_control_outbox SET state = 'delivering', attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'pending'").run(now, deliveryId);
      this.journal(item.conversation_id, control.revision, item.generation, "delivery-started", { delivery_id: deliveryId }, now);
      return { ok: true, value: { ...item, state: "delivering", attempts: item.attempts + 1 } };
    });
    return transaction.immediate();
  }

  finishDelivery(deliveryId: string, result: Result<{ provider_receipt_id: string }, ConversationControlError>): Result<void, ConversationControlError> {
    const transaction = this.db.transaction((): Result<void, ConversationControlError> => {
      const row = this.db.prepare("SELECT * FROM conversation_control_outbox WHERE id = ?").get(deliveryId) as Record<string, unknown> | undefined;
      if (!row) return { ok: false, error: { kind: "invalid-request", field: "delivery_id", message: "Unknown delivery" } };
      const item = this.outboxItem(row);
      const control = this.row(item.conversation_id)!;
      if (control.owner_kind !== "mandible" || control.generation !== item.generation) {
        return { ok: false, error: { kind: "stale-generation", expected_generation: item.generation, actual_generation: control.generation } };
      }
      const now = this.now();
      if (result.ok) {
        this.db.prepare("UPDATE conversation_control_outbox SET state = 'delivered', provider_receipt_id = ?, error_json = NULL, updated_at = ? WHERE id = ?")
          .run(result.value.provider_receipt_id, now, deliveryId);
        this.journal(item.conversation_id, control.revision, item.generation, "delivery-completed", { delivery_id: deliveryId, provider_receipt_id: result.value.provider_receipt_id }, now);
      } else {
        this.db.prepare("UPDATE conversation_control_outbox SET state = 'failed', error_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(result.error), now, deliveryId);
        this.journal(item.conversation_id, control.revision, item.generation, "delivery-failed", { delivery_id: deliveryId, error: result.error }, now);
      }
      return { ok: true, value: undefined };
    });
    return transaction.immediate();
  }

  markDeliveryUncertain(deliveryId: string, generation: number): Result<void, ConversationControlError> {
    const item = this.db.prepare("SELECT * FROM conversation_control_outbox WHERE id = ?").get(deliveryId) as Record<string, unknown> | undefined;
    if (!item) return { ok: false, error: { kind: "invalid-request", field: "delivery_id", message: "Unknown delivery" } };
    const parsed = this.outboxItem(item);
    const control = this.row(parsed.conversation_id)!;
    if (control.generation !== generation) {
      return { ok: false, error: { kind: "stale-generation", expected_generation: generation, actual_generation: control.generation } };
    }
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE conversation_control_outbox SET state = 'uncertain', updated_at = ? WHERE id = ?").run(now, deliveryId);
      this.journal(parsed.conversation_id, control.revision, parsed.generation, "delivery-uncertain", { delivery_id: deliveryId }, now);
    }).immediate();
    return { ok: true, value: undefined };
  }

  resolveUncertainDelivery(deliveryId: string, generation: number, delivered: boolean, providerReceiptId: string | null = null): Result<void, ConversationControlError> {
    const item = this.db.prepare("SELECT conversation_id FROM conversation_control_outbox WHERE id = ?").get(deliveryId) as { conversation_id: string } | undefined;
    if (!item) return { ok: false, error: { kind: "invalid-request", field: "delivery_id", message: "Unknown delivery" } };
    const control = this.row(item.conversation_id)!;
    if (control.owner_kind !== "mandible" || control.generation !== generation) {
      return { ok: false, error: { kind: "stale-generation", expected_generation: generation, actual_generation: control.generation } };
    }
    this.db.prepare(`UPDATE conversation_control_outbox SET state = ?, provider_receipt_id = ?, updated_at = ?
      WHERE id = ? AND state IN ('delivering','uncertain')
    `).run(delivered ? "delivered" : "pending", providerReceiptId, this.now(), deliveryId);
    return { ok: true, value: undefined };
  }

  private row(conversationId: string): ControlRow | null {
    return this.db.prepare("SELECT * FROM conversation_control_state WHERE conversation_id = ?").get(conversationId) as ControlRow | undefined ?? null;
  }

  private toSnapshot(row: ControlRow, boundary: ConversationBoundary, capabilities: ControllerAdapterCapabilities | null, adapterId: string | null): ConversationControlSnapshot {
    const detail = parseObject<StoredDetail>(row.state_detail_json);
    const owner = ownership(row, detail);
    const controller = controllerState(row, detail);
    const turn = turnState(row, detail);
    const revision = row.revision;
    let capability: ConversationContinuationCapability;
    if (boundary.parent_conversation_id) capability = unavailable(revision, "subagent");
    else if (!boundary.session_id && owner.kind !== "mandible" && !(boundary.local_draft && owner.kind === "none")) capability = unavailable(revision, "no-provider-session");
    else if (owner.kind === "external") capability = { kind: "blocked-external", revision, evidence_kind: owner.evidence.kind };
    else if (owner.kind === "unknown") capability = { kind: "blocked-ownership-unknown", revision, reason: owner.reason };
    else if (!capabilities || !adapterId) capability = unavailable(revision, "unsupported-provider");
    else if (owner.kind === "none" && boundary.local_draft && !boundary.session_id) {
      capability = capabilities.send ? { kind: "live-send", revision, generation: owner.generation } : unavailable(revision, "unsupported-provider");
    } else if (owner.kind === "none") {
      capability = capabilities.resume_message_anchor && boundary.has_message_anchor === 1
        ? { kind: "message-anchor-resume", revision, generation: owner.generation, adapter_id: adapterId, provider_session_id: boundary.session_id! }
        : capabilities.resume_provider_session
          ? { kind: "provider-session-resume", revision, generation: owner.generation, adapter_id: adapterId, provider_session_id: boundary.session_id! }
          : unavailable(revision, "unsupported-provider");
    } else if (["starting", "stopping", "failed", "unknown"].includes(controller.kind)) {
      capability = unavailable(revision, "controller-transition");
    } else if (["queued", "unknown"].includes(turn.kind)) {
      capability = unavailable(revision, "turn-transition");
    } else if (["running", "waiting-permission", "waiting-user"].includes(turn.kind)) {
      capability = capabilities.steer
        ? { kind: "live-steer", revision, generation: owner.generation }
        : capabilities.queue
          ? { kind: "owned-queue", revision, generation: owner.generation }
          : unavailable(revision, "turn-transition");
    } else {
      capability = capabilities.send
        ? { kind: "live-send", revision, generation: owner.generation }
        : unavailable(revision, "unsupported-provider");
    }
    return {
      conversation_id: row.conversation_id,
      provider: row.provider,
      provider_session_id: row.provider_session_id,
      provider_mode: capabilities?.mode ?? null,
      provider_capabilities: capabilities,
      revision,
      ownership: owner,
      controller,
      turn,
      capability,
      updated_at: row.updated_at,
    };
  }

  private operationMatches(operation: ConversationControlOperation, capability: ConversationContinuationCapability["kind"]): boolean {
    return (operation === "send" && capability === "live-send")
      || (operation === "steer" && capability === "live-steer")
      || (operation === "queue" && capability === "owned-queue")
      || (operation === "resume-provider-session" && capability === "provider-session-resume")
      || (operation === "resume-message-anchor" && capability === "message-anchor-resume");
  }

  private mutateOwned(
    conversationId: string,
    generation: number,
    kind: string,
    mutate: (row: ControlRow, revision: number, now: number) => ConversationControlError | null,
    payload: object = {},
  ): Result<void, ConversationControlError> {
    const transaction = this.db.transaction((): Result<void, ConversationControlError> => {
      const row = this.row(conversationId);
      if (!row) return { ok: false, error: { kind: "conversation-not-found", conversation_id: conversationId } };
      if (row.owner_kind !== "mandible" || row.generation !== generation) {
        return { ok: false, error: { kind: "stale-generation", expected_generation: generation, actual_generation: row.generation } };
      }
      const revision = row.revision + 1;
      const now = this.now();
      const mutationError = mutate(row, revision, now);
      if (mutationError) return { ok: false, error: mutationError };
      this.journal(conversationId, revision, generation, kind, payload, now);
      return { ok: true, value: undefined };
    });
    return transaction.immediate();
  }

  private controllerTransitionError(from: ControllerState["kind"], to: ControllerState["kind"]): ConversationControlError | null {
    const allowed: Record<ControllerState["kind"], readonly ControllerState["kind"][]> = {
      stopped: [],
      starting: ["starting", "ready", "running", "stopping", "failed", "unknown"],
      ready: ["ready", "running", "waiting", "stopping", "failed", "unknown"],
      running: ["running", "waiting", "stopping", "failed", "unknown"],
      waiting: ["waiting", "running", "stopping", "failed", "unknown"],
      stopping: ["stopping", "failed", "unknown"],
      failed: ["failed", "stopping", "unknown"],
      unknown: ["unknown"],
    };
    if (!allowed[from].includes(to)) {
      return { kind: "invalid-request", field: "controller_state", message: `Invalid controller lifecycle transition ${from} -> ${to}` };
    }
    return null;
  }

  private turnStartError(row: ControlRow, turnId: string): ConversationControlError | null {
    if (row.turn_state === "queued" && row.turn_id === turnId) return null;
    const queued = this.db.prepare(`SELECT 1 FROM conversation_control_outbox
      WHERE conversation_id = ? AND generation = ? AND turn_id = ?
        AND state IN ('pending','delivering','delivered')
    `).get(row.conversation_id, row.generation, turnId);
    return queued ? null : { kind: "invalid-request", field: "turn_id", message: `Turn ${turnId} was not accepted by the current controller generation` };
  }

  private currentTurnError(row: ControlRow, turnId: string, allowed: readonly TurnState["kind"][]): ConversationControlError | null {
    if (row.turn_id !== turnId || !allowed.includes(row.turn_state)) {
      return { kind: "invalid-request", field: "turn_id", message: `Invalid lifecycle event for turn ${turnId} while ${row.turn_id ?? "no turn"} is ${row.turn_state}` };
    }
    return null;
  }

  private journal(conversationId: string, revision: number, generation: number, kind: string, payload: object, now: number): void {
    this.db.prepare(`INSERT INTO conversation_control_journal
      (id, conversation_id, revision, generation, event_kind, event_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), conversationId, revision, generation, kind, JSON.stringify(payload), now);
  }

  private outboxItem(row: Record<string, unknown>): ConversationOutboxItem {
    return {
      id: String(row.id),
      conversation_id: String(row.conversation_id),
      generation: Number(row.generation),
      turn_id: String(row.turn_id),
      operation: row.operation as ConversationControlOperation,
      message: String(row.message),
      attachments: JSON.parse(String(row.attachments_json ?? "[]")) as ConversationOutboxItem["attachments"],
      attachment_db_path: this.db.name,
      message_anchor: row.message_anchor == null ? null : String(row.message_anchor),
      runtime_options: parseObject<ConversationOutboxItem["runtime_options"]>(
        row.runtime_options_json == null ? "{}" : String(row.runtime_options_json),
      ),
      idempotency_key: String(row.idempotency_key),
      state: row.state as ConversationOutboxItem["state"],
      attempts: Number(row.attempts),
      provider_receipt_id: row.provider_receipt_id == null ? null : String(row.provider_receipt_id),
    };
  }
}
