import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import {
  CONVERSATION_SPAWN_RECEIPT_SCHEMA,
  CONVERSATION_SPAWN_REQUEST_SCHEMA,
  type ConversationSpawnReceipt,
  type ConversationSpawnRequest,
  type Result,
} from "./types.js";

type SpawnRow = {
  id: string; request_json: string; request_digest: string; state: ConversationSpawnReceipt["state"];
  attempt_count: number; native_session_id: string | null; provider_session_id: string | null;
  provider_receipt_json: string | null; initial_message_state: ConversationSpawnReceipt["initial_message_state"];
  error_json: string | null; created_at: number; updated_at: number;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function target(request: ConversationSpawnRequest): string | null {
  switch (request.topology.kind) {
    case "child": return request.topology.parent_conversation_id;
    case "sibling": return request.topology.sibling_conversation_id;
    case "successor": return request.topology.predecessor_conversation_id;
    case "autonomous": return request.topology.sponsor_conversation_id;
    default: return null;
  }
}

export class ConversationSpawnService {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.terminalizeInterrupted();
  }

  reserve(input: ConversationSpawnRequest): Result<ConversationSpawnReceipt> {
    const validated = this.validate(input);
    if (!validated.ok) return validated;
    const request = validated.value;
    const requestJson = stable(request);
    const digest = createHash("sha256").update(requestJson).digest("hex");
    const existing = this.db.prepare("SELECT * FROM conversation_spawn_requests WHERE idempotency_key = ?")
      .get(request.idempotency_key) as SpawnRow | undefined;
    if (existing) {
      if (existing.request_digest !== digest) return { ok: false, error: { kind: "idempotency-conflict", idempotency_key: request.idempotency_key } };
      return { ok: true, value: this.receipt(existing) };
    }
    const id = randomUUID();
    const at = this.now();
    const topologyTarget = target(request);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO conversation_spawn_requests
        (id, schema_version, idempotency_key, request_digest, request_json, provider, project_id, checkout_id,
         topology_kind, topology_target_conversation_id, state, initial_message_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'queued', ?, ?)`)
        .run(id, request.schema, request.idempotency_key, digest, requestJson, request.provider,
          request.placement.project_id, request.placement.checkout_id, request.topology.kind, topologyTarget, at, at);
      this.event(id, "reserved", { request_digest: digest }, at);
    })();
    return this.get(id);
  }

  begin(reservationId: string): Result<ConversationSpawnReceipt> {
    const row = this.row(reservationId);
    if (!row) return { ok: false, error: { kind: "not-found", reservation_id: reservationId } };
    if (row.state === "creating" || row.state === "delivering") {
      return { ok: false, error: { kind: "spawn-in-progress", reservation_id: reservationId } };
    }
    if (row.state === "delivered") return { ok: true, value: this.receipt(row) };
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_spawn_requests SET state = ?, attempt_count = attempt_count + 1,
        initial_message_state = CASE WHEN native_session_id IS NULL THEN 'queued' ELSE 'delivering' END,
        error_json = NULL, updated_at = ? WHERE id = ?`)
        .run(row.native_session_id === null ? "creating" : "delivering", at, reservationId);
      this.event(reservationId, row.native_session_id === null ? "creation-started" : "delivery-started", {}, at);
    })();
    return this.get(reservationId);
  }

  recordNativeSession(reservationId: string, nativeSessionId: string): Result<ConversationSpawnReceipt> {
    const row = this.row(reservationId);
    if (!row) return { ok: false, error: { kind: "not-found", reservation_id: reservationId } };
    if (row.native_session_id && row.native_session_id !== nativeSessionId) {
      return { ok: false, error: { kind: "idempotency-conflict", idempotency_key: JSON.parse(row.request_json).idempotency_key } };
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_spawn_requests SET native_session_id = ?, updated_at = ? WHERE id = ?`)
        .run(nativeSessionId, at, reservationId);
    })();
    return this.get(reservationId);
  }

  recordProviderReceipt(reservationId: string, nativeSessionId: string, providerSessionId: string, providerReceipt: Record<string, unknown>): Result<ConversationSpawnReceipt> {
    const row = this.row(reservationId);
    if (!row) return { ok: false, error: { kind: "not-found", reservation_id: reservationId } };
    if (row.native_session_id && row.native_session_id !== nativeSessionId) {
      return { ok: false, error: { kind: "idempotency-conflict", idempotency_key: JSON.parse(row.request_json).idempotency_key } };
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_spawn_requests SET state = 'delivering', native_session_id = ?,
        provider_session_id = COALESCE(?, provider_session_id), provider_receipt_json = ?,
        initial_message_state = 'delivering', updated_at = ? WHERE id = ?`)
        .run(nativeSessionId, providerSessionId, stable(providerReceipt), at, reservationId);
      this.event(reservationId, "provider-receipt", providerReceipt, at);
      this.event(reservationId, "delivery-started", {}, at);
    })();
    return this.get(reservationId);
  }

  delivered(reservationId: string, providerSessionId: string | null = null): Result<ConversationSpawnReceipt> {
    const row = this.row(reservationId);
    if (!row) return { ok: false, error: { kind: "not-found", reservation_id: reservationId } };
    if (!(providerSessionId?.trim() || row.provider_session_id?.trim())) {
      return { ok: false, error: { kind: "provider-proof-required", reservation_id: reservationId } };
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_spawn_requests SET state = 'delivered', initial_message_state = 'delivered',
        provider_session_id = COALESCE(?, provider_session_id), error_json = NULL, updated_at = ? WHERE id = ?`)
        .run(providerSessionId, at, reservationId);
      this.event(reservationId, "delivered", {}, at);
    })();
    return this.get(reservationId);
  }

  failed(
    reservationId: string,
    error: {
      code: string;
      message: string;
      retryable: boolean;
      phase?: "configuration" | "readiness";
      provenance?: import("../provider-startup.js").ProviderStartupProvenance;
    },
    options: { resetNativeSession?: boolean } = {},
  ): Result<ConversationSpawnReceipt> {
    if (!this.row(reservationId)) return { ok: false, error: { kind: "not-found", reservation_id: reservationId } };
    const at = this.now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_spawn_requests SET state = 'failed', initial_message_state = 'failed',
        native_session_id = CASE WHEN ? THEN NULL ELSE native_session_id END,
        provider_session_id = CASE WHEN ? THEN NULL ELSE provider_session_id END,
        provider_receipt_json = CASE WHEN ? THEN NULL ELSE provider_receipt_json END,
        error_json = ?, updated_at = ? WHERE id = ?`)
        .run(options.resetNativeSession ? 1 : 0, options.resetNativeSession ? 1 : 0,
          options.resetNativeSession ? 1 : 0, stable(error), at, reservationId);
      this.event(reservationId, "failed", error, at);
    })();
    return this.get(reservationId);
  }

  get(reservationId: string): Result<ConversationSpawnReceipt> {
    const row = this.row(reservationId);
    return row ? { ok: true, value: this.receipt(row) } : { ok: false, error: { kind: "not-found", reservation_id: reservationId } };
  }

  private validate(input: ConversationSpawnRequest): Result<ConversationSpawnRequest> {
    if (!input || input.schema !== CONVERSATION_SPAWN_REQUEST_SCHEMA) return this.invalid("schema", "Unsupported conversation spawn request schema");
    if (!input.idempotency_key?.trim()) return this.invalid("idempotency_key", "Idempotency key is required");
    if (!input.label?.trim()) return this.invalid("label", "Label is required");
    if (!input.initial_message?.trim()) return this.invalid("initial_message", "Initial message is required");
    const expectedCommand = input.provider === "claude_code" ? "claude" : input.provider;
    if (input.command?.name !== expectedCommand) return this.invalid("command.name", "Command does not match provider identity");
    if (!["pty", "sdk", "spawn", "acp"].includes(input.command.backend_type)) return this.invalid("command.backend_type", "Unsupported backend type");
    if (!["sdk", "pty", "channel", "acp", "spawn"].includes(input.command.transport_lane)) return this.invalid("command.transport_lane", "Unsupported transport lane");
    const placement = input.placement;
    if (!placement || (placement.project_id === null) !== (placement.checkout_id === null)) return this.invalid("placement", "Project and checkout must both be present or both be null");
    if (placement.project_id !== null) {
      if (!this.db.prepare("SELECT 1 FROM ledger_projects WHERE id = ?").get(placement.project_id)) return { ok: false, error: { kind: "project-not-found", project_id: placement.project_id } };
      const checkout = this.db.prepare("SELECT project_id FROM ledger_project_checkouts WHERE id = ?").get(placement.checkout_id) as { project_id: string } | undefined;
      if (!checkout) return { ok: false, error: { kind: "checkout-not-found", checkout_id: placement.checkout_id } };
      if (checkout.project_id !== placement.project_id) return { ok: false, error: { kind: "checkout-project-mismatch", project_id: placement.project_id, checkout_id: placement.checkout_id } };
    }
    if (!input.topology || !["top-level", "autonomous", "child", "sibling", "successor"].includes(input.topology.kind)) return this.invalid("topology.kind", "Unsupported topology kind");
    const topologyTarget = target(input);
    if (["child", "sibling", "successor"].includes(input.topology.kind) && !topologyTarget?.trim()) return this.invalid("topology", "This topology requires an exact target conversation identity");
    if (topologyTarget && !this.db.prepare("SELECT 1 FROM conversations WHERE id = ? UNION SELECT 1 FROM conversation_spawn_requests WHERE id = ?").get(topologyTarget, topologyTarget)) {
      return { ok: false, error: { kind: "topology-target-not-found", conversation_id: topologyTarget } };
    }
    return { ok: true, value: { ...input, idempotency_key: input.idempotency_key.trim(), label: input.label.trim(), initial_message: input.initial_message.trim() } };
  }

  private invalid(field: string, message: string): Result<never> { return { ok: false, error: { kind: "invalid-request", field, message } }; }
  private terminalizeInterrupted(): void {
    const rows = this.db.prepare(
      "SELECT id FROM conversation_spawn_requests WHERE state IN ('creating', 'delivering') ORDER BY created_at, id",
    ).all() as Array<{ id: string }>;
    if (rows.length === 0) return;
    const at = this.now();
    const error = {
      code: "provider_startup_interrupted",
      message: "Provider startup was interrupted before delivery completed.",
      retryable: true,
      phase: "readiness" as const,
    };
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.prepare(`UPDATE conversation_spawn_requests
          SET state = 'failed', initial_message_state = 'failed', error_json = ?, updated_at = ?
          WHERE id = ?`).run(stable(error), at, row.id);
        this.event(row.id, "failed", error, at);
      }
    })();
  }
  private row(id: string): SpawnRow | undefined { return this.db.prepare("SELECT * FROM conversation_spawn_requests WHERE id = ?").get(id) as SpawnRow | undefined; }
  private event(spawnId: string, kind: string, body: Record<string, unknown>, at: number): void {
    const ordinal = ((this.db.prepare("SELECT MAX(ordinal) AS ordinal FROM conversation_spawn_events WHERE spawn_id = ?").get(spawnId) as { ordinal: number | null }).ordinal ?? 0) + 1;
    this.db.prepare("INSERT INTO conversation_spawn_events (id, spawn_id, ordinal, event_kind, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), spawnId, ordinal, kind, stable(body), at);
  }
  private receipt(row: SpawnRow): ConversationSpawnReceipt {
    return { schema: CONVERSATION_SPAWN_RECEIPT_SCHEMA, reservation_id: row.id, request: JSON.parse(row.request_json), state: row.state,
      attempt_count: row.attempt_count, native_session_id: row.native_session_id, provider_session_id: row.provider_session_id,
      provider_receipt: row.provider_receipt_json ? JSON.parse(row.provider_receipt_json) : null,
      initial_message_state: row.initial_message_state, error: row.error_json ? JSON.parse(row.error_json) : null,
      created_at: row.created_at, updated_at: row.updated_at };
  }
}
