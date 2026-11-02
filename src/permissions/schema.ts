export const GLOBAL_CAPABILITIES = [
  "approve_auth", "spawn_console", "change_settings", "backup", "open_path", "ask.create",
] as const;
export type GlobalCapability = typeof GLOBAL_CAPABILITIES[number];

export const GLOBAL_GRANT_SCHEMA_SQL = `CREATE TABLE permission_grants (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('user','group')),
  subject_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN (${GLOBAL_CAPABILITIES.map(value => "'" + value + "'").join(',')})),
  created_at INTEGER NOT NULL
)`;
export const GLOBAL_GRANT_INDEX_SQL = [
  "CREATE INDEX idx_permission_grants_subject ON permission_grants(subject_type, subject_id)",
  "CREATE UNIQUE INDEX uq_permission_grants_global ON permission_grants(subject_type, subject_id, permission)",
] as const;
