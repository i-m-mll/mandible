export const CONVERSATION_SPAWN_REQUEST_SCHEMA = "mandible-conversation-spawn-request@1" as const;
export const CONVERSATION_SPAWN_RECEIPT_SCHEMA = "mandible-conversation-spawn-receipt@1" as const;

export type ConversationSpawnProvider = "claude_code" | "codex" | "gemini";

export type ConversationSpawnTopology =
  | { kind: "top-level" }
  | { kind: "autonomous"; sponsor_conversation_id: string | null }
  | { kind: "child"; parent_conversation_id: string }
  | { kind: "sibling"; sibling_conversation_id: string }
  | { kind: "successor"; predecessor_conversation_id: string };

export interface ConversationSpawnRequest {
  schema: typeof CONVERSATION_SPAWN_REQUEST_SCHEMA;
  idempotency_key: string;
  provider: ConversationSpawnProvider;
  label: string;
  initial_message: string;
  placement: { project_id: string; checkout_id: string } | { project_id: null; checkout_id: null };
  topology: ConversationSpawnTopology;
  command: {
    name: "claude" | "codex" | "gemini";
    backend_type: "pty" | "sdk" | "spawn" | "acp";
    transport_lane: "sdk" | "pty" | "channel" | "acp" | "spawn";
    channel_enabled: boolean;
    run_options: Record<string, import("../session-run-options.js").SessionRunOptionValue>;
  };
}

export type ConversationSpawnState = "reserved" | "creating" | "delivering" | "delivered" | "failed";

export interface ConversationSpawnReceipt {
  schema: typeof CONVERSATION_SPAWN_RECEIPT_SCHEMA;
  reservation_id: string;
  request: ConversationSpawnRequest;
  state: ConversationSpawnState;
  attempt_count: number;
  native_session_id: string | null;
  provider_session_id: string | null;
  provider_receipt: Record<string, unknown> | null;
  initial_message_state: "queued" | "delivering" | "delivered" | "failed";
  error: { code: string; message: string; retryable: boolean } | null;
  created_at: number;
  updated_at: number;
}

export type ConversationSpawnError =
  | { kind: "invalid-request"; field: string; message: string }
  | { kind: "idempotency-conflict"; idempotency_key: string }
  | { kind: "project-not-found"; project_id: string }
  | { kind: "checkout-not-found"; checkout_id: string }
  | { kind: "checkout-project-mismatch"; project_id: string; checkout_id: string }
  | { kind: "topology-target-not-found"; conversation_id: string }
  | { kind: "spawn-in-progress"; reservation_id: string }
  | { kind: "not-found"; reservation_id: string };

export type Result<T, E = ConversationSpawnError> = { ok: true; value: T } | { ok: false; error: E };
