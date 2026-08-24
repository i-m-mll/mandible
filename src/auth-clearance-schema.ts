export const AUTH_CLEARANCE_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS delegated_signing_runtime_bindings (
    lease_id TEXT PRIMARY KEY REFERENCES delegated_signing_leases(id) ON DELETE CASCADE,
    agent_pid INTEGER NOT NULL CHECK(agent_pid > 0),
    agent_uid INTEGER NOT NULL CHECK(agent_uid >= 0),
    agent_process_start TEXT NOT NULL CHECK(trim(agent_process_start) != ''),
    agent_executable TEXT NOT NULL CHECK(trim(agent_executable) != ''),
    socket_path TEXT NOT NULL CHECK(trim(socket_path) != ''),
    socket_dev TEXT NOT NULL CHECK(trim(socket_dev) != ''),
    socket_ino TEXT NOT NULL CHECK(trim(socket_ino) != ''),
    socket_uid INTEGER NOT NULL CHECK(socket_uid >= 0),
    socket_mode INTEGER NOT NULL CHECK(socket_mode >= 0),
    credential_fingerprint TEXT NOT NULL CHECK(trim(credential_fingerprint) != ''),
    public_key_path TEXT NOT NULL CHECK(trim(public_key_path) != ''),
    issued_runtime_epoch TEXT NOT NULL CHECK(trim(issued_runtime_epoch) != ''),
    owner_runtime_epoch TEXT NOT NULL CHECK(trim(owner_runtime_epoch) != ''),
    owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
    owner_uid INTEGER NOT NULL CHECK(owner_uid >= 0),
    owner_process_start TEXT NOT NULL CHECK(trim(owner_process_start) != ''),
    owner_executable TEXT NOT NULL CHECK(trim(owner_executable) != ''),
    attached_at INTEGER NOT NULL,
    last_validated_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('available','draining','retired','lost')),
    retired_at INTEGER,
    retired_reason TEXT,
    CHECK((state IN ('available','draining') AND retired_at IS NULL)
       OR (state IN ('retired','lost') AND retired_at IS NOT NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_delegated_signing_runtime_owner
     ON delegated_signing_runtime_bindings(owner_runtime_epoch, state)`,
  `CREATE TABLE IF NOT EXISTS auth_clearances (
    id TEXT PRIMARY KEY,
    issuer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    grantee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    grantee_credential_id TEXT NOT NULL REFERENCES user_credentials(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
    base_branch TEXT NOT NULL CHECK(trim(base_branch) != ''),
    issue_id TEXT REFERENCES ledger_issues(id) ON DELETE RESTRICT,
    head_branch TEXT,
    action TEXT NOT NULL CHECK(action = 'merge'),
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at > issued_at),
    max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 100),
    revoked_at INTEGER,
    revoked_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    runtime_epoch TEXT NOT NULL CHECK(trim(runtime_epoch) != ''),
    signing_lease_id TEXT NOT NULL REFERENCES delegated_signing_leases(id) ON DELETE RESTRICT,
    created_from_request_id TEXT,
    CHECK(issue_id IS NOT NULL OR (head_branch IS NOT NULL AND trim(head_branch) != '')),
    CHECK((revoked_at IS NULL AND revoked_by_user_id IS NULL)
       OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_clearances_match
     ON auth_clearances(project_id, base_branch, grantee_user_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_clearances_issue
     ON auth_clearances(issue_id) WHERE issue_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_auth_clearances_head
     ON auth_clearances(head_branch) WHERE head_branch IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS auth_clearance_uses (
    id TEXT PRIMARY KEY,
    clearance_id TEXT NOT NULL REFERENCES auth_clearances(id) ON DELETE RESTRICT,
    auth_request_id TEXT NOT NULL UNIQUE,
    use_ordinal INTEGER NOT NULL CHECK(use_ordinal >= 1),
    evidence_id TEXT NOT NULL UNIQUE REFERENCES attribution_evidence(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    requester_evidence_method TEXT NOT NULL CHECK(requester_evidence_method IN ('api_token','credential_signature')),
    requester_credential_id TEXT NOT NULL REFERENCES user_credentials(id) ON DELETE RESTRICT,
    signing_lease_id TEXT NOT NULL REFERENCES delegated_signing_leases(id) ON DELETE RESTRICT,
    request_snapshot_json TEXT NOT NULL CHECK(json_valid(request_snapshot_json) AND json_type(request_snapshot_json) = 'object'),
    request_snapshot_digest TEXT NOT NULL CHECK(length(request_snapshot_digest) = 64 AND request_snapshot_digest NOT GLOB '*[^0-9a-f]*'),
    consumed_at INTEGER NOT NULL,
    UNIQUE(clearance_id, use_ordinal)
  )`,
  `CREATE TRIGGER IF NOT EXISTS auth_clearances_scope_immutable
     BEFORE UPDATE OF issuer_user_id, grantee_user_id, grantee_credential_id, project_id,
       base_branch, issue_id, head_branch, action, issued_at, expires_at, max_uses,
       runtime_epoch, signing_lease_id, created_from_request_id ON auth_clearances
     BEGIN SELECT RAISE(ABORT, 'auth clearance scope is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS auth_clearances_revocation_immutable
     BEFORE UPDATE OF revoked_at, revoked_by_user_id ON auth_clearances
     WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by_user_id IS NULL
     BEGIN SELECT RAISE(ABORT, 'auth clearance revocation is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS auth_clearances_delete_forbidden
     BEFORE DELETE ON auth_clearances
     BEGIN SELECT RAISE(ABORT, 'auth clearance audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS auth_clearance_uses_immutable
     BEFORE UPDATE ON auth_clearance_uses
     BEGIN SELECT RAISE(ABORT, 'auth clearance use evidence is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS auth_clearance_uses_delete_forbidden
     BEFORE DELETE ON auth_clearance_uses
     BEGIN SELECT RAISE(ABORT, 'auth clearance use evidence is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS auth_requests_clearance_review_frozen
     BEFORE UPDATE OF requested_by_user_id, requester_evidence_method, requester_credential_id,
       type, command, cwd, repo, base_branch, head_branch, merge_head_sha,
       issue_references, issue_closures, issues, execution_mode ON auth_requests
     WHEN OLD.clearance_use_id IS NOT NULL
     BEGIN SELECT RAISE(ABORT, 'clearance-reviewed auth request fields are frozen'); END`,
];
