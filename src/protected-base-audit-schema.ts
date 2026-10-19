/**
 * Issue 117ba80 — the latest protected-base audit of each merge request. One
 * row per request, replaced whenever Mandible re-reads that request's base.
 * Kept outside auth_requests so audits never change lifecycle snapshots.
 */
export const PROTECTED_BASE_AUDIT_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS auth_base_audits (
    auth_request_id TEXT PRIMARY KEY REFERENCES auth_requests(id) ON DELETE RESTRICT,
    base_sha TEXT NOT NULL CHECK(trim(base_sha) != ''),
    result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    checked_at INTEGER NOT NULL
  )`,
];
