/**
 * Durable candidate acceptance results for runtime self-update merge requests
 * (issues a09b4d2, 7d83fe5). Each row binds one daemon-run acceptance to the
 * exact retained candidate (pin commit, merged tree, reviewed base and head).
 * `queued` and `running` rows are open; every other status is a final outcome.
 * `cancelled` means the run stopped without a verdict: a newer candidate or a
 * request resolution replaced it, or a daemon restart interrupted it.
 */
export const CANDIDATE_ACCEPTANCE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS auth_candidate_acceptances (
    id TEXT PRIMARY KEY,
    auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE RESTRICT,
    pin_sha TEXT NOT NULL CHECK(trim(pin_sha) != ''),
    tree_sha TEXT NOT NULL CHECK(trim(tree_sha) != ''),
    base_sha TEXT NOT NULL CHECK(trim(base_sha) != ''),
    head_sha TEXT NOT NULL CHECK(trim(head_sha) != ''),
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'passed', 'failed', 'unavailable', 'cancelled')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    error TEXT,
    CHECK((status IN ('queued', 'running')) = (finished_at IS NULL))
  )`;

export const CANDIDATE_ACCEPTANCE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_auth_candidate_acceptances_request
     ON auth_candidate_acceptances(auth_request_id, started_at)`;

export const CANDIDATE_ACCEPTANCE_SCHEMA_SQL: readonly string[] = [
  CANDIDATE_ACCEPTANCE_TABLE_SQL,
  CANDIDATE_ACCEPTANCE_INDEX_SQL,
];

/** v195: admit `queued` and `cancelled` outcomes for automatic acceptance. */
export const CANDIDATE_ACCEPTANCE_QUEUE_MIGRATION_SQL: readonly string[] = [
  "ALTER TABLE auth_candidate_acceptances RENAME TO auth_candidate_acceptances_v194",
  CANDIDATE_ACCEPTANCE_TABLE_SQL,
  `INSERT INTO auth_candidate_acceptances
     (id, auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, result_json, error)
     SELECT id, auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, result_json, error
     FROM auth_candidate_acceptances_v194`,
  "DROP TABLE auth_candidate_acceptances_v194",
  CANDIDATE_ACCEPTANCE_INDEX_SQL,
];
