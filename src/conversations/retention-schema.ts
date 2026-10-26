export const CHILD_RETENTION_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE conversation_retention_state (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('planner','archaeologist','worker')),
    last_activity_at INTEGER,
    last_input_at INTEGER,
    last_terminal_at INTEGER,
    activity_state TEXT NOT NULL DEFAULT 'unknown' CHECK(activity_state IN ('active','settled','unknown')),
    activity_generation INTEGER NOT NULL DEFAULT 0,
    source_version_id TEXT,
    restored_at INTEGER,
    due_at INTEGER,
    trigger TEXT CHECK(trigger IN ('retention','resolved-worker')),
    attempts INTEGER NOT NULL DEFAULT 0,
    native_pending INTEGER NOT NULL DEFAULT 0 CHECK(native_pending IN (0,1)),
    last_native_outcome TEXT
  )`,
  `CREATE INDEX idx_conversation_retention_due ON conversation_retention_state(due_at, conversation_id) WHERE due_at IS NOT NULL`,
  `ALTER TABLE work_units ADD COLUMN worker_provider TEXT CHECK(worker_provider IN ('codex','claude_code','gemini'))`,
  `ALTER TABLE work_units ADD COLUMN retained_assignment_session_id TEXT`,
  `CREATE INDEX idx_work_units_worker_binding ON work_units(worker_provider, worker_provider_session_id, state) WHERE worker_provider_session_id IS NOT NULL`,
];
