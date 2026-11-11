import { AUTH_REQUEST_ACTION_KINDS } from "./contracts.js";
import { ledgerOriginColumnSql } from "./ledger-origin-schema.js";

/** The staged actions of an auth request; `kind` admits exactly `AUTH_REQUEST_ACTION_KINDS`. */
export const AUTH_REQUEST_ACTIONS_TABLE_SQL = `CREATE TABLE auth_request_actions (
        id TEXT PRIMARY KEY,
        auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN (${AUTH_REQUEST_ACTION_KINDS.map((kind) => `'${kind}'`).join(",")})),
        target_issue_ref TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','applied','failed','vetoed','skipped_stale')),
        target_digest TEXT,
        staged_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        outcome_detail TEXT,
        replacement_action_id TEXT REFERENCES auth_request_actions(id) ON DELETE RESTRICT,
        ${ledgerOriginColumnSql}
      )`;

export const AUTH_REQUEST_ACTIONS_INDEX_SQL: readonly string[] = [
  "CREATE INDEX idx_auth_request_actions_request_ordinal\n        ON auth_request_actions(auth_request_id, ordinal)",
  "CREATE INDEX idx_auth_request_actions_state\n        ON auth_request_actions(state, auth_request_id)",
];

/** Rebuild the table at the current kind vocabulary, keeping every row; run with foreign keys off. */
export const AUTH_REQUEST_ACTIONS_REBUILD_SQL: readonly string[] = [
  "DROP INDEX idx_auth_request_actions_request_ordinal",
  "DROP INDEX idx_auth_request_actions_state",
  "ALTER TABLE auth_request_actions RENAME TO auth_request_actions_previous",
  AUTH_REQUEST_ACTIONS_TABLE_SQL,
  "INSERT INTO auth_request_actions SELECT * FROM auth_request_actions_previous",
  "DROP TABLE auth_request_actions_previous",
  ...AUTH_REQUEST_ACTIONS_INDEX_SQL,
];
