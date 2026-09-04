export const CONVERSATION_SPAWN_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE conversation_spawn_requests (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK(schema_version = 'mandible-conversation-spawn-request@1'),
    idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
    request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
    request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
    provider TEXT NOT NULL CHECK(provider IN ('claude_code','codex','gemini')),
    project_id TEXT REFERENCES ledger_projects(id) ON DELETE RESTRICT,
    checkout_id TEXT REFERENCES ledger_project_checkouts(id) ON DELETE RESTRICT,
    topology_kind TEXT NOT NULL CHECK(topology_kind IN ('top-level','autonomous','child','sibling','successor')),
    topology_target_conversation_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('reserved','creating','delivering','delivered','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    native_session_id TEXT,
    provider_session_id TEXT,
    provider_receipt_json TEXT CHECK(provider_receipt_json IS NULL OR (json_valid(provider_receipt_json) AND json_type(provider_receipt_json) = 'object')),
    initial_message_state TEXT NOT NULL DEFAULT 'queued' CHECK(initial_message_state IN ('queued','delivering','delivered','failed')),
    error_json TEXT CHECK(error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((project_id IS NULL) = (checkout_id IS NULL))
  )`,
  `CREATE INDEX idx_conversation_spawn_requests_state
    ON conversation_spawn_requests(state, updated_at)`,
  `CREATE TABLE conversation_spawn_events (
    id TEXT PRIMARY KEY,
    spawn_id TEXT NOT NULL REFERENCES conversation_spawn_requests(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
    event_kind TEXT NOT NULL CHECK(event_kind IN ('reserved','creation-started','provider-receipt','delivery-started','delivered','failed')),
    event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json) = 'object'),
    created_at INTEGER NOT NULL,
    UNIQUE(spawn_id, ordinal)
  )`,
  `CREATE TRIGGER conversation_spawn_events_immutable_update
    BEFORE UPDATE ON conversation_spawn_events BEGIN
      SELECT RAISE(ABORT, 'conversation spawn events are immutable');
    END`,
  `CREATE TRIGGER conversation_spawn_events_immutable_delete
    BEFORE DELETE ON conversation_spawn_events BEGIN
      SELECT RAISE(ABORT, 'conversation spawn events are immutable');
    END`,
];
