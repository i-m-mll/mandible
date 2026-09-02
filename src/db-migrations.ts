import { BASELINE_SCHEMA_VERSION, createFreshSchemaBaseline } from "./db-baseline.js";
import type { Db } from "./db.js";
import { CONVERSATION_CONTROL_SCHEMA_SQL } from "./conversation-control/schema.js";
import { BRIEFING_COMPOSER_SCHEMA_SQL } from "./feedback/schema.js";

const SCHEMA_VERSION_KEY = "schema_version";

export interface Migration {
  version: number;
  name: string;
  statements: string[];
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
    statements: [...CONVERSATION_CONTROL_SCHEMA_SQL],
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
    statements: [...BRIEFING_COMPOSER_SCHEMA_SQL],
  },
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

function applySchemaMigrations(db: Db, migrations: readonly Migration[]): void {
  if (migrations.length === 0) return;
  const setVersion = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  db.transaction(() => {
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      setVersion.run(SCHEMA_VERSION_KEY, String(migration.version));
    }
  })();
}

export function migrate(db: Db): void {
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

  const found = getSchemaVersion(db);
  if (found < MINIMUM_SUPPORTED_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(found, belowFloorMessage(found, databasePath(db)));
  }
  if (found > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(found, aboveHeadMessage(found, databasePath(db)));
  }

  applySchemaMigrations(db, MIGRATIONS.filter((migration) => migration.version > found));
}
