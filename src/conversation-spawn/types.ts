export const CONVERSATION_SPAWN_REQUEST_SCHEMA = "mandible-conversation-spawn-request@3" as const;
export const CONVERSATION_SPAWN_RECEIPT_SCHEMA = "mandible-conversation-spawn-receipt@3" as const;

export type ConversationSpawnProvider = "claude_code" | "codex";
export type ConversationSpawnPlacement =
  | { kind: "projectless" }
  | { kind: "project"; project_id: string; checkout_id: string };

export interface ConversationSpawnRequest {
  schema: typeof CONVERSATION_SPAWN_REQUEST_SCHEMA;
  idempotency_key: string;
  provider: ConversationSpawnProvider;
  placement: ConversationSpawnPlacement;
}

export interface HistoricalConversationSpawnRequest {
  schema: "mandible-conversation-spawn-request@1" | "mandible-conversation-spawn-request@2";
  idempotency_key: string;
  provider: ConversationSpawnProvider | "gemini";
  label: string;
  initial_message: string;
  placement: ConversationSpawnPlacement | { project_id: null; checkout_id: null };
  topology:
    | { kind: "top-level" }
    | { kind: "autonomous"; sponsor_conversation_id: string | null }
    | { kind: "child"; parent_conversation_id: string }
    | { kind: "sibling"; sibling_conversation_id: string }
    | { kind: "successor"; predecessor_conversation_id: string };
  command: {
    name: "claude" | "codex" | "gemini";
    backend_type: "pty" | "sdk" | "spawn" | "acp";
    transport_lane: "sdk" | "pty" | "channel" | "acp" | "spawn";
    channel_enabled: boolean;
    run_options: Record<string, import("../session-run-options.js").SessionRunOptionValue>;
  };
}

export type ConversationSpawnState = "reserved" | "starting" | "stopping" | "ready" | "failed" | "cancelled";
export type HistoricalConversationSpawnState = "reserved" | "creating" | "delivering" | "delivered" | "failed";

export interface ConversationSpawnFailure {
  code: string;
  message: string;
  retryable: boolean;
  phase?: "configuration" | "readiness";
  provenance?: import("../provider-startup.js").ProviderStartupProvenance;
}

export interface ConversationSpawnReceipt {
  schema: typeof CONVERSATION_SPAWN_RECEIPT_SCHEMA | "mandible-conversation-spawn-receipt@1" | "mandible-conversation-spawn-receipt@2";
  reservation_id: string;
  request: ConversationSpawnRequest | HistoricalConversationSpawnRequest;
  state: ConversationSpawnState | HistoricalConversationSpawnState;
  attempt_count: number;
  native_session_id: string | null;
  controller_instance_id?: string | null;
  provider_session_id: string | null;
  provider_receipt: Record<string, unknown> | null;
  initial_message_state?: "queued" | "delivering" | "delivered" | "failed";
  error: ConversationSpawnFailure | null;
  created_at: number;
  updated_at: number;
}

export type ConversationSpawnError =
  | { kind: "invalid-request"; field: string; message: string }
  | { kind: "idempotency-conflict"; idempotency_key: string }
  | { kind: "project-not-found"; project_id: string }
  | { kind: "checkout-not-found"; checkout_id: string }
  | { kind: "checkout-project-mismatch"; project_id: string; checkout_id: string }
  | { kind: "spawn-in-progress"; reservation_id: string }
  | { kind: "stale-generation"; reservation_id: string; expected_generation: number; actual_generation: number }
  | { kind: "not-found"; reservation_id: string };

export type Result<T, E = ConversationSpawnError> = { ok: true; value: T } | { ok: false; error: E };
