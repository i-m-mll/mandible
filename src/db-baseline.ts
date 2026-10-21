import { SPACE_PUBLICATION_AUTH_SCHEMA_SQL } from "./spaces/publication-auth-schema.js";
import { SPACE_PUBLICATION_SCHEMA_SQL } from "./spaces/publication-schema.js";
import { CONVERSATION_RUNTIME_SCHEMA_SQL } from "./conversation-control/runtime-schema.js";
import { ARTIFACT_CUSTODY_TRIGGERS_SQL } from './artifact-custody-schema.js';
import { ARTIFACT_SOURCE_SCHEMA_SQL } from './artifact-source-schema.js';
import type { Db } from "./db.js";
import { AUTH_CLEARANCE_SCHEMA_SQL } from "./auth-clearance-schema.js";
import { CANDIDATE_ACCEPTANCE_SCHEMA_SQL } from "./candidate-acceptance-schema.js";
import { PROTECTED_BASE_AUDIT_SCHEMA_SQL } from "./protected-base-audit-schema.js";
import { ISSUE_SEARCH_SCHEMA_SQL } from "./ledger/issue-search.js";
import { BRIEFING_SCHEMA_SQL, CANONICAL_AGENT_DISPATCH_SQL, CANONICAL_SPACE_ITEMS_SQL } from "./feedback/schema.js";
import { CONVERSATION_CONTROL_SCHEMA_SQL } from "./conversation-control/schema.js";
import { CONVERSATION_SPAWN_SCHEMA_SQL } from "./conversation-spawn/schema.js";
import { TASK_ACTIVATION_SCHEMA_SQL } from "./task-activation-schema.js";
import { DOTFILES_INSTRUCTION_COMMAND, DOTFILES_INSTRUCTION_LABEL } from "./dotfiles-instruction-hook.js";

/**
 * The Mandible schema. This file is the single representation of the head shape
 * and is applied verbatim to a fresh database; `src/db-migrations.ts` carries
 * only the forward statements that move a supported existing database to the
 * same shape.
 *
 * Append a migration and update these statements in the same change.
 * `test/db-schema-baseline.test.ts` migrates the frozen floor-version fixture to
 * head and fails if the two representations disagree.
 */
export const BASELINE_SCHEMA_VERSION = 202;

// Issue 8ae6b5f — what an explicit protected-root dirty policy did before a
// merge submission: where someone's uncommitted work went. Shared by the fresh
// baseline and migration v201 so both produce identical column SQL.
export const AUTH_PROTECTED_ROOT_DIRTY_ACTION_COLUMN_SQL = `ALTER TABLE auth_requests ADD COLUMN protected_root_dirty_action_json TEXT
      CHECK(protected_root_dirty_action_json IS NULL OR (
        json_valid(protected_root_dirty_action_json)
        AND json_type(protected_root_dirty_action_json) = 'object'
      ))`;

// Issue 72b00f8 — immutable work-unit custody receipts. An agent may take over a
// unit whose holder is provably stopped (the receipt keeps that liveness
// evidence), and an operator-approved custody-transfer request names its
// request. Shared by the fresh baseline and migration v202.
export const WORK_UNIT_CUSTODY_EVENTS_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE work_unit_custody_events (
        id TEXT PRIMARY KEY,
        work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
        prior_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        prior_credential_id TEXT REFERENCES user_credentials(id) ON DELETE RESTRICT,
        new_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        new_credential_id TEXT NOT NULL REFERENCES user_credentials(id) ON DELETE RESTRICT,
        prior_generation INTEGER NOT NULL,
        new_generation INTEGER NOT NULL CHECK(new_generation = prior_generation + 1),
        authority_path TEXT NOT NULL CHECK(authority_path IN ('initial_assignment','parent_role_handoff','operator_recovery','stopped_holder_takeover','operator_approval')),
        parent_role_checkpoint_id TEXT REFERENCES ledger_issue_checkpoints(id) ON DELETE RESTRICT,
        operator_evidence_method TEXT,
        reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
        occurred_at INTEGER NOT NULL,
        auth_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT,
        prior_holder_liveness_json TEXT CHECK(prior_holder_liveness_json IS NULL OR json_valid(prior_holder_liveness_json)),
        UNIQUE(work_unit_id, new_generation),
        CHECK((authority_path = 'operator_approval') = (auth_request_id IS NOT NULL)),
        CHECK(authority_path != 'stopped_holder_takeover' OR prior_holder_liveness_json IS NOT NULL)
      )`,
  `CREATE TRIGGER work_unit_custody_events_immutable_update
        BEFORE UPDATE ON work_unit_custody_events
        BEGIN SELECT RAISE(ABORT, 'work unit custody events are immutable'); END`,
  `CREATE TRIGGER work_unit_custody_events_immutable_delete
        BEFORE DELETE ON work_unit_custody_events
        BEGIN SELECT RAISE(ABORT, 'work unit custody events are immutable'); END`,
];

export const USER_SETTINGS_SCHEMA_SQL = `CREATE TABLE user_settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL CHECK(key IN ('app_rail_order', 'ui_font_face', 'ui_font_size', 'detail_font_face', 'detail_font_size')),
        value TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, key)
      )`;

const CONVERSATION_SOURCE_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE conversation_sources (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('claude_code','codex','gemini')),
    native_session_id TEXT NOT NULL, parser_format TEXT NOT NULL, parser_version TEXT NOT NULL,
    normalization_version TEXT NOT NULL, redaction_epoch INTEGER NOT NULL DEFAULT 0 CHECK(redaction_epoch >= 0),
    availability TEXT NOT NULL DEFAULT 'unchecked' CHECK(availability IN ('available','missing','stale','unsupported','unchecked')),
    custody_state TEXT NOT NULL DEFAULT 'provider' CHECK(custody_state IN ('provider','requested','capturing','verified','mirroring','sealed','error')),
    current_version_id TEXT, unavailable_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(conversation_id, provider)
  )`,
  `CREATE INDEX idx_conversation_sources_native_session ON conversation_sources(provider, native_session_id)`,
  `CREATE INDEX idx_conversation_sources_availability ON conversation_sources(availability, custody_state)`,
  `CREATE TABLE conversation_source_aliases (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES conversation_sources(id) ON DELETE CASCADE,
    root_kind TEXT NOT NULL CHECK(root_kind IN ('provider','managed_custody')), root_path TEXT NOT NULL,
    relative_path TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    alias_kind TEXT NOT NULL CHECK(alias_kind IN ('active','archive','provider','managed')),
    availability TEXT NOT NULL DEFAULT 'unchecked' CHECK(availability IN ('available','missing','stale','unsupported','unchecked')),
    first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_conversation_source_aliases_source ON conversation_source_aliases(source_id, availability, last_seen_at DESC)`,
  `CREATE TABLE conversation_source_versions (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES conversation_sources(id) ON DELETE CASCADE,
    content_sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length >= 0), file_mtime_ms REAL,
    generation TEXT NOT NULL CHECK(generation IN ('sealed_sha256','legacy_hash')),
    parser_format TEXT NOT NULL, parser_version TEXT NOT NULL, normalization_version TEXT NOT NULL,
    redaction_epoch INTEGER NOT NULL DEFAULT 0 CHECK(redaction_epoch >= 0),
    availability TEXT NOT NULL DEFAULT 'unchecked' CHECK(availability IN ('available','missing','stale','unsupported','unchecked')),
    custody_state TEXT NOT NULL DEFAULT 'provider' CHECK(custody_state IN ('provider','requested','capturing','verified','mirroring','sealed','error')),
    custody_ref TEXT, capture_consistency TEXT,
    verification_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(verification_json)), created_at INTEGER NOT NULL,
    filesystem_device TEXT, filesystem_inode TEXT, filesystem_ctime_ns TEXT,
    UNIQUE(source_id, content_sha256)
  )`,
  `CREATE INDEX idx_conversation_source_versions_source ON conversation_source_versions(source_id, created_at DESC)`,
  `CREATE INDEX idx_conversation_source_versions_custody ON conversation_source_versions(custody_state, availability)`,
  `CREATE TABLE conversation_normalization_checkpoints (
    id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES conversation_source_versions(id) ON DELETE CASCADE,
    record_ordinal INTEGER NOT NULL, prefix_offset INTEGER NOT NULL CHECK(prefix_offset >= 0),
    parser_format TEXT NOT NULL, parser_version TEXT NOT NULL, normalization_version TEXT NOT NULL,
    redaction_epoch INTEGER NOT NULL DEFAULT 0 CHECK(redaction_epoch >= 0),
    state_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state_json)), created_at INTEGER NOT NULL,
    UNIQUE(source_version_id, record_ordinal, parser_version, normalization_version, redaction_epoch)
  )`,
  `CREATE TABLE conversation_structural_blocks (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_version_id TEXT REFERENCES conversation_source_versions(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'current' CHECK(status IN ('current','retired')), provider_key TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0), type TEXT NOT NULL, role TEXT NOT NULL, timestamp TEXT,
    parent_block_id TEXT REFERENCES conversation_structural_blocks(id) ON DELETE SET NULL,
    dag_uuid TEXT, dag_parent_uuid TEXT,
    record_offset INTEGER CHECK(record_offset IS NULL OR record_offset >= 0),
    record_length INTEGER CHECK(record_length IS NULL OR record_length >= 0), record_hash TEXT, record_ordinal INTEGER,
    sub_block_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(sub_block_ordinal >= 0),
    normalization_checkpoint_id TEXT REFERENCES conversation_normalization_checkpoints(id) ON DELETE SET NULL,
    parser_format TEXT NOT NULL, parser_version TEXT NOT NULL, normalization_version TEXT NOT NULL,
    redaction_epoch INTEGER NOT NULL DEFAULT 0 CHECK(redaction_epoch >= 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(conversation_id, provider_key)
  )`,
  `CREATE UNIQUE INDEX idx_conversation_structural_blocks_current_position ON conversation_structural_blocks(conversation_id, position) WHERE status = 'current'`,
  `CREATE INDEX idx_conversation_structural_blocks_version ON conversation_structural_blocks(source_version_id, record_offset)`,
  `CREATE INDEX idx_conversation_structural_blocks_parent ON conversation_structural_blocks(parent_block_id) WHERE parent_block_id IS NOT NULL`,
  `CREATE TABLE conversation_block_aliases (
    alias TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES conversation_structural_blocks(id) ON DELETE CASCADE,
    alias_kind TEXT NOT NULL CHECK(alias_kind IN ('legacy','provider','external')), created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_conversation_block_aliases_block ON conversation_block_aliases(block_id)`,
];

const TASK_COMMAND_REQUESTS_V2_SQL = `CREATE TABLE task_command_requests (
        id                   TEXT PRIMARY KEY,
        schema_id            TEXT NOT NULL
                             CHECK(schema_id IN ('task-command@1','task-command@2')),
        request_key          TEXT NOT NULL CHECK(trim(request_key) != ''),
        request_digest       TEXT NOT NULL
                             CHECK(length(request_digest) = 64
                               AND request_digest NOT GLOB '*[^0-9a-f]*'),
        executor_name        TEXT NOT NULL CHECK(trim(executor_name) != ''),
        task_id              TEXT NOT NULL CHECK(trim(task_id) != ''),
        verb                 TEXT NOT NULL CHECK(verb IN ('disable','dry_run','enable')),
        payload_json         TEXT NOT NULL DEFAULT '{}'
                             CHECK(json_valid(payload_json)
                               AND json_type(payload_json) = 'object'
                               AND (
                                 (schema_id = 'task-command@1'
                                   AND verb = 'disable' AND payload_json = '{}')
                                 OR
                                 (schema_id = 'task-command@2' AND (
                                   (verb = 'disable' AND payload_json = '{}')
                                   OR
                                   (verb IN ('dry_run','enable')
                                     AND json_type(payload_json, '$.execution_hash') = 'text'
                                     AND length(json_extract(payload_json, '$.execution_hash')) = 64
                                     AND json_extract(payload_json, '$.execution_hash')
                                       NOT GLOB '*[^0-9a-f]*'
                                     AND payload_json = '{"execution_hash":"'
                                       || json_extract(payload_json, '$.execution_hash') || '"}')
                                 ))
                               )),
        requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        requested_at         INTEGER NOT NULL,
        UNIQUE(requested_by_user_id, request_key)
      )`;

const TASK_COMMAND_EVENTS_V2_SQL = `CREATE TABLE task_command_events (
        id               TEXT PRIMARY KEY,
        command_id       TEXT NOT NULL
                         REFERENCES task_command_requests(id) ON DELETE RESTRICT,
        schema_id        TEXT NOT NULL
                         CHECK(schema_id IN ('task-command-event@1','task-command-event@2')),
        event_ordinal    INTEGER NOT NULL CHECK(event_ordinal BETWEEN 0 AND 8),
        event_digest     TEXT NOT NULL
                         CHECK(length(event_digest) = 64
                           AND event_digest NOT GLOB '*[^0-9a-f]*'),
        event_type       TEXT NOT NULL
                         CHECK(event_type IN (
                           'accepted','started','progress','applied','rejected','cancelled'
                         )),
        payload_json     TEXT NOT NULL DEFAULT '{}'
                         CHECK(json_valid(payload_json)
                           AND json_type(payload_json) = 'object'),
        no_op            INTEGER CHECK(no_op IS NULL OR no_op IN (0,1)),
        rejection_reason TEXT CHECK(rejection_reason IS NULL OR rejection_reason IN (
                           'unknown_task','unsupported_verb','invalid_payload','stale_target',
                           'busy','missing_receipt','stale_receipt','policy_refused',
                           'dry_run_failed','unknown'
                         )),
        actor_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at       INTEGER NOT NULL,
        UNIQUE(command_id, event_ordinal),
        UNIQUE(command_id, event_digest),
        CHECK (
          (event_type = 'accepted' AND event_ordinal = 0)
          OR (event_type = 'started' AND event_ordinal = 1)
          OR (event_type = 'progress' AND event_ordinal BETWEEN 2 AND 7)
          OR (event_type IN ('applied','rejected','cancelled') AND event_ordinal = 8)
        ),
        CHECK (schema_id = 'task-command-event@2'
          OR event_type IN ('accepted','applied','rejected','cancelled')),
        CHECK (
          (event_type IN ('accepted','cancelled')
            AND payload_json = '{}' AND no_op IS NULL AND rejection_reason IS NULL)
          OR (event_type IN ('started','progress')
            AND no_op IS NULL AND rejection_reason IS NULL)
          OR (event_type = 'applied' AND rejection_reason IS NULL)
          OR (event_type = 'rejected' AND no_op IS NULL AND rejection_reason IS NOT NULL)
        )
      )`;

const TASK_COMMAND_V2_INDEX_SQL: readonly string[] = [
  `CREATE INDEX idx_task_command_requests_target
        ON task_command_requests(executor_name, task_id, requested_at DESC)`,
  `CREATE UNIQUE INDEX uq_task_command_events_accepted
        ON task_command_events(command_id) WHERE event_type = 'accepted'`,
  `CREATE UNIQUE INDEX uq_task_command_events_started
        ON task_command_events(command_id) WHERE event_type = 'started'`,
  `CREATE UNIQUE INDEX uq_task_command_events_terminal
        ON task_command_events(command_id)
        WHERE event_type IN ('applied','rejected','cancelled')`,
  `CREATE INDEX idx_task_command_events_command
        ON task_command_events(command_id, event_ordinal)`,
];

const HEAD_SCHEMA_STATEMENTS: readonly string[] = [
  "CREATE TABLE artifact (\n        id                TEXT PRIMARY KEY,\n        identity_key      TEXT NOT NULL,\n        source_kind       TEXT NOT NULL DEFAULT 'managed'\n          CHECK(source_kind IN ('tracked_repo','local_only','managed','external','mixed')),\n        title             TEXT,\n        source_project_id TEXT REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        logical_name      TEXT,\n        latest_version_id TEXT,\n        version_count     INTEGER NOT NULL DEFAULT 0,\n        metadata_json     TEXT NOT NULL DEFAULT '{}',\n        created_at        INTEGER NOT NULL,\n        updated_at        INTEGER NOT NULL,\n        UNIQUE(identity_key)\n      )",
  "CREATE TABLE \"artifact_aliases\" (\n          id                TEXT PRIMARY KEY,\n          blob_id           TEXT REFERENCES artifact_blob(id) ON DELETE RESTRICT,\n          scheme            TEXT NOT NULL,\n          alias             TEXT NOT NULL,\n          normalized_ref    TEXT NOT NULL,\n          locator_json      TEXT NOT NULL DEFAULT '{}',\n          resolution_status TEXT NOT NULL DEFAULT 'resolved'\n            CHECK(resolution_status IN ('resolved','unresolved','ambiguous','unsupported')),\n          source            TEXT NOT NULL DEFAULT 'artifact_registry',\n          created_at        INTEGER NOT NULL,\n          updated_at        INTEGER NOT NULL,\n          CHECK (\n            (resolution_status = 'resolved' AND blob_id IS NOT NULL) OR\n            (resolution_status != 'resolved' AND blob_id IS NULL)\n          )\n        )",
  "CREATE TABLE \"artifact_blob\" (\n        id             TEXT PRIMARY KEY,\n        algorithm      TEXT NOT NULL DEFAULT 'sha256' CHECK(algorithm='sha256'),\n        content_hash   TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),\n        storage_uri    TEXT,\n        media_type     TEXT,\n        role           TEXT,\n        size_bytes     INTEGER NOT NULL DEFAULT 0,\n        provider_id    TEXT,\n        manifest_id    TEXT,\n        metadata_json  TEXT NOT NULL DEFAULT '{}',\n        created_at     INTEGER NOT NULL,\n        UNIQUE(algorithm, content_hash)\n      )",
  "CREATE TABLE \"artifact_drafts\" (\n          id              TEXT PRIMARY KEY,\n          artifact_id     TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,\n          version_id      TEXT NOT NULL REFERENCES artifact_version(id) ON DELETE RESTRICT,\n          content         TEXT NOT NULL,\n          media_type      TEXT,\n          label           TEXT,\n          note            TEXT,\n          metadata_json   TEXT NOT NULL DEFAULT '{}',\n          created_at      INTEGER NOT NULL,\n          updated_at      INTEGER NOT NULL,\n          UNIQUE(artifact_id)\n        )",
  "CREATE TABLE \"artifact_links\" (\n          id                  TEXT PRIMARY KEY,\n          blob_id             TEXT NOT NULL REFERENCES artifact_blob(id) ON DELETE RESTRICT,\n          entity_type         TEXT NOT NULL,\n          entity_id           TEXT NOT NULL,\n          link_type           TEXT NOT NULL DEFAULT 'references',\n          role                TEXT,\n          repo_id             TEXT,\n          provider_id         TEXT,\n          source              TEXT NOT NULL DEFAULT 'artifact_registry',\n          metadata_json       TEXT NOT NULL DEFAULT '{}',\n          created_at          INTEGER NOT NULL,\n          updated_at          INTEGER NOT NULL,\n          link_kind           TEXT NOT NULL DEFAULT 'pinned'\n            CHECK(link_kind IN ('pinned','living')),\n          series_ref          TEXT,\n          target_type         TEXT NOT NULL\n            CHECK(target_type IN ('artifact','artifact_version','artifact_blob')),\n          target_id           TEXT NOT NULL,\n          fallback_version_id TEXT REFERENCES artifact_version(id) ON DELETE RESTRICT,\n          CHECK (\n            (link_kind = 'living' AND target_type = 'artifact') OR\n            (link_kind = 'pinned' AND target_type IN ('artifact_version','artifact_blob'))\n          )\n        )",
  "CREATE TABLE \"artifact_version\" (\n        id                  TEXT PRIMARY KEY,\n        artifact_id         TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,\n        version_no          INTEGER NOT NULL,\n        blob_id             TEXT NOT NULL REFERENCES artifact_blob(id) ON DELETE RESTRICT,\n        source_kind         TEXT NOT NULL\n          CHECK(source_kind IN ('tracked_repo','local_only','managed')),\n        content_hash        TEXT NOT NULL,\n        source_project_id   TEXT REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        repo_path           TEXT,\n        commit_sha          TEXT,\n        observed_path       TEXT,\n        parent_version_id   TEXT REFERENCES artifact_version(id) ON DELETE SET NULL,\n        custody_mode        TEXT NOT NULL CHECK(custody_mode IN ('git','managed')),\n        label               TEXT,\n        note                TEXT,\n        metadata_json       TEXT NOT NULL DEFAULT '{}',\n        created_at          INTEGER NOT NULL,\n        CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),\n        CHECK((custody_mode='git' AND source_project_id IS NOT NULL AND repo_path IS NOT NULL AND length(repo_path)>0 AND commit_sha IS NOT NULL AND length(commit_sha) IN (40,64) AND commit_sha NOT GLOB '*[^a-f0-9]*') OR (custody_mode='managed' AND source_project_id IS NULL AND repo_path IS NULL AND commit_sha IS NULL)),\n        UNIQUE(artifact_id, version_no)\n      )",
  "CREATE TABLE attribution_evidence (\n        id              TEXT PRIMARY KEY,\n        evidence_method TEXT NOT NULL,\n        credential_id   TEXT REFERENCES user_credentials(id) ON DELETE SET NULL,\n        lease_id        TEXT REFERENCES delegated_signing_leases(id) ON DELETE SET NULL,\n        verified_at     INTEGER NOT NULL,\n        details_json    TEXT NOT NULL DEFAULT '{}'\n                          CHECK(json_valid(details_json) AND json_type(details_json)='object')\n      )",
  "CREATE TABLE auth_hooks (\n        id            TEXT PRIMARY KEY,\n        repo_pattern  TEXT NOT NULL DEFAULT '*',\n        auth_type     TEXT NOT NULL DEFAULT 'merge',\n        command       TEXT NOT NULL,\n        label         TEXT NOT NULL DEFAULT '',\n        enabled       INTEGER NOT NULL DEFAULT 1,\n        builtin       INTEGER NOT NULL DEFAULT 0,\n        position      INTEGER NOT NULL DEFAULT 0,\n        created_at    INTEGER NOT NULL,\n        updated_at    INTEGER NOT NULL\n      , required INTEGER NOT NULL DEFAULT 1)",
  "CREATE TABLE auth_hook_alerts (\n        id                TEXT PRIMARY KEY,\n        auth_request_id   TEXT NOT NULL,\n        hook_id           TEXT NOT NULL,\n        hook_label        TEXT NOT NULL DEFAULT '',\n        session_id        TEXT,\n        repo              TEXT,\n        detail            TEXT NOT NULL DEFAULT '',\n        created_at        INTEGER NOT NULL,\n        updated_at        INTEGER NOT NULL,\n        acknowledged_at   INTEGER,\n        acknowledged_by   TEXT,\n        UNIQUE(auth_request_id, hook_id)\n      )",
  "CREATE TABLE auth_hook_executions (\n        id                TEXT PRIMARY KEY,\n        auth_request_id   TEXT NOT NULL,\n        hook_id           TEXT NOT NULL,\n        hook_label        TEXT NOT NULL DEFAULT '',\n        command           TEXT NOT NULL,\n        command_digest    TEXT NOT NULL CHECK(length(command_digest) = 64),\n        position          INTEGER NOT NULL DEFAULT 0,\n        required          INTEGER NOT NULL DEFAULT 1,\n        state             TEXT NOT NULL DEFAULT 'pending'\n                          CHECK(state IN ('pending','running','complete','failed')),\n        attempts          INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),\n        max_attempts      INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts >= 1),\n        exit_code         INTEGER,\n        output            TEXT NOT NULL DEFAULT '',\n        attempt_history   TEXT NOT NULL DEFAULT '[]',\n        started_at        INTEGER,\n        finished_at       INTEGER,\n        created_at        INTEGER NOT NULL,\n        updated_at        INTEGER NOT NULL,\n        UNIQUE(auth_request_id, hook_id)\n      )",
  "CREATE TABLE \"auth_request_actions\" (\n        id TEXT PRIMARY KEY,\n        auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE CASCADE,\n        ordinal INTEGER NOT NULL,\n        kind TEXT NOT NULL CHECK(kind IN ('comment_add','issue_close','worker_status_set','label_add','label_rm','checkpoint_add','link_add','briefing_group_promote')),\n        target_issue_ref TEXT NOT NULL,\n        payload TEXT NOT NULL,\n        state TEXT NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','applied','failed','vetoed','skipped_stale')),\n        target_digest TEXT,\n        staged_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        applied_at INTEGER,\n        outcome_detail TEXT\n      )",
  "CREATE TABLE auth_requests (\n  id            TEXT PRIMARY KEY,\n  session_id    TEXT,\n  command       TEXT NOT NULL,\n  title         TEXT NOT NULL,\n  cwd           TEXT,\n  diff_summary  TEXT,\n  spec_content  TEXT,\n  status        TEXT NOT NULL DEFAULT 'pending',\n  created_at    INTEGER NOT NULL,\n  updated_at    INTEGER NOT NULL,\n  approved_at   INTEGER,\n  resolved_at   INTEGER,\n  skipped_at    INTEGER,\n  expires_at    INTEGER NOT NULL,\n  exit_code     INTEGER,\n  output        TEXT NOT NULL DEFAULT '',\n  error         TEXT\n, repo TEXT, base_branch TEXT, head_branch TEXT, files_changed INTEGER DEFAULT 0, additions INTEGER DEFAULT 0, deletions INTEGER DEFAULT 0, execution_mode TEXT NOT NULL DEFAULT 'daemon', commit_message TEXT, last_executed_at INTEGER, acknowledged_by TEXT, post_merge_handoff TEXT, issue_ids TEXT, depends_on_id TEXT, issues TEXT, type TEXT NOT NULL DEFAULT 'merge', target_session_id TEXT, target_repo_root TEXT, delivered_at INTEGER, conversation_id TEXT, approval_source TEXT NOT NULL DEFAULT 'manual', approval_lease_id TEXT, issue_references TEXT, issue_closures TEXT, merge_preflight_base_sha TEXT, merge_preflight_queue_fingerprint TEXT, merge_head_sha TEXT, merge_finalized_at INTEGER, requested_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, approved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, execution_evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL, merge_finalizer_state TEXT, merge_candidate_tree_sha TEXT, merge_candidate_pin_sha TEXT, merge_atomic_enabled INTEGER NOT NULL DEFAULT 0, commit_message_digest TEXT, supersedes_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT, superseded_by_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT)",
  "CREATE TABLE auth_request_lifecycle_events (\n        id TEXT PRIMARY KEY,\n        auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE RESTRICT,\n        revision INTEGER NOT NULL CHECK(revision >= 1),\n        event_type TEXT NOT NULL CHECK(event_type IN ('legacy_snapshot','submitted','revised','approved','executing','rejected','withdrawn','superseded','needs_rebase','expired','completed')),\n        prior_status TEXT,\n        next_status TEXT NOT NULL,\n        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),\n        snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),\n        prior_snapshot_json TEXT CHECK(prior_snapshot_json IS NULL OR json_valid(prior_snapshot_json)),\n        prior_snapshot_sha256 TEXT CHECK(prior_snapshot_sha256 IS NULL OR length(prior_snapshot_sha256) = 64),\n        actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,\n        evidence_method TEXT,\n        evidence_id TEXT,\n        credential_id TEXT REFERENCES user_credentials(id) ON DELETE RESTRICT,\n        reason TEXT,\n        related_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT,\n        custody_work_unit_id TEXT REFERENCES work_units(id) ON DELETE RESTRICT,\n        custody_generation INTEGER,\n        authority_path TEXT CHECK(authority_path IN ('custodian','operator_recovery','system','legacy')),\n        occurred_at INTEGER NOT NULL,\n        UNIQUE(auth_request_id, revision)\n      )",
  "CREATE INDEX idx_auth_request_lifecycle_events_request ON auth_request_lifecycle_events(auth_request_id, revision)",
  "CREATE TRIGGER auth_request_lifecycle_events_immutable_update BEFORE UPDATE ON auth_request_lifecycle_events BEGIN SELECT RAISE(ABORT, 'auth request lifecycle events are immutable'); END",
  "CREATE TRIGGER auth_request_lifecycle_events_immutable_delete BEFORE DELETE ON auth_request_lifecycle_events BEGIN SELECT RAISE(ABORT, 'auth request lifecycle events are immutable'); END",
  ...WORK_UNIT_CUSTODY_EVENTS_SCHEMA_SQL,
  "CREATE TABLE auth_request_merge_succeeded_facts (\n        auth_request_id   TEXT PRIMARY KEY,\n        project_id        TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        base_branch       TEXT NOT NULL,\n        completed_at      INTEGER NOT NULL,\n        canonical_message INTEGER NOT NULL CHECK(canonical_message IN (0,1)),\n        recorded_at       INTEGER NOT NULL\n      )",
  "CREATE TABLE branches (\n  repo_root     TEXT NOT NULL,\n  branch        TEXT NOT NULL,\n  is_current    INTEGER NOT NULL DEFAULT 0,\n  is_worktree   INTEGER DEFAULT 0,\n  worktree_path TEXT,\n  is_dirty      INTEGER DEFAULT 0,\n  ahead         INTEGER DEFAULT 0,\n  behind        INTEGER DEFAULT 0,\n  last_commit_hash    TEXT,\n  last_commit_message TEXT,\n  last_commit_author  TEXT,\n  last_commit_date    TEXT,\n  diff_stat     TEXT,\n  updated_at    TEXT NOT NULL DEFAULT (datetime('now')), ahead_default INTEGER DEFAULT 0, behind_default INTEGER DEFAULT 0, default_branch TEXT DEFAULT '', worktree_inventory_known INTEGER NOT NULL DEFAULT 0, worktree_status_known INTEGER NOT NULL DEFAULT 0, default_comparison_known INTEGER NOT NULL DEFAULT 0, has_upstream INTEGER NOT NULL DEFAULT 0, upstream TEXT,\n  PRIMARY KEY (repo_root, branch)\n)",
  "CREATE TABLE console_session_telemetry (\n        telemetry_key TEXT PRIMARY KEY,\n        console_session_id TEXT REFERENCES console_sessions(id) ON DELETE CASCADE,\n        provider_session_id TEXT,\n        transcript_path TEXT,\n        model TEXT,\n        context_used_percentage REAL,\n        context_window_size INTEGER,\n        context_input_tokens INTEGER,\n        context_output_tokens INTEGER,\n        context_cache_creation_input_tokens INTEGER,\n        context_cache_read_input_tokens INTEGER,\n        rate_limit_five_hour_used_percentage REAL,\n        rate_limit_five_hour_resets_at TEXT,\n        rate_limit_seven_day_used_percentage REAL,\n        rate_limit_seven_day_resets_at TEXT,\n        raw_payload_json TEXT NOT NULL,\n        received_at INTEGER NOT NULL\n      )",
  "CREATE TABLE console_session_usage (\n        id                            TEXT PRIMARY KEY,\n        console_session_id            TEXT NOT NULL,\n        provider_session_id           TEXT,\n        recorded_at                   INTEGER NOT NULL,\n        input_tokens                  INTEGER NOT NULL DEFAULT 0,\n        cache_creation_input_tokens   INTEGER NOT NULL DEFAULT 0,\n        cache_read_input_tokens       INTEGER NOT NULL DEFAULT 0,\n        output_tokens                 INTEGER NOT NULL DEFAULT 0,\n        web_search_requests           INTEGER NOT NULL DEFAULT 0,\n        cost_usd                      REAL NOT NULL DEFAULT 0,\n        total_cost_usd                REAL NOT NULL DEFAULT 0,\n        duration_ms                   INTEGER NOT NULL DEFAULT 0,\n        num_turns                     INTEGER NOT NULL DEFAULT 0,\n        is_error                      INTEGER NOT NULL DEFAULT 0,\n        result_subtype                TEXT,\n        usage_json                    TEXT NOT NULL DEFAULT '{}',\n        model_usage_json              TEXT NOT NULL DEFAULT '{}',\n        errors_json                   TEXT NOT NULL DEFAULT '[]',\n        FOREIGN KEY (console_session_id) REFERENCES console_sessions(id) ON DELETE CASCADE\n      )",
  "CREATE TABLE console_sessions (\n        id            TEXT PRIMARY KEY,\n        label         TEXT NOT NULL,\n        command       TEXT NOT NULL,\n        args_json     TEXT NOT NULL DEFAULT '[]',\n        cwd           TEXT,\n        env_json      TEXT NOT NULL DEFAULT '{}',\n        cols          INTEGER NOT NULL DEFAULT 120,\n        rows          INTEGER NOT NULL DEFAULT 30,\n        status        TEXT NOT NULL DEFAULT 'stopped',\n        pid           INTEGER,\n        exit_code     INTEGER,\n        auto_restart  INTEGER NOT NULL DEFAULT 0,\n        is_operator   INTEGER NOT NULL DEFAULT 0,\n        interaction_mode TEXT NOT NULL DEFAULT 'both',\n        created_at    INTEGER NOT NULL,\n        updated_at    INTEGER NOT NULL,\n        started_at    INTEGER,\n        stopped_at    INTEGER\n      , provider_session_id TEXT, backend_type TEXT NOT NULL DEFAULT 'pty', allowed_tools TEXT, mandible_session_id TEXT, resume_at_message TEXT, channel_enabled INTEGER NOT NULL DEFAULT 0, transport_lane TEXT NOT NULL DEFAULT 'pty', owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, run_options_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(run_options_json) AND json_type(run_options_json) = 'object'))",
  "CREATE TABLE conversation_blocks (\n        id TEXT PRIMARY KEY,\n        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,\n        type TEXT NOT NULL,\n        role TEXT NOT NULL,\n        content TEXT NOT NULL DEFAULT '',\n        position INTEGER NOT NULL,\n        timestamp TEXT,\n        parent_id TEXT,\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        dag_uuid TEXT,\n        dag_parent_uuid TEXT, compressed INTEGER NOT NULL DEFAULT 0, timestamp_ms INTEGER, payload_state TEXT NOT NULL DEFAULT 'legacy' CHECK(payload_state IN ('legacy','source')),\n        UNIQUE(conversation_id, position)\n      )",
  "CREATE TABLE conversation_ingest_state (\n        file_path TEXT PRIMARY KEY,\n        byte_offset INTEGER NOT NULL DEFAULT 0,\n        line_count INTEGER NOT NULL DEFAULT 0,\n        tail_hash TEXT NOT NULL DEFAULT '',\n        partial_line TEXT NOT NULL DEFAULT '',\n        updated_at INTEGER NOT NULL\n      , empty_source_mtime REAL, empty_source_size INTEGER)",
  "CREATE TABLE conversations (\n        id TEXT PRIMARY KEY,\n        source TEXT NOT NULL CHECK(source IN ('claude_code', 'codex', 'gemini')),\n        source_path TEXT NOT NULL,\n        source_hash TEXT NOT NULL,\n        source_mtime INTEGER NOT NULL,\n        title TEXT NOT NULL DEFAULT '',\n        summary TEXT,\n        started_at TEXT NOT NULL,\n        ended_at TEXT,\n        block_count INTEGER NOT NULL DEFAULT 0,\n        session_id TEXT NOT NULL,\n        project_path TEXT,\n        cwd TEXT,\n        branch TEXT,\n        model TEXT,\n        cli_version TEXT,\n        starred INTEGER NOT NULL DEFAULT 0,\n        notes TEXT,\n        created_at TEXT NOT NULL DEFAULT (datetime('now')),\n        updated_at TEXT NOT NULL DEFAULT (datetime('now'))\n      , parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL, is_sidechain INTEGER NOT NULL DEFAULT 0, agent_id TEXT, started_at_ms INTEGER, ended_at_ms INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'))",
  "CREATE TABLE conversation_archive_states (\n        conversation_id TEXT PRIMARY KEY,\n        archived_at INTEGER NOT NULL CHECK(archived_at > 0)\n      )",
  ...CONVERSATION_CONTROL_SCHEMA_SQL,
  ...CONVERSATION_RUNTIME_SCHEMA_SQL,
  `CREATE TABLE chat_attachment_files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length > 0),
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ...CONVERSATION_SPAWN_SCHEMA_SQL,
  "CREATE TABLE daemon_log (\n        id              TEXT PRIMARY KEY,\n        ts              INTEGER NOT NULL,\n        level           TEXT NOT NULL CHECK(level IN ('debug','info','warn','error')),\n        event           TEXT NOT NULL,\n        subsystem       TEXT NOT NULL DEFAULT 'daemon',\n        fields_json     TEXT NOT NULL DEFAULT '{}',\n        issue_id        TEXT,\n        auth_request_id TEXT,\n        artifact_id     TEXT,\n        session_id      TEXT,\n        repo_id         TEXT\n      )",
  "CREATE TABLE delegated_signing_leases (\n        id            TEXT PRIMARY KEY,\n        credential_id TEXT NOT NULL REFERENCES user_credentials(id) ON DELETE RESTRICT,\n        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,\n        minted_at     INTEGER NOT NULL,\n        expires_at    INTEGER NOT NULL,\n        mint_method   TEXT NOT NULL\n                        CHECK(mint_method IN ('fresh_presence','reused_lease'))\n      )",
  "CREATE TABLE graph_edges (\n        id            TEXT PRIMARY KEY,\n        source_id     TEXT NOT NULL,\n        target_id     TEXT NOT NULL,\n        edge_type     TEXT NOT NULL,\n        edge_class    TEXT NOT NULL DEFAULT 'provenance',\n        provenance    TEXT NOT NULL DEFAULT 'system',\n        confidence    TEXT NOT NULL DEFAULT 'observed',\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        created_at    INTEGER,\n        observed_at   INTEGER NOT NULL,\n        source        TEXT NOT NULL\n      )",
  "CREATE TABLE graph_entities (\n        id                  TEXT PRIMARY KEY,\n        entity_type         TEXT NOT NULL,\n        repo_id             TEXT,\n        provider_id         TEXT,\n        external_id         TEXT,\n        title               TEXT NOT NULL,\n        status              TEXT,\n        labels_json         TEXT NOT NULL DEFAULT '[]',\n        summary_json        TEXT NOT NULL DEFAULT '{}',\n        detail_ref_json     TEXT NOT NULL DEFAULT '{}',\n        action_context_json TEXT NOT NULL DEFAULT '{}',\n        visual_json         TEXT NOT NULL DEFAULT '{}',\n        created_at          INTEGER,\n        updated_at          INTEGER,\n        observed_at         INTEGER NOT NULL,\n        source              TEXT NOT NULL\n      )",
  "CREATE TABLE issue_branches (\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        branch TEXT NOT NULL,\n        role TEXT NOT NULL DEFAULT 'primary'\n          CHECK(role IN ('primary','superseded')),\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        PRIMARY KEY (issue_id, branch)\n      )",
  "CREATE TABLE issue_resolutions (\n        issue_id    TEXT NOT NULL,\n        commit_sha  TEXT NOT NULL,\n        repo_id     TEXT NOT NULL,\n        resolved_at INTEGER NOT NULL,\n        PRIMARY KEY (issue_id, commit_sha)\n      )",
  "CREATE TABLE knowledge_backrefs (\n        id            TEXT PRIMARY KEY,\n        source_type   TEXT NOT NULL CHECK(source_type IN ('artifact','document')),\n        source_id     TEXT NOT NULL,\n        provider_id   TEXT NOT NULL DEFAULT 'humbleb',\n        ref_type      TEXT NOT NULL CHECK(ref_type IN ('document','entity','claim')),\n        external_id   TEXT NOT NULL,\n        external_ref  TEXT NOT NULL,\n        status        TEXT NOT NULL DEFAULT 'returned'\n          CHECK(status IN ('offered','indexed','returned')),\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        created_at    INTEGER NOT NULL,\n        updated_at    INTEGER NOT NULL,\n        UNIQUE(source_type, source_id, provider_id, ref_type, external_id)\n      )",
  "CREATE TABLE ledger_auth_issue_links (\n        auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE CASCADE,\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE RESTRICT,\n        link_type TEXT NOT NULL DEFAULT 'references',\n        source TEXT NOT NULL DEFAULT 'auth_queue',\n        created_at INTEGER NOT NULL,\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        PRIMARY KEY (auth_request_id, issue_id, link_type)\n      )",
  "CREATE TABLE ledger_body_revisions (\n        id TEXT PRIMARY KEY,\n        entity_type TEXT NOT NULL CHECK(entity_type IN ('issue_body','issue_work_notes','comment_body')),\n        entity_id TEXT NOT NULL,\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        revision_no INTEGER NOT NULL,\n        event_id TEXT UNIQUE REFERENCES ledger_events(id) ON DELETE SET NULL,\n        actor_id TEXT,\n        actor_type TEXT NOT NULL CHECK(actor_type IN ('mandible_user','agent','system','external_adapter')),\n        source TEXT NOT NULL CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),\n        reason TEXT NOT NULL DEFAULT 'edit'\n          CHECK(reason IN ('create','edit','import_snapshot','external_update','normalize','migration_snapshot','restore')),\n        occurred_at INTEGER NOT NULL,\n        observed_at INTEGER NOT NULL,\n        base_revision_id TEXT REFERENCES ledger_body_revisions(id) ON DELETE SET NULL,\n        base_hash TEXT,\n        new_hash TEXT NOT NULL,\n        snapshot_body TEXT NOT NULL,\n        patch_format TEXT,\n        patch_text TEXT,\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        redacted_at INTEGER,\n        redacted_by_actor_id TEXT,\n        redaction_reason TEXT, actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, evidence_method TEXT, evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL, redacted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,\n        UNIQUE(entity_type, entity_id, revision_no)\n      )",
  "CREATE TABLE ledger_comments (\n        id TEXT PRIMARY KEY,\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        ordinal INTEGER NOT NULL DEFAULT 0,\n        body TEXT NOT NULL,\n        author_actor_id TEXT,\n        author_actor_type TEXT NOT NULL\n          CHECK(author_actor_type IN ('mandible_user','agent','system','external_adapter')),\n        author_display TEXT NOT NULL DEFAULT '',\n        source TEXT NOT NULL\n          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER,\n        deleted_at INTEGER\n      , author_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, evidence_method TEXT, evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL)",
  "CREATE TABLE ledger_change_feed_state (\n        project_id TEXT PRIMARY KEY REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence >= 1),\n        retained_from_sequence INTEGER NOT NULL DEFAULT 1 CHECK(retained_from_sequence >= 1),\n        updated_at INTEGER NOT NULL,\n        CHECK(retained_from_sequence <= next_sequence)\n      )",
  "CREATE TABLE ledger_change_log (\n        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        sequence INTEGER NOT NULL CHECK(sequence >= 1),\n        event_id TEXT NOT NULL UNIQUE,\n        recorded_at INTEGER NOT NULL,\n        PRIMARY KEY(project_id, sequence)\n      )",
  "CREATE TABLE ledger_commit_issue_links (\n        commit_sha TEXT NOT NULL,\n        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE RESTRICT,\n        link_type TEXT NOT NULL DEFAULT 'fixed_by',\n        source TEXT NOT NULL DEFAULT 'auth_queue',\n        created_at INTEGER NOT NULL,\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        PRIMARY KEY (commit_sha, issue_id, link_type)\n      )",
  "CREATE TABLE ledger_events (\n        id TEXT PRIMARY KEY,\n        entity_type TEXT NOT NULL,\n        entity_id TEXT NOT NULL,\n        event_type TEXT NOT NULL,\n        actor_id TEXT,\n        actor_type TEXT NOT NULL\n          CHECK(actor_type IN ('mandible_user','agent','system','external_adapter')),\n        source TEXT NOT NULL\n          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),\n        payload_json TEXT NOT NULL DEFAULT '{}',\n        occurred_at INTEGER NOT NULL,\n        observed_at INTEGER NOT NULL\n      , actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, evidence_method TEXT, evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL)",
  "CREATE TABLE ledger_issue_aliases (\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        alias_kind TEXT NOT NULL,\n        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE CASCADE,\n        alias TEXT NOT NULL,\n        external_id TEXT NOT NULL DEFAULT '',\n        source TEXT NOT NULL,\n        is_primary INTEGER NOT NULL DEFAULT 0,\n        created_at INTEGER NOT NULL,\n        PRIMARY KEY (alias_kind, project_id, alias)\n      )",
  "CREATE TABLE ledger_issue_checkpoints (\n        id TEXT PRIMARY KEY,\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        kind TEXT NOT NULL,\n        payload_json TEXT NOT NULL,\n        author_actor_id TEXT,\n        author_actor_type TEXT NOT NULL CHECK(author_actor_type IN ('mandible_user','agent','system','external_adapter')),\n        author_display TEXT NOT NULL DEFAULT '',\n        source TEXT NOT NULL CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),\n        created_at INTEGER NOT NULL\n      , author_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, evidence_method TEXT, evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL)",
  "CREATE TABLE ledger_issue_relationship_sources (\n          id TEXT PRIMARY KEY,\n          relationship_id TEXT NOT NULL REFERENCES ledger_issue_relationships(id) ON DELETE CASCADE,\n          source_entity_type TEXT NOT NULL CHECK(source_entity_type IN ('issue_body','comment')),\n          source_entity_id TEXT NOT NULL,\n          source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n          target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n          relationship_type TEXT NOT NULL\n            CHECK(relationship_type IN ('parent_child','blocks','duplicate_of','related','references','fixed_by','caused_by','implements','tests')),\n          ref_kind TEXT NOT NULL CHECK(ref_kind IN ('issue','comment')),\n          raw_ref TEXT NOT NULL,\n          normalized_ref TEXT NOT NULL,\n          metadata_json TEXT NOT NULL DEFAULT '{}',\n          created_at INTEGER NOT NULL,\n          updated_at INTEGER NOT NULL,\n          deleted_at INTEGER,\n          UNIQUE(source_entity_type, source_entity_id, target_issue_id, relationship_type, ref_kind, normalized_ref)\n        )",
  "CREATE TABLE ledger_issue_relationships (\n        id TEXT PRIMARY KEY,\n        source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        relationship_type TEXT NOT NULL\n          CHECK(relationship_type IN ('parent_child','blocks','duplicate_of','related','references','fixed_by','caused_by','implements','tests')),\n        provenance TEXT NOT NULL DEFAULT 'manual'\n          CHECK(provenance IN ('manual','imported','derived','system')),\n        confidence TEXT NOT NULL DEFAULT 'observed',\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        deleted_at INTEGER,\n        UNIQUE(source_issue_id, target_issue_id, relationship_type)\n      )",
  "CREATE TABLE ledger_issues (\n        id TEXT PRIMARY KEY,\n        short_id TEXT NOT NULL DEFAULT '',\n        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        title TEXT NOT NULL,\n        body TEXT NOT NULL DEFAULT '',\n        work_notes TEXT NOT NULL DEFAULT '',\n        status TEXT NOT NULL CHECK(status IN ('open','closed')),\n        resolution TEXT CHECK(resolution IN ('delivered','duplicate','wontfix') OR resolution IS NULL),\n        kind TEXT NOT NULL DEFAULT 'unknown'\n          CHECK(kind IN ('bug','feature','maintenance','experiment','tracker','umbrella','unknown')),\n        priority TEXT NOT NULL DEFAULT 'normal'\n          CHECK(priority IN ('low','normal','high','urgent')),\n        author_actor_id TEXT,\n        author_actor_type TEXT NOT NULL DEFAULT 'external_adapter'\n          CHECK(author_actor_type IN ('mandible_user','agent','system','external_adapter')),\n        author_display TEXT NOT NULL DEFAULT '',\n        source TEXT NOT NULL DEFAULT 'mandible'\n          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        closed_at INTEGER,\n        deleted_at INTEGER\n      , worker_status TEXT NOT NULL DEFAULT 'none'\n        CHECK(worker_status IN ('none','in_progress','done','blocked','pivot-needed')), author_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, evidence_method TEXT, evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL,\n        CHECK((status = 'open' AND resolution IS NULL) OR (status = 'closed' AND resolution IS NOT NULL)))",
  "CREATE TABLE ledger_labels (\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        label TEXT NOT NULL,\n        source TEXT NOT NULL DEFAULT 'mandible',\n        created_at INTEGER NOT NULL,\n        deleted_at INTEGER,\n        PRIMARY KEY (issue_id, label)\n      )",
  "CREATE TABLE ledger_operational_link_mismatches (\n        id TEXT PRIMARY KEY,\n        report_id TEXT NOT NULL REFERENCES ledger_operational_link_reports(id) ON DELETE CASCADE,\n        source_table TEXT NOT NULL,\n        source_id TEXT NOT NULL,\n        repo_id TEXT NOT NULL DEFAULT '',\n        issue_ref TEXT NOT NULL DEFAULT '',\n        mismatch_type TEXT NOT NULL,\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        created_at INTEGER NOT NULL\n      )",
  "CREATE TABLE ledger_operational_link_reports (\n        id TEXT PRIMARY KEY,\n        status TEXT NOT NULL CHECK(status IN ('clean','incomplete','failed')),\n        resolved_count INTEGER NOT NULL DEFAULT 0,\n        unresolved_count INTEGER NOT NULL DEFAULT 0,\n        ambiguous_count INTEGER NOT NULL DEFAULT 0,\n        source_counts_json TEXT NOT NULL DEFAULT '{}',\n        error TEXT,\n        started_at INTEGER NOT NULL,\n        finished_at INTEGER\n      )",
  "CREATE TABLE ledger_project_checkouts (\n        id TEXT PRIMARY KEY,\n        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        work_repo_id TEXT,\n        root TEXT NOT NULL,\n        name TEXT NOT NULL,\n        default_branch TEXT NOT NULL DEFAULT '',\n        remote_url TEXT NOT NULL DEFAULT '',\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        UNIQUE(root)\n      )",
  "CREATE TABLE ledger_projects (\n        id TEXT PRIMARY KEY,\n        display_name TEXT NOT NULL,\n        remote_identity TEXT NOT NULL DEFAULT '',\n        upstream_identity TEXT NOT NULL DEFAULT '',\n        namespace_policy TEXT NOT NULL DEFAULT 'remote'\n          CHECK(namespace_policy IN ('remote','upstream','local')),\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL\n      , project_key TEXT NOT NULL DEFAULT '', restricted INTEGER NOT NULL DEFAULT 0\n        CHECK(restricted IN (0, 1)))",
  "CREATE TABLE ledger_reconciliation_mismatches (\n        id TEXT PRIMARY KEY,\n        report_id TEXT NOT NULL REFERENCES ledger_reconciliation_reports(id) ON DELETE CASCADE,\n        project_id TEXT NOT NULL DEFAULT '',\n        repo_id TEXT NOT NULL DEFAULT '',\n        issue_ref TEXT NOT NULL DEFAULT '',\n        mismatch_type TEXT NOT NULL,\n        scanner_value_json TEXT NOT NULL DEFAULT 'null',\n        ledger_value_json TEXT NOT NULL DEFAULT 'null',\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        created_at INTEGER NOT NULL\n      )",
  "CREATE TABLE ledger_reconciliation_reports (\n        id TEXT PRIMARY KEY,\n        read_mode TEXT NOT NULL CHECK(read_mode IN ('scanner','shadow','ledger')),\n        status TEXT NOT NULL CHECK(status IN ('running','clean','mismatch','failed')),\n        scanner_issue_count INTEGER NOT NULL DEFAULT 0,\n        ledger_issue_count INTEGER NOT NULL DEFAULT 0,\n        scanner_open_count INTEGER NOT NULL DEFAULT 0,\n        ledger_open_count INTEGER NOT NULL DEFAULT 0,\n        scanner_closed_count INTEGER NOT NULL DEFAULT 0,\n        ledger_closed_count INTEGER NOT NULL DEFAULT 0,\n        mismatch_count INTEGER NOT NULL DEFAULT 0,\n        summary_json TEXT NOT NULL DEFAULT '{}',\n        error TEXT,\n        started_at INTEGER NOT NULL,\n        finished_at INTEGER\n      )",
  "CREATE TABLE ledger_relationship_edges (\n        id TEXT PRIMARY KEY,\n        source_entity_type TEXT NOT NULL CHECK(source_entity_type IN ('issue','comment')),\n        source_entity_id TEXT NOT NULL,\n        source_project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        target_entity_type TEXT NOT NULL CHECK(target_entity_type IN ('issue','comment')),\n        target_entity_id TEXT NOT NULL,\n        target_project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,\n        link_type TEXT NOT NULL\n          CHECK(link_type IN ('parent_child','blocks','duplicate_of','related','references','fixed_by','caused_by','implements','tests')),\n        provenance TEXT NOT NULL DEFAULT 'manual'\n          CHECK(provenance IN ('manual','imported','derived','system')),\n        note TEXT,\n        action_id TEXT NOT NULL,\n        actor_id TEXT,\n        actor_type TEXT NOT NULL\n          CHECK(actor_type IN ('mandible_user','agent','system','external_adapter')),\n        source TEXT NOT NULL\n          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        deleted_at INTEGER, actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, evidence_method TEXT, evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL,\n        UNIQUE(source_entity_type, source_entity_id, target_entity_type, target_entity_id, link_type)\n      )",
  "CREATE TABLE ledger_session_issue_links (\n        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE RESTRICT,\n        link_type TEXT NOT NULL DEFAULT 'worked_on',\n        source TEXT NOT NULL DEFAULT 'system',\n        created_at INTEGER NOT NULL,\n        last_seen_at INTEGER,\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        PRIMARY KEY (session_id, issue_id, link_type)\n      )",
  "CREATE TABLE ledger_work_unit_issue_links (\n        work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE CASCADE,\n        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE RESTRICT,\n        link_type TEXT NOT NULL DEFAULT 'work_unit_tracks',\n        source TEXT NOT NULL DEFAULT 'system',\n        created_at INTEGER NOT NULL,\n        last_seen_at INTEGER,\n        metadata_json TEXT NOT NULL DEFAULT '{}',\n        PRIMARY KEY (work_unit_id, issue_id, link_type)\n      )",
  "CREATE TABLE message_params (\n        id              INTEGER PRIMARY KEY AUTOINCREMENT,\n        session_id      TEXT NOT NULL,\n        message_index   INTEGER NOT NULL,\n        model           TEXT,\n        permission_mode TEXT,\n        max_turns       INTEGER,\n        max_cost_usd    REAL,\n        allowed_tools   TEXT,\n        created_at      INTEGER NOT NULL DEFAULT (unixepoch()), thinking_effort TEXT,\n        UNIQUE(session_id, message_index)\n      )",
  "CREATE TABLE meta (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n)",
  "CREATE TABLE managed_tasks (\n        id                 TEXT PRIMARY KEY,\n        project_id         TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        kind               TEXT NOT NULL CHECK(kind = 'mandible-reminder'),\n        lifecycle          TEXT NOT NULL CHECK(lifecycle IN ('armed','completed','cancelled')),\n        active_revision_id TEXT NOT NULL\n                           REFERENCES managed_task_revisions(id) ON DELETE RESTRICT\n                           DEFERRABLE INITIALLY DEFERRED,\n        created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,\n        created_at         INTEGER NOT NULL,\n        updated_at         INTEGER NOT NULL,\n        completed_at       INTEGER,\n        cancelled_at       INTEGER,\n        CHECK (\n          (lifecycle = 'armed' AND completed_at IS NULL AND cancelled_at IS NULL) OR\n          (lifecycle = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL) OR\n          (lifecycle = 'cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL)\n        )\n      )",
  "CREATE TABLE managed_task_revisions (\n        id                 TEXT PRIMARY KEY,\n        task_id            TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE RESTRICT,\n        revision_no        INTEGER NOT NULL CHECK(revision_no = 1),\n        schema_id          TEXT NOT NULL CHECK(schema_id = 'mandible-reminder@1'),\n        payload_json       TEXT NOT NULL CHECK(\n                             json_valid(payload_json)\n                             AND json_type(payload_json) = 'object'\n                             AND json_extract(payload_json, '$.schema') = 'mandible-reminder@1'\n                             AND json_extract(payload_json, '$.effect.kind') = 'inbox_occurrence'\n                           ),\n        payload_digest     TEXT NOT NULL CHECK(\n                             length(payload_digest) = 64\n                             AND payload_digest NOT GLOB '*[^0-9a-f]*'\n                           ),\n        created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,\n        created_at         INTEGER NOT NULL,\n        UNIQUE(task_id),\n        UNIQUE(task_id, id),\n        UNIQUE(task_id, revision_no)\n      )",
  "CREATE TABLE managed_task_create_requests (\n        id                 TEXT PRIMARY KEY,\n        created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,\n        idempotency_key    TEXT NOT NULL CHECK(trim(idempotency_key) != ''),\n        request_digest     TEXT NOT NULL CHECK(\n                             length(request_digest) = 64\n                             AND request_digest NOT GLOB '*[^0-9a-f]*'\n                           ),\n        task_id            TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE RESTRICT,\n        result_json        TEXT NOT NULL CHECK(\n                             json_valid(result_json) AND json_type(result_json) = 'object'\n                           ),\n        created_at         INTEGER NOT NULL,\n        UNIQUE(created_by_user_id, idempotency_key),\n        UNIQUE(task_id)\n      )",
  "CREATE TABLE managed_task_occurrences (\n        id                        TEXT PRIMARY KEY,\n        task_id                   TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE RESTRICT,\n        revision_id               TEXT NOT NULL,\n        occurrence_key            TEXT NOT NULL CHECK(trim(occurrence_key) != ''),\n        kind                      TEXT NOT NULL CHECK(kind = 'inbox_occurrence'),\n        payload_json              TEXT NOT NULL CHECK(\n                                    json_valid(payload_json) AND json_type(payload_json) = 'object'\n                                  ),\n        triggering_evidence_json TEXT NOT NULL CHECK(\n                                    json_valid(triggering_evidence_json)\n                                    AND json_type(triggering_evidence_json) = 'object'\n                                  ),\n        created_by_user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,\n        fired_by_user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,\n        created_at                INTEGER NOT NULL, acknowledged_by TEXT, acknowledged_at INTEGER,\n        UNIQUE(task_id, revision_id, occurrence_key),\n        FOREIGN KEY(task_id, revision_id)\n          REFERENCES managed_task_revisions(task_id, id) ON DELETE RESTRICT\n      )",
  "CREATE TABLE managed_task_events (\n        id              TEXT PRIMARY KEY,\n        task_id         TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE RESTRICT,\n        revision_id     TEXT NOT NULL,\n        project_id      TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        event_type      TEXT NOT NULL CHECK(event_type IN ('created','completed','cancelled')),\n        actor_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,\n        evidence_method TEXT NOT NULL CHECK(evidence_method IN ('api_token','ephemeral','local_default','session_claim','system_internal')),\n        payload_json    TEXT NOT NULL DEFAULT '{}' CHECK(\n                          json_valid(payload_json) AND json_type(payload_json) = 'object'\n                        ),\n        occurred_at     INTEGER NOT NULL,\n        FOREIGN KEY(task_id, revision_id)\n          REFERENCES managed_task_revisions(task_id, id) ON DELETE RESTRICT\n      )",
  "CREATE INDEX idx_managed_tasks_reconcile\n        ON managed_tasks(lifecycle, created_at, id)",
  "CREATE INDEX idx_managed_tasks_project\n        ON managed_tasks(project_id, created_at DESC, id DESC)",
  "CREATE INDEX idx_managed_task_occurrences_created\n        ON managed_task_occurrences(created_at DESC, id DESC)",
  "CREATE INDEX idx_managed_task_occurrences_inbox\n        ON managed_task_occurrences(acknowledged_at, created_at DESC, id DESC)",
  "CREATE INDEX idx_managed_task_events_task\n        ON managed_task_events(task_id, occurred_at, id)",
  "CREATE TRIGGER trg_managed_task_revisions_immutable_update\n        BEFORE UPDATE ON managed_task_revisions\n        BEGIN SELECT RAISE(ABORT, 'managed task revisions are immutable'); END",
  "CREATE TRIGGER trg_managed_task_revisions_immutable_delete\n        BEFORE DELETE ON managed_task_revisions\n        BEGIN SELECT RAISE(ABORT, 'managed task revisions are immutable'); END",
  "CREATE TRIGGER trg_managed_task_revision_matches_task\n        AFTER INSERT ON managed_task_revisions\n        WHEN (SELECT active_revision_id FROM managed_tasks WHERE id = NEW.task_id) != NEW.id\n        BEGIN SELECT RAISE(ABORT, 'managed task active revision mismatch'); END",
  "CREATE TRIGGER trg_managed_task_active_revision_immutable\n        BEFORE UPDATE OF active_revision_id ON managed_tasks\n        BEGIN SELECT RAISE(ABORT, 'managed task active revision is immutable'); END",
  "CREATE TABLE project_artifact_associations (\n        id               TEXT PRIMARY KEY,\n        project_id       TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        target_type      TEXT NOT NULL CHECK(target_type IN ('artifact','artifact_version')),\n        target_id        TEXT NOT NULL,\n        association_kind TEXT NOT NULL DEFAULT 'associated'\n          CHECK(association_kind IN ('associated','canonical')),\n        role             TEXT NOT NULL DEFAULT '',\n        title            TEXT,\n        description      TEXT,\n        rank             INTEGER,\n        status           TEXT NOT NULL DEFAULT 'active'\n          CHECK(status IN ('active','superseded','archived')),\n        source           TEXT NOT NULL DEFAULT 'user'\n          CHECK(source IN ('user','agent_explicit','space_rule','migration','system')),\n        source_ref_type  TEXT,\n        source_ref_id    TEXT,\n        metadata_json    TEXT NOT NULL DEFAULT '{}',\n        created_at       INTEGER NOT NULL,\n        updated_at       INTEGER NOT NULL,\n        UNIQUE(project_id, target_type, target_id, role)\n      )",
  "CREATE TABLE permission_grants (\n        id            TEXT PRIMARY KEY,\n        subject_type  TEXT NOT NULL CHECK(subject_type IN ('user','group')),\n        subject_id    TEXT NOT NULL,\n        resource_type TEXT NOT NULL CHECK(resource_type IN ('project','global')),\n        resource_id   TEXT REFERENCES ledger_projects(id) ON DELETE CASCADE,\n        permission    TEXT NOT NULL,\n        created_at    INTEGER NOT NULL,\n        CHECK (\n          (resource_type = 'project' AND resource_id IS NOT NULL\n            AND permission IN ('read','write','admin')) OR\n          (resource_type = 'global' AND resource_id IS NULL\n            AND permission IN (\n              'approve_auth','spawn_console','change_settings','backup','open_path','ask.create'\n            ))\n        )\n      )",
  "CREATE TABLE provider_manifests ( id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, manifest_type TEXT NOT NULL DEFAULT 'provider_manifest', version TEXT, content_hash TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'ingest', content_json TEXT NOT NULL, created_at INTEGER NOT NULL , blob_id TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL)",
  "CREATE TABLE providers (\n        id                TEXT PRIMARY KEY,\n        display_name      TEXT NOT NULL,\n        version           TEXT,\n        status            TEXT NOT NULL DEFAULT 'active',\n        transport         TEXT NOT NULL DEFAULT 'manifest',\n        endpoint          TEXT,\n        capabilities_json TEXT NOT NULL DEFAULT '{}',\n        actions_json      TEXT NOT NULL DEFAULT '[]',\n        source            TEXT NOT NULL DEFAULT 'local',\n        created_at        INTEGER NOT NULL,\n        updated_at        INTEGER NOT NULL,\n        last_seen_at      INTEGER\n      )",
  "CREATE TABLE push_history (\n        id TEXT PRIMARY KEY,\n        repo_id TEXT NOT NULL,\n        repo_root TEXT NOT NULL,\n        scope TEXT NOT NULL,\n        status TEXT NOT NULL CHECK(status IN ('started','completed','failed')),\n        result_json TEXT,\n        started_at INTEGER NOT NULL,\n        completed_at INTEGER\n      )",
  "CREATE TABLE session_issues (\n        session_id  TEXT NOT NULL,\n        issue_id    TEXT NOT NULL,\n        repo_id     TEXT NOT NULL,\n        created_at  INTEGER NOT NULL,\n        PRIMARY KEY (session_id, issue_id, repo_id)\n      )",
  "CREATE TABLE session_projects (\n        session_id TEXT NOT NULL,\n        repo_id TEXT NOT NULL,\n        repo_name TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        PRIMARY KEY (session_id, repo_id)\n      )",
  "CREATE TABLE sessions (\n  id            TEXT PRIMARY KEY,\n  app           TEXT NOT NULL,\n  parent_id     TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n  status        TEXT NOT NULL DEFAULT 'active',\n  pid           INTEGER,\n  pid_start     TEXT,\n  cwd           TEXT,\n  branch        TEXT,\n  worktree      TEXT,\n  task          TEXT,\n  terminal      TEXT,\n  multiplexer   TEXT,\n  nav_session   TEXT,\n  nav_tab       TEXT,\n  nav_pane_id   TEXT,\n  nav_extra     TEXT,\n  agent_type    TEXT,\n  description   TEXT,\n  created_at    TEXT NOT NULL DEFAULT (datetime('now')),\n  ended_at      TEXT,\n  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))\n, nav_metadata_status TEXT NOT NULL DEFAULT 'not_applicable', nav_metadata_attempts INTEGER NOT NULL DEFAULT 0, nav_metadata_last_error TEXT, nav_metadata_last_attempt_at TEXT, nav_metadata_next_retry_at TEXT, continuation TEXT, continuation_acked_by TEXT, pinned INTEGER DEFAULT 0, last_active TEXT, channel_connected_at INTEGER, channel_last_tool_call INTEGER, conversation_id TEXT, owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, identity_mismatch_at INTEGER, identity_mismatch_json TEXT)",
  "CREATE TABLE settings (\n        key TEXT PRIMARY KEY,\n        value TEXT NOT NULL,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE space_blocks (\n        id                 TEXT NOT NULL,\n        space_id           TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,\n        parent_id          TEXT,\n        block_type         TEXT NOT NULL\n                             CHECK(block_type IN (\n                               'heading','paragraph','reference','artifact_embed',\n                               'issue_embed','comment_embed','todo'\n                             )),\n        item_id            TEXT,\n        item_snapshot_json TEXT\n                             CHECK(item_snapshot_json IS NULL\n                               OR (json_valid(item_snapshot_json)\n                                   AND json_type(item_snapshot_json)='object')),\n        sort_key           TEXT NOT NULL,\n        markdown           TEXT NOT NULL DEFAULT '',\n        metadata_json      TEXT NOT NULL DEFAULT '{}'\n                             CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),\n        created_at         INTEGER NOT NULL,\n        updated_at         INTEGER NOT NULL,\n        PRIMARY KEY (id),\n        UNIQUE (space_id, id),\n        CHECK (item_id IS NULL OR item_snapshot_json IS NOT NULL),\n        FOREIGN KEY (space_id, parent_id)\n          REFERENCES space_blocks(space_id, id) ON DELETE CASCADE,\n        FOREIGN KEY (space_id, item_id)\n          REFERENCES space_items(space_id, id) ON DELETE RESTRICT\n      )",
  "CREATE TABLE space_edges (\n        id            TEXT PRIMARY KEY,\n        space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,\n        source        TEXT NOT NULL,\n        target        TEXT NOT NULL,\n        label         TEXT,\n        style         TEXT,\n        metadata_json TEXT NOT NULL DEFAULT '{}'\n                        CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),\n        created_at    INTEGER NOT NULL,\n        updated_at    INTEGER NOT NULL,\n        FOREIGN KEY (space_id, source)\n          REFERENCES space_occurrences(space_id, id) ON DELETE CASCADE,\n        FOREIGN KEY (space_id, target)\n          REFERENCES space_occurrences(space_id, id) ON DELETE CASCADE\n      )",
  "CREATE TABLE space_exports ( id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, repo_id TEXT NOT NULL REFERENCES ledger_project_checkouts(id) ON DELETE RESTRICT, branch TEXT NOT NULL, path TEXT NOT NULL, authority TEXT NOT NULL DEFAULT 'mandible' CHECK(authority IN ('mandible','repo')), status TEXT NOT NULL DEFAULT 'clean' CHECK(status IN ('clean','stale','repo_changed','worktree_dirty','conflict')), last_export_commit TEXT, last_export_blob_sha TEXT, last_export_content_sha256 TEXT, last_seen_commit TEXT, last_seen_content_sha256 TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_export_blob_id TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL, pre_export_snapshot_blob_id TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL, UNIQUE (repo_id, branch, path) )",
  CANONICAL_SPACE_ITEMS_SQL,
  "CREATE TABLE space_occurrences (\n        id            TEXT NOT NULL,\n        space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,\n        item_id       TEXT,\n        renderer      TEXT NOT NULL DEFAULT 'canvas'\n                        CHECK(renderer IN ('canvas','board','collection')),\n        parent_id     TEXT,\n        x             REAL,\n        y             REAL,\n        width         REAL,\n        height        REAL,\n        z_index       INTEGER,\n        sort_key      TEXT,\n        section_id    TEXT,\n        note          TEXT,\n        metadata_json TEXT NOT NULL DEFAULT '{}'\n                        CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),\n        created_at    INTEGER NOT NULL,\n        updated_at    INTEGER NOT NULL,\n        PRIMARY KEY (id),\n        UNIQUE (space_id, id),\n        FOREIGN KEY (space_id, item_id)\n          REFERENCES space_items(space_id, id) ON DELETE CASCADE,\n        FOREIGN KEY (space_id, parent_id)\n          REFERENCES space_occurrences(space_id, id) ON DELETE CASCADE\n      )",
  "CREATE TABLE spaces (\n        id               TEXT PRIMARY KEY,\n        project_id       TEXT REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        title            TEXT NOT NULL,\n        default_renderer TEXT NOT NULL DEFAULT 'canvas'\n                           CHECK(default_renderer IN ('canvas','document','board','collection')),\n        description      TEXT,\n        metadata_json    TEXT NOT NULL DEFAULT '{}'\n                           CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),\n        created_at       INTEGER NOT NULL,\n        updated_at       INTEGER NOT NULL\n      )",
  "CREATE TABLE trash_entries (\n        id               TEXT PRIMARY KEY,\n        project_id       TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,\n        checkout_id      TEXT NOT NULL REFERENCES ledger_project_checkouts(id) ON DELETE RESTRICT,\n        repo_root        TEXT NOT NULL,\n        branch           TEXT NOT NULL,\n        issue_refs_json  TEXT NOT NULL DEFAULT '[]'\n                           CHECK(json_valid(issue_refs_json) AND json_type(issue_refs_json)='array'),\n        reason           TEXT NOT NULL\n                           CHECK(reason IN ('superseded','merged','abandoned','manual')),\n        actor            TEXT NOT NULL,\n        snapshot_ref     TEXT NOT NULL UNIQUE,\n        snapshot_oid     TEXT NOT NULL,\n        original_oid     TEXT NOT NULL,\n        retention_policy TEXT NOT NULL DEFAULT 'trash-retention.v1',\n        retention_days   INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),\n        state            TEXT NOT NULL DEFAULT 'active'\n                           CHECK(state IN (\n                             'active','remove_failed','restored','expired',\n                             'restore_failed','gc_pending','gc_failed'\n                           )),\n        created_at       INTEGER NOT NULL,\n        expires_at       INTEGER NOT NULL,\n        restored_at      INTEGER,\n        expired_at       INTEGER,\n        last_error       TEXT,\n        outcome_json     TEXT NOT NULL DEFAULT '{}'\n                           CHECK(json_valid(outcome_json) AND json_type(outcome_json)='object')\n      )",
  "CREATE TABLE user_bindings (\n        id           TEXT PRIMARY KEY,\n        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,\n        binding_type TEXT NOT NULL\n                       CHECK(binding_type IN ('app_name','provider_session_env','process_pattern','git_author_email','external_author')),\n        value        TEXT NOT NULL,\n        scope        TEXT,\n        status       TEXT NOT NULL DEFAULT 'active'\n                       CHECK(status IN ('active','inactive')),\n        created_at   INTEGER NOT NULL,\n        updated_at   INTEGER NOT NULL\n      )",
  "CREATE TABLE user_credentials (\n        id              TEXT PRIMARY KEY,\n        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,\n        type            TEXT NOT NULL,\n        fingerprint     TEXT NOT NULL,\n        public_material TEXT,\n        label           TEXT,\n        status          TEXT NOT NULL DEFAULT 'active'\n                          CHECK(status IN ('active','revoked')),\n        created_at      INTEGER NOT NULL,\n        revoked_at      INTEGER,\n        metadata_json   TEXT NOT NULL DEFAULT '{}'\n                          CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object')\n      )",
  "CREATE TABLE user_group_members (\n        group_id  TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,\n        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n        created_at INTEGER NOT NULL,\n        PRIMARY KEY (group_id, user_id)\n      )",
  "CREATE TABLE user_groups (\n        id           TEXT PRIMARY KEY,\n        slug         TEXT NOT NULL UNIQUE,\n        display_name TEXT NOT NULL,\n        kind         TEXT NOT NULL DEFAULT 'custom'\n                       CHECK(kind IN ('system','custom')),\n        created_at   INTEGER NOT NULL,\n        updated_at   INTEGER NOT NULL\n      )",
  USER_SETTINGS_SCHEMA_SQL,
  "CREATE TABLE users (\n        id            TEXT PRIMARY KEY,\n        slug          TEXT NOT NULL UNIQUE,\n        kind          TEXT NOT NULL\n                        CHECK(kind IN ('human','agent','system','external')),\n        display_name  TEXT NOT NULL,\n        email         TEXT,\n        status        TEXT NOT NULL DEFAULT 'active'\n                        CHECK(status IN ('active','retired')),\n        created_at    INTEGER NOT NULL,\n        updated_at    INTEGER NOT NULL,\n        metadata_json TEXT NOT NULL DEFAULT '{}'\n                        CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object')\n      )",
  "CREATE TABLE webhook_events (\n        id             TEXT PRIMARY KEY,\n        source         TEXT NOT NULL,\n        event_type     TEXT NOT NULL,\n        title          TEXT,\n        data_json      TEXT NOT NULL,\n        target_session TEXT,\n        target_issue   TEXT,\n        target_branch  TEXT,\n        priority       TEXT NOT NULL DEFAULT 'normal',\n        status         TEXT NOT NULL DEFAULT 'pending',\n        created_at     INTEGER NOT NULL,\n        delivered_at   INTEGER,\n        delivered_to   TEXT\n      )",
  "CREATE TABLE work_repos (\n        id              TEXT NOT NULL,\n        root            TEXT NOT NULL,\n        name            TEXT NOT NULL,\n        default_branch  TEXT NOT NULL DEFAULT '',\n        dir_exists      INTEGER NOT NULL DEFAULT 1,\n        excluded        INTEGER NOT NULL DEFAULT 0,\n        user_modified   INTEGER NOT NULL DEFAULT 0,\n        last_scanned_at TEXT,\n        created_at      TEXT NOT NULL DEFAULT (datetime('now')),\n        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),\n        PRIMARY KEY (root)\n      )",
  "CREATE TABLE work_units (\n        id TEXT PRIMARY KEY,\n        issue_id TEXT NOT NULL,\n        repo_id TEXT NOT NULL,\n        branch TEXT,\n        parent_branch TEXT,\n        kind TEXT NOT NULL DEFAULT 'solo',\n        state TEXT NOT NULL DEFAULT 'open',\n        assigned_session_id TEXT,\n        provider TEXT,\n        provider_session_id TEXT,\n        continuation TEXT,\n        continuation_by TEXT,\n        continuation_at INTEGER,\n        created_at INTEGER NOT NULL,\n        activated_at INTEGER,\n        last_commit_at INTEGER,\n        resolved_at INTEGER,\n        auth_request_id TEXT\n      , ledger_issue_id TEXT REFERENCES ledger_issues(id), owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, merge_scan_retired_at INTEGER, worker_provider_session_id TEXT)",
  "CREATE TABLE workflow_ingest_state (\n        file_path TEXT PRIMARY KEY,\n        source_mtime REAL NOT NULL DEFAULT 0,\n        summary_path TEXT NOT NULL,\n        workflow_id TEXT,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE workflow_phases (\n        id              TEXT PRIMARY KEY,\n        workflow_id     TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,\n        phase_index     INTEGER NOT NULL,\n        title           TEXT NOT NULL,\n        status          TEXT NOT NULL\n          CHECK(status IN ('pending','running','completed','failed','warning')),\n        worker_count    INTEGER NOT NULL DEFAULT 0,\n        completed_count INTEGER NOT NULL DEFAULT 0,\n        UNIQUE(workflow_id, phase_index)\n      )",
  "CREATE TABLE workflow_runs (\n        id                TEXT PRIMARY KEY,\n        provider          TEXT NOT NULL DEFAULT 'claude_code'\n          CHECK(provider IN ('claude_code')),\n        provider_run_id   TEXT NOT NULL,\n        session_id        TEXT NOT NULL,\n        project_path      TEXT,\n        summary_path      TEXT NOT NULL UNIQUE,\n        summary_mtime     REAL NOT NULL DEFAULT 0,\n        summary_hash      TEXT NOT NULL DEFAULT '',\n        workflow_name     TEXT NOT NULL,\n        status            TEXT NOT NULL\n          CHECK(status IN ('pending','running','completed','failed','warning')),\n        started_at        INTEGER,\n        updated_at        INTEGER,\n        completed_at      INTEGER,\n        duration_ms       INTEGER,\n        total_tokens      INTEGER,\n        total_tool_calls  INTEGER,\n        agent_count       INTEGER NOT NULL DEFAULT 0,\n        completed_workers INTEGER NOT NULL DEFAULT 0,\n        total_workers     INTEGER NOT NULL DEFAULT 0,\n        format_version    TEXT NOT NULL,\n        script_path       TEXT,\n        warnings_json     TEXT NOT NULL DEFAULT '[]',\n        created_at        INTEGER NOT NULL,\n        ingested_at       INTEGER NOT NULL\n      )",
  "CREATE TABLE workflow_workers (\n        id                TEXT PRIMARY KEY,\n        workflow_id       TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,\n        phase_id          TEXT REFERENCES workflow_phases(id) ON DELETE SET NULL,\n        worker_index      INTEGER NOT NULL,\n        agent_id          TEXT,\n        label             TEXT NOT NULL,\n        status            TEXT NOT NULL\n          CHECK(status IN ('pending','running','completed','failed','warning')),\n        model             TEXT,\n        queued_at         INTEGER,\n        started_at        INTEGER,\n        last_progress_at  INTEGER,\n        completed_at      INTEGER,\n        duration_ms       INTEGER,\n        tokens            INTEGER,\n        tool_calls        INTEGER,\n        last_tool_name    TEXT,\n        last_tool_summary TEXT,\n        prompt_preview    TEXT,\n        result_preview    TEXT,\n        transcript_path   TEXT,\n        conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,\n        warnings_json     TEXT NOT NULL DEFAULT '[]',\n        UNIQUE(workflow_id, agent_id)\n      )",
  "CREATE INDEX idx_auth_merge_succeeded_project\n        ON auth_request_merge_succeeded_facts(\n          project_id, base_branch, canonical_message, completed_at, auth_request_id\n        )",
  "CREATE INDEX idx_artifact_aliases_blob\n      ON artifact_aliases(blob_id) WHERE blob_id IS NOT NULL",
  "CREATE UNIQUE INDEX idx_artifact_aliases_scheme_ref\n      ON artifact_aliases(scheme, normalized_ref)",
  "CREATE INDEX idx_artifact_aliases_status\n      ON artifact_aliases(resolution_status, scheme)",
  "CREATE INDEX idx_artifact_blob_provider\n        ON artifact_blob(provider_id)\n        WHERE provider_id IS NOT NULL",
  "CREATE INDEX idx_artifact_blob_role\n        ON artifact_blob(role)\n        WHERE role IS NOT NULL",
  "CREATE INDEX idx_artifact_drafts_version ON artifact_drafts(version_id)",
  "CREATE INDEX idx_artifact_links_blob\n      ON artifact_links(blob_id, link_type)",
  "CREATE INDEX idx_artifact_links_entity\n      ON artifact_links(entity_type, entity_id)",
  "CREATE INDEX idx_artifact_links_fallback_version\n      ON artifact_links(fallback_version_id) WHERE fallback_version_id IS NOT NULL",
  "CREATE INDEX idx_artifact_links_kind ON artifact_links(link_kind)",
  "CREATE INDEX idx_artifact_links_provider\n      ON artifact_links(provider_id) WHERE provider_id IS NOT NULL",
  "CREATE INDEX idx_artifact_links_repo\n      ON artifact_links(repo_id) WHERE repo_id IS NOT NULL",
  "CREATE INDEX idx_artifact_links_role\n      ON artifact_links(role) WHERE role IS NOT NULL",
  "CREATE INDEX idx_artifact_links_target\n      ON artifact_links(target_type, target_id)",
  "CREATE INDEX idx_artifact_source_kind\n        ON artifact(source_kind)",
  "CREATE INDEX idx_artifact_source_project\n        ON artifact(source_project_id)\n        WHERE source_project_id IS NOT NULL",
  "CREATE INDEX idx_artifact_version_artifact\n        ON artifact_version(artifact_id, version_no DESC)",
  "CREATE INDEX idx_artifact_version_blob\n        ON artifact_version(blob_id)",
  "CREATE INDEX idx_artifact_version_hash\n        ON artifact_version(content_hash)",
  "CREATE INDEX idx_artifact_version_source_project\n        ON artifact_version(source_project_id)\n        WHERE source_project_id IS NOT NULL",
  "CREATE INDEX idx_attribution_evidence_credential\n        ON attribution_evidence(credential_id) WHERE credential_id IS NOT NULL",
  "CREATE INDEX idx_attribution_evidence_lease\n        ON attribution_evidence(lease_id) WHERE lease_id IS NOT NULL",
  "CREATE INDEX idx_auth_hook_alerts_open\n        ON auth_hook_alerts(acknowledged_at, created_at DESC)",
  "CREATE INDEX idx_auth_hook_executions_runnable\n        ON auth_hook_executions(state, updated_at)",
  "CREATE INDEX idx_auth_hooks_repo_type\n        ON auth_hooks(repo_pattern, auth_type)",
  "CREATE INDEX idx_auth_request_actions_request_ordinal\n        ON auth_request_actions(auth_request_id, ordinal)",
  "CREATE INDEX idx_auth_request_actions_state\n        ON auth_request_actions(state, auth_request_id)",
  "CREATE INDEX idx_auth_requests_conversation_id\n        ON auth_requests(conversation_id) WHERE conversation_id IS NOT NULL",
  "CREATE INDEX idx_auth_requests_approved_by_user\n        ON auth_requests(approved_by_user_id) WHERE approved_by_user_id IS NOT NULL",
  "CREATE INDEX idx_auth_requests_execution_evidence\n        ON auth_requests(execution_evidence_id) WHERE execution_evidence_id IS NOT NULL",
  "CREATE INDEX idx_auth_requests_queue\n  ON auth_requests(status, skipped_at, created_at)",
  "CREATE INDEX idx_auth_requests_requested_by_user\n        ON auth_requests(requested_by_user_id) WHERE requested_by_user_id IS NOT NULL",
  "CREATE INDEX idx_auth_requests_status_created\n  ON auth_requests(status, created_at)",
  "CREATE INDEX idx_auth_requests_target_repo\n        ON auth_requests(target_repo_root) WHERE target_repo_root IS NOT NULL",
  "CREATE INDEX idx_auth_requests_target_session\n        ON auth_requests(target_session_id) WHERE target_session_id IS NOT NULL",
  "CREATE INDEX idx_blocks_conv ON conversation_blocks(conversation_id)",
  "CREATE INDEX idx_blocks_dag_parent\n      ON conversation_blocks(conversation_id, dag_parent_uuid)\n      WHERE dag_parent_uuid IS NOT NULL",
  "CREATE INDEX idx_blocks_parent ON conversation_blocks(parent_id) WHERE parent_id IS NOT NULL",
  "CREATE INDEX idx_blocks_timestamp_ms\n        ON conversation_blocks(timestamp_ms) WHERE timestamp_ms IS NOT NULL",
  "CREATE INDEX idx_blocks_type ON conversation_blocks(conversation_id, type)",
  "CREATE INDEX idx_console_session_telemetry_console\n        ON console_session_telemetry(console_session_id)\n        WHERE console_session_id IS NOT NULL",
  "CREATE INDEX idx_console_session_telemetry_provider\n        ON console_session_telemetry(provider_session_id)\n        WHERE provider_session_id IS NOT NULL",
  "CREATE INDEX idx_console_session_usage_session\n        ON console_session_usage(console_session_id, recorded_at DESC)",
  "CREATE INDEX idx_console_sessions_operator\n         ON console_sessions(is_operator) WHERE is_operator = 1",
  "CREATE INDEX idx_console_sessions_status\n         ON console_sessions(status)",
  "CREATE INDEX idx_conv_agent\n      ON conversations(agent_id)\n      WHERE agent_id IS NOT NULL",
  "CREATE INDEX idx_conv_ended_ms\n        ON conversations(ended_at_ms) WHERE ended_at_ms IS NOT NULL",
  "CREATE INDEX idx_conv_parent ON conversations(parent_conversation_id) WHERE parent_conversation_id IS NOT NULL",
  "CREATE INDEX idx_conv_session ON conversations(session_id)",
  "CREATE INDEX idx_conv_sidechain_parent\n      ON conversations(parent_conversation_id, is_sidechain)\n      WHERE is_sidechain = 1",
  "CREATE INDEX idx_conv_source ON conversations(source)",
  "CREATE INDEX idx_conv_source_path ON conversations(source_path)",
  "CREATE INDEX idx_conv_starred ON conversations(starred) WHERE starred = 1",
  "CREATE INDEX idx_conv_started ON conversations(started_at)",
  "CREATE INDEX idx_conv_started_ms\n        ON conversations(started_at_ms) WHERE started_at_ms IS NOT NULL",
  "CREATE INDEX idx_conversation_ingest_state_updated\n        ON conversation_ingest_state(updated_at)",
  "CREATE INDEX idx_daemon_log_artifact\n        ON daemon_log(artifact_id, ts DESC)\n        WHERE artifact_id IS NOT NULL",
  "CREATE INDEX idx_daemon_log_auth_request\n        ON daemon_log(auth_request_id, ts DESC)\n        WHERE auth_request_id IS NOT NULL",
  "CREATE INDEX idx_daemon_log_facets\n        ON daemon_log(subsystem, level, event, ts DESC)",
  "CREATE INDEX idx_daemon_log_issue\n        ON daemon_log(issue_id, ts DESC)\n        WHERE issue_id IS NOT NULL",
  "CREATE INDEX idx_daemon_log_repo\n        ON daemon_log(repo_id, ts DESC)\n        WHERE repo_id IS NOT NULL",
  "CREATE INDEX idx_daemon_log_session\n        ON daemon_log(session_id, ts DESC)\n        WHERE session_id IS NOT NULL",
  "CREATE INDEX idx_daemon_log_ts\n        ON daemon_log(ts DESC)",
  "CREATE INDEX idx_delegated_signing_leases_credential\n        ON delegated_signing_leases(credential_id)",
  "CREATE INDEX idx_delegated_signing_leases_owner\n        ON delegated_signing_leases(owner_user_id)",
  "CREATE INDEX idx_graph_edges_class\n        ON graph_edges(edge_class)",
  "CREATE INDEX idx_graph_edges_source\n        ON graph_edges(source_id)",
  "CREATE INDEX idx_graph_edges_target\n        ON graph_edges(target_id)",
  "CREATE INDEX idx_graph_edges_type\n        ON graph_edges(edge_type)",
  "CREATE INDEX idx_graph_entities_provider\n        ON graph_entities(provider_id)",
  "CREATE INDEX idx_graph_entities_repo\n        ON graph_entities(repo_id)",
  "CREATE INDEX idx_graph_entities_type\n        ON graph_entities(entity_type)",
  "CREATE INDEX idx_issue_branches_branch\n        ON issue_branches(branch)",
  "CREATE INDEX idx_issue_branches_role\n        ON issue_branches(role)",
  "CREATE INDEX idx_issue_resolutions_issue\n        ON issue_resolutions(issue_id)",
  "CREATE INDEX idx_knowledge_backrefs_external_ref\n        ON knowledge_backrefs(external_ref)",
  "CREATE INDEX idx_knowledge_backrefs_provider\n        ON knowledge_backrefs(provider_id, ref_type)",
  "CREATE INDEX idx_knowledge_backrefs_source\n        ON knowledge_backrefs(source_type, source_id)",
  "CREATE INDEX idx_ledger_auth_issue_issue\n        ON ledger_auth_issue_links(issue_id)",
  "CREATE INDEX idx_ledger_body_revisions_entity\n        ON ledger_body_revisions(entity_type, entity_id, revision_no)",
  "CREATE INDEX idx_ledger_body_revisions_event\n        ON ledger_body_revisions(event_id)\n        WHERE event_id IS NOT NULL",
  "CREATE INDEX idx_ledger_body_revisions_issue\n        ON ledger_body_revisions(issue_id, occurred_at)",
  "CREATE INDEX idx_ledger_comments_author_user\n        ON ledger_comments(author_user_id) WHERE author_user_id IS NOT NULL",
  "CREATE INDEX idx_ledger_comments_issue_created\n        ON ledger_comments(issue_id, created_at)",
  "CREATE UNIQUE INDEX idx_ledger_comments_issue_ordinal\n        ON ledger_comments(issue_id, ordinal)\n        WHERE ordinal > 0",
  "CREATE INDEX idx_ledger_commit_issue_issue\n        ON ledger_commit_issue_links(issue_id)",
  "CREATE INDEX idx_ledger_events_actor_user\n        ON ledger_events(actor_user_id) WHERE actor_user_id IS NOT NULL",
  "CREATE INDEX idx_ledger_events_entity\n        ON ledger_events(entity_type, entity_id, occurred_at)",
  "CREATE INDEX idx_ledger_events_occurred\n        ON ledger_events(occurred_at DESC)",
  "CREATE INDEX idx_ledger_change_log_event\n        ON ledger_change_log(event_id)",
  "CREATE INDEX idx_ledger_issue_aliases_alias\n        ON ledger_issue_aliases(alias)",
  "CREATE INDEX idx_ledger_issue_aliases_issue\n        ON ledger_issue_aliases(issue_id)",
  "CREATE INDEX idx_ledger_issue_checkpoints_issue_created\n        ON ledger_issue_checkpoints(issue_id, created_at DESC)",
  "CREATE INDEX idx_ledger_issue_checkpoints_issue_kind_created\n        ON ledger_issue_checkpoints(issue_id, kind, created_at DESC)",
  "CREATE INDEX idx_ledger_issues_author_user\n        ON ledger_issues(author_user_id) WHERE author_user_id IS NOT NULL",
  "CREATE INDEX idx_ledger_issues_kind\n        ON ledger_issues(kind)",
  "CREATE UNIQUE INDEX idx_ledger_issues_project_short_id\n        ON ledger_issues(project_id, short_id)\n        WHERE short_id != ''",
  "CREATE INDEX idx_ledger_issues_project_status_updated\n        ON ledger_issues(project_id, status, updated_at DESC)",
  "CREATE INDEX idx_ledger_labels_label\n        ON ledger_labels(label)",
  "CREATE INDEX idx_ledger_operational_link_mismatches_report\n        ON ledger_operational_link_mismatches(report_id, source_table, mismatch_type)",
  "CREATE INDEX idx_ledger_operational_link_reports_status\n        ON ledger_operational_link_reports(status, finished_at DESC)",
  "CREATE INDEX idx_ledger_project_checkouts_project\n        ON ledger_project_checkouts(project_id)",
  "CREATE UNIQUE INDEX idx_ledger_projects_project_key\n      ON ledger_projects(project_key)\n      WHERE project_key != ''",
  "CREATE UNIQUE INDEX idx_ledger_projects_remote_identity\n        ON ledger_projects(remote_identity)\n        WHERE remote_identity != ''",
  "CREATE INDEX idx_permission_grants_resource\n        ON permission_grants(resource_type, resource_id)",
  "CREATE INDEX idx_permission_grants_subject\n        ON permission_grants(subject_type, subject_id)",
  "CREATE INDEX idx_ledger_reconciliation_mismatches_issue\n        ON ledger_reconciliation_mismatches(repo_id, issue_ref)",
  "CREATE INDEX idx_ledger_reconciliation_mismatches_report\n        ON ledger_reconciliation_mismatches(report_id, mismatch_type)",
  "CREATE INDEX idx_ledger_reconciliation_reports_status\n        ON ledger_reconciliation_reports(status, finished_at DESC)",
  "CREATE INDEX idx_ledger_relationship_edges_action\n        ON ledger_relationship_edges(action_id)",
  "CREATE INDEX idx_ledger_relationship_edges_source\n        ON ledger_relationship_edges(source_entity_type, source_entity_id, deleted_at)",
  "CREATE INDEX idx_ledger_relationship_edges_source_issue\n        ON ledger_relationship_edges(source_issue_id, deleted_at)",
  "CREATE INDEX idx_ledger_relationship_edges_target\n        ON ledger_relationship_edges(target_entity_type, target_entity_id, deleted_at)",
  "CREATE INDEX idx_ledger_relationship_edges_target_issue\n        ON ledger_relationship_edges(target_issue_id, deleted_at)",
  "CREATE INDEX idx_ledger_relationship_sources_relationship\n          ON ledger_issue_relationship_sources(relationship_id)",
  "CREATE INDEX idx_ledger_relationship_sources_source\n          ON ledger_issue_relationship_sources(source_entity_type, source_entity_id)",
  "CREATE INDEX idx_ledger_relationship_sources_target\n          ON ledger_issue_relationship_sources(target_issue_id)",
  "CREATE INDEX idx_ledger_relationships_source\n        ON ledger_issue_relationships(source_issue_id)",
  "CREATE INDEX idx_ledger_relationships_target\n        ON ledger_issue_relationships(target_issue_id)",
  "CREATE INDEX idx_ledger_relationships_type\n        ON ledger_issue_relationships(relationship_type)",
  "CREATE INDEX idx_ledger_session_issue_issue\n        ON ledger_session_issue_links(issue_id)",
  "CREATE INDEX idx_ledger_work_unit_issue_issue\n        ON ledger_work_unit_issue_links(issue_id)",
  "CREATE INDEX idx_message_params_session\n        ON message_params(session_id, message_index DESC)",
  "CREATE INDEX idx_project_artifact_assoc_project\n        ON project_artifact_associations(project_id, association_kind, status)",
  "CREATE INDEX idx_project_artifact_assoc_source\n        ON project_artifact_associations(source_ref_type, source_ref_id)\n        WHERE source_ref_type IS NOT NULL AND source_ref_id IS NOT NULL",
  "CREATE INDEX idx_project_artifact_assoc_target\n        ON project_artifact_associations(target_type, target_id)",
  "CREATE INDEX idx_provider_manifests_provider\n        ON provider_manifests(provider_id, created_at DESC)",
  "CREATE INDEX idx_providers_status\n        ON providers(status)",
  "CREATE INDEX idx_push_history_repo ON push_history(repo_id)",
  "CREATE INDEX idx_push_history_status ON push_history(status)",
  "CREATE INDEX idx_session_issues_issue\n        ON session_issues(issue_id, repo_id)",
  "CREATE INDEX idx_session_issues_session\n        ON session_issues(session_id)",
  "CREATE INDEX idx_session_projects_session\n        ON session_projects(session_id)",
  "CREATE INDEX idx_sessions_conversation_id\n        ON sessions(conversation_id) WHERE conversation_id IS NOT NULL",
  "CREATE INDEX idx_space_blocks_item\n        ON space_blocks(space_id, item_id) WHERE item_id IS NOT NULL",
  "CREATE INDEX idx_space_blocks_tree\n        ON space_blocks(space_id, parent_id, sort_key)",
  "CREATE INDEX idx_space_edges_source ON space_edges(space_id, source)",
  "CREATE INDEX idx_space_edges_target ON space_edges(space_id, target)",
  "CREATE INDEX idx_space_exports_repo\n        ON space_exports(repo_id, branch, path)",
  "CREATE INDEX idx_space_exports_space\n        ON space_exports(space_id)",
  "CREATE INDEX idx_space_items_by_ref\n        ON space_items(ref_type, ref_id, space_id)",
  "CREATE INDEX idx_space_items_lookup\n        ON space_items(space_id, ref_type, ref_id)",
  "CREATE INDEX idx_space_occurrences_item\n        ON space_occurrences(space_id, item_id) WHERE item_id IS NOT NULL",
  "CREATE INDEX idx_space_occurrences_render\n        ON space_occurrences(space_id, renderer, sort_key)",
  "CREATE INDEX idx_space_occurrences_tree\n        ON space_occurrences(space_id, parent_id, sort_key)",
  "CREATE INDEX idx_spaces_project_updated\n        ON spaces(project_id, updated_at DESC)",
  "CREATE INDEX idx_trash_entries_branch\n         ON trash_entries(project_id, branch, created_at DESC)",
  "CREATE INDEX idx_trash_entries_expiry\n         ON trash_entries(state, expires_at)",
  "CREATE INDEX idx_trash_entries_project_created\n         ON trash_entries(project_id, created_at DESC)",
  "CREATE INDEX idx_user_group_members_user\n        ON user_group_members(user_id, group_id)",
  "CREATE INDEX idx_user_bindings_lookup\n        ON user_bindings(binding_type, value)",
  "CREATE INDEX idx_user_bindings_user\n        ON user_bindings(user_id)",
  "CREATE UNIQUE INDEX idx_user_credentials_active_fingerprint\n        ON user_credentials(fingerprint) WHERE status = 'active'",
  "CREATE INDEX idx_user_credentials_user\n        ON user_credentials(user_id)",
  "CREATE INDEX idx_webhook_events_created\n        ON webhook_events(created_at DESC)",
  "CREATE INDEX idx_webhook_events_status\n        ON webhook_events(status)",
  "CREATE INDEX idx_work_units_ledger_issue\n      ON work_units(ledger_issue_id) WHERE ledger_issue_id IS NOT NULL",
  "CREATE INDEX idx_work_units_provider_session\n      ON work_units(provider, provider_session_id)\n      WHERE provider IS NOT NULL AND provider_session_id IS NOT NULL",
  "CREATE INDEX idx_work_units_repo_branch ON work_units(repo_id, branch)",
  "CREATE INDEX idx_work_units_repo_issue ON work_units(repo_id, issue_id)",
  "CREATE INDEX idx_work_units_state ON work_units(state)",
  "CREATE INDEX idx_workflow_ingest_state_summary\n        ON workflow_ingest_state(summary_path)",
  "CREATE INDEX idx_workflow_ingest_state_updated\n        ON workflow_ingest_state(updated_at)",
  "CREATE INDEX idx_workflow_phases_run\n        ON workflow_phases(workflow_id, phase_index)",
  "CREATE INDEX idx_workflow_runs_session\n        ON workflow_runs(session_id, updated_at DESC)",
  "CREATE INDEX idx_workflow_runs_status\n        ON workflow_runs(status, updated_at DESC)",
  "CREATE INDEX idx_workflow_workers_conversation\n        ON workflow_workers(conversation_id)\n        WHERE conversation_id IS NOT NULL",
  "CREATE INDEX idx_workflow_workers_phase\n        ON workflow_workers(phase_id, worker_index)",
  "CREATE INDEX idx_workflow_workers_run\n        ON workflow_workers(workflow_id, worker_index)",
  "CREATE INDEX sessions_app_idx ON sessions(app)",
  "CREATE INDEX sessions_branch_idx ON sessions(branch) WHERE branch IS NOT NULL",
  "CREATE INDEX sessions_channel_idx\n        ON sessions(channel_connected_at) WHERE channel_connected_at IS NOT NULL",
  "CREATE INDEX sessions_nav_metadata_idx\n        ON sessions(nav_metadata_status, nav_metadata_next_retry_at)",
  "CREATE INDEX sessions_parent_idx ON sessions(parent_id)",
  "CREATE INDEX sessions_status_idx ON sessions(status)",
  "CREATE UNIQUE INDEX uq_user_bindings_active_scoped\n        ON user_bindings(binding_type, value, scope)\n        WHERE status = 'active' AND scope IS NOT NULL",
  "CREATE UNIQUE INDEX uq_user_bindings_active_unscoped\n        ON user_bindings(binding_type, value)\n        WHERE status = 'active' AND scope IS NULL",
  "CREATE UNIQUE INDEX uq_permission_grants_global\n        ON permission_grants(subject_type, subject_id, permission)\n        WHERE resource_type = 'global'",
  "CREATE UNIQUE INDEX uq_permission_grants_project\n        ON permission_grants(subject_type, subject_id, resource_id, permission)\n        WHERE resource_type = 'project'",
  "CREATE INDEX work_repos_excluded_idx ON work_repos(excluded)",
  "CREATE UNIQUE INDEX work_repos_id_idx ON work_repos(id)",
  "CREATE TRIGGER trg_work_units_assigned_session_insert_normalize\n     AFTER INSERT ON work_units\n     WHEN NEW.assigned_session_id IS NOT NULL AND trim(NEW.assigned_session_id) = ''\n     BEGIN\n       UPDATE work_units SET assigned_session_id = NULL WHERE id = NEW.id;\n     END",
  "CREATE TRIGGER trg_work_units_assigned_session_update_normalize\n     AFTER UPDATE OF assigned_session_id ON work_units\n     WHEN NEW.assigned_session_id IS NOT NULL AND trim(NEW.assigned_session_id) = ''\n     BEGIN\n       UPDATE work_units SET assigned_session_id = NULL WHERE id = NEW.id;\n     END",
  // Migration v136 (issue 5308097) — durable operational incidents and their
  // immutable executor observation and operator/server workflow event ledgers.
  `CREATE TABLE operational_incidents (
        id                         TEXT PRIMARY KEY,
        executor                   TEXT NOT NULL,
        task                       TEXT NOT NULL,
        condition                  TEXT NOT NULL
          CHECK(condition IN (
            'failed_permanent',
            'timeout',
            'circuit_open',
            'publish_stale',
            'publish_quarantined',
            'containment_blocked'
          )),
        first_seen                 INTEGER NOT NULL,

        observation_state          TEXT NOT NULL
          CHECK(observation_state IN ('active','recovered')),
        attention_state            TEXT NOT NULL DEFAULT 'unacknowledged'
          CHECK(attention_state IN ('unacknowledged','acknowledged')),
        remediation_state          TEXT NOT NULL DEFAULT 'none'
          CHECK(remediation_state IN (
            'none',
            'triaging',
            'fix_prepared',
            'awaiting_auth',
            'auth_expired',
            'awaiting_deploy',
            'awaiting_verification',
            'complete'
          )),

        latest_event_seq           INTEGER NOT NULL CHECK(latest_event_seq IN (1,2)),
        latest_observed_at         INTEGER NOT NULL,
        latest_event_id            TEXT NOT NULL,
        latest_telemetry_json      TEXT NOT NULL CHECK(json_valid(latest_telemetry_json)),
        latest_telemetry_sha256    TEXT NOT NULL CHECK(length(latest_telemetry_sha256) = 64),
        provenance                 TEXT NOT NULL DEFAULT 'executor_asserted_unverified'
          CHECK(provenance = 'executor_asserted_unverified'),
        posted_by_user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

        recovered_at               INTEGER,
        recovery_run_id            TEXT,
        acknowledged_at            INTEGER,
        acknowledged_by_user_id    TEXT REFERENCES users(id) ON DELETE RESTRICT,

        resolved_at                INTEGER,
        resolution_kind            TEXT
          CHECK(resolution_kind IS NULL OR
                resolution_kind IN ('successful_run','operator_closure')),
        operator_closed_at         INTEGER,
        operator_closed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,

        created_at                 INTEGER NOT NULL,
        updated_at                 INTEGER NOT NULL,

        UNIQUE(executor, task, condition, first_seen),

        CHECK(
          (observation_state = 'active'
            AND recovered_at IS NULL AND recovery_run_id IS NULL)
          OR
          (observation_state = 'recovered'
            AND recovered_at IS NOT NULL AND recovery_run_id IS NOT NULL)
        ),
        CHECK(
          (attention_state = 'unacknowledged'
            AND acknowledged_at IS NULL AND acknowledged_by_user_id IS NULL)
          OR
          (attention_state = 'acknowledged'
            AND acknowledged_at IS NOT NULL AND acknowledged_by_user_id IS NOT NULL)
        ),
        CHECK(
          (resolution_kind IS NULL AND resolved_at IS NULL)
          OR
          (resolution_kind IS NOT NULL AND resolved_at IS NOT NULL)
        ),
        CHECK(
          resolution_kind != 'successful_run'
          OR observation_state = 'recovered'
        ),
        CHECK(
          resolution_kind != 'operator_closure'
          OR (operator_closed_at IS NOT NULL
              AND operator_closed_by_user_id IS NOT NULL)
        ),
        CHECK(
          (resolved_at IS NULL AND remediation_state != 'complete')
          OR
          (resolved_at IS NOT NULL AND remediation_state = 'complete')
        )
      )`,
  `CREATE INDEX idx_operational_incidents_queue
        ON operational_incidents(
          resolved_at,
          observation_state,
          attention_state,
          first_seen DESC,
          id
        )`,
  `CREATE INDEX idx_operational_incidents_task_history
        ON operational_incidents(executor, task, condition, first_seen DESC)`,
  `CREATE INDEX idx_operational_incidents_badge
        ON operational_incidents(attention_state, first_seen DESC)
        WHERE resolved_at IS NULL
          AND observation_state = 'active'
          AND attention_state = 'unacknowledged'`,
  `CREATE TABLE operational_incident_observation_events (
        id                       TEXT PRIMARY KEY,
        incident_id              TEXT NOT NULL
          REFERENCES operational_incidents(id) ON DELETE RESTRICT,
        source_event_id          TEXT NOT NULL UNIQUE,
        event_seq                INTEGER NOT NULL CHECK(event_seq IN (1,2)),
        observation_state        TEXT NOT NULL
          CHECK(observation_state IN ('active','recovered')),
        observed_at              INTEGER NOT NULL,
        inventory_digest         TEXT NOT NULL CHECK(length(inventory_digest) = 64),
        telemetry_json           TEXT NOT NULL CHECK(json_valid(telemetry_json)),
        telemetry_sha256         TEXT NOT NULL CHECK(length(telemetry_sha256) = 64),
        posted_by_user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        received_at              INTEGER NOT NULL,
        applied                  INTEGER NOT NULL CHECK(applied IN (0,1)),
        ignored_reason           TEXT
          CHECK(ignored_reason IS NULL OR ignored_reason IN ('stale_sequence')),
        UNIQUE(incident_id, event_seq),
        CHECK(
          (event_seq = 1 AND observation_state = 'active')
          OR
          (event_seq = 2 AND observation_state = 'recovered')
        ),
        CHECK(
          (applied = 1 AND ignored_reason IS NULL)
          OR
          (applied = 0 AND ignored_reason IS NOT NULL)
        )
      )`,
  `CREATE INDEX idx_operational_incident_observations_incident
        ON operational_incident_observation_events(incident_id, event_seq)`,
  `CREATE INDEX idx_operational_incident_observations_received
        ON operational_incident_observation_events(received_at DESC, id)`,
  CANONICAL_AGENT_DISPATCH_SQL,
  `CREATE INDEX idx_agent_dispatch_events_issue
         ON agent_dispatch_events(issue_id, created_at DESC)`,
  `CREATE INDEX idx_agent_dispatch_events_incident
        ON agent_dispatch_events(incident_id, created_at DESC)`,
  `CREATE TABLE operational_incident_workflow_events (
        id                       TEXT PRIMARY KEY,
        incident_id              TEXT NOT NULL
          REFERENCES operational_incidents(id) ON DELETE RESTRICT,
        kind                     TEXT NOT NULL
          CHECK(kind IN (
            'attention_acknowledged',
            'operator_closed',
            'prepare_fix_confirmed',
            'dispatch_failed',
            'remediation_transition'
          )),
        authority                TEXT NOT NULL CHECK(authority IN ('user','server')),
        actor_user_id            TEXT REFERENCES users(id) ON DELETE RESTRICT,

        from_attention_state     TEXT
          CHECK(from_attention_state IS NULL OR
                from_attention_state IN ('unacknowledged','acknowledged')),
        to_attention_state       TEXT
          CHECK(to_attention_state IS NULL OR
                to_attention_state IN ('unacknowledged','acknowledged')),
        from_remediation_state   TEXT
          CHECK(from_remediation_state IS NULL OR
                from_remediation_state IN (
                  'none','triaging','fix_prepared','awaiting_auth','auth_expired',
                  'awaiting_deploy','awaiting_verification','complete'
                )),
        to_remediation_state     TEXT
          CHECK(to_remediation_state IS NULL OR
                to_remediation_state IN (
                  'none','triaging','fix_prepared','awaiting_auth','auth_expired',
                  'awaiting_deploy','awaiting_verification','complete'
                )),

        agent_dispatch_event_id  TEXT
          REFERENCES agent_dispatch_events(id) ON DELETE RESTRICT,
        auth_request_id          TEXT,
        deploy_ref               TEXT,
        verification_run_id      TEXT,
        reason                   TEXT,
        metadata_json            TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
        created_at               INTEGER NOT NULL,

        CHECK(authority != 'user' OR actor_user_id IS NOT NULL)
      )`,
  `CREATE INDEX idx_operational_incident_workflow_incident
        ON operational_incident_workflow_events(incident_id, created_at, id)`,
  `CREATE INDEX idx_operational_incident_workflow_dispatch
        ON operational_incident_workflow_events(agent_dispatch_event_id)
        WHERE agent_dispatch_event_id IS NOT NULL`,
  `CREATE INDEX idx_operational_incident_workflow_auth
        ON operational_incident_workflow_events(auth_request_id)
        WHERE auth_request_id IS NOT NULL`,
  `CREATE TABLE task_inventory_generations (
        id                TEXT PRIMARY KEY,
        digest            TEXT NOT NULL,
        schema_id         TEXT NOT NULL,
        executor_name     TEXT NOT NULL,
        executor_version  TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]'
                            CHECK(json_valid(capabilities_json)
                              AND json_type(capabilities_json)='array'),
        observed_at       INTEGER NOT NULL,
        task_count        INTEGER NOT NULL DEFAULT 0,
        payload_json      TEXT NOT NULL CHECK(json_valid(payload_json)),
        posted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at        INTEGER NOT NULL,
        UNIQUE(executor_name, digest)
      )`,
  `CREATE INDEX idx_task_inventory_generations_executor
         ON task_inventory_generations(executor_name, observed_at DESC, created_at DESC)`,
  `CREATE INDEX idx_task_inventory_generations_received
         ON task_inventory_generations(created_at DESC)`,
  ...TASK_ACTIVATION_SCHEMA_SQL,
  TASK_COMMAND_REQUESTS_V2_SQL,
  TASK_COMMAND_V2_INDEX_SQL[0],
  TASK_COMMAND_EVENTS_V2_SQL,
  ...TASK_COMMAND_V2_INDEX_SQL.slice(1),
  ...BRIEFING_SCHEMA_SQL,
  ...CONVERSATION_SOURCE_SCHEMA_SQL,
  ...ARTIFACT_SOURCE_SCHEMA_SQL,
  ...ARTIFACT_CUSTODY_TRIGGERS_SQL,
  ...CANDIDATE_ACCEPTANCE_SCHEMA_SQL,
  ...ISSUE_SEARCH_SCHEMA_SQL,
  ...PROTECTED_BASE_AUDIT_SCHEMA_SQL,
];

const DEFAULT_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  [
    "protected_branches",
    "main,develop"
  ],
  [
    "subagent_panes_enabled",
    "false"
  ],
  [
    "claude_notifications_enabled",
    "true"
  ],
  [
    "codex_notifications_enabled",
    "true"
  ],
  [
    "notification_sound",
    "Blow"
  ],
  [
    "quiet_hours",
    ""
  ],
  [
    "pretool_hooks_enabled",
    "true"
  ],
  [
    "log_retention_days",
    "7"
  ],
  [
    "theme",
    "catppuccin-mocha"
  ],
  [
    "prompt",
    "powerlevel10k"
  ],
  [
    "multiplexer",
    "both"
  ],
  [
    "console_pinned_sessions",
    "[]"
  ],
  [
    "console_operator_session_id",
    ""
  ],
  [
    "push_same_name_upstream",
    "true"
  ],
  [
    "inbox.project_grace_days",
    "7"
  ],
  [
    "inbox.global_grace_days",
    "30"
  ],
  [
    "auth_auto_approve_duration_minutes",
    "60"
  ],
  [
    "ledger.issues.read_mode",
    "scanner"
  ],
  [
    "ledger.issues.write_mode",
    "git_bug"
  ],
  [
    "ledger.issues.shadow_report_enabled",
    "true"
  ],
  [
    "ledger.issues.fallback_on_ledger_error",
    "true"
  ],
  [
    "app_theme",
    "system"
  ],
  [
    "stderr_rotation_max_bytes",
    "16777216"
  ],
  [
    "stderr_rotation_keep_segments",
    "5"
  ]
];

interface BaselineAuthHook {
  id: string;
  repo_pattern: string;
  auth_type: string;
  command: string;
  label: string;
  enabled: number;
  builtin: number;
  position: number;
}

const BUILTIN_AUTH_HOOKS: readonly BaselineAuthHook[] = [
  {
    "id": "builtin-mandible-rebuild",
    "repo_pattern": "mandible",
    "auth_type": "merge",
    "command": "bash cli/post-merge-build-dist.sh",
    "label": "Build Mandible and install instructions after merge",
    "enabled": 1,
    "builtin": 1,
    "position": 0
  },
  {
    "id": "builtin-dotfiles-agent-instructions",
    "repo_pattern": ".dotfiles",
    "auth_type": "merge",
    "command": DOTFILES_INSTRUCTION_COMMAND,
    "label": DOTFILES_INSTRUCTION_LABEL,
    "enabled": 1,
    "builtin": 1,
    "position": 0
  },
  {
    "id": "builtin-dotfiles-agent-instructions-nodot",
    "repo_pattern": "dotfiles",
    "auth_type": "merge",
    "command": DOTFILES_INSTRUCTION_COMMAND,
    "label": DOTFILES_INSTRUCTION_LABEL,
    "enabled": 1,
    "builtin": 1,
    "position": 0
  },
  {
    "id": "builtin-dotfiles-agent-schedule-deploy",
    "repo_pattern": ".dotfiles",
    "auth_type": "merge",
    "command": "set -o pipefail\nbase=$(git rev-parse --verify -q HEAD^1 || git rev-parse --verify -q HEAD~1)\nif [ -z \"$base\" ]; then echo \"agent-schedule deploy hook: cannot resolve the merge parent\" >&2; exit 1; fi\nif [ -z \"$(git diff --name-only \"$base\" HEAD -- agents/)\" ]; then echo \"no agents/ changes in this merge; skipping agent-schedule deploy\"; exit 0; fi\nsched=\"\"\nfor candidate in \"$HOME/.local/bin/agent-schedule\" \"$HOME/.dotfiles/bin/agent-schedule\"; do\n  if [ -x \"$candidate\" ]; then sched=\"$candidate\"; break; fi\ndone\nif [ -z \"$sched\" ]; then echo \"agent-schedule deploy hook: agent-schedule executable not found\" >&2; exit 1; fi\n\"$sched\" deploy",
    "label": "Deploy the agent-schedule bundle after an agents/ merge",
    "enabled": 1,
    "builtin": 1,
    "position": 10
  },
  {
    "id": "builtin-dotfiles-agent-schedule-deploy-nodot",
    "repo_pattern": "dotfiles",
    "auth_type": "merge",
    "command": "set -o pipefail\nbase=$(git rev-parse --verify -q HEAD^1 || git rev-parse --verify -q HEAD~1)\nif [ -z \"$base\" ]; then echo \"agent-schedule deploy hook: cannot resolve the merge parent\" >&2; exit 1; fi\nif [ -z \"$(git diff --name-only \"$base\" HEAD -- agents/)\" ]; then echo \"no agents/ changes in this merge; skipping agent-schedule deploy\"; exit 0; fi\nsched=\"\"\nfor candidate in \"$HOME/.local/bin/agent-schedule\" \"$HOME/.dotfiles/bin/agent-schedule\"; do\n  if [ -x \"$candidate\" ]; then sched=\"$candidate\"; break; fi\ndone\nif [ -z \"$sched\" ]; then echo \"agent-schedule deploy hook: agent-schedule executable not found\" >&2; exit 1; fi\n\"$sched\" deploy",
    "label": "Deploy the agent-schedule bundle after an agents/ merge",
    "enabled": 1,
    "builtin": 1,
    "position": 10
  }
];

export function createFreshSchemaBaseline(db: Db, schemaVersion: number): void {
  if (schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `Fresh schema baseline is v${BASELINE_SCHEMA_VERSION}, but migration head is v${schemaVersion}`,
    );
  }

  const create = db.transaction(() => {
    for (const statement of [...HEAD_SCHEMA_STATEMENTS, ...SPACE_PUBLICATION_SCHEMA_SQL]) {
      const executable = statement.startsWith("CREATE TABLE auth_requests")
        ? statement.replace(
            ", supersedes_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT, superseded_by_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT",
            "",
          )
        : statement;
      db.exec(executable);
    }
    db.exec("ALTER TABLE auth_requests ADD COLUMN requester_evidence_method TEXT");
    db.exec("ALTER TABLE auth_requests ADD COLUMN requester_credential_id TEXT REFERENCES user_credentials(id) ON DELETE RESTRICT");
    for (const statement of AUTH_CLEARANCE_SCHEMA_SQL.filter((sql) => !sql.includes("auth_requests_clearance_review_frozen"))) {
      db.exec(statement);
    }
    db.exec("ALTER TABLE auth_requests ADD COLUMN clearance_use_id TEXT REFERENCES auth_clearance_uses(id) ON DELETE RESTRICT");
    db.exec("ALTER TABLE auth_requests ADD COLUMN supersedes_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT");
    db.exec("ALTER TABLE auth_requests ADD COLUMN superseded_by_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT");
    db.exec("ALTER TABLE auth_requests ADD COLUMN custody_work_unit_id TEXT REFERENCES work_units(id) ON DELETE RESTRICT");
    db.exec(`ALTER TABLE auth_requests ADD COLUMN change_report_json TEXT
      CHECK(change_report_json IS NULL OR (
        json_valid(change_report_json)
        AND json_extract(change_report_json, '$.schema') = 'mandible-auth-change-report@1'
        AND json_type(change_report_json, '$.files') = 'array'
        AND json_extract(change_report_json, '$.totals.files') = json_array_length(json_extract(change_report_json, '$.files'))
      ))`);
    db.exec(`CREATE TRIGGER auth_change_report_insert_consistent
      BEFORE INSERT ON auth_requests
      WHEN NEW.change_report_json IS NOT NULL AND (
        NEW.files_changed IS NOT json_extract(NEW.change_report_json, '$.totals.files')
        OR NEW.additions IS NOT json_extract(NEW.change_report_json, '$.totals.additions')
        OR NEW.deletions IS NOT json_extract(NEW.change_report_json, '$.totals.deletions')
      )
      BEGIN SELECT RAISE(ABORT, 'auth change report totals must own headline counts'); END`);
    db.exec(`CREATE TRIGGER auth_change_report_immutable_update
      BEFORE UPDATE OF change_report_json ON auth_requests
      WHEN OLD.change_report_json IS NOT NEW.change_report_json
      BEGIN SELECT RAISE(ABORT, 'auth change reports are immutable'); END`);
    db.exec(`CREATE TRIGGER auth_change_report_counts_immutable_update
      BEFORE UPDATE OF files_changed, additions, deletions ON auth_requests
      WHEN OLD.change_report_json IS NOT NULL AND (
        OLD.files_changed IS NOT NEW.files_changed
        OR OLD.additions IS NOT NEW.additions
        OR OLD.deletions IS NOT NEW.deletions
      )
      BEGIN SELECT RAISE(ABORT, 'captured auth headline counts are immutable'); END`);
    db.exec("ALTER TABLE work_units ADD COLUMN owner_credential_id TEXT REFERENCES user_credentials(id) ON DELETE RESTRICT");
    // Match forward migration order: publication binding follows all prior auth columns.
    for (const statement of SPACE_PUBLICATION_AUTH_SCHEMA_SQL) db.exec(statement);
    db.exec(AUTH_PROTECTED_ROOT_DIRTY_ACTION_COLUMN_SQL);
    db.exec("ALTER TABLE work_units ADD COLUMN custody_generation INTEGER NOT NULL DEFAULT 0 CHECK(custody_generation >= 0)");
    db.exec("ALTER TABLE auth_request_actions ADD COLUMN replacement_action_id TEXT REFERENCES auth_request_actions(id) ON DELETE RESTRICT");
    const clearanceFreezeTrigger = AUTH_CLEARANCE_SCHEMA_SQL.find((sql) => sql.includes("auth_requests_clearance_review_frozen"));
    if (clearanceFreezeTrigger) db.exec(clearanceFreezeTrigger);
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run("schema_version", String(schemaVersion));

    const now = Date.now();
    const insertSetting = db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
    );
    for (const [key, value] of DEFAULT_SETTINGS) {
      insertSetting.run(key, value, now);
    }

    const insertAuthHook = db.prepare(`
      INSERT INTO auth_hooks (
        id, repo_pattern, auth_type, command, label, enabled, builtin, position,
        created_at, updated_at
      ) VALUES (
        @id, @repo_pattern, @auth_type, @command, @label, @enabled, @builtin, @position,
        @created_at, @updated_at
      )
    `);
    for (const hook of BUILTIN_AUTH_HOOKS) {
      insertAuthHook.run({ ...hook, created_at: now, updated_at: now });
    }

    // Seed the single canonical `system` user, matching migration v107. Fixed
    // sentinel id and created_at/updated_at=0 so a fresh-baseline DB and a fully
    // migrated DB carry byte-identical seed rows. The local human operator is
    // never seeded here — only `mandible user setup` creates it.
    db.prepare(
      `INSERT OR IGNORE INTO users (
        id, slug, kind, display_name, email, status, created_at, updated_at, metadata_json
      ) VALUES (
        '00000000000000000000000000', 'system', 'system', 'System', NULL, 'active', 0, 0, '{}'
      )`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO user_groups (
        id, slug, display_name, kind, created_at, updated_at
      ) VALUES (
        '00000000000000000000000001', 'agents', 'Agents', 'system', 0, 0
      )`,
    ).run();
  });

  create();
}
