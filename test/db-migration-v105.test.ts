import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";
import { MIGRATIONS, type Migration } from "../src/db-migrations.js";
import {
  findSpaceExport,
  getSpaceExport,
  listSpaceExportsForSpace,
} from "../src/spaces/export.js";

const COMPLETION_KEY = "post_migration.v105_space_export_canonical_artifacts.complete";

let db: Db;
let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v105-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  downgradeSpaceExportsToV104();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function downgradeSpaceExportsToV104(): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      DROP TABLE space_exports;
      CREATE TABLE space_exports (
        id                              TEXT PRIMARY KEY,
        space_id                        TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        repo_id                         TEXT NOT NULL REFERENCES ledger_project_checkouts(id) ON DELETE RESTRICT,
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
      UPDATE meta SET value = '104' WHERE key = 'schema_version';
      DELETE FROM meta WHERE key = '${COMPLETION_KEY}';
    `);
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function seedParents(): void {
  db.prepare(
    `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
     VALUES ('project-one', 'Project One', 'example/project-one', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO ledger_project_checkouts (
       id, project_id, root, name, default_branch, remote_url, created_at, updated_at
     ) VALUES ('checkout-one', 'project-one', '/tmp/project-one', 'project-one', 'main', '', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO spaces (id, project_id, title, created_at, updated_at)
     VALUES ('space-one', 'project-one', 'Space One', 1, 1)`,
  ).run();
}

function seedMapping(
  legacyId = "legacy-one",
  blobId = "blob-one",
  hash = "a".repeat(64),
): void {
  db.prepare(
    `INSERT INTO artifacts (id, algorithm, content_hash, uri, created_at)
     VALUES (?, 'sha256', ?, ?, 1)`,
  ).run(legacyId, hash, `artifact://${legacyId}`);
  db.prepare(
    `INSERT INTO artifact_blob (id, algorithm, content_hash, size_bytes, created_at)
     VALUES (?, 'sha256', ?, 1, 1)`,
  ).run(blobId, hash);
}

function seedExport(args: {
  id?: string;
  legacy?: string | null;
  snapshotLegacy?: string | null;
  canonical?: string | null;
  snapshotCanonical?: string | null;
} = {}): void {
  seedParents();
  const columns = new Set(
    (db.pragma("table_info(space_exports)") as Array<{ name: string }>).map((row) => row.name),
  );
  if (columns.has("last_export_blob_id")) {
    db.prepare(
      `INSERT INTO space_exports (
         id, space_id, repo_id, branch, path,
         last_export_artifact_id, pre_export_snapshot_artifact_id,
         last_export_blob_id, pre_export_snapshot_blob_id, created_at, updated_at
       ) VALUES (?, 'space-one', 'checkout-one', 'docs', 'space.md', ?, ?, ?, ?, 1, 1)`,
    ).run(
      args.id ?? "export-one",
      args.legacy ?? null,
      args.snapshotLegacy ?? null,
      args.canonical ?? null,
      args.snapshotCanonical ?? null,
    );
    return;
  }
  db.prepare(
    `INSERT INTO space_exports (
       id, space_id, repo_id, branch, path,
       last_export_artifact_id, pre_export_snapshot_artifact_id, created_at, updated_at
     ) VALUES (?, 'space-one', 'checkout-one', 'docs', 'space.md', ?, ?, 1, 1)`,
  ).run(args.id ?? "export-one", args.legacy ?? null, args.snapshotLegacy ?? null);
}

function columns(): Set<string> {
  return new Set(
    (db.pragma("table_info(space_exports)") as Array<{ name: string }>).map((row) => row.name),
  );
}

function marker(): unknown {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(COMPLETION_KEY);
}

function restoreArtifactTargetTablesToV90(): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      DROP TABLE artifact_aliases;
      DROP TABLE artifact_links;
      DROP TABLE session_instruction_artifacts;
      DROP TABLE artifact_drafts;
      DROP TABLE project_artifact_associations;
      DROP TABLE artifact_version;
      DROP TABLE artifact;
      DROP TABLE artifact_blob;
      CREATE TABLE artifact_aliases (
        id                TEXT PRIMARY KEY,
        artifact_id       TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        scheme            TEXT NOT NULL,
        alias             TEXT NOT NULL,
        normalized_ref    TEXT NOT NULL,
        locator_json      TEXT NOT NULL DEFAULT '{}',
        resolution_status TEXT NOT NULL DEFAULT 'resolved'
          CHECK(resolution_status IN ('resolved','unresolved','ambiguous','unsupported')),
        source            TEXT NOT NULL DEFAULT 'artifact_registry',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_artifact_aliases_scheme_ref
        ON artifact_aliases(scheme, normalized_ref);
      CREATE INDEX idx_artifact_aliases_artifact
        ON artifact_aliases(artifact_id) WHERE artifact_id IS NOT NULL;
      CREATE INDEX idx_artifact_aliases_status
        ON artifact_aliases(resolution_status, scheme);
      CREATE TABLE artifact_links (
        id            TEXT PRIMARY KEY,
        artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        entity_type   TEXT NOT NULL,
        entity_id     TEXT NOT NULL,
        link_type     TEXT NOT NULL DEFAULT 'references',
        role          TEXT,
        repo_id       TEXT,
        provider_id   TEXT,
        source        TEXT NOT NULL DEFAULT 'artifact_registry',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        link_kind     TEXT NOT NULL DEFAULT 'pinned'
          CHECK(link_kind IN ('pinned','living')),
        series_id     TEXT,
        series_ref    TEXT
      );
      CREATE INDEX idx_artifact_links_artifact
        ON artifact_links(artifact_id, link_type);
      CREATE INDEX idx_artifact_links_entity
        ON artifact_links(entity_type, entity_id);
      CREATE INDEX idx_artifact_links_repo
        ON artifact_links(repo_id) WHERE repo_id IS NOT NULL;
      CREATE INDEX idx_artifact_links_provider
        ON artifact_links(provider_id) WHERE provider_id IS NOT NULL;
      CREATE INDEX idx_artifact_links_role
        ON artifact_links(role) WHERE role IS NOT NULL;
      CREATE INDEX idx_artifact_links_kind ON artifact_links(link_kind);
      CREATE INDEX idx_artifact_links_series
        ON artifact_links(series_id) WHERE series_id IS NOT NULL;
    `);
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

describe("migration v105: canonical Spaces export artifacts", () => {
  it("completes v105 before applying a synthetic later migration", () => {
    const migrations = MIGRATIONS as Migration[];
    const realHead = migrations.pop();
    expect(realHead?.version).toBe(127);
    migrations.push({
      version: 127,
      name: "test_v105_ordering_boundary",
      statements: [
        `INSERT INTO meta (key, value)
         VALUES (
           'test.v127.observed_v105',
           COALESCE((SELECT value FROM meta WHERE key = '${COMPLETION_KEY}'), 'missing')
         )`,
      ],
    });
    try {
      expect(() => migrate(db)).not.toThrow();
      expect(db.prepare(
        "SELECT value FROM meta WHERE key = 'test.v127.observed_v105'",
      ).get()).toEqual({ value: "done" });
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: "127",
      });
    } finally {
      expect(migrations.pop()?.version).toBe(127);
      if (realHead) migrations.push(realHead);
    }
  });

  it("recovers a missing v105 marker without lowering a newer schema version", () => {
    migrate(db);
    db.exec(`
      UPDATE meta SET value = '107' WHERE key = 'schema_version';
      DELETE FROM meta WHERE key = '${COMPLETION_KEY}';
    `);

    expect(() => migrate(db)).not.toThrow();

    expect(marker()).toEqual({ value: "done" });
    // Re-migration from the rewound fixture now also applies main's user-system
    // migrations (v107-v111) and our additive v112, v113, and v114 columns,
    // advancing (never lowering) the schema version.
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "127",
    });
  });

  it("runs v91 identity backfill before v105 for genuine legacy-only rows", () => {
    const exportHash = "d".repeat(64);
    const snapshotHash = "e".repeat(64);
    db.prepare(
      `INSERT INTO artifacts (id, algorithm, content_hash, uri, created_at)
       VALUES ('legacy-export', 'sha256', ?, 'artifact://legacy-export', 1),
              ('legacy-snapshot', 'sha256', ?, 'artifact://legacy-snapshot', 1)`,
    ).run(exportHash, snapshotHash);
    seedExport({ legacy: "legacy-export", snapshotLegacy: "legacy-snapshot" });
    restoreArtifactTargetTablesToV90();
    db.exec(`
      UPDATE meta SET value = '90' WHERE key = 'schema_version';
      DELETE FROM meta
       WHERE key IN (
         'post_migration.v91_backfill_artifact_identity.complete',
         'post_migration.v104_artifact_canonical_targets.complete',
         '${COMPLETION_KEY}'
       );
    `);

    for (const table of [
      "artifact_blob",
      "artifact",
      "artifact_version",
      "project_artifact_associations",
    ]) {
      expect(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)).toBeUndefined();
    }

    expect(() => migrate(db)).not.toThrow();

    expect(db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('artifact_blob', 'artifact', 'artifact_version',
                       'project_artifact_associations')
        ORDER BY name`,
    ).all()).toEqual([
      { name: "artifact" },
      { name: "artifact_blob" },
      { name: "artifact_version" },
      { name: "project_artifact_associations" },
    ]);
    expect(db.prepare(
      "SELECT id FROM artifact_blob ORDER BY id",
    ).all()).toEqual([
      { id: "artifact-blob:legacy-export" },
      { id: "artifact-blob:legacy-snapshot" },
    ]);

    expect(db.prepare(
      `SELECT last_export_artifact_id, pre_export_snapshot_artifact_id,
              last_export_blob_id, pre_export_snapshot_blob_id
         FROM space_exports WHERE id = 'export-one'`,
    ).get()).toEqual({
      last_export_artifact_id: "legacy-export",
      pre_export_snapshot_artifact_id: "legacy-snapshot",
      last_export_blob_id: "artifact-blob:legacy-export",
      pre_export_snapshot_blob_id: "artifact-blob:legacy-snapshot",
    });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "127",
    });
    expect(marker()).toEqual({ value: "done" });

    const expectedProjection = {
      last_export_artifact_id: `artifact:${exportHash.slice(0, 12)}`,
      pre_export_snapshot_artifact_id: `artifact:${snapshotHash.slice(0, 12)}`,
    };
    expect(getSpaceExport(db, "export-one")).toMatchObject(expectedProjection);
    expect(findSpaceExport(db, "checkout-one", "docs", "space.md")).toMatchObject(
      expectedProjection,
    );
    expect(listSpaceExportsForSpace(db, "space-one")).toHaveLength(1);
    expect(listSpaceExportsForSpace(db, "space-one")[0]).toMatchObject(expectedProjection);
  });

  it("backfills exact mappings, preserves legacy provenance, and reopens idempotently", () => {
    seedMapping("legacy-one", "blob-one", "a".repeat(64));
    seedMapping("legacy-two", "blob-two", "b".repeat(64));
    seedExport({ legacy: "legacy-one", snapshotLegacy: "legacy-two" });

    migrate(db);

    expect(db.prepare(
      `SELECT last_export_artifact_id, pre_export_snapshot_artifact_id,
              last_export_blob_id, pre_export_snapshot_blob_id
         FROM space_exports`,
    ).get()).toEqual({
      last_export_artifact_id: "legacy-one",
      pre_export_snapshot_artifact_id: "legacy-two",
      last_export_blob_id: "blob-one",
      pre_export_snapshot_blob_id: "blob-two",
    });
    expect(marker()).toEqual({ value: "done" });
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.exec(`UPDATE meta SET value = '104' WHERE key = 'schema_version'`);
    db.prepare("DELETE FROM meta WHERE key = ?").run(COMPLETION_KEY);
    expect(() => migrate(db)).not.toThrow();
    expect(marker()).toEqual({ value: "done" });
  });

  it("accepts canonical-only and null rows", () => {
    seedMapping("legacy-one", "blob-one");
    db.exec(`
      ALTER TABLE space_exports ADD COLUMN last_export_blob_id
        TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL;
      ALTER TABLE space_exports ADD COLUMN pre_export_snapshot_blob_id
        TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL;
    `);
    seedExport({ canonical: "blob-one" });

    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare(
      "SELECT last_export_artifact_id, last_export_blob_id FROM space_exports",
    ).get()).toEqual({ last_export_artifact_id: null, last_export_blob_id: "blob-one" });
  });

  it("rolls back columns, gate, and schema version on an unmappable legacy row", () => {
    db.prepare(
      `INSERT INTO artifacts (id, algorithm, content_hash, uri, created_at)
       VALUES ('legacy-missing', 'sha256', ?, 'artifact://missing', 1)`,
    ).run("c".repeat(64));
    seedExport({ legacy: "legacy-missing" });

    expect(() => migrate(db)).toThrow(/map to exactly one canonical blob.*export-one/i);
    expect(columns()).not.toContain("last_export_blob_id");
    expect(marker()).toBeUndefined();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "104",
    });
  });

  it("fails closed on ambiguous canonical bytes and rolls back", () => {
    seedMapping("legacy-one", "blob-one");
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TABLE artifact_blob;
      CREATE TABLE artifact_blob (
        id TEXT PRIMARY KEY, algorithm TEXT NOT NULL, content_hash TEXT NOT NULL,
        storage_uri TEXT, media_type TEXT, role TEXT, size_bytes INTEGER NOT NULL DEFAULT 0,
        provider_id TEXT, manifest_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
        custody_mode TEXT NOT NULL DEFAULT 'managed', availability TEXT NOT NULL DEFAULT 'unchecked',
        retention_json TEXT NOT NULL DEFAULT '{}', reference_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      INSERT INTO artifact_blob (id, algorithm, content_hash, created_at)
      VALUES ('blob-one', 'sha256', '${"a".repeat(64)}', 1),
             ('blob-two', 'sha256', '${"a".repeat(64)}', 1);
    `);
    db.pragma("foreign_keys = ON");
    seedExport({ legacy: "legacy-one" });

    expect(() => migrate(db)).toThrow(/exactly one canonical blob.*export-one/i);
    expect(columns()).not.toContain("last_export_blob_id");
  });

  it("rejects contradictory canonical values without overwriting them", () => {
    seedMapping("legacy-one", "blob-one", "a".repeat(64));
    seedMapping("legacy-two", "blob-two", "b".repeat(64));
    db.exec(`
      ALTER TABLE space_exports ADD COLUMN last_export_blob_id
        TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL;
      ALTER TABLE space_exports ADD COLUMN pre_export_snapshot_blob_id
        TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL;
    `);
    seedExport({ legacy: "legacy-one", canonical: "blob-two" });

    expect(() => migrate(db)).toThrow(/contradicts legacy artifact bytes.*export-one/i);
    expect(db.prepare("SELECT last_export_blob_id FROM space_exports").get()).toEqual({
      last_export_blob_id: "blob-two",
    });
    expect(marker()).toBeUndefined();
  });

  it("rejects partial or wrongly defined canonical columns", () => {
    db.exec("ALTER TABLE space_exports ADD COLUMN last_export_blob_id TEXT");
    expect(() => migrate(db)).toThrow(/only partially applied/i);
    expect(marker()).toBeUndefined();

    db.exec(
      "ALTER TABLE space_exports ADD COLUMN pre_export_snapshot_blob_id TEXT",
    );
    expect(() => migrate(db)).toThrow(/must reference artifact_blob/i);
    expect(marker()).toBeUndefined();
  });

  it("preserves table constraints, explicit indexes, autoindexes, and triggers", () => {
    seedMapping();
    seedExport({ legacy: "legacy-one" });
    db.exec(`
      CREATE INDEX idx_space_exports_custom_v105 ON space_exports(status, updated_at);
      CREATE TRIGGER trg_space_exports_custom_v105
        AFTER UPDATE OF status ON space_exports BEGIN SELECT 1; END;
    `);
    const beforeIndexes = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE tbl_name = 'space_exports' AND type = 'index' ORDER BY name",
    ).all();
    const beforeTriggers = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE tbl_name = 'space_exports' AND type = 'trigger' ORDER BY name",
    ).all();

    migrate(db);

    expect(db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE tbl_name = 'space_exports' AND type = 'index' ORDER BY name",
    ).all()).toEqual(beforeIndexes);
    expect(db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE tbl_name = 'space_exports' AND type = 'trigger' ORDER BY name",
    ).all()).toEqual(beforeTriggers);
    expect(() => db.prepare(
      `INSERT INTO space_exports (
         id, space_id, repo_id, branch, path, authority, status, created_at, updated_at
       ) VALUES ('bad', 'space-one', 'checkout-one', 'docs', 'bad.md', 'invalid', 'clean', 1, 1)`,
    ).run()).toThrow();
  });
});
