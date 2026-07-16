import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

const COMPLETION_KEY = "post_migration.v104_artifact_canonical_targets.complete";

let db: Db;
let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v104-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  downgradeArtifactTargetsToV103();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function downgradeArtifactTargetsToV103(): void {
  db.pragma("foreign_keys = OFF");
  try {
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
      CREATE INDEX idx_artifact_links_series
        ON artifact_links(series_id) WHERE series_id IS NOT NULL;
      CREATE INDEX idx_artifact_links_target
        ON artifact_links(target_type, target_id)
        WHERE target_type IS NOT NULL AND target_id IS NOT NULL;
      CREATE INDEX idx_artifact_links_fallback_version
        ON artifact_links(fallback_version_id) WHERE fallback_version_id IS NOT NULL;
      CREATE INDEX idx_artifact_links_legacy_blob
        ON artifact_links(legacy_blob_id) WHERE legacy_blob_id IS NOT NULL;
      CREATE INDEX idx_artifact_links_provider
        ON artifact_links(provider_id) WHERE provider_id IS NOT NULL;
      CREATE INDEX idx_artifact_links_repo
        ON artifact_links(repo_id) WHERE repo_id IS NOT NULL;
      CREATE INDEX idx_artifact_links_role
        ON artifact_links(role) WHERE role IS NOT NULL;
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
      UPDATE meta SET value = '103' WHERE key = 'schema_version';
      DELETE FROM meta WHERE key = '${COMPLETION_KEY}';
    `);
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function seedMapping(prefix = "one", hash = "hash-one"): void {
  db.prepare(
    `INSERT INTO artifacts (
       id, algorithm, content_hash, uri, size_bytes, created_at
     ) VALUES (?, 'sha256', ?, ?, 4, 1)`,
  ).run(`legacy-blob-${prefix}`, hash, `file:///${prefix}`);
  db.prepare(
    `INSERT INTO artifact_series (
       id, series_key, source_kind, version_count, metadata_json, created_at, updated_at
     ) VALUES (?, ?, 'managed', 1, '{}', 1, 1)`,
  ).run(`legacy-series-${prefix}`, `identity-${prefix}`);
  db.prepare(
    `INSERT INTO artifact_versions (
       id, series_id, artifact_id, version_no, source_kind, content_hash,
       metadata_json, created_at
     ) VALUES (?, ?, ?, 1, 'managed', ?, '{}', 1)`,
  ).run(
    `legacy-version-${prefix}`,
    `legacy-series-${prefix}`,
    `legacy-blob-${prefix}`,
    hash,
  );
  db.prepare(
    `INSERT INTO artifact_blob (id, algorithm, content_hash, size_bytes, created_at)
     VALUES (?, 'sha256', ?, 4, 1)`,
  ).run(`blob-${prefix}`, hash);
  db.prepare(
    `INSERT INTO artifact (
       id, identity_key, source_kind, version_count, metadata_json, created_at, updated_at
     ) VALUES (?, ?, 'managed', 1, '{}', 1, 1)`,
  ).run(`artifact-${prefix}`, `identity-${prefix}`);
  db.prepare(
    `INSERT INTO artifact_version (
       id, artifact_id, version_no, blob_id, source_kind, content_hash,
       source_locator_json, metadata_json, created_at
     ) VALUES (?, ?, 1, ?, 'managed', ?, '{}', '{}', 1)`,
  ).run(`version-${prefix}`, `artifact-${prefix}`, `blob-${prefix}`, hash);
}

function seedValidRows(): void {
  seedMapping();
  db.prepare(
    `INSERT INTO artifact_aliases (
       id, artifact_id, scheme, alias, normalized_ref, created_at, updated_at
     ) VALUES ('alias-one', 'legacy-blob-one', 'artifact', 'one', 'artifact:one', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO artifact_links (
       id, artifact_id, entity_type, entity_id, link_kind, target_type, target_id,
       legacy_blob_id, created_at, updated_at
     ) VALUES (
       'link-pinned', 'legacy-blob-one', 'issue', 'issue-one', 'pinned',
       'artifact_version', 'version-one', 'blob-one', 1, 1
     )`,
  ).run();
  db.prepare(
    `INSERT INTO artifact_links (
       id, artifact_id, entity_type, entity_id, link_kind, created_at, updated_at
     ) VALUES (
       'link-untyped', 'legacy-blob-one', 'issue', 'issue-three', 'pinned', 1, 1
     )`,
  ).run();
  db.prepare(
    `INSERT INTO artifact_links (
       id, artifact_id, entity_type, entity_id, link_kind, series_id,
       target_type, target_id, fallback_version_id, created_at, updated_at
     ) VALUES (
       'link-living', 'legacy-blob-one', 'issue', 'issue-two', 'living',
       'legacy-series-one', 'artifact', 'artifact-one', 'version-one', 1, 1
     )`,
  ).run();
  db.prepare(
    `INSERT INTO session_instruction_artifacts (
       session_id, artifact_series_id, artifact_version_id, position, created_at, updated_at
     ) VALUES ('session-one', 'legacy-series-one', 'legacy-version-one', 0, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO artifact_drafts (
       id, series_id, base_version_id, content, created_at, updated_at
     ) VALUES ('draft-one', 'legacy-series-one', 'legacy-version-one', 'draft', 1, 1)`,
  ).run();
}

function completionMarker(): unknown {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(COMPLETION_KEY);
}

function tableSql(table: string): string {
  return (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string }).sql;
}

describe("migration v104: canonical artifact targets", () => {
  it("backfills every target, preserves legacy columns, and reopens idempotently", () => {
    seedValidRows();

    migrate(db);

    expect(db.prepare(
      "SELECT artifact_id, blob_id FROM artifact_aliases WHERE id = 'alias-one'",
    ).get()).toEqual({ artifact_id: "legacy-blob-one", blob_id: "blob-one" });
    expect(db.prepare(
      `SELECT id, blob_id, target_type, target_id
         FROM artifact_links ORDER BY id`,
    ).all()).toEqual([
      {
        id: "link-living",
        blob_id: "blob-one",
        target_type: "artifact",
        target_id: "artifact-one",
      },
      {
        id: "link-pinned",
        blob_id: "blob-one",
        target_type: "artifact_version",
        target_id: "version-one",
      },
      {
        id: "link-untyped",
        blob_id: "blob-one",
        target_type: "artifact_blob",
        target_id: "blob-one",
      },
    ]);
    expect(db.prepare(
      `SELECT artifact_id, version_id, artifact_series_id, artifact_version_id
         FROM session_instruction_artifacts`,
    ).get()).toEqual({
      artifact_id: "artifact-one",
      version_id: "version-one",
      artifact_series_id: "legacy-series-one",
      artifact_version_id: "legacy-version-one",
    });
    expect(db.prepare(
      "SELECT artifact_id, version_id, series_id, base_version_id FROM artifact_drafts",
    ).get()).toEqual({
      artifact_id: "artifact-one",
      version_id: "version-one",
      series_id: "legacy-series-one",
      base_version_id: "legacy-version-one",
    });
    expect(completionMarker()).toEqual({ value: "done" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);

    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_links").get()).toEqual({ count: 3 });
  });

  it("fails closed on an unmappable blob and reports the link id", () => {
    db.prepare(
      `INSERT INTO artifacts (id, algorithm, content_hash, uri, size_bytes, created_at)
       VALUES ('legacy-only', 'sha256', 'missing-hash', 'file:///missing', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO artifact_links (
         id, artifact_id, entity_type, entity_id, created_at, updated_at
       ) VALUES ('link-unmappable', 'legacy-only', 'issue', 'issue-one', 1, 1)`,
    ).run();
    const beforeSql = tableSql("artifact_links");

    expect(() => migrate(db)).toThrow(/links must map.*link-unmappable/i);
    expect(tableSql("artifact_links")).toBe(beforeSql);
    expect(db.prepare("SELECT artifact_id FROM artifact_links").get()).toEqual({
      artifact_id: "legacy-only",
    });
    expect(completionMarker()).toBeUndefined();
  });

  it("fails closed on a canonical target that identifies different bytes", () => {
    seedValidRows();
    seedMapping("two", "hash-two");
    db.prepare(
      `UPDATE artifact_links
          SET target_id = 'version-two'
        WHERE id = 'link-pinned'`,
    ).run();

    expect(() => migrate(db)).toThrow(/targets contradict.*link-pinned/i);
    expect(tableSql("artifact_links")).not.toMatch(/blob_id\s+TEXT NOT NULL/i);
    expect(completionMarker()).toBeUndefined();
  });

  it("rolls back DDL and data when index recreation fails inside the rebuild", () => {
    seedValidRows();
    db.prepare(
      `INSERT INTO artifact_links (
         id, artifact_id, entity_type, entity_id, link_kind, created_at, updated_at
       ) VALUES (
         'link-second-untyped', 'legacy-blob-one', 'issue', 'issue-four', 'pinned', 1, 1
       )`,
    ).run();
    db.exec(
      `CREATE UNIQUE INDEX idx_artifact_links_custom_v104_test
         ON artifact_links(target_type, target_id)`,
    );
    const beforeSql = tableSql("artifact_links");

    expect(() => migrate(db)).toThrow(/UNIQUE constraint failed.*target_type/i);
    expect(tableSql("artifact_links")).toBe(beforeSql);
    expect(db.prepare(
      "SELECT artifact_id, target_id FROM artifact_links WHERE id = 'link-pinned'",
    ).get()).toEqual({
      artifact_id: "legacy-blob-one",
      target_id: "version-one",
    });
    expect(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get("idx_artifact_links_custom_v104_test")).toEqual({ 1: 1 });
    expect(completionMarker()).toBeUndefined();
  });

  it("fails closed on a canonical session key collision", () => {
    seedMapping();
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TABLE session_instruction_artifacts;
      CREATE TABLE session_instruction_artifacts (
        session_id TEXT NOT NULL,
        artifact_series_id TEXT NOT NULL REFERENCES artifact_series(id),
        artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
        legacy_preset_id TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.pragma("foreign_keys = ON");
    const insert = db.prepare(
      `INSERT INTO session_instruction_artifacts (
         session_id, artifact_series_id, artifact_version_id, position, created_at, updated_at
       ) VALUES ('session-one', 'legacy-series-one', 'legacy-version-one', ?, 1, 1)`,
    );
    insert.run(0);
    insert.run(1);

    expect(() => migrate(db)).toThrow(/canonical session attachment keys collide/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM session_instruction_artifacts").get()).toEqual({
      count: 2,
    });
    expect(completionMarker()).toBeUndefined();
  });
});
