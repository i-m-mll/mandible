export const SPACE_PUBLICATION_AUTH_SCHEMA_SQL = [
  "ALTER TABLE space_publications ADD COLUMN expected_destination_mode TEXT CHECK(expected_destination_mode IN ('100644','100755'))",
  "ALTER TABLE auth_requests ADD COLUMN space_publication_id TEXT REFERENCES space_publications(id) ON DELETE RESTRICT",
  "UPDATE auth_requests SET space_publication_id=(SELECT id FROM space_publications WHERE auth_request_id=auth_requests.id) WHERE EXISTS(SELECT 1 FROM space_publications WHERE auth_request_id=auth_requests.id)",
  `CREATE TRIGGER auth_publication_reference_immutable BEFORE UPDATE OF space_publication_id ON auth_requests
   WHEN NEW.space_publication_id IS NOT OLD.space_publication_id
   BEGIN SELECT RAISE(ABORT, 'publication request reference is immutable'); END`,
  "CREATE UNIQUE INDEX space_publication_auth_request_unique ON space_publications(auth_request_id) WHERE auth_request_id IS NOT NULL",
  `CREATE TRIGGER space_publication_mode_immutable BEFORE UPDATE OF expected_destination_mode ON space_publications
   BEGIN SELECT RAISE(ABORT, 'publication destination mode is immutable'); END`,
  `CREATE TRIGGER space_publication_auth_binding_immutable BEFORE UPDATE OF auth_request_id,branch,worktree,commit_sha,version_ref,state ON space_publications
   WHEN OLD.auth_request_id IS NOT NULL AND (NEW.branch IS NOT OLD.branch OR NEW.worktree IS NOT OLD.worktree OR NEW.commit_sha IS NOT OLD.commit_sha
     OR NEW.version_ref IS NOT OLD.version_ref OR NEW.state IS NOT OLD.state OR
     (NEW.auth_request_id IS NOT OLD.auth_request_id AND NOT EXISTS (
       SELECT 1 FROM auth_requests successor JOIN auth_requests predecessor ON predecessor.id=OLD.auth_request_id
       WHERE successor.id=NEW.auth_request_id AND successor.supersedes_request_id=OLD.auth_request_id AND successor.space_publication_id=OLD.id AND predecessor.status='pending'
     )))
   BEGIN SELECT RAISE(ABORT, 'publication auth binding requires exact pending supersession'); END`,
];
