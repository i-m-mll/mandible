const conversationControlSchemaSql = (includeRuntimeOptions: boolean, allowPendingNativeIdentity = false, knownOwnership = false): readonly string[] => [
  `CREATE TABLE conversation_control_state (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    provider_session_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    owner_kind TEXT NOT NULL CHECK(owner_kind IN (${knownOwnership ? "'none','mandible','external'" : "'none','mandible','external','unknown'"})),
    controller_state TEXT NOT NULL CHECK(controller_state IN (${knownOwnership ? "'starting','ready','running','waiting','stopping','stopped','failed'" : "'starting','ready','running','waiting','stopping','stopped','failed','unknown'"})),
    controller_instance_id TEXT,
    adapter_id TEXT,
    owner_detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(owner_detail_json) AND json_type(owner_detail_json) = 'object'),
    last_authoritative_signal INTEGER,
    turn_state TEXT NOT NULL CHECK(turn_state IN ('none','queued','running','waiting-user','waiting-permission','completed','failed','cancelled','unknown')),
    turn_id TEXT,
    delivery_id TEXT,
    state_detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state_detail_json) AND json_type(state_detail_json) = 'object'),
    updated_at INTEGER NOT NULL,
    CHECK (
      (owner_kind = 'none' AND controller_state = 'stopped' AND controller_instance_id IS NULL AND adapter_id IS NULL AND owner_detail_json = '{}')
      OR (owner_kind = 'mandible' AND controller_state != 'stopped' AND controller_instance_id IS NOT NULL AND adapter_id IS NOT NULL AND ${allowPendingNativeIdentity ? "(provider_session_id IS NOT NULL OR (provider = 'claude_code' AND json_extract(owner_detail_json, '$.native_identity_pending') = 1))" : 'provider_session_id IS NOT NULL'} AND last_authoritative_signal IS NOT NULL)
      OR (owner_kind = 'external' AND controller_state = ${knownOwnership ? "'stopped'" : "'unknown'"} AND controller_instance_id IS NULL AND adapter_id IS NULL AND last_authoritative_signal IS NOT NULL)
      ${knownOwnership ? "" : "OR (owner_kind = 'unknown' AND controller_state = 'unknown' AND controller_instance_id IS NULL AND adapter_id IS NULL)"}
    ),
    CHECK (
      (turn_state = 'none' AND turn_id IS NULL AND delivery_id IS NULL)
      OR (turn_state = 'unknown')
      OR (turn_state = 'queued' AND turn_id IS NOT NULL AND delivery_id IS NOT NULL)
      OR (turn_state NOT IN ('none','unknown','queued') AND turn_id IS NOT NULL)
    )
  )`,
  `CREATE TABLE conversation_control_journal (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    generation INTEGER NOT NULL CHECK(generation >= 0),
    event_kind TEXT NOT NULL CHECK(event_kind IN (
      'controller-acquired','controller-ready','controller-running','controller-waiting',
      'controller-stopping','controller-failed','controller-released','ownership-unknown',
      'external-ownership-observed','provider-session-bound','turn-queued','turn-started',
      'turn-waiting-user','turn-waiting-permission','turn-completed','turn-failed',
      'turn-cancelled','turn-unknown','delivery-started','delivery-completed',
      'delivery-failed','delivery-uncertain'
    )),
    event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json) = 'object'),
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_conversation_control_journal_conversation
    ON conversation_control_journal(conversation_id, revision, created_at)`,
  `CREATE TRIGGER conversation_control_journal_immutable_update
    BEFORE UPDATE ON conversation_control_journal BEGIN
      SELECT RAISE(ABORT, 'conversation control journal is immutable');
    END`,
  `CREATE TRIGGER conversation_control_journal_immutable_delete
    BEFORE DELETE ON conversation_control_journal BEGIN
      SELECT RAISE(ABORT, 'conversation control journal is immutable');
    END`,
  `CREATE TABLE conversation_control_outbox (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    turn_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('send','steer','queue','resume-provider-session','resume-message-anchor')),
    message TEXT NOT NULL CHECK(length(trim(message)) > 0),
    message_anchor TEXT,
    idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
    state TEXT NOT NULL CHECK(state IN ('pending','delivering','delivered','failed','uncertain')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    provider_receipt_id TEXT,
    error_json TEXT CHECK(error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ${includeRuntimeOptions ? "runtime_options_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(runtime_options_json) AND json_type(runtime_options_json) = 'object')," : ""}
    ${includeRuntimeOptions ? "attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json) AND json_type(attachments_json) = 'array')," : ""}
    UNIQUE(conversation_id, idempotency_key),
    UNIQUE(conversation_id, turn_id)
  )`,
  `CREATE INDEX idx_conversation_control_outbox_dispatch
    ON conversation_control_outbox(state, updated_at)`,
];

/** Historical v163 shape used only by the v163 migration. */
export const CONVERSATION_CONTROL_SCHEMA_V163_SQL = conversationControlSchemaSql(false);

/** Current head shape used by fresh databases. */
export const CONVERSATION_CONTROL_SCHEMA_SQL = conversationControlSchemaSql(true, true, true);

export const CONVERSATION_CONTROL_PENDING_IDENTITY_MIGRATION_SQL = [
  conversationControlSchemaSql(true, true)[0].replace('CREATE TABLE conversation_control_state', 'CREATE TABLE conversation_control_state_v189'),
  'INSERT INTO conversation_control_state_v189 SELECT * FROM conversation_control_state',
  'DROP TABLE conversation_control_state',
  'ALTER TABLE conversation_control_state_v189 RENAME TO conversation_control_state',
] as const;

const freed = `owner_kind = 'unknown' OR (owner_kind = 'external' AND json_extract(owner_detail_json, '$.kind') = 'provider-controller')`;
const now = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const lost = (state: string) => `json_object('kind', 'adapter-failure', 'adapter_id',
  CASE ${state}.provider WHEN 'codex' THEN 'codex-app-server-v2' ELSE 'claude-agent-sdk-v1' END,
  'code', 'controller-lost', 'message', 'The controller ended before this message was sent', 'retryable', json('true'))`;

/**
 * Ownership is never unknown and an external controller has no controller
 * state of its own. Claims nothing can answer for are freed, with their
 * unsent deliveries failed and in-flight ones marked uncertain.
 */
export const CONVERSATION_CONTROL_KNOWN_OWNERSHIP_MIGRATION_SQL = [
  `INSERT INTO conversation_control_journal (id, conversation_id, revision, generation, event_kind, event_json, created_at)
    SELECT lower(hex(randomblob(16))), o.conversation_id, s.revision,
      o.generation, CASE o.state WHEN 'pending' THEN 'delivery-failed' ELSE 'delivery-uncertain' END,
      json_object('delivery_id', o.id), ${now}
    FROM conversation_control_outbox o JOIN conversation_control_state s ON s.conversation_id = o.conversation_id
    WHERE o.state IN ('pending','delivering') AND (${freed})`,
  `UPDATE conversation_control_outbox SET
      state = CASE state WHEN 'pending' THEN 'failed' ELSE 'uncertain' END,
      error_json = CASE state WHEN 'pending' THEN (SELECT ${lost("s")} FROM conversation_control_state s WHERE s.conversation_id = conversation_control_outbox.conversation_id) ELSE error_json END,
      updated_at = ${now}
    WHERE state IN ('pending','delivering')
      AND conversation_id IN (SELECT conversation_id FROM conversation_control_state WHERE ${freed})`,
  `INSERT INTO conversation_control_journal (id, conversation_id, revision, generation, event_kind, event_json, created_at)
    SELECT lower(hex(randomblob(16))), conversation_id, revision + 1, generation, 'controller-released',
      json_object('prior_owner', owner_kind), ${now}
    FROM conversation_control_state WHERE ${freed}`,
  CONVERSATION_CONTROL_SCHEMA_SQL[0].replace('CREATE TABLE conversation_control_state', 'CREATE TABLE conversation_control_state_v195'),
  `INSERT INTO conversation_control_state_v195 SELECT conversation_id, provider, provider_session_id,
      CASE WHEN ${freed} THEN revision + 1 ELSE revision END, generation,
      CASE WHEN ${freed} THEN 'none' ELSE owner_kind END,
      CASE WHEN ${freed} OR owner_kind = 'external' THEN 'stopped' ELSE controller_state END,
      controller_instance_id, adapter_id,
      CASE WHEN ${freed} THEN '{}' ELSE owner_detail_json END,
      CASE WHEN ${freed} THEN NULL ELSE last_authoritative_signal END,
      turn_state, turn_id, delivery_id, state_detail_json,
      CASE WHEN ${freed} THEN ${now} ELSE updated_at END
    FROM conversation_control_state`,
  'DROP TABLE conversation_control_state',
  'ALTER TABLE conversation_control_state_v195 RENAME TO conversation_control_state',
] as const;
