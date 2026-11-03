export const HISTORICAL_PROJECT_ROOTS_SCHEMA_SQL = [
  `CREATE TABLE ledger_project_historical_roots (
    project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
    root TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, root)
  )`,
];
