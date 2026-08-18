/** Canonical schema for one Briefing model with immutable artifact-backed rounds. */
export const BRIEFING_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS briefings (
    id TEXT PRIMARY KEY,
    briefing_key TEXT NOT NULL UNIQUE CHECK(trim(briefing_key) != ''),
    title TEXT NOT NULL CHECK(trim(title) != ''),
    latest_round_id TEXT,
    round_count INTEGER NOT NULL DEFAULT 0 CHECK(round_count >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS briefing_members (
    briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(briefing_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS briefing_rounds (
    id TEXT PRIMARY KEY,
    briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    artifact_version_id TEXT NOT NULL REFERENCES artifact_version(id) ON DELETE RESTRICT,
    previous_round_id TEXT REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
    profile TEXT NOT NULL CHECK(profile = 'mandible-briefing.v1'),
    binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
    created_at INTEGER NOT NULL,
    UNIQUE(briefing_id, ordinal),
    CHECK(previous_round_id IS NULL OR previous_round_id != id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_briefing_rounds_briefing
    ON briefing_rounds(briefing_id, ordinal DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_briefing_rounds_artifact_version
    ON briefing_rounds(artifact_version_id)`,
  `CREATE TABLE IF NOT EXISTS briefing_directive_definitions (
    id TEXT PRIMARY KEY,
    artifact_version_id TEXT NOT NULL REFERENCES artifact_version(id) ON DELETE RESTRICT,
    directive_key TEXT NOT NULL CHECK(length(directive_key) BETWEEN 1 AND 128),
    definition_digest TEXT NOT NULL CHECK(length(definition_digest) = 64),
    response_type TEXT NOT NULL CHECK(response_type IN ('verdict','free_text','single_choice','multi_choice')),
    required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
    prompt TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(options_json) AND json_type(options_json) = 'array'),
    start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK(end_offset > start_offset),
    body_start_offset INTEGER NOT NULL CHECK(body_start_offset >= start_offset),
    body_end_offset INTEGER NOT NULL CHECK(body_end_offset > body_start_offset AND body_end_offset <= end_offset),
    created_at INTEGER NOT NULL,
    UNIQUE(artifact_version_id, directive_key)
  )`,
  `CREATE TABLE IF NOT EXISTS briefing_directive_instances (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
    definition_id TEXT NOT NULL REFERENCES briefing_directive_definitions(id) ON DELETE RESTRICT,
    directive_key TEXT NOT NULL CHECK(length(directive_key) BETWEEN 1 AND 128),
    position INTEGER NOT NULL CHECK(position >= 0),
    created_at INTEGER NOT NULL,
    UNIQUE(round_id, directive_key),
    UNIQUE(round_id, position)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_briefing_directive_instances_definition
    ON briefing_directive_instances(definition_id)`,
  `CREATE TABLE IF NOT EXISTS briefing_runs (
    id TEXT PRIMARY KEY,
    briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE RESTRICT,
    round_id TEXT REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
    artifact_version_id TEXT REFERENCES artifact_version(id) ON DELETE RESTRICT,
    publisher_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    task_identity TEXT NOT NULL CHECK(trim(task_identity) != ''),
    run_id TEXT NOT NULL CHECK(trim(run_id) != ''),
    run_key TEXT NOT NULL CHECK(trim(run_key) != ''),
    request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
    evidence_series_ref TEXT NOT NULL CHECK(trim(evidence_series_ref) != ''),
    evidence_version INTEGER NOT NULL CHECK(evidence_version >= 0),
    evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),
    source_health_json TEXT NOT NULL CHECK(json_valid(source_health_json) AND json_type(source_health_json) = 'object'),
    quiet INTEGER NOT NULL CHECK(quiet IN (0,1)),
    quiet_reason TEXT,
    received_at INTEGER NOT NULL,
    UNIQUE(publisher_user_id, task_identity, run_key),
    CHECK((quiet = 1 AND round_id IS NULL AND artifact_version_id IS NULL AND quiet_reason IS NOT NULL)
      OR (quiet = 0 AND round_id IS NOT NULL AND artifact_version_id IS NOT NULL AND quiet_reason IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_briefing_runs_briefing
    ON briefing_runs(briefing_id, received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS briefing_run_occurrences (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES briefing_runs(id) ON DELETE RESTRICT,
    directive_instance_id TEXT REFERENCES briefing_directive_instances(id) ON DELETE RESTRICT,
    directive_key TEXT NOT NULL CHECK(length(directive_key) BETWEEN 1 AND 128),
    evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),
    occurred_at INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
    UNIQUE(run_id, directive_key, evidence_digest, occurred_at)
  )`,
  `CREATE TABLE IF NOT EXISTS briefing_response_events (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
    directive_instance_id TEXT NOT NULL REFERENCES briefing_directive_instances(id) ON DELETE RESTRICT,
    operation TEXT NOT NULL CHECK(operation IN ('set','retract')),
    value_json TEXT,
    retracts_event_id TEXT REFERENCES briefing_response_events(id) ON DELETE RESTRICT,
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    CHECK((operation = 'set' AND value_json IS NOT NULL AND json_valid(value_json)
      AND json_type(value_json) = 'object' AND retracts_event_id IS NULL)
      OR (operation = 'retract' AND value_json IS NULL AND retracts_event_id IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_briefing_response_retraction
    ON briefing_response_events(retracts_event_id) WHERE operation = 'retract'`,
  `CREATE INDEX IF NOT EXISTS idx_briefing_response_events_round_actor
    ON briefing_response_events(round_id, actor_user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS briefing_annotation_events (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
    operation TEXT NOT NULL CHECK(operation IN ('set','retract')),
    annotation_kind TEXT CHECK(annotation_kind IS NULL OR annotation_kind IN ('comment','suggest_replacement')),
    start_offset INTEGER,
    end_offset INTEGER,
    quote TEXT,
    body TEXT,
    replacement_text TEXT,
    retracts_event_id TEXT REFERENCES briefing_annotation_events(id) ON DELETE RESTRICT,
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    CHECK((operation = 'set' AND annotation_kind IS NOT NULL AND start_offset IS NOT NULL AND start_offset >= 0
      AND end_offset IS NOT NULL AND end_offset > start_offset AND quote IS NOT NULL AND quote != ''
      AND retracts_event_id IS NULL)
      OR (operation = 'retract' AND annotation_kind IS NULL AND start_offset IS NULL AND end_offset IS NULL
      AND quote IS NULL AND body IS NULL AND replacement_text IS NULL AND retracts_event_id IS NOT NULL)),
    CHECK(operation != 'set'
      OR (annotation_kind = 'comment' AND body IS NOT NULL AND trim(body) != '' AND replacement_text IS NULL)
      OR (annotation_kind = 'suggest_replacement' AND replacement_text IS NOT NULL AND (body IS NULL OR trim(body) != '')))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_briefing_annotation_retraction
    ON briefing_annotation_events(retracts_event_id) WHERE operation = 'retract'`,
  `CREATE INDEX IF NOT EXISTS idx_briefing_annotation_events_round_actor
    ON briefing_annotation_events(round_id, actor_user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS briefing_submissions (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    supersedes_submission_id TEXT REFERENCES briefing_submissions(id) ON DELETE RESTRICT,
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    UNIQUE(round_id, ordinal)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_briefing_submission_superseded_once_actor
    ON briefing_submissions(supersedes_submission_id, actor_user_id)
    WHERE supersedes_submission_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_briefing_submissions_round_actor
    ON briefing_submissions(round_id, actor_user_id, ordinal DESC)`,
  `CREATE TABLE IF NOT EXISTS briefing_submission_answers (
    submission_id TEXT NOT NULL REFERENCES briefing_submissions(id) ON DELETE RESTRICT,
    directive_instance_id TEXT NOT NULL REFERENCES briefing_directive_instances(id) ON DELETE RESTRICT,
    response_event_id TEXT NOT NULL REFERENCES briefing_response_events(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(submission_id, directive_instance_id),
    UNIQUE(submission_id, response_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS briefing_submission_annotations (
    submission_id TEXT NOT NULL REFERENCES briefing_submissions(id) ON DELETE RESTRICT,
    annotation_event_id TEXT NOT NULL REFERENCES briefing_annotation_events(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(submission_id, annotation_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS briefing_legacy_audit (
    id TEXT PRIMARY KEY,
    legacy_collection_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('reconstructed','sealed_ambiguous')),
    reason TEXT NOT NULL,
    provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
    created_at INTEGER NOT NULL
  )`,
];

export const CANONICAL_AGENT_DISPATCH_SQL = `CREATE TABLE agent_dispatch_events (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('issue','incident')),
  issue_id TEXT,
  incident_id TEXT REFERENCES operational_incidents(id) ON DELETE RESTRICT,
  incident_telemetry_sha256 TEXT CHECK(incident_telemetry_sha256 IS NULL OR length(incident_telemetry_sha256) = 64),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'claude', instruction TEXT NOT NULL, cwd TEXT NOT NULL,
  prompt_path TEXT, prompt_sha256 TEXT,
  status TEXT NOT NULL CHECK(status IN ('dispatching','dispatched','failed')),
  session_handle TEXT, session_id TEXT, attach_command TEXT, error TEXT,
  created_at INTEGER NOT NULL, settled_at INTEGER,
  CHECK((subject_kind = 'issue' AND issue_id IS NOT NULL AND incident_id IS NULL)
     OR (subject_kind = 'incident' AND incident_id IS NOT NULL
         AND incident_telemetry_sha256 IS NOT NULL AND issue_id IS NULL))
)`;

export const CANONICAL_SPACE_ITEMS_SQL = `CREATE TABLE space_items (
  id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL CHECK(ref_type IN ('issue','comment','artifact','external_ref','space')),
  ref_id TEXT NOT NULL CHECK(ref_id != ''), ref_uri TEXT, title TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(id), UNIQUE(space_id,id), UNIQUE(space_id,ref_type,ref_id),
  CHECK(ref_type != 'external_ref' OR ref_uri IS NOT NULL)
)`;

export const BRIEFING_SCHEMA_TABLES: readonly string[] = [
  "briefings", "briefing_members", "briefing_rounds", "briefing_directive_definitions",
  "briefing_directive_instances", "briefing_runs", "briefing_run_occurrences",
  "briefing_response_events", "briefing_annotation_events", "briefing_submissions",
  "briefing_submission_answers", "briefing_submission_annotations", "briefing_legacy_audit",
];

/** Child-first retirement of the pre-v142 kind-split feedback schema. */
export const LEGACY_FEEDBACK_DROP_SQL: readonly string[] = [
  "DROP TABLE IF EXISTS feedback_submission_annotations",
  "DROP TABLE IF EXISTS feedback_item_directives",
  "DROP TABLE IF EXISTS feedback_collection_documents",
  "DROP TABLE IF EXISTS feedback_submission_answers",
  "DROP TABLE IF EXISTS feedback_submissions",
  "DROP TABLE IF EXISTS feedback_annotation_events",
  "DROP TABLE IF EXISTS feedback_comments",
  "DROP TABLE IF EXISTS feedback_response_events",
  "DROP TABLE IF EXISTS feedback_item_events",
  "DROP TABLE IF EXISTS feedback_collection_events",
  "DROP TABLE IF EXISTS feedback_publication_items",
  "DROP TABLE IF EXISTS feedback_item_options",
  "DROP TABLE IF EXISTS feedback_item_revisions",
  "DROP TABLE IF EXISTS feedback_items",
  "DROP TABLE IF EXISTS feedback_publications",
  "DROP TABLE IF EXISTS feedback_ingest_requests",
  "DROP TABLE IF EXISTS feedback_ask_sessions",
  "DROP TABLE IF EXISTS feedback_recurring_profiles",
  "DROP TABLE IF EXISTS feedback_collections",
];
