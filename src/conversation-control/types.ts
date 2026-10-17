import type { ChatItem } from "../parsers/types.js";
import type { ChatAttachment } from "./attachments.js";

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type ControllerState =
  | { kind: "stopped"; at: number }
  | { kind: "starting"; since: number }
  | { kind: "ready"; since: number }
  | { kind: "running"; since: number }
  | { kind: "waiting"; since: number }
  | { kind: "stopping"; since: number }
  | { kind: "failed"; at: number; error: ConversationControlError }
  | { kind: "unknown"; since: number; reason: ReconciliationUnknownReason };

export type TurnState =
  | { kind: "none" }
  | { kind: "queued"; turn_id: string; delivery_id: string; since: number }
  | { kind: "running"; turn_id: string; since: number }
  | { kind: "waiting-user"; turn_id: string; since: number }
  | { kind: "waiting-permission"; turn_id: string; since: number }
  | { kind: "completed"; turn_id: string; at: number }
  | { kind: "failed"; turn_id: string; at: number; error: ConversationControlError }
  | { kind: "cancelled"; turn_id: string; at: number }
  | { kind: "unknown"; turn_id: string | null; since: number; reason: ReconciliationUnknownReason };

export type ExternalControllerEvidence = {
  kind: "registered-channel" | "registered-process" | "provider-controller";
  reference: string;
};

export type ControllerOwnership =
  | { kind: "none"; generation: number }
  | {
      kind: "mandible";
      generation: number;
      controller_instance_id: string;
      adapter_id: string;
      provider_session_id: string | null;
      last_authoritative_signal: number;
    }
  | {
      kind: "external";
      generation: number;
      evidence: ExternalControllerEvidence;
      last_authoritative_signal: number;
    }
  | {
      kind: "unknown";
      generation: number;
      prior_owner: "mandible" | "external" | "unknown";
      reason: ReconciliationUnknownReason;
    };

export type ReconciliationUnknownReason =
  | "daemon-restarted"
  | "adapter-unavailable"
  | "probe-ambiguous"
  | "authoritative-signal-expired"
  | "provider-identity-changed";

export type ConversationControlError =
  | { kind: "conversation-not-found"; conversation_id: string }
  | { kind: "invalid-request"; field: string; message: string }
  | { kind: "capability-drift"; expected_revision: number; actual_revision: number }
  | { kind: "unsupported-operation"; operation: ConversationControlOperation | "stop"; capability: ConversationContinuationCapability }
  | { kind: "ownership-conflict"; owner: "external" | "unknown"; capability: ConversationContinuationCapability }
  | { kind: "stale-generation"; expected_generation: number; actual_generation: number }
  | { kind: "adapter-unavailable"; adapter_id: string | null; provider: string }
  | { kind: "adapter-failure"; adapter_id: string; code: string; message: string; retryable: boolean }
  | { kind: "adapter-contract-violation"; adapter_id: string; message: string }
  | { kind: "delivery-uncertain"; delivery_id: string };

export type ConversationContinuationCapability =
  | { kind: "live-send"; revision: number; generation: number }
  | { kind: "live-steer"; revision: number; generation: number }
  | { kind: "owned-queue"; revision: number; generation: number }
  | { kind: "provider-session-resume"; revision: number; generation: number; adapter_id: string; provider_session_id: string }
  | { kind: "message-anchor-resume"; revision: number; generation: number; adapter_id: string; provider_session_id: string }
  | { kind: "blocked-external"; revision: number; evidence_kind: ExternalControllerEvidence["kind"] }
  | { kind: "blocked-ownership-unknown"; revision: number; reason: ReconciliationUnknownReason }
  | {
      kind: "unavailable";
      revision: number;
      reason: "unsupported-provider" | "no-provider-session" | "subagent" | "controller-transition" | "turn-transition";
    };

export type ConversationControlSnapshot = {
  conversation_id: string;
  provider: string;
  provider_session_id: string | null;
  provider_mode: ProviderAdapterMode | null;
  provider_capabilities: ProviderAdapterCapabilities | null;
  revision: number;
  ownership: ControllerOwnership;
  controller: ControllerState;
  turn: TurnState;
  capability: ConversationContinuationCapability;
  updated_at: number;
};

export type ConversationControlOperation =
  | "send"
  | "steer"
  | "queue"
  | "resume-provider-session"
  | "resume-message-anchor";

export type ProviderRuntimeEvent = {
  kind: "usage";
  conversation_id: string;
  generation: number;
  provider_session_id: string;
  provider_record_id: string;
  observed_at: number;
  snapshot: { usage?: Record<string, unknown>; model_usage?: Record<string, unknown>; total_cost_usd?: number; duration_ms?: number; num_turns?: number };
};

export type ManagedPermissionRequest = {
  id: string; tool_name: string; tool_input: unknown; created_at: number; expires_at: number;
  title?: string; description?: string;
};

export type ConversationRuntimeOptions = {
  system_prompt?: string;
  setting_sources?: ("user" | "project" | "local")[];
  allowed_tools?: string[];
  max_turns?: number;
  max_cost_usd?: number;
  model?: string;
  effort?: string;
  permission_mode?: "read-only" | "agent" | "agent-full-access" | "default" | "acceptEdits" | "bypassPermissions";
};

export type ConversationSubmitRequest = {
  conversation_id: string;
  operation: ConversationControlOperation;
  expected_revision: number;
  expected_generation: number;
  message: string;
  attachments?: ChatAttachment[];
  message_anchor?: string;
  runtime_options?: ConversationRuntimeOptions;
  idempotency_key: string;
};

export type AcceptedConversationSubmission = {
  kind: "accepted";
  delivery_id: string;
  turn_id: string;
  /** Null only when replaying an already-completed idempotent submission. */
  provider_receipt: ProviderDeliveryReceipt | null;
  snapshot: ConversationControlSnapshot;
};

export type ProviderAdapterMode = "sdk-managed" | "native-background" | "app-server-managed";

/**
 * Provider features are evidence, not an affordance wish-list. A caller must
 * render and execute an operation only when the selected adapter advertises it.
 */
export type ProviderAdapterCapabilities = {
  mode: ProviderAdapterMode;
  resume_provider_session: boolean;
  resume_message_anchor: boolean;
  send: boolean;
  steer: boolean;
  queue: boolean;
  stop: boolean;
  remove: boolean;
  structured_deltas: boolean;
  lifecycle_callbacks: boolean;
  permission_callbacks: boolean;
  terminal_attach: boolean;
  logs: boolean;
  initial_message_acceptance: "provider-protocol" | "unavailable";
};

export type ProviderProtocolEvidence =
  | {
      kind: "claude-stream-user-echo";
      provider_session_id: string;
      provider_message_id: string | null;
    }
  | {
      kind: "codex-turn-response";
      provider_session_id: string;
      provider_turn_id: string;
    };

export type ProviderDeliveryReceipt = {
  provider_receipt_id: string;
  acceptance: ProviderProtocolEvidence;
};

export type ProviderLiveContentEvent = {
  kind: "provisional-content";
  conversation_id: string;
  provider_session_id: string;
  generation: number;
  sequence: number;
  observed_at: number;
  /** Exact provider-qualified Chat item/content-block identity. */
  identity: string;
  correlation?: {
    intent_id: string;
    delivery_id: string;
    turn_id: string;
    provider_message_id?: string;
  };
  item: ChatItem;
};

export type ProviderDurableReconciliationEvent = {
  kind: "durable-reconciliation";
  conversation_id: string;
  provider_session_id: string;
  generation: number;
  sequence: number;
  observed_at: number;
  provider_event_id: string;
  /** Live identities proven to have exact durable Chat-item counterparts. */
  covered_identities: string[];
  /**
   * Provider-complete live items whose transient lifetime ends after a fresh
   * terminal transcript is established, even when the provider exposes no
   * cross-surface identity that could prove durable equivalence.
   */
  terminal_retired_identities?: string[];
};

export type ProviderLineageEvent = {
  kind: "provider-lineage";
  conversation_id: string;
  provider_session_id: string;
  generation: number;
  sequence: number;
  observed_at: number;
  provider_event_id: string;
  relation: "spawned-child";
  sender_provider_session_id: string;
  receiver_provider_session_id: string;
};

export type ProviderTransientRetirementEvent = {
  kind: "transient-retirement";
  conversation_id: string;
  provider_session_id: string;
  generation: number;
  sequence: number;
  observed_at: number;
  provider_event_id: string;
  reason: "provider-disconnected" | "generation-replaced";
};

export type ProviderAdapterEvent =
  | ProviderLiveContentEvent
  | ProviderLineageEvent
  | ProviderDurableReconciliationEvent
  | ProviderTransientRetirementEvent;

/**
 * Bounded live supplements for one provider controller generation.
 *
 * A provisional item lives only until its exact durable Chat-item identity is
 * observed, its controller disconnects, a newer generation replaces it, or
 * the oldest item crosses the bounded projection limit. The provider
 * transcript remains the durable authority throughout this lifecycle.
 */
export type ProviderLiveProjection = {
  conversation_id: string;
  revision: number;
  generation: number;
  events: ProviderAdapterEvent[];
};

export type ConversationLifecycleEvent =
  | { kind: "controller-ready"; at: number }
  | { kind: "controller-running"; at: number }
  | { kind: "controller-waiting"; at: number }
  | { kind: "controller-stopping"; at: number }
  | { kind: "controller-failed"; at: number; error: ConversationControlError }
  | { kind: "controller-released"; at: number }
  | { kind: "ownership-unknown"; at: number; reason: ReconciliationUnknownReason }
  | { kind: "provider-session-bound"; at: number; provider_session_id: string }
  | { kind: "turn-started"; at: number; turn_id: string }
  | { kind: "turn-waiting-user"; at: number; turn_id: string }
  | { kind: "turn-waiting-permission"; at: number; turn_id: string }
  | { kind: "turn-completed"; at: number; turn_id: string }
  | { kind: "turn-failed"; at: number; turn_id: string; error: ConversationControlError }
  | { kind: "turn-cancelled"; at: number; turn_id: string }
  | { kind: "turn-unknown"; at: number; turn_id: string | null; reason: ReconciliationUnknownReason };

export type OutboxDeliveryState = "pending" | "delivering" | "delivered" | "failed" | "uncertain";

export type ConversationOutboxItem = {
  id: string;
  conversation_id: string;
  generation: number;
  turn_id: string;
  operation: ConversationControlOperation;
  message: string;
  attachments: ChatAttachment[];
  /** Internal source database location, used to resolve this instance's retained bytes. */
  attachment_db_path: string;
  message_anchor: string | null;
  runtime_options: ConversationRuntimeOptions;
  idempotency_key: string;
  state: OutboxDeliveryState;
  attempts: number;
  provider_receipt_id: string | null;
};

export type ConversationOwnershipReconciliationReport = {
  checked: number;
  released: number;
  external: number;
  /** Unresolved claims with no provider session identity to probe. */
  unresolvable: number;
  probe_error: string | null;
  errors: ConversationControlError[];
};

export type ConversationControlReconciliationReport = {
  claims_checked: number;
  deliveries_checked: number;
  ownership: ConversationOwnershipReconciliationReport;
  errors: ConversationControlError[];
};
