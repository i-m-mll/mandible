import { SPACE_PUBLICATION_AUTH_SCHEMA_SQL } from "./spaces/publication-auth-schema.js";
import { SPACE_PUBLICATION_SCHEMA_SQL } from "./spaces/publication-schema.js";
import { preserveLegacyDocuments } from "./spaces/history.js";
import { artifactDescriptiveMetadataJson } from "./artifact-metadata.js";
import { CONVERSATION_RUNTIME_SCHEMA_SQL } from "./conversation-control/runtime-schema.js";
import { reconcileRecoveredArtifactSources } from './artifact-source-recovery.js';
import { recoverArtifactCustody } from './artifact-recovery.js';
import { retainArtifactCommit } from './artifact-repo-resolution.js';
import { ARTIFACT_CUSTODY_MIGRATION_SQL, ARTIFACT_CUSTODY_TRIGGERS_SQL } from './artifact-custody-schema.js';
import { ARTIFACT_SOURCE_SCHEMA_SQL, ARTIFACT_SOURCE_BACKFILL_SQL } from './artifact-source-schema.js';
import {
  BASELINE_SCHEMA_VERSION,
  createFreshSchemaBaseline,
  USER_SETTINGS_SCHEMA_SQL,
} from "./db-baseline.js";
import type { Db } from "./db.js";
import { createHash } from "node:crypto";
import { CONVERSATION_CONTROL_SCHEMA_V163_SQL, CONVERSATION_CONTROL_PENDING_IDENTITY_MIGRATION_SQL } from "./conversation-control/schema.js";
import {
  CONVERSATION_SPAWN_SCHEMA_SQL,
  CONVERSATION_SPAWN_SCHEMA_V2_SQL,
  CONVERSATION_SPAWN_SCHEMA_V1_SQL,
} from "./conversation-spawn/schema.js";
import {
  BRIEFING_COMPOSER_SCHEMA_V165_SQL,
  BRIEFING_COMPOSER_SCHEMA_V171_SQL,
  BRIEFING_DESTINATION_MUTATION_SCHEMA_SQL,
  BRIEFING_GROUP_REVIEW_SCHEMA_V167_SQL,
  BRIEFING_GROUP_SCHEMA_SQL,
} from "./feedback/schema.js";
import { TASK_ACTIVATION_SCHEMA_SQL } from "./task-activation-schema.js";
import { DOTFILES_INSTRUCTION_HOOK_MIGRATION_SQL } from "./dotfiles-instruction-hook.js";

const SCHEMA_VERSION_KEY = "schema_version";

// Historical migration 170 admitted one user-scoped Chat view preference. Keep
// its exact intermediate schema here: migrations are a byte-for-byte history,
// while USER_SETTINGS_SCHEMA_SQL is the current baseline used by migration 171.
const USER_SETTINGS_V170_SCHEMA_SQL = `CREATE TABLE user_settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL CHECK(key IN ('app_rail_order', 'ui_font_face', 'ui_font_size', 'detail_font_face', 'detail_font_size', 'chat_bottom_shelf')),
        value TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, key)
      )`;

export interface Migration {
  version: number;
  name: string;
  statements: string[];
  /** SQLite cannot toggle foreign_keys from inside a transaction. */
  requires_foreign_keys_off?: boolean;
}

/**
 * The oldest schema version this build can open.
 *
 * `src/db-baseline.ts` IS the schema: it is the single representation of the
 * head shape, applied verbatim to a fresh database. `MIGRATIONS` carries only
 * what landed after the floor was last raised, and moves a database at or above
 * the floor to that same head shape. A database below the floor is refused
 * loudly rather than migrated, because this build no longer carries the
 * statements that would move it forward.
 */
export const MINIMUM_SUPPORTED_SCHEMA_VERSION = 158;

/**
 * Retire the legacy artifact model (`artifacts`, `artifact_series`,
 * `artifact_versions`) and the legacy foreign keys that reach into it.
 *
 * The canonical model (`artifact_blob`, `artifact`, `artifact_version`) is
 * authoritative and is a legitimate SUPERSET of the legacy rows: a canonical
 * artifact may carry versions the legacy series never had. Nothing here copies
 * a legacy counter or latest-version pointer back over canonical state.
 *
 * Four things are ported forward before the legacy rows go, because they are
 * facts the canonical rows did not yet carry:
 *
 *  1. A legacy artifact id that is not the default `artifact:sha256:<hash>`
 *     spelling (the `artifact:ref:<hash>` external-reference locators) becomes
 *     `artifact_blob.metadata_json.$.compatibility_artifact_id`, which is the
 *     field the canonical resolver already reads for those refs. Durable text
 *     in the ledger names those ids, so they must keep resolving.
 *  2. A legacy `uri` with no canonical equivalent becomes the blob's
 *     `reference_json.$.uri`, the locator slot for non-custodied bytes.
 *  3. A legacy `home_repo_id` / `repo_locator_json` with no canonical
 *     equivalent becomes `metadata_json.$.home_repo_id` and
 *     `$.repo_locator`, the slots `projectCanonicalArtifactRecord` reads. A
 *     `link`-custody blob resolves its bytes through that locator and nothing
 *     else, so dropping it makes the content unreadable while every row
 *     survives. Rehearsal against a copy of the live database found 96 blobs
 *     in exactly that state.
 *  4. A blob id that is not `artifact-blob:<content_hash>` is normalized to
 *     that spelling, along with every column that references it. Those ids
 *     were built from the legacy artifact id by an older backfill, so hash
 *     lookups could not find them.
 *
 * The guards are generic predicates over the whole database, not assertions
 * about one machine's rows: each writes a count into a CHECK-constrained temp
 * table, so a nonzero count aborts the surrounding migration transaction and
 * leaves the database at v159.
 */
const RETIRE_LEGACY_ARTIFACT_MODEL: string[] = [
  // Rewriting primary keys their own children reference means rows are briefly
  // inconsistent. Defer enforcement to COMMIT rather than dropping it.
  "PRAGMA defer_foreign_keys = ON",

  `CREATE TEMP TABLE artifact_retirement_guard (
     check_name TEXT PRIMARY KEY,
     offending  INTEGER NOT NULL CHECK (offending = 0)
   )`,

  // A referenced legacy artifact must already exist canonically. An
  // unreferenced one (no alias, link, or version) is dropped with the table.
  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'referenced_legacy_artifact_without_canonical_blob', COUNT(*)
     FROM artifacts a
    WHERE NOT EXISTS (
            SELECT 1 FROM artifact_blob b
             WHERE b.algorithm = a.algorithm AND b.content_hash = a.content_hash)
      AND (EXISTS (SELECT 1 FROM artifact_aliases al WHERE al.artifact_id = a.id)
        OR EXISTS (SELECT 1 FROM artifact_links l WHERE l.artifact_id = a.id)
        OR EXISTS (SELECT 1 FROM artifact_versions v WHERE v.artifact_id = a.id)
        OR EXISTS (SELECT 1 FROM space_exports s
                    WHERE s.last_export_artifact_id = a.id
                       OR s.pre_export_snapshot_artifact_id = a.id)
        OR EXISTS (SELECT 1 FROM provider_manifests m WHERE m.artifact_id = a.id))`,

  // Every legacy series is the same logical artifact as its canonical row.
  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'legacy_series_without_matching_canonical_artifact', COUNT(*)
     FROM artifact_series s
    WHERE NOT EXISTS (
      SELECT 1 FROM artifact a
       WHERE a.id = 'artifact:' || substr(s.id, length('artifact-series:') + 1)
         AND a.identity_key = s.series_key)`,

  // Canonical may be ahead of legacy; it may never be behind it.
  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'canonical_artifact_behind_legacy_series', COUNT(*)
     FROM artifact_series s
     JOIN artifact a
       ON a.id = 'artifact:' || substr(s.id, length('artifact-series:') + 1)
    WHERE a.version_count < s.version_count`,

  // Every legacy version id is already the canonical version id, same number
  // and same bytes.
  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'legacy_version_without_matching_canonical_version', COUNT(*)
     FROM artifact_versions v
    WHERE NOT EXISTS (
      SELECT 1 FROM artifact_version cv
       WHERE cv.id = v.id
         AND cv.version_no = v.version_no
         AND cv.content_hash = v.content_hash
         AND cv.artifact_id = 'artifact:' || substr(v.series_id, length('artifact-series:') + 1))`,

  // A link's legacy artifact id and its canonical blob must name the same
  // bytes, and the duplicate legacy_blob_id must not disagree with blob_id.
  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'artifact_link_legacy_and_canonical_target_disagree', COUNT(*)
     FROM artifact_links l
    WHERE (l.legacy_blob_id IS NOT NULL AND l.legacy_blob_id <> l.blob_id)
       OR (l.artifact_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM artifacts a JOIN artifact_blob b
                    ON b.algorithm = a.algorithm AND b.content_hash = a.content_hash
              WHERE a.id = l.artifact_id AND b.id = l.blob_id))`,

  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'artifact_alias_legacy_and_canonical_target_disagree', COUNT(*)
     FROM artifact_aliases al
    WHERE al.artifact_id IS NOT NULL AND al.blob_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM artifacts a JOIN artifact_blob b
             ON b.algorithm = a.algorithm AND b.content_hash = a.content_hash
       WHERE a.id = al.artifact_id AND b.id = al.blob_id)`,

  // A living link's stored series id is exactly its canonical target spelled
  // the old way, so the column carries no fact the target does not.
  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'living_link_series_id_not_derivable_from_target', COUNT(*)
     FROM artifact_links l
    WHERE l.series_id IS NOT NULL
      AND l.series_id <> 'artifact-series:' || substr(l.target_id, length('artifact:') + 1)`,

  // Space exports and provider manifests must already carry their canonical
  // target wherever they carry a legacy one.
  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'space_export_legacy_artifact_without_blob', COUNT(*)
     FROM space_exports s
    WHERE (s.last_export_artifact_id IS NOT NULL AND s.last_export_blob_id IS NULL)
       OR (s.pre_export_snapshot_artifact_id IS NOT NULL AND s.pre_export_snapshot_blob_id IS NULL)`,

  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'provider_manifest_artifact_without_canonical_blob', COUNT(*)
     FROM provider_manifests m
    WHERE m.artifact_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM artifacts a JOIN artifact_blob b
               ON b.algorithm = a.algorithm AND b.content_hash = a.content_hash
         WHERE a.id = m.artifact_id)`,

  // A draft must resolve to a canonical artifact and version, directly or
  // through its legacy series/base pair.
  `INSERT INTO artifact_retirement_guard (check_name, offending)
   SELECT 'draft_without_canonical_artifact_or_version', COUNT(*)
     FROM artifact_drafts d
    WHERE COALESCE(d.artifact_id,
            CASE WHEN d.series_id IS NULL THEN NULL
                 ELSE 'artifact:' || substr(d.series_id, length('artifact-series:') + 1) END) IS NULL
       OR COALESCE(d.version_id, d.base_version_id) IS NULL`,

  // --- Port legacy-only facts into the canonical rows -----------------------

  // 1. Non-default legacy ids become the blob's compatibility id.
  `UPDATE artifact_blob
      SET metadata_json = json_set(
            CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
            '$.compatibility_artifact_id',
            (SELECT a.id FROM artifacts a
              WHERE a.algorithm = artifact_blob.algorithm
                AND a.content_hash = artifact_blob.content_hash))
    WHERE json_extract(
            CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
            '$.compatibility_artifact_id') IS NULL
      AND EXISTS (
        SELECT 1 FROM artifacts a
         WHERE a.algorithm = artifact_blob.algorithm
           AND a.content_hash = artifact_blob.content_hash
           AND a.id <> 'artifact:sha256:' || a.content_hash)`,

  // 2. A legacy locator the canonical row never recorded.
  `UPDATE artifact_blob
      SET reference_json = json_set(
            CASE WHEN json_valid(reference_json) THEN reference_json ELSE '{}' END,
            '$.uri',
            (SELECT a.uri FROM artifacts a
              WHERE a.algorithm = artifact_blob.algorithm
                AND a.content_hash = artifact_blob.content_hash))
    WHERE storage_uri IS NULL
      AND json_extract(
            CASE WHEN json_valid(reference_json) THEN reference_json ELSE '{}' END,
            '$.uri') IS NULL
      AND EXISTS (
        SELECT 1 FROM artifacts a
         WHERE a.algorithm = artifact_blob.algorithm
           AND a.content_hash = artifact_blob.content_hash
           AND a.uri IS NOT NULL AND a.uri <> '')`,

  // 3. A legacy repo locator the canonical row never recorded. Without it a
  //    `link`-custody blob has nothing to resolve its bytes from, so the
  //    content becomes unreadable even though every row survives.
  `UPDATE artifact_blob
      SET metadata_json = json_set(
            CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
            '$.home_repo_id',
            (SELECT a.home_repo_id FROM artifacts a
              WHERE a.algorithm = artifact_blob.algorithm
                AND a.content_hash = artifact_blob.content_hash))
    WHERE json_extract(
            CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
            '$.home_repo_id') IS NULL
      AND EXISTS (
        SELECT 1 FROM artifacts a
         WHERE a.algorithm = artifact_blob.algorithm
           AND a.content_hash = artifact_blob.content_hash
           AND a.home_repo_id IS NOT NULL AND a.home_repo_id <> '')`,

  `UPDATE artifact_blob
      SET metadata_json = json_set(
            CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
            '$.repo_locator',
            json((SELECT a.repo_locator_json FROM artifacts a
                   WHERE a.algorithm = artifact_blob.algorithm
                     AND a.content_hash = artifact_blob.content_hash)))
    WHERE json_extract(
            CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
            '$.repo_locator') IS NULL
      AND EXISTS (
        SELECT 1 FROM artifacts a
         WHERE a.algorithm = artifact_blob.algorithm
           AND a.content_hash = artifact_blob.content_hash
           AND json_valid(a.repo_locator_json)
           AND a.repo_locator_json NOT IN ('', '{}'))`,

  // 4. Normalize blob ids that were built from a legacy artifact id, and every
  //    column that references one. Children first is fine: enforcement is
  //    deferred to COMMIT.
  `UPDATE artifact_version SET blob_id = 'artifact-blob:' || (
     SELECT b.content_hash FROM artifact_blob b WHERE b.id = artifact_version.blob_id)
    WHERE blob_id IN (SELECT id FROM artifact_blob WHERE id <> 'artifact-blob:' || content_hash)`,
  `UPDATE artifact_aliases SET blob_id = 'artifact-blob:' || (
     SELECT b.content_hash FROM artifact_blob b WHERE b.id = artifact_aliases.blob_id)
    WHERE blob_id IN (SELECT id FROM artifact_blob WHERE id <> 'artifact-blob:' || content_hash)`,
  `UPDATE artifact_links SET blob_id = 'artifact-blob:' || (
     SELECT b.content_hash FROM artifact_blob b WHERE b.id = artifact_links.blob_id)
    WHERE blob_id IN (SELECT id FROM artifact_blob WHERE id <> 'artifact-blob:' || content_hash)`,
  `UPDATE artifact_links SET target_id = 'artifact-blob:' || (
     SELECT b.content_hash FROM artifact_blob b WHERE b.id = artifact_links.target_id)
    WHERE target_type = 'artifact_blob'
      AND target_id IN (SELECT id FROM artifact_blob WHERE id <> 'artifact-blob:' || content_hash)`,
  `UPDATE space_exports SET last_export_blob_id = 'artifact-blob:' || (
     SELECT b.content_hash FROM artifact_blob b WHERE b.id = space_exports.last_export_blob_id)
    WHERE last_export_blob_id IN (SELECT id FROM artifact_blob WHERE id <> 'artifact-blob:' || content_hash)`,
  `UPDATE space_exports SET pre_export_snapshot_blob_id = 'artifact-blob:' || (
     SELECT b.content_hash FROM artifact_blob b WHERE b.id = space_exports.pre_export_snapshot_blob_id)
    WHERE pre_export_snapshot_blob_id IN (SELECT id FROM artifact_blob WHERE id <> 'artifact-blob:' || content_hash)`,
  `UPDATE artifact_blob SET id = 'artifact-blob:' || content_hash
    WHERE id <> 'artifact-blob:' || content_hash`,

  // --- Drop the legacy foreign keys -----------------------------------------

  `CREATE TABLE artifact_aliases__v160 (
          id                TEXT PRIMARY KEY,
          blob_id           TEXT REFERENCES artifact_blob(id) ON DELETE RESTRICT,
          scheme            TEXT NOT NULL,
          alias             TEXT NOT NULL,
          normalized_ref    TEXT NOT NULL,
          locator_json      TEXT NOT NULL DEFAULT '{}',
          resolution_status TEXT NOT NULL DEFAULT 'resolved'
            CHECK(resolution_status IN ('resolved','unresolved','ambiguous','unsupported')),
          source            TEXT NOT NULL DEFAULT 'artifact_registry',
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          CHECK (
            (resolution_status = 'resolved' AND blob_id IS NOT NULL) OR
            (resolution_status != 'resolved' AND blob_id IS NULL)
          )
        )`,
  `INSERT INTO artifact_aliases__v160 (
     id, blob_id, scheme, alias, normalized_ref, locator_json,
     resolution_status, source, created_at, updated_at)
   SELECT id, blob_id, scheme, alias, normalized_ref, locator_json,
          resolution_status, source, created_at, updated_at
     FROM artifact_aliases`,
  "DROP TABLE artifact_aliases",
  "ALTER TABLE artifact_aliases__v160 RENAME TO artifact_aliases",
  `CREATE INDEX idx_artifact_aliases_blob
      ON artifact_aliases(blob_id) WHERE blob_id IS NOT NULL`,
  `CREATE UNIQUE INDEX idx_artifact_aliases_scheme_ref
      ON artifact_aliases(scheme, normalized_ref)`,
  `CREATE INDEX idx_artifact_aliases_status
      ON artifact_aliases(resolution_status, scheme)`,

  `CREATE TABLE artifact_links__v160 (
          id                  TEXT PRIMARY KEY,
          blob_id             TEXT NOT NULL REFERENCES artifact_blob(id) ON DELETE RESTRICT,
          entity_type         TEXT NOT NULL,
          entity_id           TEXT NOT NULL,
          link_type           TEXT NOT NULL DEFAULT 'references',
          role                TEXT,
          repo_id             TEXT,
          provider_id         TEXT,
          source              TEXT NOT NULL DEFAULT 'artifact_registry',
          metadata_json       TEXT NOT NULL DEFAULT '{}',
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          link_kind           TEXT NOT NULL DEFAULT 'pinned'
            CHECK(link_kind IN ('pinned','living')),
          series_ref          TEXT,
          target_type         TEXT NOT NULL
            CHECK(target_type IN ('artifact','artifact_version','artifact_blob')),
          target_id           TEXT NOT NULL,
          fallback_version_id TEXT REFERENCES artifact_version(id) ON DELETE RESTRICT,
          CHECK (
            (link_kind = 'living' AND target_type = 'artifact') OR
            (link_kind = 'pinned' AND target_type IN ('artifact_version','artifact_blob'))
          )
        )`,
  `INSERT INTO artifact_links__v160 (
     id, blob_id, entity_type, entity_id, link_type, role, repo_id, provider_id,
     source, metadata_json, created_at, updated_at, link_kind, series_ref,
     target_type, target_id, fallback_version_id)
   SELECT id, blob_id, entity_type, entity_id, link_type, role, repo_id, provider_id,
          source, metadata_json, created_at, updated_at, link_kind, series_ref,
          target_type, target_id, fallback_version_id
     FROM artifact_links`,
  "DROP TABLE artifact_links",
  "ALTER TABLE artifact_links__v160 RENAME TO artifact_links",
  `CREATE INDEX idx_artifact_links_blob
      ON artifact_links(blob_id, link_type)`,
  `CREATE INDEX idx_artifact_links_entity
      ON artifact_links(entity_type, entity_id)`,
  `CREATE INDEX idx_artifact_links_fallback_version
      ON artifact_links(fallback_version_id) WHERE fallback_version_id IS NOT NULL`,
  "CREATE INDEX idx_artifact_links_kind ON artifact_links(link_kind)",
  `CREATE INDEX idx_artifact_links_provider
      ON artifact_links(provider_id) WHERE provider_id IS NOT NULL`,
  `CREATE INDEX idx_artifact_links_repo
      ON artifact_links(repo_id) WHERE repo_id IS NOT NULL`,
  `CREATE INDEX idx_artifact_links_role
      ON artifact_links(role) WHERE role IS NOT NULL`,
  `CREATE INDEX idx_artifact_links_target
      ON artifact_links(target_type, target_id)`,

  `CREATE TABLE artifact_drafts__v160 (
          id              TEXT PRIMARY KEY,
          artifact_id     TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
          version_id      TEXT NOT NULL REFERENCES artifact_version(id) ON DELETE RESTRICT,
          content         TEXT NOT NULL,
          media_type      TEXT,
          label           TEXT,
          note            TEXT,
          metadata_json   TEXT NOT NULL DEFAULT '{}',
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          UNIQUE(artifact_id)
        )`,
  `INSERT INTO artifact_drafts__v160 (
     id, artifact_id, version_id, content, media_type, label, note,
     metadata_json, created_at, updated_at)
   SELECT id,
          COALESCE(artifact_id,
            'artifact:' || substr(series_id, length('artifact-series:') + 1)),
          COALESCE(version_id, base_version_id),
          content, media_type, label, note, metadata_json, created_at, updated_at
     FROM artifact_drafts`,
  "DROP TABLE artifact_drafts",
  "ALTER TABLE artifact_drafts__v160 RENAME TO artifact_drafts",
  "CREATE INDEX idx_artifact_drafts_version ON artifact_drafts(version_id)",

  "ALTER TABLE space_exports DROP COLUMN last_export_artifact_id",
  "ALTER TABLE space_exports DROP COLUMN pre_export_snapshot_artifact_id",

  "ALTER TABLE provider_manifests ADD COLUMN blob_id TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL",
  `UPDATE provider_manifests SET blob_id = (
     SELECT b.id FROM artifacts a JOIN artifact_blob b
            ON b.algorithm = a.algorithm AND b.content_hash = a.content_hash
      WHERE a.id = provider_manifests.artifact_id)
    WHERE artifact_id IS NOT NULL`,
  "ALTER TABLE provider_manifests DROP COLUMN artifact_id",

  // --- Drop the legacy tables, children before parents ----------------------

  "DROP TABLE artifact_versions",
  "DROP TABLE artifact_series",
  "DROP TABLE artifacts",

  "DROP TABLE artifact_retirement_guard",
];

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 159,
    name: "drop_retired_git_bug_and_preset_tables",
    statements: [
      // Children before parents: convention_setting_links -> preset_nodes -> presets.
      // Nothing that survives references any of these tables.
      "DROP TABLE IF EXISTS convention_setting_links",
      "DROP TABLE IF EXISTS preset_nodes",
      "DROP TABLE IF EXISTS presets",
      "DROP TABLE IF EXISTS preset_diffs",
      "DROP TABLE IF EXISTS session_presets",
      "DROP TABLE IF EXISTS session_instruction_artifacts",
      "DROP TABLE IF EXISTS starred_chats",
      "DROP TABLE IF EXISTS ledger_outbox",
      "DROP TABLE IF EXISTS ledger_external_refs",
      "DROP TABLE IF EXISTS ledger_conflicts",
      "DROP TABLE IF EXISTS ledger_sync_jobs",
      "ALTER TABLE message_params DROP COLUMN preset_ids",
      // Completion markers for the retired v1-v158 post-DDL backfills.
      "DELETE FROM meta WHERE key LIKE 'post_migration.%'",
    ],
  },
  {
    version: 160,
    name: "retire_legacy_artifact_model",
    statements: RETIRE_LEGACY_ARTIFACT_MODEL,
  },
  {
    version: 161,
    name: "briefing_logical_artifact_identity",
    statements: [
      `CREATE TEMP TABLE briefing_lineage_guard (
         briefing_id TEXT PRIMARY KEY,
         logical_artifact_count INTEGER NOT NULL CHECK(logical_artifact_count <= 1)
       )`,
      `INSERT INTO briefing_lineage_guard (briefing_id, logical_artifact_count)
       SELECT r.briefing_id, COUNT(DISTINCT v.artifact_id)
         FROM briefing_rounds r
         JOIN artifact_version v ON v.id = r.artifact_version_id
        GROUP BY r.briefing_id`,
      "ALTER TABLE briefings ADD COLUMN logical_artifact_id TEXT REFERENCES artifact(id) ON DELETE RESTRICT",
      `UPDATE briefings
          SET logical_artifact_id = (
            SELECT v.artifact_id
              FROM briefing_rounds r
              JOIN artifact_version v ON v.id = r.artifact_version_id
             WHERE r.briefing_id = briefings.id
             ORDER BY r.ordinal
             LIMIT 1
          )
        WHERE EXISTS (SELECT 1 FROM briefing_rounds r WHERE r.briefing_id = briefings.id)`,
      "CREATE INDEX idx_briefings_logical_artifact ON briefings(logical_artifact_id, archived_at) WHERE logical_artifact_id IS NOT NULL",
      `CREATE TABLE briefing_creation_overrides (
         id TEXT PRIMARY KEY,
         briefing_id TEXT NOT NULL UNIQUE REFERENCES briefings(id) ON DELETE RESTRICT,
         logical_artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE RESTRICT,
         reason TEXT NOT NULL CHECK(trim(reason) != ''),
         actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
         evidence_method TEXT NOT NULL CHECK(evidence_method IN (
           'local_default','session_claim','external_import','credential_signature',
           'hardware_presence','delegated_lease','system_internal','api_token'
         )),
         credential_id TEXT REFERENCES user_credentials(id) ON DELETE RESTRICT,
         created_at INTEGER NOT NULL
       )`,
      `CREATE TRIGGER briefing_creation_overrides_immutable_update
         BEFORE UPDATE ON briefing_creation_overrides BEGIN
           SELECT RAISE(ABORT, 'briefing creation override receipts are immutable');
         END`,
      `CREATE TRIGGER briefing_creation_overrides_immutable_delete
         BEFORE DELETE ON briefing_creation_overrides BEGIN
           SELECT RAISE(ABORT, 'briefing creation override receipts are immutable');
         END`,
      "DROP TABLE briefing_lineage_guard",
    ],
  },
  {
    version: 162,
    name: "briefing_group_lifecycle_and_collection_placement",
    statements: [
      "ALTER TABLE briefing_groups ADD COLUMN archived_at INTEGER",
      "DROP INDEX idx_briefing_groups_current_bundle",
      `CREATE INDEX idx_briefing_groups_current_bundle
        ON briefing_groups(current_bundle_id) WHERE current_bundle_id IS NOT NULL`,
      "ALTER TABLE briefing_group_updates RENAME TO briefing_group_updates_v161",
      `CREATE TABLE briefing_group_updates (
        group_id TEXT NOT NULL REFERENCES briefing_groups(id) ON DELETE RESTRICT,
        bundle_id TEXT NOT NULL REFERENCES briefing_bundles(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK(position >= 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(group_id, bundle_id), UNIQUE(group_id, position) )`,
      `INSERT INTO briefing_group_updates (group_id, bundle_id, position, created_at)
        SELECT group_id, bundle_id, position, created_at FROM briefing_group_updates_v161`,
      "DROP TABLE briefing_group_updates_v161",
      `CREATE TABLE briefing_collection_sharing_receipts (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL CHECK(trim(operation) != ''),
        target_kind TEXT NOT NULL CHECK(target_kind IN ('group','bundle')),
        target_id TEXT NOT NULL CHECK(trim(target_id) != ''),
        subject_kind TEXT NOT NULL CHECK(subject_kind IN ('bundle','briefing')),
        subject_id TEXT NOT NULL CHECK(trim(subject_id) != ''),
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('group','bundle')),
        owner_id TEXT NOT NULL CHECK(trim(owner_id) != ''),
        reason TEXT NOT NULL CHECK(trim(reason) != ''),
        actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        evidence_method TEXT NOT NULL CHECK(evidence_method = 'api_token'),
        credential_id TEXT REFERENCES user_credentials(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL )`,
      `CREATE INDEX idx_briefing_collection_sharing_target
        ON briefing_collection_sharing_receipts(target_kind, target_id, created_at)`,
      `CREATE TRIGGER briefing_collection_sharing_receipts_immutable_update
        BEFORE UPDATE ON briefing_collection_sharing_receipts BEGIN
          SELECT RAISE(ABORT, 'Briefing collection sharing receipts are immutable');
        END`,
      `CREATE TRIGGER briefing_collection_sharing_receipts_immutable_delete
        BEFORE DELETE ON briefing_collection_sharing_receipts BEGIN
          SELECT RAISE(ABORT, 'Briefing collection sharing receipts are immutable');
        END`,
    ],
  },
  {
    version: 163,
    name: "authoritative_conversation_control",
    statements: [...CONVERSATION_CONTROL_SCHEMA_V163_SQL],
  },
  {
    version: 164,
    name: "bounded_ledger_change_feed",
    statements: [
      `CREATE TABLE ledger_change_feed_state (
        project_id TEXT PRIMARY KEY REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence >= 1),
        retained_from_sequence INTEGER NOT NULL DEFAULT 1 CHECK(retained_from_sequence >= 1),
        updated_at INTEGER NOT NULL,
        CHECK(retained_from_sequence <= next_sequence)
      )`,
      `CREATE TABLE ledger_change_log (
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL CHECK(sequence >= 1),
        event_id TEXT NOT NULL UNIQUE,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, sequence)
      )`,
      `CREATE INDEX idx_ledger_change_log_event
        ON ledger_change_log(event_id)`,
    ],
  },
  {
    version: 165,
    name: "base_relative_briefing_composer",
    statements: [...BRIEFING_COMPOSER_SCHEMA_V165_SQL],
  },
  {
    version: 166,
    name: "task_activation_health",
    statements: [...TASK_ACTIVATION_SCHEMA_SQL],
  },
  {
    version: 167,
    name: "human_reviewed_briefing_group_disposition",
    statements: [...BRIEFING_GROUP_REVIEW_SCHEMA_V167_SQL],
  },
  {
    version: 168,
    name: "conversation_turn_runtime_options",
    statements: [
      `ALTER TABLE conversation_control_outbox ADD COLUMN runtime_options_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(runtime_options_json) AND json_type(runtime_options_json) = 'object')`,
    ],
  },
  {
    version: 169,
    name: "mandible_conversation_spawn_authority",
    statements: [...CONVERSATION_SPAWN_SCHEMA_V1_SQL],
  },
  {
    version: 170,
    name: "chat_bottom_shelf_user_setting",
    statements: [
      "ALTER TABLE user_settings RENAME TO user_settings_v169",
      USER_SETTINGS_V170_SCHEMA_SQL,
      `INSERT INTO user_settings (user_id, key, value, revision, updated_at)
       SELECT user_id, key, value, revision, updated_at FROM user_settings_v169`,
      "DROP TABLE user_settings_v169",
    ],
  },
  {
    version: 171,
    name: "briefing_group_keys_and_destination_ownership",
    statements: [
      `CREATE TEMP TABLE briefing_destination_owner_guard (
        logical_artifact_id TEXT PRIMARY KEY,
        group_count INTEGER NOT NULL CHECK(group_count = 1),
        heading_count INTEGER NOT NULL CHECK(heading_count = 1),
        active_group_count INTEGER NOT NULL CHECK(active_group_count = 1),
        base_document_count INTEGER NOT NULL CHECK(base_document_count = 1)
      )`,
      `INSERT INTO briefing_destination_owner_guard (
         logical_artifact_id, group_count, heading_count, active_group_count, base_document_count)
       SELECT logical_artifact_id, COUNT(DISTINCT group_id),
         MAX((SELECT COUNT(*) FROM briefing_destination_routes sibling
           WHERE sibling.logical_artifact_id = route.logical_artifact_id
             AND sibling.heading = route.heading)),
         COUNT(DISTINCT CASE WHEN owner.archived_at IS NULL AND owner.current_bundle_id IS NOT NULL
           THEN owner.id END),
         MAX((SELECT COUNT(*)
           FROM briefing_bundle_members member
           JOIN briefings briefing ON briefing.id = member.briefing_id
           WHERE member.bundle_id = owner.current_bundle_id
             AND briefing.logical_artifact_id = route.logical_artifact_id
             AND briefing.archived_at IS NULL))
       FROM briefing_destination_routes route
       JOIN briefing_groups owner ON owner.id = route.group_id
       GROUP BY logical_artifact_id`,
      "DROP INDEX idx_briefing_groups_current_bundle",
      "DROP INDEX idx_briefing_group_dispositions_group",
      "DROP INDEX idx_briefing_group_review_dispositions_group",
      "DROP INDEX idx_briefing_composition_contributions_pending",
      "DROP TRIGGER briefing_group_review_disposition_items_bounded_insert",
      "DROP TRIGGER briefing_group_review_dispositions_immutable_update",
      "DROP TRIGGER briefing_group_review_dispositions_immutable_delete",
      "DROP TRIGGER briefing_group_review_disposition_items_immutable_update",
      "DROP TRIGGER briefing_group_review_disposition_items_immutable_delete",
      "ALTER TABLE briefing_group_review_disposition_items RENAME TO briefing_group_review_disposition_items_v170",
      "ALTER TABLE briefing_group_review_dispositions RENAME TO briefing_group_review_dispositions_v170",
      "ALTER TABLE briefing_group_dispositions RENAME TO briefing_group_dispositions_v170",
      "ALTER TABLE briefing_group_updates RENAME TO briefing_group_updates_v170",
      "ALTER TABLE briefing_destination_templates RENAME TO briefing_destination_templates_v170",
      "ALTER TABLE briefing_composition_inputs RENAME TO briefing_composition_inputs_v170",
      "ALTER TABLE briefing_composition_contributions RENAME TO briefing_composition_contributions_v170",
      "ALTER TABLE briefing_composition_targets RENAME TO briefing_composition_targets_v170",
      "ALTER TABLE briefing_destination_routes RENAME TO briefing_destination_routes_v170",
      "ALTER TABLE briefing_groups RENAME TO briefing_groups_v170",
      ...BRIEFING_GROUP_SCHEMA_SQL.map((sql) => sql.replace(
        "composition_run_id TEXT REFERENCES", "composition_run_id TEXT NOT NULL REFERENCES",
      )),
      ...BRIEFING_COMPOSER_SCHEMA_V171_SQL,
      `WITH RECURSIVE normalized (
          id, name, current_bundle_id, created_at, updated_at, archived_at, position, candidate
        ) AS (
          SELECT id, name, current_bundle_id, created_at, updated_at, archived_at, 1, ''
          FROM briefing_groups_v170
          UNION ALL
          SELECT id, name, current_bundle_id, created_at, updated_at, archived_at, position + 1,
            CASE
              WHEN length(substr(name, position, 1)) = 1
                AND lower(substr(name, position, 1)) GLOB '[a-z0-9]'
                THEN candidate || lower(substr(name, position, 1))
              WHEN substr(name, position, 1) IN ('''', '’') THEN candidate
              WHEN candidate = '' OR substr(candidate, -1, 1) = '-' THEN candidate
              ELSE candidate || '-'
            END
          FROM normalized WHERE position <= length(name)
        ), slugs AS (
          SELECT id, name, current_bundle_id, created_at, updated_at, archived_at,
            CASE WHEN rtrim(candidate, '-') = '' THEN 'group-' || substr(replace(id, '-', ''), 1, 12)
              ELSE substr(rtrim(candidate, '-'), 1, 80) END AS candidate
          FROM normalized WHERE position = length(name) + 1
        ), ranked AS (
          SELECT *, CASE WHEN archived_at IS NULL THEN
            row_number() OVER (PARTITION BY candidate, archived_at IS NULL ORDER BY created_at, id)
            ELSE 1 END AS active_rank
          FROM slugs
        )
        INSERT INTO briefing_groups (id, key, name, current_bundle_id, created_at, updated_at, archived_at)
        SELECT id,
          CASE WHEN archived_at IS NULL AND active_rank > 1
            THEN substr(candidate, 1, 40) || '-' || substr(replace(id, '-', ''), 1, 32)
            ELSE candidate END,
          name, current_bundle_id, created_at, updated_at, archived_at
        FROM ranked ORDER BY created_at, id`,
      `INSERT INTO briefing_group_updates (group_id, bundle_id, position, created_at)
       SELECT group_id, bundle_id, position, created_at FROM briefing_group_updates_v170`,
      `INSERT INTO briefing_group_dispositions (
         id, group_id, kind, prior_base_bundle_id, proposal_bundle_id, resulting_base_bundle_id,
         auth_request_id, merge_head_sha, created_at)
       SELECT id, group_id, kind, prior_base_bundle_id, proposal_bundle_id, resulting_base_bundle_id,
         auth_request_id, merge_head_sha, created_at FROM briefing_group_dispositions_v170`,
      `INSERT INTO briefing_group_review_dispositions (
         id, group_id, decision, expected_base_bundle_id, proposal_bundle_id, composition_run_id,
         resulting_base_bundle_id, base_layout_digest, proposal_layout_digest, binding_digest,
         manifest_json, item_count, destination_change_count, actor_user_id, evidence_method,
         credential_id, created_at)
       SELECT id, group_id, decision, expected_base_bundle_id, proposal_bundle_id, composition_run_id,
         resulting_base_bundle_id, NULL, NULL, binding_digest, manifest_json, item_count, 0,
         actor_user_id, evidence_method, credential_id, created_at
       FROM briefing_group_review_dispositions_v170`,
      `INSERT INTO briefing_group_review_disposition_items (
         disposition_id, position, proposal_briefing_id, proposal_round_id,
         proposal_artifact_version_id, base_briefing_id, base_round_id,
         base_artifact_version_id, submission_id)
       SELECT disposition_id, position, proposal_briefing_id, proposal_round_id,
         proposal_artifact_version_id, base_briefing_id, base_round_id,
         base_artifact_version_id, submission_id
       FROM briefing_group_review_disposition_items_v170`,
      `INSERT INTO briefing_destination_owners (
         logical_artifact_id, group_id, bound_by_user_id, evidence_method, credential_id,
         created_at, updated_at)
       SELECT logical_artifact_id, MIN(group_id), NULL, 'migration', NULL,
         MIN(created_at), MAX(updated_at)
       FROM briefing_destination_routes_v170 GROUP BY logical_artifact_id`,
      `INSERT INTO briefing_destination_routes (
         route_key, logical_artifact_id, heading, composer_kind, active_template_version,
         max_contributions, max_document_bytes, max_directives, created_at, updated_at)
       SELECT route_key, logical_artifact_id, heading, composer_kind, active_template_version,
         max_contributions, max_document_bytes, max_directives, created_at, updated_at
       FROM briefing_destination_routes_v170`,
      `INSERT INTO briefing_destination_templates (
         route_key, version, contribution_template, slots_json, created_at)
       SELECT route_key, version, contribution_template, slots_json, created_at
       FROM briefing_destination_templates_v170`,
      `INSERT INTO briefing_composition_inputs (
         run_id, route_key, expected_base_artifact_version_id, agentic_markdown)
       SELECT run_id, route_key, expected_base_artifact_version_id, agentic_markdown
       FROM briefing_composition_inputs_v170`,
      `INSERT INTO briefing_composition_contributions (
         id, run_id, publisher_user_id, source_key, route_key, change_id, evidence_ref,
         evidence_digest, occurred_at, slots_json, observed_base_artifact_version_id,
         state, proposal_bundle_id, created_at)
       SELECT id, run_id, publisher_user_id, source_key, route_key, change_id, evidence_ref,
         evidence_digest, occurred_at, slots_json, observed_base_artifact_version_id,
         state, proposal_bundle_id, created_at
       FROM briefing_composition_contributions_v170`,
      `INSERT INTO briefing_composition_targets (
         run_id, group_id, outcome, base_bundle_id, proposal_bundle_id)
       SELECT run_id, group_id, outcome, base_bundle_id, proposal_bundle_id
       FROM briefing_composition_targets_v170`,
      "DROP TABLE briefing_group_review_disposition_items_v170",
      "DROP TABLE briefing_group_review_dispositions_v170",
      "DROP TABLE briefing_group_dispositions_v170",
      "DROP TABLE briefing_group_updates_v170",
      "DROP TABLE briefing_destination_templates_v170",
      "DROP TABLE briefing_composition_inputs_v170",
      "DROP TABLE briefing_composition_contributions_v170",
      "DROP TABLE briefing_composition_targets_v170",
      "DROP TABLE briefing_destination_routes_v170",
      "DROP TABLE briefing_groups_v170",
      "DROP TABLE briefing_destination_owner_guard",
    ],
  },
  {
    version: 172,
    name: "remove_chat_bottom_shelf_user_setting",
    statements: [
      "ALTER TABLE user_settings RENAME TO user_settings_v171",
      USER_SETTINGS_SCHEMA_SQL,
      `INSERT INTO settings (key, value, updated_at)
       SELECT 'chat_entity_link_action', json_extract(legacy.value, '$.clickAction'), legacy.updated_at
         FROM user_settings_v171 legacy
        WHERE legacy.key = 'chat_bottom_shelf'
          AND legacy.user_id = (SELECT value FROM settings WHERE key = 'user.operator_id')
          AND json_valid(legacy.value)
          AND json_extract(legacy.value, '$.clickAction') IN ('preview', 'open')
       ON CONFLICT(key) DO NOTHING`,
      `INSERT INTO user_settings (user_id, key, value, revision, updated_at)
       SELECT user_id, key, value, revision, updated_at FROM user_settings_v171
       WHERE key <> 'chat_bottom_shelf'`,
      "DROP TABLE user_settings_v171",
    ],
  },
  {
    version: 173,
    name: "auth_request_immutable_lifecycle",
    statements: [
      "ALTER TABLE auth_requests ADD COLUMN supersedes_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT",
      "ALTER TABLE auth_requests ADD COLUMN superseded_by_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT",
      "ALTER TABLE auth_requests ADD COLUMN custody_work_unit_id TEXT REFERENCES work_units(id) ON DELETE RESTRICT",
      "ALTER TABLE work_units ADD COLUMN owner_credential_id TEXT REFERENCES user_credentials(id) ON DELETE RESTRICT",
      "ALTER TABLE work_units ADD COLUMN custody_generation INTEGER NOT NULL DEFAULT 0 CHECK(custody_generation >= 0)",
      "ALTER TABLE auth_request_actions ADD COLUMN replacement_action_id TEXT REFERENCES auth_request_actions(id) ON DELETE RESTRICT",
      `CREATE TABLE auth_request_lifecycle_events (
        id TEXT PRIMARY KEY,
        auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        event_type TEXT NOT NULL CHECK(event_type IN ('legacy_snapshot','submitted','revised','approved','executing','rejected','withdrawn','superseded','needs_rebase','expired','completed')),
        prior_status TEXT,
        next_status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
        prior_snapshot_json TEXT CHECK(prior_snapshot_json IS NULL OR json_valid(prior_snapshot_json)),
        prior_snapshot_sha256 TEXT CHECK(prior_snapshot_sha256 IS NULL OR length(prior_snapshot_sha256) = 64),
        actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        evidence_method TEXT,
        evidence_id TEXT,
        credential_id TEXT REFERENCES user_credentials(id) ON DELETE RESTRICT,
        reason TEXT,
        related_request_id TEXT REFERENCES auth_requests(id) ON DELETE RESTRICT,
        custody_work_unit_id TEXT REFERENCES work_units(id) ON DELETE RESTRICT,
        custody_generation INTEGER,
        authority_path TEXT CHECK(authority_path IN ('custodian','operator_recovery','system','legacy')),
        occurred_at INTEGER NOT NULL,
        UNIQUE(auth_request_id, revision)
      )`,
      "CREATE INDEX idx_auth_request_lifecycle_events_request ON auth_request_lifecycle_events(auth_request_id, revision)",
      `CREATE TRIGGER auth_request_lifecycle_events_immutable_update
        BEFORE UPDATE ON auth_request_lifecycle_events
        BEGIN SELECT RAISE(ABORT, 'auth request lifecycle events are immutable'); END`,
      `CREATE TRIGGER auth_request_lifecycle_events_immutable_delete
        BEFORE DELETE ON auth_request_lifecycle_events
        BEGIN SELECT RAISE(ABORT, 'auth request lifecycle events are immutable'); END`,
      `CREATE TABLE work_unit_custody_events (
        id TEXT PRIMARY KEY,
        work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
        prior_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        prior_credential_id TEXT REFERENCES user_credentials(id) ON DELETE RESTRICT,
        new_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        new_credential_id TEXT NOT NULL REFERENCES user_credentials(id) ON DELETE RESTRICT,
        prior_generation INTEGER NOT NULL,
        new_generation INTEGER NOT NULL CHECK(new_generation = prior_generation + 1),
        authority_path TEXT NOT NULL CHECK(authority_path IN ('initial_assignment','parent_role_handoff','operator_recovery')),
        parent_role_checkpoint_id TEXT REFERENCES ledger_issue_checkpoints(id) ON DELETE RESTRICT,
        operator_evidence_method TEXT,
        reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
        occurred_at INTEGER NOT NULL,
        UNIQUE(work_unit_id, new_generation)
      )`,
      `CREATE TRIGGER work_unit_custody_events_immutable_update
        BEFORE UPDATE ON work_unit_custody_events
        BEGIN SELECT RAISE(ABORT, 'work unit custody events are immutable'); END`,
      `CREATE TRIGGER work_unit_custody_events_immutable_delete
        BEFORE DELETE ON work_unit_custody_events
        BEGIN SELECT RAISE(ABORT, 'work unit custody events are immutable'); END`,
      `WITH snapshots AS (
        SELECT ar.*,
          json_object(
            'request', json_object(
              'id', ar.id, 'session_id', ar.session_id, 'requested_by_user_id', ar.requested_by_user_id,
              'requester_evidence_method', ar.requester_evidence_method,
              'requester_credential_id', ar.requester_credential_id, 'type', ar.type,
              'command', ar.command, 'title', ar.title, 'cwd', ar.cwd, 'status', ar.status,
              'repo', ar.repo, 'base_branch', ar.base_branch, 'head_branch', ar.head_branch,
              'merge_head_sha', ar.merge_head_sha, 'issue_references', json(ar.issue_references),
              'issue_closures', json(ar.issue_closures), 'created_at', ar.created_at,
              'updated_at', ar.updated_at, 'approved_at', ar.approved_at, 'resolved_at', ar.resolved_at,
              'expires_at', ar.expires_at, 'exit_code', ar.exit_code, 'error', ar.error
            ),
            'actions', json(COALESCE((
              SELECT json_group_array(json(action_json)) FROM (
                SELECT json_object(
                  'id', action.id, 'ordinal', action.ordinal, 'kind', action.kind,
                  'target_issue_ref', action.target_issue_ref, 'payload', json(action.payload),
                  'state', action.state, 'target_digest', action.target_digest,
                  'staged_at', action.staged_at, 'updated_at', action.updated_at,
                  'applied_at', action.applied_at, 'outcome_detail', action.outcome_detail
                ) AS action_json
                FROM auth_request_actions action
                WHERE action.auth_request_id = ar.id
                ORDER BY action.ordinal, action.id
              )
            ), '[]'))
          ) AS lifecycle_snapshot
        FROM auth_requests ar
      )
      INSERT INTO auth_request_lifecycle_events (
        id, auth_request_id, revision, event_type, prior_status, next_status,
        snapshot_json, snapshot_sha256, actor_user_id, evidence_method,
        credential_id, reason, custody_work_unit_id, custody_generation, authority_path, occurred_at
      )
      SELECT
        lower(hex(randomblob(16))), id, 1, 'legacy_snapshot', NULL, status,
        lifecycle_snapshot, mandible_sha256(lifecycle_snapshot),
        NULL, NULL, NULL,
        'Baseline captured during migration; earlier transition provenance is unknown.',
        NULL, NULL, 'legacy', updated_at
      FROM snapshots`,
    ],
  },
  {
    version: 174,
    name: "backfill_canonical_artifact_parent_lineage",
    statements: [
      `UPDATE artifact_version AS child
          SET source_locator_json = json_set(
            child.source_locator_json,
            '$.parent_version_id',
            (SELECT parent.id
               FROM artifact_version AS parent
              WHERE parent.artifact_id = child.artifact_id
                AND parent.version_no = child.version_no - 1)
          )
        WHERE child.version_no > 1
          AND json_valid(child.source_locator_json)
          AND (json_type(child.source_locator_json, '$.parent_version_id') IS NULL
            OR json_type(child.source_locator_json, '$.parent_version_id') = 'null')
          AND EXISTS (
            SELECT 1
              FROM artifact_version AS parent
             WHERE parent.artifact_id = child.artifact_id
               AND parent.version_no = child.version_no - 1
          )`,
    ],
  },
  {
    version: 175,
    name: "provider_first_conversation_spawn",
    statements: [
      "DROP TRIGGER conversation_spawn_events_immutable_update",
      "DROP TRIGGER conversation_spawn_events_immutable_delete",
      "DROP INDEX idx_conversation_spawn_requests_state",
      "ALTER TABLE conversation_spawn_events RENAME TO conversation_spawn_events_v174",
      "ALTER TABLE conversation_spawn_requests RENAME TO conversation_spawn_requests_v174",
      ...CONVERSATION_SPAWN_SCHEMA_V2_SQL,
      `INSERT INTO conversation_spawn_requests (
         id, schema_version, idempotency_key, request_digest, request_json, provider,
         project_id, checkout_id, topology_kind, topology_target_conversation_id,
         state, attempt_count, native_session_id, provider_session_id, provider_receipt_json,
         initial_message_state, error_json, created_at, updated_at)
       SELECT id, schema_version, idempotency_key, request_digest, request_json, provider,
         project_id, checkout_id, topology_kind, topology_target_conversation_id,
         state, attempt_count, native_session_id, provider_session_id, provider_receipt_json,
         initial_message_state, error_json, created_at, updated_at
       FROM conversation_spawn_requests_v174`,
      `INSERT INTO conversation_spawn_events
         (id, spawn_id, ordinal, event_kind, event_json, created_at)
       SELECT id, spawn_id, ordinal, event_kind, event_json, created_at
       FROM conversation_spawn_events_v174`,
      "DROP TABLE conversation_spawn_events_v174",
      "DROP TABLE conversation_spawn_requests_v174",
    ],
  },
  {
    version: 176,
    name: "immutable_auth_change_reports",
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN change_report_json TEXT
         CHECK(change_report_json IS NULL OR (
           json_valid(change_report_json)
           AND json_extract(change_report_json, '$.schema') = 'mandible-auth-change-report@1'
           AND json_type(change_report_json, '$.files') = 'array'
           AND json_extract(change_report_json, '$.totals.files') = json_array_length(json_extract(change_report_json, '$.files'))
         ))`,
      `CREATE TRIGGER auth_change_report_insert_consistent
         BEFORE INSERT ON auth_requests
         WHEN NEW.change_report_json IS NOT NULL AND (
           NEW.files_changed IS NOT json_extract(NEW.change_report_json, '$.totals.files')
           OR NEW.additions IS NOT json_extract(NEW.change_report_json, '$.totals.additions')
           OR NEW.deletions IS NOT json_extract(NEW.change_report_json, '$.totals.deletions')
         )
         BEGIN SELECT RAISE(ABORT, 'auth change report totals must own headline counts'); END`,
      `CREATE TRIGGER auth_change_report_immutable_update
         BEFORE UPDATE OF change_report_json ON auth_requests
         WHEN OLD.change_report_json IS NOT NEW.change_report_json
         BEGIN SELECT RAISE(ABORT, 'auth change reports are immutable'); END`,
      `CREATE TRIGGER auth_change_report_counts_immutable_update
         BEFORE UPDATE OF files_changed, additions, deletions ON auth_requests
         WHEN OLD.change_report_json IS NOT NULL AND (
           OLD.files_changed IS NOT NEW.files_changed
           OR OLD.additions IS NOT NEW.additions
           OR OLD.deletions IS NOT NEW.deletions
         )
         BEGIN SELECT RAISE(ABORT, 'captured auth headline counts are immutable'); END`,
    ],
  },
  {
    version: 177,
    name: "unified_chat_creation_lifecycle",
    statements: [
      "DROP TRIGGER conversation_spawn_events_immutable_update",
      "DROP TRIGGER conversation_spawn_events_immutable_delete",
      "DROP INDEX idx_conversation_spawn_requests_state",
      "ALTER TABLE conversation_spawn_events RENAME TO conversation_spawn_events_v175",
      "ALTER TABLE conversation_spawn_requests RENAME TO conversation_spawn_requests_v175",
      ...CONVERSATION_SPAWN_SCHEMA_SQL,
      `INSERT INTO conversation_spawn_requests (
         id, schema_version, idempotency_key, request_digest, request_json, provider,
         project_id, checkout_id, topology_kind, topology_target_conversation_id,
         state, attempt_count, native_session_id, provider_session_id, provider_receipt_json,
         initial_message_state, error_json, created_at, updated_at)
       SELECT id, schema_version, idempotency_key, request_digest, request_json, provider,
         project_id, checkout_id, topology_kind, topology_target_conversation_id,
         state, attempt_count, native_session_id, provider_session_id, provider_receipt_json,
         initial_message_state, error_json, created_at, updated_at
       FROM conversation_spawn_requests_v175`,
      `INSERT INTO conversation_spawn_events
         (id, spawn_id, ordinal, event_kind, event_json, created_at)
       SELECT id, spawn_id, ordinal, event_kind, event_json, created_at
       FROM conversation_spawn_events_v175`,
      "DROP TABLE conversation_spawn_events_v175",
      "DROP TABLE conversation_spawn_requests_v175",
    ],
  },
  {
    version: 178,
    name: "mandible_conversation_archive_state",
    statements: [
      `CREATE TABLE conversation_archive_states (
        conversation_id TEXT PRIMARY KEY,
        archived_at INTEGER NOT NULL CHECK(archived_at > 0)
      )`,
    ],
  },
  {
    version: 179,
    name: "briefing_destination_publication_modes",
    statements: [
      `CREATE TABLE IF NOT EXISTS briefing_destination_policies (
        route_key TEXT PRIMARY KEY REFERENCES briefing_destination_routes(route_key) ON DELETE RESTRICT,
        publication_mode TEXT NOT NULL CHECK(publication_mode IN ('reviewed-document','published-report')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `INSERT INTO briefing_destination_policies (route_key, publication_mode, created_at, updated_at)
       SELECT route_key, 'reviewed-document', created_at, updated_at FROM briefing_destination_routes`,
      `CREATE TABLE IF NOT EXISTS briefing_composition_report_publications (
        run_id TEXT NOT NULL REFERENCES briefing_composition_runs(id) ON DELETE RESTRICT,
        logical_artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE RESTRICT,
        group_id TEXT NOT NULL REFERENCES briefing_groups(id) ON DELETE RESTRICT,
        briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE RESTRICT,
        outcome TEXT NOT NULL CHECK(outcome IN ('unchanged','published')),
        previous_round_id TEXT NOT NULL REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
        current_round_id TEXT NOT NULL REFERENCES briefing_rounds(id) ON DELETE RESTRICT,
        previous_artifact_version_id TEXT NOT NULL REFERENCES artifact_version(id) ON DELETE RESTRICT,
        current_artifact_version_id TEXT NOT NULL REFERENCES artifact_version(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, logical_artifact_id),
        CHECK((outcome = 'unchanged' AND previous_round_id = current_round_id
          AND previous_artifact_version_id = current_artifact_version_id)
          OR (outcome = 'published' AND previous_round_id != current_round_id))
      )`,
    ],
  },
  {
    version: 180,
    name: "briefing_report_round_compare_and_swap",
    statements: [
      "ALTER TABLE briefing_composition_inputs ADD COLUMN expected_current_round_id TEXT REFERENCES briefing_rounds(id) ON DELETE RESTRICT",
    ],
  },
  {
    version: 181,
    name: "manual_briefing_group_review",
    statements: [
      "DROP INDEX idx_briefing_group_review_dispositions_group",
      ...BRIEFING_GROUP_SCHEMA_SQL.filter((sql) => sql.startsWith("CREATE TRIGGER IF NOT EXISTS briefing_group_review_"))
        .map((sql) => `DROP TRIGGER ${sql.split(/\s+/)[5]}`),
      "ALTER TABLE briefing_group_review_disposition_items RENAME TO briefing_group_review_disposition_items_v180",
      "ALTER TABLE briefing_group_review_destination_items RENAME TO briefing_group_review_destination_items_v180",
      "ALTER TABLE briefing_group_review_dispositions RENAME TO briefing_group_review_dispositions_v180",
      ...BRIEFING_GROUP_SCHEMA_SQL.filter((sql) => /(?:CREATE TABLE IF NOT EXISTS|CREATE TRIGGER IF NOT EXISTS) briefing_group_review_|CREATE INDEX IF NOT EXISTS idx_briefing_group_review_/.test(sql)),
      "INSERT INTO briefing_group_review_dispositions SELECT * FROM briefing_group_review_dispositions_v180",
      "INSERT INTO briefing_group_review_disposition_items SELECT * FROM briefing_group_review_disposition_items_v180",
      "INSERT INTO briefing_group_review_destination_items SELECT * FROM briefing_group_review_destination_items_v180",
      "DROP TABLE briefing_group_review_disposition_items_v180",
      "DROP TABLE briefing_group_review_destination_items_v180",
      "DROP TABLE briefing_group_review_dispositions_v180",
    ],
  },
  {
    version: 182,
    name: "briefing_destination_mutation_receipts",
    statements: [...BRIEFING_DESTINATION_MUTATION_SCHEMA_SQL],
  },
  {
    version: 183,
    name: "issue_work_notes_and_kind_retirement",
    requires_foreign_keys_off: true,
    statements: [
      `CREATE TEMP TABLE ledger_migration_events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      )`,
      `CREATE TEMP TABLE ledger_resolution_migration (
        issue_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        previous_resolution TEXT,
        next_resolution TEXT,
        legacy_updated_at INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE
      )`,
      `INSERT INTO ledger_resolution_migration (
        issue_id, project_id, previous_resolution, next_resolution, legacy_updated_at, occurred_at, observed_at,
        event_id
      )
      SELECT id, project_id, resolution,
        CASE resolution
          WHEN 'fixed' THEN 'delivered'
          WHEN 'merged' THEN 'delivered'
          WHEN 'obsolete' THEN 'wontfix'
          WHEN 'duplicate' THEN 'duplicate'
          WHEN 'wontfix' THEN 'wontfix'
          ELSE NULL
        END,
        updated_at,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        lower(hex(randomblob(32)))
      FROM ledger_issues
      WHERE resolution IN ('fixed', 'merged', 'obsolete')`,
      `CREATE TEMP TABLE ledger_issue_lifecycle_guard (
        check_name TEXT PRIMARY KEY,
        offending INTEGER NOT NULL CONSTRAINT v183_metadata_requires_explicit_review CHECK(offending = 0)
      )`,
      `INSERT INTO ledger_issue_lifecycle_guard (check_name, offending)
       SELECT 'closed_without_resolution', COUNT(*)
       FROM ledger_issues
       WHERE status = 'closed' AND (resolution IS NULL OR resolution IN ('invalid', 'unknown'))`,
      `INSERT INTO ledger_issue_lifecycle_guard (check_name, offending)
       SELECT 'open_with_resolution', COUNT(*)
       FROM ledger_issues
       WHERE status = 'open' AND resolution IS NOT NULL`,
      `CREATE TEMP TABLE ledger_parent_label_migration (
        issue_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        label TEXT NOT NULL,
        parent_ref TEXT NOT NULL,
        parent_project_id TEXT,
        resolved_parent_id TEXT,
        match_count INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at INTEGER NOT NULL,
        PRIMARY KEY(issue_id, label)
      )`,
      `WITH parsed AS (
        SELECT l.issue_id, i.project_id, l.label,
          CASE
            WHEN l.label LIKE 'parent:%' THEN substr(l.label, length('parent:') + 1)
            ELSE substr(l.label, length('mandible:parent:') + 1)
          END AS parent_ref
        FROM ledger_labels l
        JOIN ledger_issues i ON i.id = l.issue_id
        WHERE l.deleted_at IS NULL
          AND (l.label LIKE 'parent:%' OR l.label LIKE 'mandible:parent:%')
      ), candidates AS (
        SELECT p.issue_id, p.project_id, p.label, p.parent_ref,
          parent.id AS parent_id, parent.project_id AS parent_project_id
        FROM parsed p
        LEFT JOIN ledger_issues parent
          ON parent.id = p.parent_ref
          OR (parent.project_id = p.project_id AND parent.short_id = p.parent_ref)
          OR EXISTS (
            SELECT 1 FROM ledger_issue_aliases alias
            WHERE alias.issue_id = parent.id
              AND alias.project_id = p.project_id
              AND alias.alias = p.parent_ref
          )
      )
      INSERT INTO ledger_parent_label_migration (
        issue_id, project_id, label, parent_ref, parent_project_id, resolved_parent_id,
        match_count, event_id, occurred_at
      )
      SELECT issue_id, project_id, label, parent_ref,
        CASE WHEN COUNT(DISTINCT parent_id) = 1 THEN MAX(parent_project_id) END,
        CASE WHEN COUNT(DISTINCT parent_id) = 1 THEN MAX(parent_id) END,
        COUNT(DISTINCT parent_id), lower(hex(randomblob(32))),
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM candidates
      GROUP BY issue_id, project_id, label, parent_ref`,
      `INSERT INTO ledger_issue_lifecycle_guard (check_name, offending)
       SELECT 'unresolved_parent_reference', COUNT(*)
       FROM ledger_parent_label_migration WHERE match_count <> 1`,
      `CREATE TEMP TABLE ledger_parent_relationship_migration AS
      SELECT p.resolved_parent_id AS parent_id, p.issue_id AS child_id,
        p.parent_project_id, p.project_id, 'migration-v183-parent-edge:' || p.resolved_parent_id || ':' || p.issue_id AS relationship_id,
        'migration-v183-parent:' || p.resolved_parent_id || ':' || p.issue_id AS action_id,
        lower(hex(randomblob(32))) AS event_id, p.occurred_at
      FROM ledger_parent_label_migration p
      WHERE p.match_count = 1 AND p.resolved_parent_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_relationship_edges r
          WHERE r.source_issue_id = p.resolved_parent_id
            AND r.target_issue_id = p.issue_id
            AND r.link_type = 'parent_child'
        )
      GROUP BY p.resolved_parent_id, p.issue_id, p.parent_project_id, p.project_id, p.occurred_at`,
      `CREATE TEMP TABLE ledger_kind_migration (
        issue_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        previous_kind TEXT NOT NULL,
        next_kind TEXT NOT NULL CHECK(next_kind IN ('bug','feature','maintenance','experiment','tracker','umbrella','unknown')),
        event_id TEXT NOT NULL UNIQUE,
        occurred_at INTEGER NOT NULL
      )`,
      `CREATE TEMP TABLE ledger_kind_candidates AS
        SELECT i.id, i.project_id, i.kind,
          (SELECT COUNT(DISTINCT CASE l.label
             WHEN 'error' THEN 'bug'
             WHEN 'enhancement' THEN 'feature'
             WHEN 'coordination' THEN 'tracker'
             ELSE l.label END)
             FROM ledger_labels l
            WHERE l.issue_id = i.id AND l.deleted_at IS NULL
              AND l.label IN ('bug','error','feature','enhancement','maintenance','experiment','coordination','umbrella','unknown')) AS candidate_count,
          (SELECT MAX(CASE WHEN l.label IN ('task','question') THEN 1 ELSE 0 END)
             FROM ledger_labels l
            WHERE l.issue_id = i.id AND l.deleted_at IS NULL) AS retired_label,
          (SELECT MAX(CASE l.label
             WHEN 'error' THEN 'bug'
             WHEN 'enhancement' THEN 'feature'
             WHEN 'coordination' THEN 'tracker'
             ELSE l.label END)
             FROM ledger_labels l
            WHERE l.issue_id = i.id AND l.deleted_at IS NULL
              AND l.label IN ('bug','error','feature','enhancement','maintenance','experiment','coordination','umbrella','unknown')) AS candidate_kind
        FROM ledger_issues i`,
      `INSERT INTO ledger_kind_migration (
        issue_id, project_id, previous_kind, next_kind, event_id, occurred_at
      )
      SELECT id, project_id, kind,
        CASE
          WHEN kind = 'error' THEN 'bug'
          WHEN kind = 'enhancement' THEN 'feature'
          WHEN kind = 'coordination' THEN 'tracker'
          WHEN kind IN ('deferred','task','question') THEN 'unknown'
          WHEN candidate_count = 1 AND kind IN ('unknown','bug','feature','maintenance','experiment','tracker','umbrella')
            AND (kind = candidate_kind OR kind = 'unknown') THEN candidate_kind
          ELSE kind
        END,
        lower(hex(randomblob(32))), CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM ledger_kind_candidates
      WHERE kind IN ('error','enhancement','coordination','deferred','task','question')
         OR (candidate_count = 1 AND (kind = 'unknown' OR kind = candidate_kind))`,
      `INSERT INTO ledger_issue_lifecycle_guard (check_name, offending)
      SELECT 'unreviewed_ambiguous_kind', COUNT(*)
      FROM ledger_kind_candidates c
      WHERE (
          c.candidate_count > 1
          OR c.retired_label = 1
          OR (c.candidate_count = 1
              AND c.kind NOT IN ('unknown','bug','feature','maintenance','experiment','tracker','umbrella')
              AND c.kind NOT IN ('error','enhancement','coordination','deferred','task','question'))
          OR (c.candidate_count = 1
              AND c.kind IN ('bug','feature','maintenance','experiment','tracker','umbrella')
              AND c.kind <> c.candidate_kind)
        )`,
      `INSERT INTO ledger_issue_lifecycle_guard (check_name, offending)
       SELECT 'branch_label_without_structured_row', COUNT(*)
       FROM ledger_labels l
       LEFT JOIN issue_branches b
         ON b.issue_id = l.issue_id
        AND b.branch = substr(l.label, length('mandible:branch:') + 1)
       WHERE l.deleted_at IS NULL
         AND l.label LIKE 'mandible:branch:%'
         AND b.issue_id IS NULL`,
      `INSERT INTO ledger_issue_lifecycle_guard (check_name, offending)
       SELECT 'worker_status_label_drift', COUNT(*)
       FROM ledger_labels l
       JOIN ledger_issues i ON i.id = l.issue_id
       WHERE l.deleted_at IS NULL
         AND l.label IN (
           'mandible:status:none', 'mandible:status:in_progress',
           'mandible:status:done', 'mandible:status:blocked',
           'mandible:status:pivot-needed'
         )
         AND i.worker_status <> CASE l.label
           WHEN 'mandible:status:none' THEN 'none'
           WHEN 'mandible:status:in_progress' THEN 'in_progress'
           WHEN 'mandible:status:done' THEN 'done'
           WHEN 'mandible:status:blocked' THEN 'blocked'
           WHEN 'mandible:status:pivot-needed' THEN 'pivot-needed'
         END`,
      `CREATE TEMP TABLE ledger_metadata_label_migration (
        issue_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        label TEXT NOT NULL,
        reason TEXT NOT NULL,
        resolved_parent_id TEXT,
        parent_match_count INTEGER,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at INTEGER NOT NULL,
        PRIMARY KEY(issue_id, label)
      )`,
      `INSERT INTO ledger_metadata_label_migration (
        issue_id, project_id, label, reason, resolved_parent_id,
        parent_match_count, event_id, occurred_at
      )
      SELECT l.issue_id, i.project_id, l.label,
        CASE
          WHEN l.label LIKE 'parent:%' OR l.label LIKE 'mandible:parent:%' THEN 'parent_reference'
          WHEN l.label LIKE 'mandible:branch:%' THEN 'branch_reference'
          WHEN l.label LIKE 'mandible:status:%' THEN 'worker_status'
          WHEN l.label LIKE 'mandible:priority:%' OR l.label = 'important' THEN 'priority'
          WHEN l.label = 'user-action-required' THEN 'user_action_required'
          WHEN l.label IN ('bug','error','feature','enhancement','maintenance','experiment','coordination','umbrella','unknown','task','question','deferred') THEN 'kind'
          ELSE 'legacy_resolution'
        END,
        p.resolved_parent_id, p.match_count, lower(hex(randomblob(32))),
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM ledger_labels l
      JOIN ledger_issues i ON i.id = l.issue_id
      LEFT JOIN ledger_parent_label_migration p
        ON p.issue_id = l.issue_id AND p.label = l.label
      WHERE l.deleted_at IS NULL
        AND (
          l.label IN (
            'bug','error','feature','enhancement','maintenance','experiment','coordination','umbrella','unknown',
            'task','question','deferred','merged','fixed','duplicate','invalid','obsolete','wontfix','superseded',
            'open','closed','important','user-action-required'
          )
          OR l.label LIKE 'mandible:branch:%'
          OR l.label LIKE 'mandible:parent:%'
          OR l.label LIKE 'parent:%'
          OR l.label IN ('mandible:priority:low','mandible:priority:normal','mandible:priority:high','mandible:priority:urgent','mandible:priority:unknown')
          OR l.label IN ('mandible:status:none','mandible:status:in_progress','mandible:status:done','mandible:status:blocked','mandible:status:pivot-needed')
        )`,
      "DROP INDEX idx_ledger_issues_author_user",
      "DROP INDEX idx_ledger_issues_kind",
      "DROP INDEX idx_ledger_issues_project_short_id",
      "DROP INDEX idx_ledger_issues_project_status_updated",
      `CREATE TABLE ledger_issues_new (
        id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        work_notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('open','closed')),
        resolution TEXT CHECK(resolution IN ('delivered','duplicate','wontfix') OR resolution IS NULL),
        kind TEXT NOT NULL DEFAULT 'unknown'
          CHECK(kind IN ('bug','feature','maintenance','experiment','tracker','umbrella','unknown')),
        priority TEXT NOT NULL DEFAULT 'unknown'
          CHECK(priority IN ('low','normal','high','urgent','unknown')),
        author_actor_id TEXT,
        author_actor_type TEXT NOT NULL DEFAULT 'external_adapter'
          CHECK(author_actor_type IN ('mandible_user','agent','system','external_adapter')),
        author_display TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'mandible'
          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        deleted_at INTEGER
      , worker_status TEXT NOT NULL DEFAULT 'none'
          CHECK(worker_status IN ('none','in_progress','done','blocked','pivot-needed')),
        author_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        evidence_method TEXT,
        evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL,
        CHECK((status = 'open' AND resolution IS NULL) OR (status = 'closed' AND resolution IS NOT NULL))
      )`,
      `INSERT INTO ledger_issues_new (
        id, short_id, project_id, title, body, work_notes, status, resolution, kind, priority,
        author_actor_id, author_actor_type, author_display, source, created_at, updated_at,
        closed_at, deleted_at, worker_status, author_user_id, evidence_method, evidence_id
      )
      SELECT id, short_id, project_id, title, body,
        CASE WHEN kind = 'deferred'
          THEN 'this issue had kind ''deferred'', when ''deferred'' was a kind'
          ELSE '' END
        || CASE WHEN EXISTS (
            SELECT 1 FROM ledger_labels l
             WHERE l.issue_id = ledger_issues.id
               AND l.label = 'deferred'
               AND l.deleted_at IS NULL
          ) THEN CASE WHEN kind IN ('deferred', 'task', 'question') THEN char(10) ELSE '' END
            || 'this issue had an active ''deferred'' label, when ''deferred'' was an active label'
          ELSE '' END
        || CASE WHEN EXISTS (
            SELECT 1 FROM ledger_labels l
             WHERE l.issue_id = ledger_issues.id
               AND l.label = 'user-action-required'
               AND l.deleted_at IS NULL
          ) THEN CASE
            WHEN kind = 'deferred' OR EXISTS (
              SELECT 1 FROM ledger_labels l2
               WHERE l2.issue_id = ledger_issues.id
                 AND l2.label = 'deferred'
                 AND l2.deleted_at IS NULL
            ) THEN char(10)
            ELSE '' END || 'user action required'
          ELSE '' END,
        status,
        COALESCE(
          (SELECT m.next_resolution FROM ledger_resolution_migration m WHERE m.issue_id = ledger_issues.id),
          CASE resolution
            WHEN 'fixed' THEN 'delivered'
            WHEN 'merged' THEN 'delivered'
            WHEN 'obsolete' THEN 'wontfix'
            WHEN 'invalid' THEN NULL
            WHEN 'unknown' THEN NULL
            ELSE resolution
          END
        ),
        COALESCE(
          (SELECT m.next_kind FROM ledger_kind_migration m WHERE m.issue_id = ledger_issues.id),
          CASE
            WHEN kind = 'error' THEN 'bug'
            WHEN kind = 'enhancement' THEN 'feature'
            WHEN kind = 'coordination' THEN 'tracker'
            WHEN kind IN ('deferred', 'task', 'question') THEN 'unknown'
            ELSE kind
          END
        ),
        CASE
          WHEN EXISTS (SELECT 1 FROM ledger_labels l WHERE l.issue_id = ledger_issues.id AND l.deleted_at IS NULL AND l.label IN ('important','mandible:priority:high')) THEN 'high'
          WHEN EXISTS (SELECT 1 FROM ledger_labels l WHERE l.issue_id = ledger_issues.id AND l.deleted_at IS NULL AND l.label = 'mandible:priority:urgent') THEN 'urgent'
          WHEN EXISTS (SELECT 1 FROM ledger_labels l WHERE l.issue_id = ledger_issues.id AND l.deleted_at IS NULL AND l.label = 'mandible:priority:normal') THEN 'normal'
          WHEN EXISTS (SELECT 1 FROM ledger_labels l WHERE l.issue_id = ledger_issues.id AND l.deleted_at IS NULL AND l.label = 'mandible:priority:low') THEN 'low'
          ELSE priority
        END,
        author_actor_id, author_actor_type, author_display, source, created_at, updated_at,
        closed_at, deleted_at, worker_status, author_user_id, evidence_method, evidence_id
      FROM ledger_issues`,
      "DROP TABLE ledger_issues",
      `CREATE TABLE ledger_issues (
        id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        work_notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('open','closed')),
        resolution TEXT CHECK(resolution IN ('delivered','duplicate','wontfix') OR resolution IS NULL),
        kind TEXT NOT NULL DEFAULT 'unknown'
          CHECK(kind IN ('bug','feature','maintenance','experiment','tracker','umbrella','unknown')),
        priority TEXT NOT NULL DEFAULT 'unknown'
          CHECK(priority IN ('low','normal','high','urgent','unknown')),
        author_actor_id TEXT,
        author_actor_type TEXT NOT NULL DEFAULT 'external_adapter'
          CHECK(author_actor_type IN ('mandible_user','agent','system','external_adapter')),
        author_display TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'mandible'
          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        deleted_at INTEGER
      , worker_status TEXT NOT NULL DEFAULT 'none'
        CHECK(worker_status IN ('none','in_progress','done','blocked','pivot-needed')), author_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, evidence_method TEXT, evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL,
        CHECK((status = 'open' AND resolution IS NULL) OR (status = 'closed' AND resolution IS NOT NULL)))`,
      `INSERT INTO ledger_issues
        SELECT id, short_id, project_id, title, body, work_notes, status, resolution, kind, priority,
          author_actor_id, author_actor_type, author_display, source, created_at, updated_at,
          closed_at, deleted_at, worker_status, author_user_id, evidence_method, evidence_id
        FROM ledger_issues_new`,
      "DROP TABLE ledger_issues_new",
      `INSERT INTO ledger_relationship_edges (
        id, source_entity_type, source_entity_id, source_project_id, source_issue_id,
        target_entity_type, target_entity_id, target_project_id, target_issue_id,
        link_type, provenance, note, action_id, actor_id, actor_type, source,
        metadata_json, created_at, updated_at, deleted_at
      )
      SELECT relationship_id, 'issue', parent_id, parent_project_id, parent_id,
        'issue', child_id, project_id, child_id, 'parent_child', 'system',
        'Migrated from parent label', action_id, 'schema-migration-v183', 'system', 'system',
        json_object('migration', 'metadata_label_retirement', 'source_label', (
          SELECT MIN(p.label) FROM ledger_parent_label_migration p
          WHERE p.resolved_parent_id = m.parent_id AND p.issue_id = m.child_id
        )), occurred_at, occurred_at, NULL
      FROM ledger_parent_relationship_migration m`,
      `INSERT INTO ledger_events (
        id, entity_type, entity_id, event_type, actor_id, actor_type, source,
        payload_json, occurred_at, observed_at, actor_user_id, evidence_method, evidence_id
      )
      SELECT event_id, 'issue', issue_id, 'issue.updated', 'schema-migration-v183', 'system', 'system',
        json_object(
          'issue_id', issue_id,
          'patch', json_object('resolution', next_resolution),
          'previous_resolution', previous_resolution,
          'resolution', next_resolution,
          'migration', 'resolution_retirement',
          'retired_resolution', previous_resolution,
          'replacement_resolution', next_resolution,
          'legacy_updated_at', legacy_updated_at
        ),
        occurred_at, observed_at, NULL, NULL, NULL
      FROM ledger_resolution_migration`,
      `INSERT INTO ledger_migration_events (event_id, project_id, occurred_at)
       SELECT event_id, project_id, occurred_at FROM ledger_resolution_migration`,
      `INSERT INTO ledger_events (
        id, entity_type, entity_id, event_type, actor_id, actor_type, source,
        payload_json, occurred_at, observed_at, actor_user_id, evidence_method, evidence_id
      )
      SELECT event_id, 'issue', issue_id, 'issue.updated', 'schema-migration-v183', 'system', 'system',
        json_object(
          'issue_id', issue_id,
          'patch', json_object('kind', next_kind),
          'previous_kind', previous_kind,
          'kind', next_kind,
          'migration', 'kind_normalization'
        ),
        occurred_at, occurred_at, NULL, NULL, NULL
      FROM ledger_kind_migration`,
      `INSERT INTO ledger_migration_events (event_id, project_id, occurred_at)
       SELECT event_id, project_id, occurred_at FROM ledger_kind_migration`,
      `INSERT INTO ledger_events (
        id, entity_type, entity_id, event_type, actor_id, actor_type, source,
        payload_json, occurred_at, observed_at, actor_user_id, evidence_method, evidence_id
      )
      SELECT event_id, 'issue_relationship_edge', relationship_id, 'relationship.upserted',
        'schema-migration-v183', 'system', 'system',
        json_object(
          'relationship_id', relationship_id,
          'source_issue_id', parent_id,
          'target_issue_id', child_id,
          'relationship_type', 'parent_child',
          'migration', 'parent_label_normalization',
          'action_id', action_id
        ), occurred_at, occurred_at, NULL, NULL, NULL
      FROM ledger_parent_relationship_migration`,
      `INSERT INTO ledger_migration_events (event_id, project_id, occurred_at)
       SELECT event_id, project_id, occurred_at FROM ledger_parent_relationship_migration`,
      `INSERT INTO ledger_events (
        id, entity_type, entity_id, event_type, actor_id, actor_type, source,
        payload_json, occurred_at, observed_at, actor_user_id, evidence_method, evidence_id
      )
      SELECT event_id, 'issue', issue_id, 'label.updated', 'schema-migration-v183', 'system', 'system',
        json_object(
          'issue_id', issue_id,
          'label', label,
          'present', 0,
          'migration', 'metadata_label_retirement',
          'reason', reason,
          'resolved_parent_id', resolved_parent_id,
          'parent_match_count', parent_match_count
        ), occurred_at, occurred_at, NULL, NULL, NULL
      FROM ledger_metadata_label_migration`,
      `INSERT INTO ledger_migration_events (event_id, project_id, occurred_at)
       SELECT event_id, project_id, occurred_at FROM ledger_metadata_label_migration`,
      `CREATE TABLE ledger_body_revisions_new (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('issue_body','issue_work_notes','comment_body')),
        entity_id TEXT NOT NULL,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        revision_no INTEGER NOT NULL,
        event_id TEXT UNIQUE REFERENCES ledger_events(id) ON DELETE SET NULL,
        actor_id TEXT,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('mandible_user','agent','system','external_adapter')),
        source TEXT NOT NULL CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        reason TEXT NOT NULL DEFAULT 'edit'
          CHECK(reason IN ('create','edit','import_snapshot','external_update','normalize','migration_snapshot','restore')),
        occurred_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        base_revision_id TEXT REFERENCES ledger_body_revisions(id) ON DELETE SET NULL,
        base_hash TEXT,
        new_hash TEXT NOT NULL,
        snapshot_body TEXT NOT NULL,
        patch_format TEXT,
        patch_text TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        redacted_at INTEGER,
        redacted_by_actor_id TEXT,
        redaction_reason TEXT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        evidence_method TEXT,
        evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL,
        redacted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        UNIQUE(entity_type, entity_id, revision_no)
      )`,
      `INSERT INTO ledger_body_revisions_new
        SELECT id, entity_type, entity_id, issue_id, project_id, revision_no, event_id,
          actor_id, actor_type, source, reason, occurred_at, observed_at, base_revision_id,
          base_hash, new_hash, snapshot_body, patch_format, patch_text, metadata_json,
          redacted_at, redacted_by_actor_id, redaction_reason, actor_user_id, evidence_method,
          evidence_id, redacted_by_user_id
        FROM ledger_body_revisions`,
      "DROP INDEX idx_ledger_body_revisions_entity",
      "DROP INDEX idx_ledger_body_revisions_event",
      "DROP INDEX idx_ledger_body_revisions_issue",
      "DROP TABLE ledger_body_revisions",
      `CREATE TABLE ledger_body_revisions (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('issue_body','issue_work_notes','comment_body')),
        entity_id TEXT NOT NULL,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        revision_no INTEGER NOT NULL,
        event_id TEXT UNIQUE REFERENCES ledger_events(id) ON DELETE SET NULL,
        actor_id TEXT,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('mandible_user','agent','system','external_adapter')),
        source TEXT NOT NULL CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        reason TEXT NOT NULL DEFAULT 'edit'
          CHECK(reason IN ('create','edit','import_snapshot','external_update','normalize','migration_snapshot','restore')),
        occurred_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        base_revision_id TEXT REFERENCES ledger_body_revisions(id) ON DELETE SET NULL,
        base_hash TEXT,
        new_hash TEXT NOT NULL,
        snapshot_body TEXT NOT NULL,
        patch_format TEXT,
        patch_text TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        redacted_at INTEGER,
        redacted_by_actor_id TEXT,
        redaction_reason TEXT, actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, evidence_method TEXT, evidence_id TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL, redacted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        UNIQUE(entity_type, entity_id, revision_no)
      )`,
      `INSERT INTO ledger_body_revisions
        SELECT id, entity_type, entity_id, issue_id, project_id, revision_no, event_id,
          actor_id, actor_type, source, reason, occurred_at, observed_at, base_revision_id,
          base_hash, new_hash, snapshot_body, patch_format, patch_text, metadata_json,
          redacted_at, redacted_by_actor_id, redaction_reason, actor_user_id, evidence_method,
          evidence_id, redacted_by_user_id
        FROM ledger_body_revisions_new`,
      "DROP TABLE ledger_body_revisions_new",
      `UPDATE ledger_labels
          SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE EXISTS (
          SELECT 1 FROM ledger_metadata_label_migration m
          WHERE m.issue_id = ledger_labels.issue_id AND m.label = ledger_labels.label
        ) AND deleted_at IS NULL`,
      `CREATE TEMP TABLE ledger_work_notes_migration (
        issue_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        snapshot_body TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        revision_id TEXT NOT NULL UNIQUE,
        occurred_at INTEGER NOT NULL
      )`,
      `INSERT INTO ledger_work_notes_migration (
        issue_id, project_id, snapshot_body, event_id, revision_id, occurred_at
      )
      SELECT id, project_id, work_notes, lower(hex(randomblob(32))), lower(hex(randomblob(16))),
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM ledger_issues
      WHERE trim(work_notes) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM ledger_body_revisions r
          WHERE r.entity_type = 'issue_work_notes' AND r.entity_id = ledger_issues.id
        )`,
      `INSERT INTO ledger_events (
        id, entity_type, entity_id, event_type, actor_id, actor_type, source,
        payload_json, occurred_at, observed_at, actor_user_id, evidence_method, evidence_id
      )
      SELECT event_id, 'issue', issue_id, 'issue.work_notes_updated',
        'schema-migration-v183', 'system', 'system',
        json_object(
          'issue_id', issue_id,
          'work_notes', snapshot_body,
          'changed_fields', json_array('work_notes'),
          'body_revision_id', revision_id,
          'migration', 'metadata_label_retirement'
        ), occurred_at, occurred_at, NULL, NULL, NULL
      FROM ledger_work_notes_migration`,
      `INSERT INTO ledger_migration_events (event_id, project_id, occurred_at)
       SELECT event_id, project_id, occurred_at FROM ledger_work_notes_migration`,
      `INSERT INTO ledger_body_revisions (
        id, entity_type, entity_id, issue_id, project_id, revision_no, event_id,
        actor_id, actor_type, source, reason, occurred_at, observed_at,
        base_revision_id, base_hash, new_hash, snapshot_body, patch_format,
        patch_text, metadata_json, redacted_at, redacted_by_actor_id,
        redaction_reason, actor_user_id, evidence_method, evidence_id,
        redacted_by_user_id
      )
      SELECT revision_id, 'issue_work_notes', issue_id, issue_id, project_id, 1, event_id,
        'schema-migration-v183', 'system', 'system', 'migration_snapshot', occurred_at, occurred_at,
        NULL, NULL, mandible_sha256(snapshot_body), snapshot_body, NULL, NULL,
        json_object('migration', 'metadata_label_retirement'), NULL, NULL, NULL,
        NULL, NULL, NULL, NULL
      FROM ledger_work_notes_migration`,
      `INSERT INTO ledger_change_feed_state (project_id, next_sequence, retained_from_sequence, updated_at)
       SELECT project_id, 1, 1, MAX(occurred_at)
       FROM ledger_migration_events
       GROUP BY project_id
       ON CONFLICT(project_id) DO NOTHING`,
      `INSERT INTO ledger_change_log (project_id, sequence, event_id, recorded_at)
       SELECT m.project_id,
         s.next_sequence + ROW_NUMBER() OVER (PARTITION BY m.project_id ORDER BY m.event_id) - 1,
         m.event_id, m.occurred_at
       FROM ledger_migration_events m
       JOIN ledger_change_feed_state s ON s.project_id = m.project_id`,
      `UPDATE ledger_change_feed_state
       SET next_sequence = next_sequence + (
         SELECT COUNT(*) FROM ledger_migration_events m
         WHERE m.project_id = ledger_change_feed_state.project_id
       ),
       updated_at = (
         SELECT MAX(m.occurred_at) FROM ledger_migration_events m
         WHERE m.project_id = ledger_change_feed_state.project_id
       )
       WHERE project_id IN (SELECT project_id FROM ledger_migration_events)`,
      "CREATE INDEX idx_ledger_body_revisions_entity ON ledger_body_revisions(entity_type, entity_id, revision_no)",
      "CREATE INDEX idx_ledger_body_revisions_event ON ledger_body_revisions(event_id) WHERE event_id IS NOT NULL",
      "CREATE INDEX idx_ledger_body_revisions_issue ON ledger_body_revisions(issue_id, occurred_at)",
      "CREATE INDEX idx_ledger_issues_author_user ON ledger_issues(author_user_id) WHERE author_user_id IS NOT NULL",
      "CREATE INDEX idx_ledger_issues_kind ON ledger_issues(kind)",
      "CREATE UNIQUE INDEX idx_ledger_issues_project_short_id ON ledger_issues(project_id, short_id) WHERE short_id != ''",
      "CREATE INDEX idx_ledger_issues_project_status_updated ON ledger_issues(project_id, status, updated_at DESC)",
      "DROP TABLE ledger_issue_lifecycle_guard",
      "DROP TABLE ledger_work_notes_migration",
      "DROP TABLE ledger_metadata_label_migration",
      "DROP TABLE ledger_parent_relationship_migration",
      "DROP TABLE ledger_parent_label_migration",
      "DROP TABLE ledger_kind_migration",
      "DROP TABLE ledger_kind_candidates",
      "DROP TABLE ledger_migration_events",
      "DROP TABLE ledger_resolution_migration",
    ],
  },
  { version: 184, name: "artifact_registered_sources", statements: [...ARTIFACT_SOURCE_SCHEMA_SQL, ...ARTIFACT_SOURCE_BACKFILL_SQL] },
  { version: 185, name: "artifact_two_custodies", statements: [...ARTIFACT_CUSTODY_MIGRATION_SQL, ...ARTIFACT_CUSTODY_TRIGGERS_SQL], requires_foreign_keys_off: true },
  { version: 186, name: "remove_commit_message_closure_setting", statements: ["DELETE FROM settings WHERE key = 'auto_close_issues_on_merge'"] },
  { version: 187, name: "chat_attachment_custody", statements: [
    `CREATE TABLE chat_attachment_files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length > 0),
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `ALTER TABLE conversation_control_outbox ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json) AND json_type(attachments_json) = 'array')`,
  ] },
  { version: 188, name: "local_reminder_attribution", statements: [
    "ALTER TABLE managed_task_events RENAME TO managed_task_events_v187",
    `CREATE TABLE managed_task_events (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE RESTRICT,
        revision_id     TEXT NOT NULL,
        project_id      TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        event_type      TEXT NOT NULL CHECK(event_type IN ('created','completed','cancelled')),
        actor_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        evidence_method TEXT NOT NULL CHECK(evidence_method IN ('api_token','ephemeral','local_default','session_claim','system_internal')),
        payload_json    TEXT NOT NULL DEFAULT '{}' CHECK(
                          json_valid(payload_json) AND json_type(payload_json) = 'object'
                        ),
        occurred_at     INTEGER NOT NULL,
        FOREIGN KEY(task_id, revision_id)
          REFERENCES managed_task_revisions(task_id, id) ON DELETE RESTRICT
    )`,
    `INSERT INTO managed_task_events
      (id, task_id, revision_id, project_id, event_type, actor_user_id, evidence_method, payload_json, occurred_at)
      SELECT id, task_id, revision_id, project_id, event_type, actor_user_id, evidence_method, payload_json, occurred_at
      FROM managed_task_events_v187`,
    "DROP TABLE managed_task_events_v187",
    "CREATE INDEX idx_managed_task_events_task\n        ON managed_task_events(task_id, occurred_at, id)",
  ] },
  { version: 189, name: "managed_conversation_runtime", statements: [...CONVERSATION_CONTROL_PENDING_IDENTITY_MIGRATION_SQL, ...CONVERSATION_RUNTIME_SCHEMA_SQL] },
  { version: 190, name: "managed_document_publications", statements: SPACE_PUBLICATION_SCHEMA_SQL },
  { version: 191, name: "frozen_publication_auth_binding", statements: SPACE_PUBLICATION_AUTH_SCHEMA_SQL },
  { version: 192, name: "compile_dotfiles_instructions_without_home_repair", statements: DOTFILES_INSTRUCTION_HOOK_MIGRATION_SQL },
];

/**
 * Migration versions must be unique and form a contiguous ascending run
 * starting immediately above the supported floor, so `CURRENT_SCHEMA_VERSION`
 * is the only head and no version can be skipped or reused.
 */
export function assertMigrationSequence(
  migrations: readonly Migration[] = MIGRATIONS,
  floor: number = MINIMUM_SUPPORTED_SCHEMA_VERSION,
): void {
  const seen = new Map<number, string>();
  for (const migration of migrations) {
    const previous = seen.get(migration.version);
    if (previous) {
      throw new Error(
        `Duplicate migration version ${migration.version}: ${previous}, ${migration.name}`,
      );
    }
    seen.set(migration.version, migration.name);
  }
  const sorted = [...migrations].map((migration) => migration.version).sort((a, b) => a - b);
  for (let index = 0; index < sorted.length; index += 1) {
    const expected = floor + index + 1;
    if (sorted[index] !== expected) {
      throw new Error(
        `Migration versions must be contiguous above v${floor}: expected ${expected}, got ${sorted[index]}`,
      );
    }
  }
}

assertMigrationSequence();

export const CURRENT_SCHEMA_VERSION =
  MIGRATIONS.at(-1)?.version ?? MINIMUM_SUPPORTED_SCHEMA_VERSION;

/**
 * Raised when a database records a schema version this build cannot serve. Both
 * directions are refusals, not repairs: an older database needs statements this
 * build no longer carries, and a newer one was written by a build that knows
 * columns and tables this one does not.
 */
export class UnsupportedSchemaVersionError extends Error {
  constructor(readonly found: number, message: string) {
    super(message);
    this.name = "UnsupportedSchemaVersionError";
  }
}

function belowFloorMessage(found: number, dbPath: string): string {
  return [
    `Database schema v${found} is older than the minimum supported v${MINIMUM_SUPPORTED_SCHEMA_VERSION}`,
    `(this build serves v${CURRENT_SCHEMA_VERSION}).`,
    `Mandible no longer carries the migrations that upgrade a pre-v${MINIMUM_SUPPORTED_SCHEMA_VERSION} database.`,
    `Open ${dbPath} once with a Mandible build from before the v${MINIMUM_SUPPORTED_SCHEMA_VERSION} floor`,
    "to bring it to that version, or move it aside and let this build create a fresh database.",
  ].join(" ");
}

function aboveHeadMessage(found: number, dbPath: string): string {
  return [
    `Database schema v${found} is newer than the v${CURRENT_SCHEMA_VERSION} this build serves.`,
    `${dbPath} was written by a newer Mandible; running this build against it would`,
    "read and write a schema it does not know.",
    "Upgrade Mandible, or point MANDIBLE_DB at a database this build can serve.",
  ].join(" ");
}

function databasePath(db: Db): string {
  return db.name || "the database";
}

function isFreshDatabase(db: Db): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  return !row;
}

function getSchemaVersion(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SCHEMA_VERSION_KEY) as
    | { value: string }
    | undefined;
  if (!row) return 0;
  const version = Number(row.value);
  return Number.isFinite(version) ? version : 0;
}

/**
 * Reconcile the one schema-number collision created by the persistent Chat
 * integration preview before the auth-report migration landed on `main`.
 *
 * That preview recorded the v3 Chat lifecycle as v176 and archive state as
 * v177. The protected branch independently used v176 for immutable auth change
 * reports. Exact shape checks distinguish the preview lineage: archive state
 * and the v3 spawn schema are present, while the auth-report column is absent.
 * Applying the canonical auth migration completes the v178 shape without
 * rebuilding or discarding preview-only Chat state.
 */
function reconcileCollidedChatPreviewSchema(db: Db, found: number): number {
  if (found !== 177) return found;
  const archiveState = db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_archive_states'",
  ).get();
  const authReportColumn = db.prepare(
    "SELECT 1 FROM pragma_table_info('auth_requests') WHERE name = 'change_report_json'",
  ).get();
  const spawnSchema = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_spawn_requests'",
  ).get() as { sql?: string } | undefined;
  if (!archiveState || authReportColumn || !spawnSchema?.sql?.includes("mandible-conversation-spawn-request@3")) {
    return found;
  }

  const authMigration = MIGRATIONS.find((migration) => migration.name === "immutable_auth_change_reports");
  if (!authMigration) throw new Error("Canonical immutable auth change-report migration is missing");
  db.transaction(() => {
    for (const statement of authMigration.statements) db.exec(statement);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(SCHEMA_VERSION_KEY, "178");
  })();
  return 178;
}

function applySchemaMigrations(db: Db, migrations: readonly Migration[]): void {
  if (migrations.length === 0) return;
  const setVersion = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  let normal: Migration[] = [];
  const applyNormal = (): void => {
    if (normal.length === 0) return;
    const group = normal;
    normal = [];
    db.transaction(() => {
      for (const migration of group) {
        for (const statement of migration.statements) db.exec(statement);
        if (migration.version === 190) preserveLegacyDocuments(db);
        setVersion.run(SCHEMA_VERSION_KEY, String(migration.version));
      }
    })();
  };
  for (const migration of migrations) {
    if (!migration.requires_foreign_keys_off) {
      normal.push(migration);
      continue;
    }
    applyNormal();
    const baselineForeignKeyViolations = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    const foreignKeysWereEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
    if (foreignKeysWereEnabled) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        for (const statement of migration.statements) db.exec(statement);
        const remainingViolations = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
        const baselineCounts = new Map<string, number>();
        for (const violation of baselineForeignKeyViolations) {
          const key = JSON.stringify(violation);
          baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
        }
        const unexpected = remainingViolations.filter((violation) => {
          const key = JSON.stringify(violation);
          const count = baselineCounts.get(key) ?? 0;
          if (count === 0) return true;
          baselineCounts.set(key, count - 1);
          return false;
        });
        if (unexpected.length > 0) {
          throw new Error(`Migration v${migration.version} left foreign-key violations`);
        }
        setVersion.run(SCHEMA_VERSION_KEY, String(migration.version));
      })();
    } finally {
      if (foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
    }
  }
  applyNormal();
}

export function migrate(db: Db): void {
  db.function("mandible_artifact_metadata", { deterministic: true }, artifactDescriptiveMetadataJson);
  db.function("mandible_sha256", { deterministic: true }, (value: unknown) =>
    createHash("sha256").update(String(value)).digest("hex"));
  assertMigrationSequence();
  if (BASELINE_SCHEMA_VERSION !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Fresh schema baseline v${BASELINE_SCHEMA_VERSION} does not match migration head v${CURRENT_SCHEMA_VERSION}`,
    );
  }

  if (isFreshDatabase(db)) {
    createFreshSchemaBaseline(db, CURRENT_SCHEMA_VERSION);
    return;
  }

  let found = getSchemaVersion(db);
  if (found < MINIMUM_SUPPORTED_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(found, belowFloorMessage(found, databasePath(db)));
  }
  if (found > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(found, aboveHeadMessage(found, databasePath(db)));
  }

  found = reconcileCollidedChatPreviewSchema(db, found);

  if (found < 185) {
    applySchemaMigrations(db, MIGRATIONS.filter(migration => migration.version > found && migration.version <= 184));
    const recovery = recoverArtifactCustody(db, { retain_git_commit: retainArtifactCommit });
    if (!recovery.recovery_receipt_path) throw new Error('Artifact recovery did not preserve its audit receipt');
    reconcileRecoveredArtifactSources(db, { collisions: 'managed', receipt_path: `${recovery.recovery_receipt_path}.sources.json` });
    found = 184;
  }
  {
    const legacyTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_patches'",
    ).get();
    if (legacyTable) {
      const { count } = db.prepare("SELECT count(*) AS count FROM runtime_patches").get() as { count: number };
      if (count === 0) {
        db.exec("DROP TABLE runtime_patches");
      } else {
        console.warn(`Retaining ${count} historical runtime_patches rows; the retired table has no application readers or writers.`);
      }
    }
  }
  applySchemaMigrations(db, MIGRATIONS.filter((migration) => migration.version > found));
}
