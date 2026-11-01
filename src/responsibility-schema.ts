export const RESPONSIBILITY_SCHEMA_SQL = [
  `CREATE TABLE responsibility_events (id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
    prior_user_id TEXT, prior_session_id TEXT, new_user_id TEXT, new_session_id TEXT,
    generation INTEGER NOT NULL, reason TEXT NOT NULL, occurred_at INTEGER NOT NULL, request_origin_json TEXT,
    UNIQUE(entity_kind, entity_id, generation))`,
  `CREATE TRIGGER responsibility_events_immutable_update BEFORE UPDATE ON responsibility_events
    BEGIN SELECT RAISE(ABORT, 'responsibility events are immutable'); END`,
  `CREATE TRIGGER responsibility_events_immutable_delete BEFORE DELETE ON responsibility_events
    BEGIN SELECT RAISE(ABORT, 'responsibility events are immutable'); END`,
  `CREATE TABLE auth_request_responsibility (auth_request_id TEXT PRIMARY KEY REFERENCES auth_requests(id),
    owner_user_id TEXT, responsibility_session_id TEXT, custody_generation INTEGER NOT NULL DEFAULT 0)`
];
