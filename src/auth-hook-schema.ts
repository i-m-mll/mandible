export const AUTH_HOOK_EXECUTIONS_TABLE_SQL = `CREATE TABLE auth_hook_executions (
        id                TEXT PRIMARY KEY,
        auth_request_id   TEXT NOT NULL,
        hook_id           TEXT NOT NULL,
        hook_label        TEXT NOT NULL DEFAULT '',
        command           TEXT NOT NULL,
        command_digest    TEXT NOT NULL CHECK(length(command_digest) = 64),
        position          INTEGER NOT NULL DEFAULT 0,
        required          INTEGER NOT NULL DEFAULT 1,
        state             TEXT NOT NULL DEFAULT 'pending'
                          CHECK(state IN ('pending','running','complete','failed','retired')),
        attempts          INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        max_attempts      INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts >= 1),
        exit_code         INTEGER,
        output            TEXT NOT NULL DEFAULT '',
        attempt_history   TEXT NOT NULL DEFAULT '[]',
        started_at        INTEGER,
        finished_at       INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        UNIQUE(auth_request_id, hook_id)
      )`;
export const AUTH_HOOK_EXECUTIONS_INDEX_SQL = "CREATE INDEX idx_auth_hook_executions_runnable ON auth_hook_executions(state, updated_at)";
/**
 * Issue 077f152 — a self-update whose own go-live was never confirmed is live
 * once a later self-update's verified go-live contains its merge. One row per
 * superseded request names that successor and both merge commits.
 */
export const AUTH_GO_LIVE_SUPERSESSIONS_TABLE_SQL = `CREATE TABLE auth_go_live_supersessions (
        auth_request_id      TEXT PRIMARY KEY REFERENCES auth_requests(id) ON DELETE RESTRICT,
        successor_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE RESTRICT,
        merge_sha            TEXT NOT NULL,
        successor_merge_sha  TEXT NOT NULL,
        recorded_at          INTEGER NOT NULL,
        CHECK(auth_request_id != successor_request_id)
      )`;
