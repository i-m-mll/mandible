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
