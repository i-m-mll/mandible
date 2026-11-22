import { ledgerOriginColumnSql } from "../ledger-origin-schema.js";

const briefingOwner = `
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('briefing')),
    briefing_round_id TEXT UNIQUE REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
    CHECK(owner_kind = 'briefing' AND briefing_round_id IS id)
`;

const reviewRoundTable = (owner: string) => `CREATE TABLE review_rounds (
    id TEXT NOT NULL PRIMARY KEY,
    ${owner}
  )`;

const requestAwareOwner = `
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('briefing', 'request_revision')),
    briefing_round_id TEXT UNIQUE REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
    auth_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT,
    CHECK((owner_kind = 'briefing' AND briefing_round_id IS id AND auth_request_id IS NULL)
      OR (owner_kind = 'request_revision' AND briefing_round_id IS NULL AND auth_request_id IS NOT NULL))
`;

const roundTriggers = ['UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER review_rounds_immutable_${operation.toLowerCase()}
      BEFORE ${operation} ON review_rounds BEGIN
        SELECT RAISE(ABORT, 'Review round bindings are immutable');
      END`);

const REVIEW_ROUND_V248 = [
  reviewRoundTable(briefingOwner),
  ...roundTriggers,
  `CREATE TABLE review_document_bindings (
    id TEXT NOT NULL PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK(position >= 0),
    document_key TEXT NOT NULL CHECK(document_key != ''),
    source_json TEXT NOT NULL CHECK(json_valid(source_json) AND json_type(source_json) = 'object'),
    comparison_target_json TEXT CHECK(comparison_target_json IS NULL OR
      (json_valid(comparison_target_json) AND json_type(comparison_target_json) = 'object')),
    artifact_version_id TEXT GENERATED ALWAYS AS (
      CASE WHEN json_extract(source_json, '$.kind') = 'artifact_version'
        THEN json_extract(source_json, '$.artifact_version_id') END
    ) VIRTUAL REFERENCES artifact_version(id) ON DELETE RESTRICT,
    comparison_artifact_version_id TEXT GENERATED ALWAYS AS (
      CASE WHEN json_extract(comparison_target_json, '$.kind') = 'artifact_version'
        THEN json_extract(comparison_target_json, '$.artifact_version_id') END
    ) VIRTUAL REFERENCES artifact_version(id) ON DELETE RESTRICT,
    UNIQUE(round_id, position),
    UNIQUE(round_id, document_key),
    UNIQUE(id, round_id)
  )`,
  `CREATE INDEX idx_review_document_bindings_artifact
    ON review_document_bindings(artifact_version_id)`,
  `CREATE INDEX idx_review_document_bindings_comparison
    ON review_document_bindings(comparison_artifact_version_id)`,
  ...['review_document_bindings'].flatMap((table) =>
    ['UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER ${table}_immutable_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table} BEGIN
        SELECT RAISE(ABORT, 'Review round bindings are immutable');
      END`)),
] as const;

export const REVIEW_EVIDENCE_SCHEMA_SQL = [
  `CREATE TABLE briefing_annotation_events (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL,
    briefing_id TEXT,
    document_binding_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('set','retract')),
    annotation_kind TEXT CHECK(annotation_kind IS NULL OR annotation_kind IN ('comment','suggest_replacement')),
    start_offset INTEGER,
    end_offset INTEGER,
    quote TEXT,
    body TEXT,
    replacement_text TEXT,
    retracts_event_id TEXT,
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    ${ledgerOriginColumnSql},
    UNIQUE(id, round_id, document_binding_id, actor_user_id),
    FOREIGN KEY(round_id, briefing_id) REFERENCES briefing_rounds(id, briefing_id) ON DELETE RESTRICT,
    FOREIGN KEY(briefing_id, actor_user_id) REFERENCES briefing_members(briefing_id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY(document_binding_id, round_id) REFERENCES review_document_bindings(id, round_id) ON DELETE RESTRICT,
    FOREIGN KEY(retracts_event_id, round_id, document_binding_id, actor_user_id)
      REFERENCES briefing_annotation_events(id, round_id, document_binding_id, actor_user_id) ON DELETE RESTRICT,
    CHECK((operation = 'set' AND annotation_kind IS NOT NULL AND start_offset IS NOT NULL AND start_offset >= 0
      AND end_offset IS NOT NULL AND end_offset > start_offset AND quote IS NOT NULL AND quote != ''
      AND retracts_event_id IS NULL)
      OR (operation = 'retract' AND annotation_kind IS NULL AND start_offset IS NULL AND end_offset IS NULL
      AND quote IS NULL AND body IS NULL AND replacement_text IS NULL AND retracts_event_id IS NOT NULL)),
    CHECK(operation != 'set'
      OR (annotation_kind = 'comment' AND body IS NOT NULL AND trim(body) != '' AND replacement_text IS NULL)
      OR (annotation_kind = 'suggest_replacement' AND replacement_text IS NOT NULL AND (body IS NULL OR trim(body) != '')))
  )`,
  `CREATE UNIQUE INDEX uq_briefing_annotation_retraction
    ON briefing_annotation_events(retracts_event_id) WHERE operation = 'retract'`,
  `CREATE TRIGGER trg_briefing_annotation_retraction_identity
    BEFORE INSERT ON briefing_annotation_events WHEN NEW.operation = 'retract'
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM briefing_annotation_events target
         WHERE target.id = NEW.retracts_event_id AND target.operation = 'set'
           AND target.round_id = NEW.round_id AND target.document_binding_id = NEW.document_binding_id
           AND target.actor_user_id = NEW.actor_user_id
      ) THEN RAISE(ABORT, 'review annotation retraction target mismatch') END;
    END`,
  `CREATE INDEX idx_briefing_annotation_events_round_actor
    ON briefing_annotation_events(round_id, actor_user_id, created_at DESC)`,
  `CREATE TABLE briefing_submissions (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE RESTRICT,
    briefing_id TEXT,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    supersedes_submission_id TEXT,
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    ${ledgerOriginColumnSql},
    UNIQUE(round_id, ordinal),
    UNIQUE(id, round_id, actor_user_id),
    FOREIGN KEY(round_id, briefing_id) REFERENCES briefing_rounds(id, briefing_id) ON DELETE RESTRICT,
    FOREIGN KEY(briefing_id, actor_user_id) REFERENCES briefing_members(briefing_id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY(supersedes_submission_id, round_id, actor_user_id)
      REFERENCES briefing_submissions(id, round_id, actor_user_id) ON DELETE RESTRICT
  )`,
  `CREATE UNIQUE INDEX uq_briefing_submission_superseded_once_actor
    ON briefing_submissions(supersedes_submission_id, actor_user_id)
    WHERE supersedes_submission_id IS NOT NULL`,
  `CREATE INDEX idx_briefing_submissions_round_actor
    ON briefing_submissions(round_id, actor_user_id, ordinal DESC)`,
  ...['briefing_annotation_events', 'briefing_submissions'].flatMap((table) =>
    ['INSERT', 'UPDATE'].map((operation) => `CREATE TRIGGER ${table}_owner_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table} WHEN EXISTS (
        SELECT 1 FROM review_rounds r WHERE r.id = NEW.round_id AND r.owner_kind = 'briefing'
      ) AND NEW.briefing_id IS NULL BEGIN
        SELECT RAISE(ABORT, 'Briefing review evidence requires its owner');
      END`)),
  `CREATE TABLE briefing_submission_annotations (
    submission_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    document_binding_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    annotation_event_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(submission_id, annotation_event_id),
    FOREIGN KEY(submission_id, round_id, actor_user_id)
      REFERENCES briefing_submissions(id, round_id, actor_user_id) ON DELETE RESTRICT,
    FOREIGN KEY(annotation_event_id, round_id, document_binding_id, actor_user_id)
      REFERENCES briefing_annotation_events(id, round_id, document_binding_id, actor_user_id) ON DELETE RESTRICT
  )`,
  `CREATE TRIGGER trg_briefing_submission_annotation_set_only
    BEFORE INSERT ON briefing_submission_annotations
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM briefing_annotation_events event
         WHERE event.id = NEW.annotation_event_id AND event.operation = 'set'
           AND event.round_id = NEW.round_id AND event.document_binding_id = NEW.document_binding_id
           AND event.actor_user_id = NEW.actor_user_id
      ) THEN RAISE(ABORT, 'review frozen annotation must reference matching set event') END;
    END`,
  `CREATE TABLE review_submission_targets (
    submission_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    document_binding_id TEXT NOT NULL,
    comparison_target_json TEXT CHECK(comparison_target_json IS NULL OR
      (json_valid(comparison_target_json) AND json_type(comparison_target_json) = 'object')),
    comparison_artifact_version_id TEXT GENERATED ALWAYS AS (
      CASE WHEN json_extract(comparison_target_json, '$.kind') = 'artifact_version'
        THEN json_extract(comparison_target_json, '$.artifact_version_id') END
    ) VIRTUAL REFERENCES artifact_version(id) ON DELETE RESTRICT,
    PRIMARY KEY(submission_id, document_binding_id),
    FOREIGN KEY(submission_id, round_id, actor_user_id)
      REFERENCES briefing_submissions(id, round_id, actor_user_id) ON DELETE RESTRICT,
    FOREIGN KEY(document_binding_id, round_id)
      REFERENCES review_document_bindings(id, round_id) ON DELETE RESTRICT
  )`,
  ...['UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER review_submission_targets_immutable_${operation.toLowerCase()}
    BEFORE ${operation} ON review_submission_targets BEGIN
      SELECT RAISE(ABORT, 'Review submission targets are immutable');
    END`),
  `CREATE INDEX idx_review_submission_targets_artifact
    ON review_submission_targets(comparison_artifact_version_id)`,
] as const;

export const REVIEW_ROUND_MIGRATION_SQL = [
  ...REVIEW_ROUND_V248,
  `INSERT INTO review_rounds (id, owner_kind, briefing_round_id) SELECT id, 'briefing', id FROM briefing_rounds`,
  `INSERT INTO review_document_bindings (id, round_id, position, document_key, source_json, comparison_target_json)
    SELECT r.id, r.id, 0, r.briefing_id,
      json_object('kind', 'artifact_version', 'artifact_version_id', r.artifact_version_id),
      CASE WHEN r.comparison_base_artifact_version_id IS NOT NULL THEN
        json_object('kind', 'artifact_version', 'artifact_version_id', r.comparison_base_artifact_version_id) END
    FROM briefing_rounds r`,
  `CREATE TEMP TABLE old_review_annotations AS SELECT rowid AS original_rowid, * FROM briefing_annotation_events`,
  `CREATE TEMP TABLE old_review_submissions AS SELECT * FROM briefing_submissions`,
  `CREATE TEMP TABLE old_review_membership AS SELECT * FROM briefing_submission_annotations`,
  `DROP TABLE briefing_submission_annotations`,
  `DROP TABLE briefing_annotation_events`,
  `DROP TABLE briefing_submissions`,
  ...REVIEW_EVIDENCE_SCHEMA_SQL,
  `INSERT INTO briefing_annotation_events
    (id, round_id, briefing_id, document_binding_id, operation, annotation_kind, start_offset, end_offset,
     quote, body, replacement_text, retracts_event_id, actor_user_id, created_at, request_origin_json)
    SELECT id, round_id, briefing_id, round_id, operation, annotation_kind, start_offset, end_offset,
     quote, body, replacement_text, retracts_event_id, actor_user_id, created_at, request_origin_json
    FROM old_review_annotations ORDER BY original_rowid`,
  `INSERT INTO briefing_submissions
    (id, round_id, briefing_id, ordinal, supersedes_submission_id, actor_user_id, created_at, request_origin_json)
    SELECT id, round_id, briefing_id, ordinal, supersedes_submission_id, actor_user_id, created_at, request_origin_json
    FROM old_review_submissions`,
  `INSERT INTO briefing_submission_annotations
    (submission_id, round_id, document_binding_id, actor_user_id, annotation_event_id, position)
    SELECT submission_id, round_id, round_id, actor_user_id, annotation_event_id, position FROM old_review_membership`,
  `INSERT INTO review_submission_targets
    (submission_id, round_id, actor_user_id, document_binding_id, comparison_target_json)
    SELECT s.id, s.round_id, s.actor_user_id, b.id, b.comparison_target_json
    FROM briefing_submissions s JOIN review_document_bindings b ON b.round_id = s.round_id`,
  `DROP TABLE old_review_annotations`,
  `DROP TABLE old_review_submissions`,
  `DROP TABLE old_review_membership`,
] as const;

const requestRoundIndex = "CREATE INDEX idx_review_rounds_auth_request ON review_rounds(auth_request_id)";

export const REVIEW_ROUND_SCHEMA_SQL = [
  reviewRoundTable(requestAwareOwner),
  ...REVIEW_ROUND_V248.slice(1),
  requestRoundIndex,
];

export const REQUEST_REVIEW_ROUND_MIGRATION_SQL = [
  "CREATE TEMP TABLE old_review_rounds AS SELECT id, owner_kind, briefing_round_id FROM review_rounds",
  "DROP TABLE review_rounds",
  reviewRoundTable(requestAwareOwner),
  `INSERT INTO review_rounds (id, owner_kind, briefing_round_id)
    SELECT id, owner_kind, briefing_round_id FROM old_review_rounds`,
  "DROP TABLE old_review_rounds",
  ...roundTriggers,
  requestRoundIndex,
];
