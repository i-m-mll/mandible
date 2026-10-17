/**
 * Issue a09b4d2 — durable candidate acceptance results for runtime
 * self-update merge requests. Each row binds one daemon-run acceptance to the
 * exact retained candidate (pin commit, merged tree, reviewed base and head).
 */
export const CANDIDATE_ACCEPTANCE_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS auth_candidate_acceptances (
    id TEXT PRIMARY KEY,
    auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE RESTRICT,
    pin_sha TEXT NOT NULL CHECK(trim(pin_sha) != ''),
    tree_sha TEXT NOT NULL CHECK(trim(tree_sha) != ''),
    base_sha TEXT NOT NULL CHECK(trim(base_sha) != ''),
    head_sha TEXT NOT NULL CHECK(trim(head_sha) != ''),
    status TEXT NOT NULL CHECK(status IN ('running', 'passed', 'failed', 'unavailable')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    error TEXT,
    CHECK((status = 'running') = (finished_at IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_candidate_acceptances_request
     ON auth_candidate_acceptances(auth_request_id, started_at)`,
];
