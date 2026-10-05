export const SPACE_PUBLICATION_SCHEMA_SQL = [
  `CREATE TABLE space_document_history (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL, content TEXT, blocks_json TEXT, artifact_ref TEXT,
    provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)), created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE space_publications (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE RESTRICT,
    source_revision TEXT NOT NULL, snapshot_ref TEXT NOT NULL, content TEXT NOT NULL,
    repo_id TEXT NOT NULL REFERENCES ledger_project_checkouts(id) ON DELETE RESTRICT,
    path TEXT NOT NULL, expected_destination_sha256 TEXT,
    issue_id TEXT NOT NULL, message TEXT NOT NULL,
    branch TEXT, worktree TEXT, commit_sha TEXT, version_ref TEXT, auth_request_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('prepared','committed','submitted')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER space_publication_snapshot_immutable BEFORE UPDATE OF
    source_revision, snapshot_ref, content, repo_id, path, expected_destination_sha256, issue_id, message
    ON space_publications BEGIN SELECT RAISE(ABORT, 'publication snapshot is immutable'); END`,
  `CREATE TRIGGER space_document_history_immutable BEFORE UPDATE ON space_document_history
    BEGIN SELECT RAISE(ABORT, 'document history is immutable'); END`,
];
