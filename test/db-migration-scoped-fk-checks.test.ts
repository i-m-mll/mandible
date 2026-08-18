import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate, type Db } from "../src/db.js";

/**
 * Issue 1a6c674 — every migration integrity check must be scoped to the tables
 * that migration actually touches.
 *
 * The production database holds three `console_session_usage` rows whose parent
 * console sessions are gone: orphaned before that foreign key was ever declared
 * and unrelated to any migration. Two migrations ran a bare
 * `PRAGMA foreign_key_check`, which reports the whole database, saw those rows,
 * aborted, rolled back, and left the daemon crash-looping on every restart —
 * a migration cannot succeed by retrying against data it will not and should
 * not repair.
 *
 * Each test below re-creates the legacy precondition of one migration, plants
 * that exact orphan in an unrelated table, and asserts two things: the
 * migration completes and does its real work, and the orphan is left exactly
 * as found. Repairing it is the operator's decision, not a migration's.
 */

const ORPHAN_ID = "usage-orphan";

function freshDb(): Db {
  const db = new Database(":memory:") as unknown as Db;
  migrate(db);
  return db;
}

/** Plant the production violation: a usage row whose console session is gone. */
function plantUnrelatedOrphan(db: Db): void {
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO console_session_usage (id, console_session_id, recorded_at)
     VALUES (?, 'session-that-no-longer-exists', 10)`,
  ).run(ORPHAN_ID);
  // Sanity: the planted row really is an unrepaired whole-database violation,
  // so a bare check would still see it.
  expect(db.pragma("foreign_key_check")).not.toEqual([]);
}

function expectOrphanUntouched(db: Db): void {
  expect(
    db.prepare("SELECT count(*) AS n FROM console_session_usage WHERE id = ?").get(ORPHAN_ID),
  ).toEqual({ n: 1 });
}

/** Re-open a completed post-migration without rewinding the schema version. */
function reopenPostMigrations(db: Db, ...names: string[]): void {
  const remove = db.prepare("DELETE FROM meta WHERE key = ?");
  for (const name of names) remove.run(`post_migration.${name}.complete`);
}

function tableSql(db: Db, table: string): string {
  return (db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string }).sql;
}

function columnIsNotNull(db: Db, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  return info.find((entry) => entry.name === column)?.notnull === 1;
}

describe("migration foreign key checks are scoped to the tables they touch", () => {
  it("migration 62 rewrites ledger event ids despite an unrelated violation", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO ledger_events (
           id, entity_type, entity_id, event_type, actor_type, source,
           payload_json, occurred_at, observed_at
         ) VALUES ('legacy-event-1', 'issue', 'iss-1', 'issue.created', 'system',
                   'mandible', '{}', 1, 1)`,
      ).run();
      reopenPostMigrations(db, "v62_migrate_ledger_event_hash_ids");
      plantUnrelatedOrphan(db);

      expect(() => migrate(db)).not.toThrow();

      const events = db.prepare("SELECT id, payload_json FROM ledger_events").all() as Array<{
        id: string;
        payload_json: string;
      }>;
      expect(events).toHaveLength(1);
      expect(events[0].id).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(events[0].payload_json).legacy_event_id).toBe("legacy-event-1");
      expectOrphanUntouched(db);
    } finally {
      db.close();
    }
  });

  it("migration 70 drops legacy relationship ref kinds despite an unrelated violation", () => {
    const db = freshDb();
    try {
      db.pragma("foreign_keys = OFF");
      db.exec(`
        DROP TABLE ledger_issue_relationship_sources;
        CREATE TABLE ledger_issue_relationship_sources (
          id TEXT PRIMARY KEY,
          relationship_id TEXT NOT NULL REFERENCES ledger_issue_relationships(id) ON DELETE CASCADE,
          source_entity_type TEXT NOT NULL CHECK(source_entity_type IN ('issue_body','comment')),
          source_entity_id TEXT NOT NULL,
          source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
          target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
          relationship_type TEXT NOT NULL,
          ref_kind TEXT NOT NULL,
          raw_ref TEXT NOT NULL,
          normalized_ref TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
        INSERT INTO ledger_issue_relationship_sources (
          id, relationship_id, source_entity_type, source_entity_id, source_issue_id,
          target_issue_id, relationship_type, ref_kind, raw_ref, normalized_ref,
          metadata_json, created_at, updated_at, deleted_at
        ) VALUES (
          'src-legacy', 'rel-1', 'issue_body', 'iss-1', 'iss-1', 'iss-2',
          'references', 'artifact', '[artifact:abc]', 'abc', '{}', 1, 1, NULL
        );
      `);
      reopenPostMigrations(db, "v70_remove_legacy_issue_relationship_source_kinds");
      plantUnrelatedOrphan(db);

      expect(() => migrate(db)).not.toThrow();

      expect(tableSql(db, "ledger_issue_relationship_sources")).toContain(
        "CHECK(ref_kind IN ('issue','comment'))",
      );
      expect(
        db.prepare("SELECT count(*) AS n FROM ledger_issue_relationship_sources").get(),
      ).toEqual({ n: 0 });
      expectOrphanUntouched(db);
    } finally {
      db.close();
    }
  });

  it("migration 86 makes spaces.project_id nullable despite an unrelated violation", () => {
    const db = freshDb();
    try {
      db.pragma("foreign_keys = OFF");
      db.exec(`
        DROP TABLE spaces;
        CREATE TABLE spaces (
          id               TEXT PRIMARY KEY,
          project_id       TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
          title            TEXT NOT NULL,
          default_renderer TEXT NOT NULL DEFAULT 'canvas'
                             CHECK(default_renderer IN ('canvas','document','board','collection')),
          description      TEXT,
          metadata_json    TEXT NOT NULL DEFAULT '{}'
                             CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        );
        CREATE INDEX idx_spaces_project_updated ON spaces(project_id, updated_at DESC);
      `);
      expect(columnIsNotNull(db, "spaces", "project_id")).toBe(true);
      reopenPostMigrations(db, "v86_spaces_nullable_project_id");
      plantUnrelatedOrphan(db);

      expect(() => migrate(db)).not.toThrow();

      expect(columnIsNotNull(db, "spaces", "project_id")).toBe(false);
      expectOrphanUntouched(db);
    } finally {
      db.close();
    }
  });

  it("migrations 90 and 121 widen space_items ref types despite an unrelated violation", () => {
    const db = freshDb();
    try {
      db.pragma("foreign_keys = OFF");
      db.exec(`
        DROP TABLE space_items;
        CREATE TABLE space_items (
          id            TEXT NOT NULL,
          space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          ref_type      TEXT NOT NULL
                          CHECK(ref_type IN ('issue','comment','artifact','external_ref')),
          ref_id        TEXT NOT NULL CHECK(ref_id != ''),
          ref_uri       TEXT,
          title         TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
                          CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          PRIMARY KEY (id),
          UNIQUE (space_id, id),
          UNIQUE (space_id, ref_type, ref_id),
          CHECK (ref_type != 'external_ref' OR ref_uri IS NOT NULL)
        );
        CREATE INDEX idx_space_items_lookup ON space_items(space_id, ref_type, ref_id);
        CREATE INDEX idx_space_items_by_ref ON space_items(ref_type, ref_id, space_id);
      `);
      reopenPostMigrations(
        db,
        "v90_space_items_link_space_refs",
        "v121_space_items_finding_refs",
      );
      plantUnrelatedOrphan(db);

      expect(() => migrate(db)).not.toThrow();

      const sql = tableSql(db, "space_items");
      expect(sql).toContain("'space'");
      expect(sql).not.toContain("'finding'");
      expectOrphanUntouched(db);
    } finally {
      db.close();
    }
  });

  it("migration 91 backfills artifact identity despite an unrelated violation", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO ledger_projects (
           id, project_key, display_name, remote_identity, upstream_identity,
           namespace_policy, created_at, updated_at
         ) VALUES ('prj_mandible', 'mandible', 'Mandible', 'github.com/i-m-mll/mandible',
                   '', 'remote', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO artifacts (
           id, algorithm, content_hash, uri, media_type, role, size_bytes, custody_mode,
           availability, retention_json, reference_json, created_at
         ) VALUES ('art_x', 'sha256', 'hash_x', 'file:///tmp/art_x', 'text/plain', 'note',
                   5, 'link', 'unchecked', '{}', '{}', 20)`,
      ).run();
      reopenPostMigrations(db, "v91_backfill_artifact_identity");
      plantUnrelatedOrphan(db);

      expect(() => migrate(db)).not.toThrow();

      expect(
        db.prepare("SELECT count(*) AS n FROM artifact_blob WHERE content_hash = 'hash_x'").get(),
      ).toEqual({ n: 1 });
      expectOrphanUntouched(db);
    } finally {
      db.close();
    }
  });

  it("migration 104 rebuilds canonical artifact targets despite an unrelated violation", () => {
    const db = freshDb();
    try {
      restorePreV104ArtifactTargetSchema(db);
      reopenPostMigrations(db, "v104_artifact_canonical_targets");
      plantUnrelatedOrphan(db);

      expect(() => migrate(db)).not.toThrow();

      for (const [table, column] of [
        ["artifact_aliases", "blob_id"],
        ["artifact_links", "blob_id"],
        ["session_instruction_artifacts", "artifact_id"],
        ["artifact_drafts", "artifact_id"],
      ] as const) {
        const names = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((entry) => entry.name);
        expect(names).toContain(column);
      }
      expectOrphanUntouched(db);
    } finally {
      db.close();
    }
  });

  it("migration 105 adds canonical space export blobs despite an unrelated violation", () => {
    const db = freshDb();
    try {
      db.pragma("foreign_keys = OFF");
      db.exec(`
        DROP TABLE space_exports;
        CREATE TABLE space_exports (
          id                              TEXT PRIMARY KEY,
          space_id                        TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          repo_id                         TEXT NOT NULL
                                            REFERENCES ledger_project_checkouts(id) ON DELETE RESTRICT,
          branch                          TEXT NOT NULL,
          path                            TEXT NOT NULL,
          authority                       TEXT NOT NULL DEFAULT 'mandible'
                                            CHECK(authority IN ('mandible','repo')),
          status                          TEXT NOT NULL DEFAULT 'clean'
                                            CHECK(status IN ('clean','stale','repo_changed','worktree_dirty','conflict')),
          last_export_artifact_id         TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          pre_export_snapshot_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          last_export_commit              TEXT,
          last_export_blob_sha            TEXT,
          last_export_content_sha256      TEXT,
          last_seen_commit                TEXT,
          last_seen_content_sha256        TEXT,
          created_at                      INTEGER NOT NULL,
          updated_at                      INTEGER NOT NULL,
          UNIQUE (repo_id, branch, path)
        );
        CREATE INDEX idx_space_exports_space ON space_exports(space_id);
        CREATE INDEX idx_space_exports_repo ON space_exports(repo_id, branch, path);
      `);
      reopenPostMigrations(db, "v105_space_export_canonical_artifacts");
      plantUnrelatedOrphan(db);

      expect(() => migrate(db)).not.toThrow();

      const names = (db.prepare("PRAGMA table_info(space_exports)").all() as Array<{ name: string }>)
        .map((entry) => entry.name);
      expect(names).toContain("last_export_blob_id");
      expect(names).toContain("pre_export_snapshot_blob_id");
      expectOrphanUntouched(db);
    } finally {
      db.close();
    }
  });
});

/**
 * The pre-v104 shape of the four artifact target tables, mirroring
 * `restorePreV104ArtifactTargetSchema` in test/db-migration-v91.test.ts. The
 * tables are empty here: this test is about the migration's integrity check,
 * not its data mapping, which the v91/v104 suites already cover.
 */
function restorePreV104ArtifactTargetSchema(db: Db): void {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TABLE artifact_aliases;
    DROP TABLE artifact_links;
    DROP TABLE session_instruction_artifacts;
    DROP TABLE artifact_drafts;
    CREATE TABLE artifact_aliases (
      id TEXT PRIMARY KEY,
      artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
      scheme TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_ref TEXT NOT NULL,
      locator_json TEXT NOT NULL DEFAULT '{}',
      resolution_status TEXT NOT NULL DEFAULT 'resolved'
        CHECK(resolution_status IN ('resolved','unresolved','ambiguous','unsupported')),
      source TEXT NOT NULL DEFAULT 'artifact_registry',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_artifact_aliases_scheme_ref
      ON artifact_aliases(scheme, normalized_ref);
    CREATE INDEX idx_artifact_aliases_artifact
      ON artifact_aliases(artifact_id) WHERE artifact_id IS NOT NULL;
    CREATE INDEX idx_artifact_aliases_status
      ON artifact_aliases(resolution_status, scheme);
    CREATE TABLE artifact_links (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'references',
      role TEXT,
      repo_id TEXT,
      provider_id TEXT,
      source TEXT NOT NULL DEFAULT 'artifact_registry',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      link_kind TEXT NOT NULL DEFAULT 'pinned'
        CHECK(link_kind IN ('pinned','living')),
      series_id TEXT,
      series_ref TEXT,
      target_type TEXT CHECK(
        target_type IS NULL OR target_type IN ('artifact','artifact_version')
      ),
      target_id TEXT,
      fallback_version_id TEXT,
      legacy_blob_id TEXT
    );
    CREATE INDEX idx_artifact_links_artifact ON artifact_links(artifact_id, link_type);
    CREATE INDEX idx_artifact_links_entity ON artifact_links(entity_type, entity_id);
    CREATE INDEX idx_artifact_links_kind ON artifact_links(link_kind);
    CREATE TABLE session_instruction_artifacts (
      session_id TEXT NOT NULL,
      artifact_series_id TEXT NOT NULL REFERENCES artifact_series(id) ON DELETE CASCADE,
      artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
      legacy_preset_id TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, artifact_series_id)
    );
    CREATE INDEX idx_session_instruction_artifacts_session
      ON session_instruction_artifacts(session_id, position);
    CREATE INDEX idx_session_instruction_artifacts_version
      ON session_instruction_artifacts(artifact_version_id);
    CREATE TABLE artifact_drafts (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL REFERENCES artifact_series(id) ON DELETE CASCADE,
      base_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
      content TEXT NOT NULL,
      media_type TEXT,
      label TEXT,
      note TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(series_id)
    );
    CREATE INDEX idx_artifact_drafts_base ON artifact_drafts(base_version_id);
  `);
}
