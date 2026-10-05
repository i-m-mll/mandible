export const CONVERSATION_RUNTIME_SCHEMA_SQL = [
  `CREATE TABLE conversation_runtime_settings (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    options_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(options_json) AND json_type(options_json) = 'object'),
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE conversation_provider_usage (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    provider_session_id TEXT NOT NULL,
    provider_record_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
    observed_at INTEGER NOT NULL,
    PRIMARY KEY(conversation_id, generation)
  )`,
  `CREATE TABLE conversation_delivery_settings (
    delivery_id TEXT PRIMARY KEY REFERENCES conversation_control_outbox(id) ON DELETE RESTRICT,
    options_json TEXT NOT NULL CHECK(json_valid(options_json) AND json_type(options_json) = 'object')
  )`,
] as const;
