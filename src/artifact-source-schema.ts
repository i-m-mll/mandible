export const ARTIFACT_SOURCE_SCHEMA_SQL = [
  `CREATE TABLE artifact_source (
    artifact_id TEXT PRIMARY KEY REFERENCES artifact(id) ON DELETE CASCADE,
    source_json TEXT CHECK(source_json IS NULL OR json_valid(source_json)),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    reconciliation_reason TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_artifact_source_location ON artifact_source(source_json)`,
  `CREATE UNIQUE INDEX idx_artifact_source_unique ON artifact_source(source_json) WHERE reconciliation_reason IS NULL`,
  `CREATE TABLE artifact_source_move (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
    previous_source_json TEXT,
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    previous_revision INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    actor TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(artifact_id, revision)
  )`,
] as const;

export const ARTIFACT_SOURCE_BACKFILL_SQL = [
  `INSERT INTO project_artifact_associations
    (id,project_id,target_type,target_id,association_kind,role,status,source,created_at,updated_at)
    SELECT 'artifact-source-access:' || id || ':' || source_project_id, source_project_id,
      'artifact_version',id,'associated','historical-source-access','active','migration',created_at,created_at
    FROM artifact_version WHERE source_project_id IS NOT NULL
    ON CONFLICT DO NOTHING`,
  `CREATE TEMP TABLE artifact_repo_evidence AS
    SELECT ref, MIN(project_id) project_id FROM (
      SELECT id ref, id project_id FROM ledger_projects
      UNION SELECT project_key, id FROM ledger_projects WHERE project_key IS NOT NULL
      UNION SELECT display_name, id FROM ledger_projects
      UNION SELECT work_repo_id, project_id FROM ledger_project_checkouts
      UNION SELECT name, project_id FROM ledger_project_checkouts
    ) WHERE ref IS NOT NULL AND ref != '' GROUP BY ref HAVING COUNT(DISTINCT project_id) = 1`,
  `UPDATE artifact_version SET source_project_id = (
    SELECT project_id FROM artifact_repo_evidence WHERE ref = artifact_version.source_repo_id
  ) WHERE source_project_id IS NULL AND source_repo_id IS NOT NULL`,
  `CREATE TEMP TABLE artifact_source_evidence AS
    SELECT artifact_id,
      CASE WHEN repo_path IS NOT NULL AND source_project_id IS NOT NULL
        THEN json_object('kind','repo','project_id',source_project_id,'path',repo_path)
        WHEN source_kind = 'local_only' AND repo_path IS NULL AND observed_path IS NOT NULL
        THEN json_object('kind','local','path',observed_path)
        ELSE NULL END source_json
    FROM artifact_version WHERE source_kind != 'managed'`,
  `INSERT INTO artifact_source (artifact_id, source_json, revision, reconciliation_reason, updated_at)
    SELECT a.id,
      CASE WHEN NOT EXISTS (SELECT 1 FROM artifact_source_evidence e WHERE e.artifact_id=a.id)
        AND a.source_kind = 'managed' THEN json_object('kind','managed','key',a.identity_key)
      WHEN (SELECT COUNT(DISTINCT source_json) FROM artifact_source_evidence e WHERE e.artifact_id=a.id)=1
        AND NOT EXISTS (SELECT 1 FROM artifact_source_evidence e WHERE e.artifact_id=a.id AND source_json IS NULL)
        THEN (SELECT MIN(source_json) FROM artifact_source_evidence e WHERE e.artifact_id=a.id)
      ELSE NULL END,
      1, 'migration_pending', a.updated_at FROM artifact a`,
  `UPDATE artifact_source SET reconciliation_reason = NULL WHERE source_json IS NOT NULL
    AND source_json NOT IN (SELECT source_json FROM artifact_source GROUP BY source_json HAVING COUNT(*) > 1)`,
  `UPDATE artifact_source SET reconciliation_reason = 'historical_source_ambiguous'
    WHERE source_json IS NULL`,
  `UPDATE artifact_source SET reconciliation_reason = 'duplicate_current_source'
    WHERE source_json IN (SELECT source_json FROM artifact_source WHERE source_json IS NOT NULL
      GROUP BY source_json HAVING COUNT(*) > 1)`,
  `UPDATE artifact SET source_project_id = (
    SELECT MIN(project_id) FROM project_artifact_associations pa WHERE pa.target_type='artifact'
      AND pa.target_id=artifact.id AND pa.association_kind='canonical' AND pa.status='active'
    HAVING COUNT(DISTINCT project_id)=1
  ) WHERE source_project_id IS NULL`,
  `UPDATE artifact SET source_project_id = json_extract((SELECT source_json FROM artifact_source s
    WHERE s.artifact_id=artifact.id AND s.reconciliation_reason IS NULL),'$.project_id')
    WHERE source_project_id IS NULL`,
  `UPDATE artifact SET metadata_json=json_set(metadata_json,'$.registered_source_migration',
    json_object('source_repo_id',source_repo_id,'source_path',source_path))
    WHERE source_repo_id IS NOT NULL OR source_path IS NOT NULL`,
  `DROP INDEX idx_artifact_source_repo`,
  `ALTER TABLE artifact DROP COLUMN source_repo_id`,
  `ALTER TABLE artifact DROP COLUMN source_path`,
  `DROP TABLE artifact_source_evidence`,
  `DROP TABLE artifact_repo_evidence`,
] as const;
