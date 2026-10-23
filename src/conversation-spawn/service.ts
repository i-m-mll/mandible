import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import {
  CONVERSATION_SPAWN_RECEIPT_SCHEMA,
  CONVERSATION_SPAWN_REQUEST_SCHEMA,
  type ConversationSpawnFailure,
  type ConversationSpawnReceipt,
  type ConversationSpawnRequest,
  type Result,
} from "./types.js";

type SpawnRow = {
  id: string;
  schema_version: string;
  request_json: string;
  request_digest: string;
  state: ConversationSpawnReceipt["state"];
  attempt_count: number;
  native_session_id: string | null;
  provider_session_id: string | null;
  provider_receipt_json: string | null;
  initial_message_state: "queued" | "delivering" | "delivered" | "failed" | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
};

function projectIds(request: ConversationSpawnRequest): { projectId: string | null; checkoutId: string | null } {
  return request.placement.kind === "project"
    ? { projectId: request.placement.project_id, checkoutId: request.placement.checkout_id }
    : { projectId: null, checkoutId: null };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class ConversationSpawnService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    recoverInterrupted = true,
  ) {
    if (recoverInterrupted) this.terminalizeInterrupted();
  }

  reserve(input: ConversationSpawnRequest, runtimeOptions?: import("../conversation-control/types.js").ConversationRuntimeOptions): Result<ConversationSpawnReceipt> {
    const validated = this.validate(input);
    if (!validated.ok) return validated;
    const request = validated.value;
    const requestJson = stable(request);
    const digest = createHash("sha256").update(requestJson).digest("hex");
    const existing = this.db.prepare("SELECT * FROM conversation_spawn_requests WHERE idempotency_key = ?")
      .get(request.idempotency_key) as SpawnRow | undefined;
    if (existing) {
      if (existing.request_digest !== digest) {
        return { ok: false, error: { kind: "idempotency-conflict", idempotency_key: request.idempotency_key } };
      }
      return { ok: true, value: this.receipt(existing) };
    }
    const at = this.now();
    const placement = projectIds(request);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO conversation_spawn_requests
        (id, schema_version, idempotency_key, request_digest, request_json, provider, project_id, checkout_id,
         topology_kind, topology_target_conversation_id, state, initial_message_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'top-level', NULL, 'reserved', NULL, ?, ?)`).run(
        request.idempotency_key,
        request.schema,
        request.idempotency_key,
        digest,
        requestJson,
        request.provider,
        placement.projectId,
        placement.checkoutId,
        at,
        at,
      );
      this.event(request.idempotency_key, "reserved", { request_digest: digest, ...(runtimeOptions ? { runtime_options: runtimeOptions } : {}) }, at);
    })();
    return this.get(request.idempotency_key);
  }

  begin(reservationId: string, expectedGeneration?: number): Result<ConversationSpawnReceipt> {
    const row = this.row(reservationId);
    if (!row) return { ok: false, error: { kind: "not-found", reservation_id: reservationId } };
    if (row.schema_version !== CONVERSATION_SPAWN_REQUEST_SCHEMA) {
      return this.invalid("schema", "Historical spawn receipts are read-only");
    }
    if (expectedGeneration !== undefined && row.attempt_count !== expectedGeneration) {
      return { ok: false, error: {
        kind: "stale-generation",
        reservation_id: reservationId,
        expected_generation: expectedGeneration,
        actual_generation: row.attempt_count,
      } };
    }
    if (row.state === "starting" || row.state === "stopping") {
      return { ok: false, error: { kind: "spawn-in-progress", reservation_id: reservationId } };
    }
    if (row.state === "ready") return { ok: true, value: this.receipt(row) };
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_spawn_requests
        SET state = 'starting', attempt_count = attempt_count + 1, native_session_id = NULL,
          provider_session_id = NULL, provider_receipt_json = NULL, error_json = NULL, updated_at = ? WHERE id = ?`)
        .run(at, reservationId);
      this.event(reservationId, "startup-started", {}, at);
    })();
    return this.get(reservationId);
  }

  assignRuntime(reservationId: string, generation: number, nativeSessionId: string): Result<ConversationSpawnReceipt> {
    const row = this.currentGeneration(reservationId, generation);
    if (!row.ok) return row;
    if (row.value.state !== "starting") {
      return { ok: false, error: { kind: "spawn-in-progress", reservation_id: reservationId } };
    }
    if (row.value.native_session_id && row.value.native_session_id !== nativeSessionId) {
      return { ok: false, error: { kind: "idempotency-conflict", idempotency_key: reservationId } };
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE conversation_spawn_requests SET native_session_id = ?, updated_at = ? WHERE id = ?")
        .run(nativeSessionId, at, reservationId);
      this.event(reservationId, "runtime-assigned", { generation, native_session_id: nativeSessionId }, at);
    })();
    return this.get(reservationId);
  }

  materializeConversationShell(
    reservationId: string,
    generation: number,
    cwd: string,
    providerSessionId: string | null,
  ): Result<ConversationSpawnReceipt> {
    const current = this.currentGeneration(reservationId, generation);
    if (!current.ok) return current;
    const row = current.value;
    if (row.state !== "starting") {
      return { ok: false, error: { kind: "spawn-in-progress", reservation_id: reservationId } };
    }
    const request = JSON.parse(row.request_json) as ConversationSpawnRequest;
    const source = request.provider;
    const title = source === "codex" ? "New Codex chat" : "New Claude chat";
    const iso = new Date(row.created_at).toISOString();
    this.db.prepare(`INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, project_path, cwd, starred, tags,
      started_at_ms, created_at_ms, updated_at_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, '[]', ?, ?, ?, ?, ?)
    `).run(
      reservationId,
      source,
      `mandible://chat/${reservationId}`,
      row.request_digest,
      row.updated_at,
      title,
      iso,
      providerSessionId ?? "",
      cwd,
      cwd,
      row.created_at,
      row.created_at,
      row.updated_at,
      iso,
      iso,
    );
    return this.get(reservationId);
  }

  observeProviderSession(nativeSessionId: string, providerSessionId: string): void {
    const id = providerSessionId.trim();
    if (!id) return;
    const row = this.db.prepare(`SELECT * FROM conversation_spawn_requests
      WHERE native_session_id = ? AND state = 'starting' ORDER BY updated_at DESC LIMIT 1`)
      .get(nativeSessionId) as SpawnRow | undefined;
    if (!row || row.provider_session_id === id) return;
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE conversation_spawn_requests SET provider_session_id = ?, updated_at = ? WHERE id = ?")
        .run(id, at, row.id);
      this.event(row.id, "provider-observed", { generation: row.attempt_count, provider_session_id: id }, at);
    })();
  }

  ready(
    reservationId: string,
    generation: number,
    nativeSessionId: string,
    providerSessionId: string | null,
    providerReceipt: Record<string, unknown>,
  ): Result<ConversationSpawnReceipt> {
    const current = this.currentGeneration(reservationId, generation);
    if (!current.ok) return current;
    const row = current.value;
    if (row.state !== "starting") {
      return { ok: false, error: { kind: "spawn-in-progress", reservation_id: reservationId } };
    }
    if (row.native_session_id && row.native_session_id !== nativeSessionId) {
      return { ok: false, error: { kind: "idempotency-conflict", idempotency_key: row.id } };
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_spawn_requests SET state = 'ready', native_session_id = ?,
        provider_session_id = ?, provider_receipt_json = ?, error_json = NULL, updated_at = ? WHERE id = ?`)
        .run(nativeSessionId, providerSessionId, stable(providerReceipt), at, reservationId);
      this.event(reservationId, "ready", providerReceipt, at);
    })();
    return this.get(reservationId);
  }

  failed(
    reservationId: string,
    generation: number,
    error: ConversationSpawnFailure,
  ): Result<ConversationSpawnReceipt> {
    const current = this.currentGeneration(reservationId, generation);
    if (!current.ok) return current;
    if (current.value.state !== "starting" && current.value.state !== "stopping") {
      return { ok: false, error: { kind: "spawn-in-progress", reservation_id: reservationId } };
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_spawn_requests SET state = 'failed', native_session_id = NULL,
        provider_session_id = NULL, provider_receipt_json = NULL, error_json = ?, updated_at = ? WHERE id = ?`)
        .run(stable(error), at, reservationId);
      this.event(reservationId, "failed", error, at);
    })();
    return this.get(reservationId);
  }

  stopping(reservationId: string, generation: number): Result<ConversationSpawnReceipt> {
    const current = this.currentGeneration(reservationId, generation);
    if (!current.ok) return current;
    if (current.value.state === "cancelled") return this.get(reservationId);
    if (current.value.state !== "starting") {
      return { ok: false, error: { kind: "spawn-in-progress", reservation_id: reservationId } };
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE conversation_spawn_requests SET state = 'stopping', updated_at = ? WHERE id = ?")
        .run(at, reservationId);
      this.event(reservationId, "stopping", { generation }, at);
    })();
    return this.get(reservationId);
  }

  cancelled(reservationId: string, generation: number): Result<ConversationSpawnReceipt> {
    const current = this.currentGeneration(reservationId, generation);
    if (!current.ok) return current;
    const at = this.now();
    const error: ConversationSpawnFailure = {
      code: "provider_startup_cancelled",
      message: "Chat creation was cancelled.",
      retryable: true,
    };
    this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_spawn_requests SET state = 'cancelled', native_session_id = NULL,
        provider_session_id = NULL, provider_receipt_json = NULL, error_json = ?, updated_at = ? WHERE id = ?`)
        .run(stable(error), at, reservationId);
      this.event(reservationId, "cancelled", { generation }, at);
    })();
    return this.get(reservationId);
  }

  listCurrent(): ConversationSpawnReceipt[] {
    return (this.db.prepare("SELECT * FROM conversation_spawn_requests WHERE schema_version = ? ORDER BY created_at DESC, id")
      .all(CONVERSATION_SPAWN_REQUEST_SCHEMA) as SpawnRow[]).map((row) => this.receipt(row));
  }

  get(reservationId: string): Result<ConversationSpawnReceipt> {
    const row = this.row(reservationId);
    return row
      ? { ok: true, value: this.receipt(row) }
      : { ok: false, error: { kind: "not-found", reservation_id: reservationId } };
  }

  private validate(input: ConversationSpawnRequest): Result<ConversationSpawnRequest> {
    if (!input || input.schema !== CONVERSATION_SPAWN_REQUEST_SCHEMA) {
      return this.invalid("schema", "Only conversation spawn request version 2 is accepted");
    }
    const allowed = new Set(["schema", "idempotency_key", "provider", "placement"]);
    const unexpected = Object.keys(input as unknown as Record<string, unknown>).find((key) => !allowed.has(key));
    if (unexpected) return this.invalid(unexpected, "Client launch-control fields are not accepted");
    const id = input.idempotency_key?.trim();
    if (!id || !isUuid(id)) return this.invalid("idempotency_key", "A UUID idempotency key is required");
    if (input.provider !== "codex" && input.provider !== "claude_code") {
      return this.invalid("provider", "Only Codex and Claude are supported");
    }
    const placement = input.placement;
    if (placement?.kind === "projectless") {
      if (Object.keys(placement).length !== 1) return this.invalid("placement", "Projectless placement accepts no project fields");
      return { ok: true, value: { ...input, idempotency_key: id, placement: { kind: "projectless" } } };
    }
    if (placement?.kind !== "project" || !placement.project_id?.trim() || !placement.checkout_id?.trim()) {
      return this.invalid("placement", "Placement must be explicitly projectless or name one exact project checkout");
    }
    if (!this.db.prepare("SELECT 1 FROM ledger_projects WHERE id = ?").get(placement.project_id)) {
      return { ok: false, error: { kind: "project-not-found", project_id: placement.project_id } };
    }
    const checkout = this.db.prepare("SELECT project_id FROM ledger_project_checkouts WHERE id = ?")
      .get(placement.checkout_id) as { project_id: string } | undefined;
    if (!checkout) return { ok: false, error: { kind: "checkout-not-found", checkout_id: placement.checkout_id } };
    if (checkout.project_id !== placement.project_id) {
      return { ok: false, error: {
        kind: "checkout-project-mismatch",
        project_id: placement.project_id,
        checkout_id: placement.checkout_id,
      } };
    }
    return { ok: true, value: { ...input, idempotency_key: id } };
  }

  private invalid(field: string, message: string): Result<never> {
    return { ok: false, error: { kind: "invalid-request", field, message } };
  }

  private currentGeneration(reservationId: string, generation: number): Result<SpawnRow> {
    const row = this.row(reservationId);
    if (!row) return { ok: false, error: { kind: "not-found", reservation_id: reservationId } };
    if (row.attempt_count !== generation) {
      return { ok: false, error: {
        kind: "stale-generation",
        reservation_id: reservationId,
        expected_generation: generation,
        actual_generation: row.attempt_count,
      } };
    }
    return { ok: true, value: row };
  }

  private terminalizeInterrupted(): void {
    const rows = this.db.prepare(
      "SELECT id FROM conversation_spawn_requests WHERE state IN ('creating', 'delivering', 'starting', 'stopping') ORDER BY created_at, id",
    ).all() as Array<{ id: string }>;
    if (rows.length === 0) return;
    const at = this.now();
    const error: ConversationSpawnFailure = {
      code: "provider_startup_interrupted",
      message: "Provider startup was interrupted before readiness completed.",
      retryable: true,
      phase: "readiness",
    };
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.prepare(`UPDATE conversation_spawn_requests SET state = 'failed', initial_message_state =
          CASE WHEN schema_version = 'mandible-conversation-spawn-request@1' THEN 'failed' ELSE NULL END,
          error_json = ?, updated_at = ? WHERE id = ?`).run(stable(error), at, row.id);
        this.event(row.id, "failed", error, at);
      }
    })();
  }

  private row(id: string): SpawnRow | undefined {
    return this.db.prepare("SELECT * FROM conversation_spawn_requests WHERE id = ?").get(id) as SpawnRow | undefined;
  }

  private event(spawnId: string, kind: string, body: object, at: number): void {
    const ordinal = ((this.db.prepare("SELECT MAX(ordinal) AS ordinal FROM conversation_spawn_events WHERE spawn_id = ?")
      .get(spawnId) as { ordinal: number | null }).ordinal ?? 0) + 1;
    this.db.prepare(`INSERT INTO conversation_spawn_events
      (id, spawn_id, ordinal, event_kind, event_json, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)`)
      .run(spawnId, ordinal, kind, stable(body), at);
  }

  private receipt(row: SpawnRow): ConversationSpawnReceipt {
    const reserved = this.db.prepare("SELECT event_json FROM conversation_spawn_events WHERE spawn_id = ? AND event_kind = 'reserved' ORDER BY ordinal LIMIT 1")
      .get(row.id) as { event_json: string } | undefined;
    const runtimeOptions = reserved ? JSON.parse(reserved.event_json).runtime_options : undefined;
    return {
      schema: row.schema_version === CONVERSATION_SPAWN_REQUEST_SCHEMA
        ? CONVERSATION_SPAWN_RECEIPT_SCHEMA
        : row.schema_version === "mandible-conversation-spawn-request@2"
          ? "mandible-conversation-spawn-receipt@2"
          : "mandible-conversation-spawn-receipt@1",
      reservation_id: row.id,
      ...(runtimeOptions ? { runtime_options: runtimeOptions } : {}),
      request: JSON.parse(row.request_json),
      state: row.state,
      attempt_count: row.attempt_count,
      native_session_id: row.schema_version === CONVERSATION_SPAWN_REQUEST_SCHEMA ? row.provider_session_id : row.native_session_id,
      ...(row.schema_version === CONVERSATION_SPAWN_REQUEST_SCHEMA ? { controller_instance_id: row.native_session_id } : {}),
      provider_session_id: row.provider_session_id,
      provider_receipt: row.provider_receipt_json ? JSON.parse(row.provider_receipt_json) : null,
      ...(row.initial_message_state ? { initial_message_state: row.initial_message_state } : {}),
      error: row.error_json ? JSON.parse(row.error_json) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
