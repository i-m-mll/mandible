/**
 * Antigravity replaces the retired Gemini CLI as Mandible's third provider.
 *
 * `ANTIGRAVITY_PROVIDER_SCHEMA_SQL` rebuilds every table whose CHECK names the
 * provider, so the fresh baseline and a migrated database share one head shape.
 * `ANTIGRAVITY_PROVIDER_MIGRATION_SQL` first deletes the indexed Gemini CLI
 * conversations: their parser is gone, so nothing could render them. The source
 * logs under `~/.gemini/tmp` are not touched. Dependents restricted by foreign
 * keys (control, runtime settings, usage, identity aliases) are left in place,
 * so a database holding any fails the migration's foreign-key check loudly.
 */

const CONVERSATIONS_SQL = `CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('claude_code', 'codex', 'antigravity')),
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_mtime INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  block_count INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL,
  project_path TEXT,
  cwd TEXT,
  branch TEXT,
  model TEXT,
  cli_version TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'),
  parent_source TEXT CHECK(parent_source IN ('claude_code', 'codex', 'antigravity')),
  parent_session_id TEXT CHECK((parent_source IS NULL) = (parent_session_id IS NULL)),
  opening_lineage TEXT CHECK(opening_lineage IN ('unread', 'none', 'child', 'successor', 'malformed', 'mismatched', 'legacy-prose')),
  opening_line TEXT,
  agent_created INTEGER NOT NULL DEFAULT 0 CHECK(agent_created IN (0, 1))
)`;

const CONVERSATIONS_INDEX_SQL = [
  "CREATE INDEX idx_conv_agent ON conversations(agent_id) WHERE agent_id IS NOT NULL",
  "CREATE INDEX idx_conv_declared_parent ON conversations(parent_session_id) WHERE parent_session_id IS NOT NULL",
  "CREATE INDEX idx_conv_ended_ms ON conversations(ended_at_ms) WHERE ended_at_ms IS NOT NULL",
  "CREATE INDEX idx_conv_parent ON conversations(parent_conversation_id) WHERE parent_conversation_id IS NOT NULL",
  "CREATE INDEX idx_conv_session ON conversations(session_id)",
  `CREATE INDEX idx_conv_sidebar ON conversations(started_at, id, source, starred, block_count, project_path, cwd, source_path, title)
    WHERE parent_conversation_id IS NULL`,
  "CREATE INDEX idx_conv_sidechain_parent ON conversations(parent_conversation_id, is_sidechain) WHERE is_sidechain = 1",
  "CREATE INDEX idx_conv_source ON conversations(source)",
  "CREATE INDEX idx_conv_source_path ON conversations(source_path)",
  "CREATE INDEX idx_conv_starred ON conversations(starred) WHERE starred = 1",
  "CREATE INDEX idx_conv_started ON conversations(started_at)",
  "CREATE INDEX idx_conv_started_ms ON conversations(started_at_ms) WHERE started_at_ms IS NOT NULL",
];

const CONVERSATION_SOURCES_SQL = `CREATE TABLE conversation_sources (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('claude_code','codex','antigravity')),
  native_session_id TEXT NOT NULL,
  parser_format TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  redaction_epoch INTEGER NOT NULL DEFAULT 0 CHECK(redaction_epoch >= 0),
  availability TEXT NOT NULL DEFAULT 'unchecked' CHECK(availability IN ('available','missing','stale','unsupported','unchecked')),
  custody_state TEXT NOT NULL DEFAULT 'provider' CHECK(custody_state IN ('provider','requested','capturing','verified','mirroring','sealed','error')),
  current_version_id TEXT,
  unavailable_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  position_space_id TEXT,
  position_count INTEGER,
  position_fingerprint TEXT,
  position_fingerprint_version INTEGER,
  publication_revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(conversation_id, provider)
)`;

const CONVERSATION_SOURCES_INDEX_SQL = [
  "CREATE INDEX idx_conversation_sources_availability ON conversation_sources(availability, custody_state)",
  "CREATE INDEX idx_conversation_sources_native_session ON conversation_sources(provider, native_session_id)",
];

const CONVERSATION_SPAWN_REQUESTS_SQL = `CREATE TABLE conversation_spawn_requests (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK(schema_version IN ('mandible-conversation-spawn-request@1','mandible-conversation-spawn-request@2','mandible-conversation-spawn-request@3')),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
  provider TEXT NOT NULL CHECK(provider IN ('claude_code','codex')),
  project_id TEXT REFERENCES ledger_projects(id) ON DELETE RESTRICT,
  checkout_id TEXT REFERENCES ledger_project_checkouts(id) ON DELETE RESTRICT,
  topology_kind TEXT NOT NULL CHECK(topology_kind IN ('top-level','autonomous','child','sibling','successor')),
  topology_target_conversation_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','creating','delivering','delivered','starting','stopping','ready','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  native_session_id TEXT,
  provider_session_id TEXT,
  provider_receipt_json TEXT CHECK(provider_receipt_json IS NULL OR (json_valid(provider_receipt_json) AND json_type(provider_receipt_json) = 'object')),
  initial_message_state TEXT CHECK(initial_message_state IS NULL OR initial_message_state IN ('queued','delivering','delivered','failed')),
  error_json TEXT CHECK(error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((project_id IS NULL) = (checkout_id IS NULL))
)`;

const CONVERSATION_SPAWN_REQUESTS_INDEX_SQL = [
  "CREATE INDEX idx_conversation_spawn_requests_state ON conversation_spawn_requests(state, updated_at)",
];

const WORK_UNITS_SQL = `CREATE TABLE work_units (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  branch TEXT,
  parent_branch TEXT,
  kind TEXT NOT NULL DEFAULT 'solo',
  state TEXT NOT NULL DEFAULT 'open',
  assigned_session_id TEXT,
  provider TEXT,
  provider_session_id TEXT,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_commit_at INTEGER,
  resolved_at INTEGER,
  auth_request_id TEXT,
  ledger_issue_id TEXT REFERENCES ledger_issues(id),
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  merge_scan_retired_at INTEGER,
  worker_provider_session_id TEXT,
  custody_generation INTEGER NOT NULL DEFAULT 0 CHECK(custody_generation >= 0),
  worker_provider TEXT CHECK(worker_provider IN ('codex','claude_code','antigravity')),
  legacy_assignment_target_json TEXT CHECK(legacy_assignment_target_json IS NULL OR
    (COALESCE(json_valid(legacy_assignment_target_json) AND json_type(legacy_assignment_target_json, '$.session_id') = 'text'
      AND length(trim(json_extract(legacy_assignment_target_json, '$.session_id'))) > 0
      AND CASE json_extract(legacy_assignment_target_json, '$.kind')
        WHEN 'alias' THEN json_type(legacy_assignment_target_json, '$.provider') IS NULL
        WHEN 'native' THEN COALESCE(json_extract(legacy_assignment_target_json, '$.provider') IN ('codex','claude_code'), 0)
        ELSE 0 END, 0))),
  responsibility_session_id TEXT,
  worker_agent_ref TEXT,
  assignment_target_json TEXT CHECK(assignment_target_json IS NULL OR
    (COALESCE(json_valid(assignment_target_json) AND CASE json_extract(assignment_target_json, '$.kind')
      WHEN 'native' THEN json_type(assignment_target_json, '$.agent_ref') = 'text' AND length(json_extract(assignment_target_json, '$.agent_ref')) > 0
      WHEN 'alias' THEN json_type(assignment_target_json, '$.session_id') = 'text' AND length(trim(json_extract(assignment_target_json, '$.session_id'))) > 0
      ELSE 0 END, 0))),
  execution_identity_json TEXT CHECK(execution_identity_json IS NULL OR json_valid(execution_identity_json)),
  landed_commit TEXT CHECK(landed_commit IS NULL OR (length(landed_commit) IN (40, 64) AND landed_commit NOT GLOB '*[^0-9a-f]*'))
)`;

const WORK_UNITS_INDEX_SQL = [
  "CREATE INDEX idx_work_units_assignment_target ON work_units(json_extract(assignment_target_json, '$.agent_ref'), state) WHERE assignment_target_json IS NOT NULL",
  "CREATE INDEX idx_work_units_created ON work_units(created_at)",
  "CREATE INDEX idx_work_units_ledger_issue ON work_units(ledger_issue_id) WHERE ledger_issue_id IS NOT NULL",
  "CREATE INDEX idx_work_units_pending_assignment ON work_units(id) WHERE assignment_target_json IS NOT NULL AND worker_provider IS NULL",
  "CREATE INDEX idx_work_units_provider_session ON work_units(provider, provider_session_id) WHERE provider IS NOT NULL AND provider_session_id IS NOT NULL",
  "CREATE INDEX idx_work_units_repo_branch ON work_units(repo_id, branch)",
  "CREATE INDEX idx_work_units_repo_issue ON work_units(repo_id, issue_id)",
  "CREATE INDEX idx_work_units_state ON work_units(state)",
  "CREATE INDEX idx_work_units_worker_binding ON work_units(worker_provider, worker_provider_session_id, state) WHERE worker_provider_session_id IS NOT NULL",
  `CREATE TRIGGER trg_work_units_assigned_session_insert_normalize
     AFTER INSERT ON work_units
     WHEN NEW.assigned_session_id IS NOT NULL AND trim(NEW.assigned_session_id) = ''
     BEGIN
       UPDATE work_units SET assigned_session_id = NULL WHERE id = NEW.id;
     END`,
  `CREATE TRIGGER trg_work_units_assigned_session_update_normalize
     AFTER UPDATE OF assigned_session_id ON work_units
     WHEN NEW.assigned_session_id IS NOT NULL AND trim(NEW.assigned_session_id) = ''
     BEGIN
       UPDATE work_units SET assigned_session_id = NULL WHERE id = NEW.id;
     END`,
];

function columnsOf(createSql: string): string {
  return createSql.split("\n").slice(1)
    .map(line => /^ {2}([a-z_]+) [A-Z]/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))
    .join(", ");
}

/** Replace `table` by `createSql`, keeping its rows; the copy carries no constraints, so foreign keys must be off. */
function rebuild(table: string, createSql: string, dependentSql: readonly string[]): string[] {
  const columns = columnsOf(createSql);
  const copy = `${table}__antigravity`;
  return [
    `CREATE TABLE ${copy} AS SELECT ${columns} FROM ${table}`,
    `DROP TABLE ${table}`,
    createSql,
    `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${copy}`,
    `DROP TABLE ${copy}`,
    ...dependentSql,
  ];
}

export const ANTIGRAVITY_PROVIDER_SCHEMA_SQL: readonly string[] = [
  ...rebuild("conversations", CONVERSATIONS_SQL, CONVERSATIONS_INDEX_SQL),
  ...rebuild("conversation_sources", CONVERSATION_SOURCES_SQL, CONVERSATION_SOURCES_INDEX_SQL),
  ...rebuild("conversation_spawn_requests", CONVERSATION_SPAWN_REQUESTS_SQL, CONVERSATION_SPAWN_REQUESTS_INDEX_SQL),
  ...rebuild("work_units", WORK_UNITS_SQL, WORK_UNITS_INDEX_SQL),
];

const GEMINI_CONVERSATIONS = "SELECT id FROM conversations WHERE source = 'gemini'";
const GEMINI_SOURCES = "SELECT id FROM conversation_sources WHERE provider = 'gemini'";

const GEMINI_RETIREMENT_SQL: readonly string[] = [
  `DELETE FROM conversation_source_aliases WHERE source_id IN (${GEMINI_SOURCES})`,
  `DELETE FROM conversation_source_versions WHERE source_id IN (${GEMINI_SOURCES})`,
  "DELETE FROM conversation_sources WHERE provider = 'gemini'",
  `DELETE FROM conversation_retention_state WHERE conversation_id IN (${GEMINI_CONVERSATIONS})`,
  `DELETE FROM conversation_archive_states WHERE conversation_id IN (${GEMINI_CONVERSATIONS})`,
  `UPDATE workflow_workers SET conversation_id = NULL WHERE conversation_id IN (${GEMINI_CONVERSATIONS})`,
  `UPDATE sessions SET conversation_id = NULL WHERE conversation_id IN (${GEMINI_CONVERSATIONS})`,
  `UPDATE conversations SET parent_conversation_id = NULL WHERE parent_conversation_id IN (${GEMINI_CONVERSATIONS})`,
  "UPDATE conversations SET parent_source = NULL, parent_session_id = NULL WHERE parent_source = 'gemini'",
  "DELETE FROM conversations WHERE source = 'gemini'",
  "UPDATE work_units SET worker_provider = NULL, worker_provider_session_id = NULL WHERE worker_provider = 'gemini'",
  "UPDATE work_units SET legacy_assignment_target_json = NULL WHERE json_extract(legacy_assignment_target_json, '$.provider') = 'gemini'",
  `UPDATE user_bindings SET value = 'antigravity' WHERE binding_type = 'app_name' AND value = 'gemini'
    AND user_id IN (SELECT id FROM users WHERE slug = 'gemini' AND kind = 'agent')`,
  `UPDATE user_bindings SET value = 'ANTIGRAVITY_CONVERSATION_ID' WHERE binding_type = 'provider_session_env' AND value = 'GEMINI_SESSION_ID'`,
  `UPDATE users SET slug = 'antigravity', display_name = 'Antigravity'
    WHERE slug = 'gemini' AND kind = 'agent' AND NOT EXISTS (SELECT 1 FROM users WHERE slug = 'antigravity')`,
];

export const ANTIGRAVITY_PROVIDER_MIGRATION_SQL: readonly string[] = [
  ...GEMINI_RETIREMENT_SQL,
  ...ANTIGRAVITY_PROVIDER_SCHEMA_SQL,
];
