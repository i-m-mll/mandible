import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";
import {
  backfillOrphanArtifactSeries,
  getArtifactSeries,
  listArtifactVersions,
} from "../src/provider-artifacts.js";

let tempDir = "";
let db: Db;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    MANDIBLE_HOME: process.env.MANDIBLE_HOME,
    MANDIBLE_ARTIFACT_DIR: process.env.MANDIBLE_ARTIFACT_DIR,
  };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-series-backfill-"));
  process.env.HOME = path.join(tempDir, "home");
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "artifacts");
  delete process.env.MANDIBLE_HOME;
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function insertArtifact(id: string, custody: string, hash: string): void {
  db.prepare(
    `INSERT INTO artifacts (id, algorithm, content_hash, uri, size_bytes, custody_mode, created_at)
     VALUES (?, 'sha256', ?, ?, 0, ?, 1)`,
  ).run(id, hash, `file:///tmp/${id}`, custody);
}

function artifactCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n;
}

function orphanCount(): number {
  return (db
    .prepare(
      `SELECT COUNT(*) AS n FROM artifacts WHERE id NOT IN (SELECT artifact_id FROM artifact_versions)`,
    )
    .get() as { n: number }).n;
}

function legacyRegistryId(prefix: string, parts: unknown[]): string {
  return `${prefix}:${crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function insertLegacySeriesVersion(input: {
  seriesKey: string;
  artifactId: string;
  sourceKind: "managed" | "local_only";
  contentHash: string;
  naturalKey: string;
  custodyMode?: string;
  createdAt?: number;
}): { seriesId: string; versionId: string } {
  const createdAt = input.createdAt ?? 1;
  const seriesId = legacyRegistryId("artifact-series", [input.seriesKey]);
  db.prepare(
    `INSERT INTO artifact_series (
      id, series_key, source_kind, title, repo_id, logical_name,
      latest_version_id, version_count, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 0, '{}', ?, ?)
    ON CONFLICT(series_key) DO NOTHING`,
  ).run(seriesId, input.seriesKey, input.sourceKind, createdAt, createdAt);
  const storedSeries = db.prepare("SELECT id FROM artifact_series WHERE series_key = ?")
    .get(input.seriesKey) as { id: string };
  const versionId = legacyRegistryId(
    "artifact-version",
    [storedSeries.id, input.sourceKind, input.naturalKey],
  );
  const versionNo = Number((db.prepare(
    "SELECT COALESCE(MAX(version_no), 0) AS n FROM artifact_versions WHERE series_id = ?",
  ).get(storedSeries.id) as { n: number }).n) + 1;
  const inserted = db.prepare(
    `INSERT INTO artifact_versions (
      id, series_id, artifact_id, version_no, parent_version_id, source_kind,
      content_hash, commit_sha, repo_path, observed_path, custody_mode, label,
      note, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, '{}', ?)
    ON CONFLICT(id) DO NOTHING`,
  ).run(
    versionId,
    storedSeries.id,
    input.artifactId,
    versionNo,
    input.sourceKind,
    input.contentHash,
    input.custodyMode ?? null,
    createdAt,
  );
  if (inserted.changes > 0) {
    db.prepare(
      `UPDATE artifact_series
          SET latest_version_id = ?, version_count = version_count + 1, updated_at = ?
        WHERE id = ?`,
    ).run(versionId, createdAt, storedSeries.id);
  }
  return { seriesId: storedSeries.id, versionId };
}

function restorePreV89ArtifactAssociationSchema(): void {
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
        updated_at    INTEGER NOT NULL
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
      DELETE FROM meta
       WHERE key = 'post_migration.v104_artifact_canonical_targets.complete';
    `);
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

describe("backfillOrphanArtifactSeries (migration v89)", () => {
  it("wraps every series-less artifact into a deterministic 1-version series", () => {
    insertArtifact("art_1", "managed", "hash_1");
    insertArtifact("art_2", "managed", "hash_2");

    const wrapped = backfillOrphanArtifactSeries(db);
    expect(wrapped).toBe(2);
    expect(orphanCount()).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM artifact_blob").get() as { n: number }).n).toBe(0);

    for (const id of ["art_1", "art_2"]) {
      const series = getArtifactSeries(db, id);
      expect(series).not.toBeNull();
      expect(series!.series_key).toBe(id); // series_key IS the artifact id
      expect(series!.version_count).toBe(1);
      expect(series!.latest_version_id).not.toBeNull();
      const versions = listArtifactVersions(db, series!.id);
      expect(versions).toHaveLength(1);
      expect(versions[0].artifact_id).toBe(id);
      expect(series!.latest_version_id).toBe(versions[0].id);
    }
  });

  it("maps series source_kind from custody (managed/copy->managed, link/external->local_only) and preserves true custody on the version", () => {
    const cases: Array<[string, string, "managed" | "local_only"]> = [
      ["art_managed", "managed", "managed"],
      ["art_copy", "copy", "managed"],
      ["art_link", "link", "local_only"],
      ["art_external", "external", "local_only"],
    ];
    for (const [id, custody, _expected] of cases) {
      insertArtifact(id, custody, `hash_${id}`);
    }

    expect(backfillOrphanArtifactSeries(db)).toBe(cases.length);

    for (const [id, custody, expectedSeriesKind] of cases) {
      const series = getArtifactSeries(db, id)!;
      expect(series.source_kind).toBe(expectedSeriesKind);
      const version = listArtifactVersions(db, series.id)[0];
      expect(version.source_kind).toBe(expectedSeriesKind);
      // The version row preserves the TRUE artifact custody_mode.
      expect(version.custody_mode).toBe(custody);
      // The version content_hash mirrors the immutable artifact content row.
      expect(version.content_hash).toBe(`hash_${id}`);
    }
  });

  it("is idempotent: a second backfill wraps nothing and changes no rows", () => {
    insertArtifact("art_a", "managed", "hash_a");
    insertArtifact("art_b", "link", "hash_b");
    expect(backfillOrphanArtifactSeries(db)).toBe(2);

    const seriesBefore = db.prepare("SELECT * FROM artifact_series ORDER BY id").all();
    const versionsBefore = db.prepare("SELECT * FROM artifact_versions ORDER BY id").all();
    const artifactsBefore = db.prepare("SELECT * FROM artifacts ORDER BY id").all();

    expect(backfillOrphanArtifactSeries(db)).toBe(0);

    expect(db.prepare("SELECT * FROM artifact_series ORDER BY id").all()).toEqual(seriesBefore);
    expect(db.prepare("SELECT * FROM artifact_versions ORDER BY id").all()).toEqual(versionsBefore);
    expect(db.prepare("SELECT * FROM artifacts ORDER BY id").all()).toEqual(artifactsBefore);
  });

  it("never touches the artifacts row count", () => {
    insertArtifact("art_1", "managed", "hash_1");
    insertArtifact("art_2", "copy", "hash_2");
    insertArtifact("art_3", "external", "hash_3");
    const before = artifactCount();
    backfillOrphanArtifactSeries(db);
    expect(artifactCount()).toBe(before);
  });

  it("skips artifacts that already belong to a series (non-orphans)", () => {
    insertArtifact("art_existing", "managed", "hash_existing");
    insertArtifact("art_orphan", "managed", "hash_orphan");

    // Give art_existing its own (non-default-keyed) series + version.
    insertLegacySeriesVersion({
      seriesKey: "managed:custom:report",
      artifactId: "art_existing",
      sourceKind: "managed",
      contentHash: "hash_existing",
      naturalKey: "art_existing",
    });

    expect(backfillOrphanArtifactSeries(db)).toBe(1); // only art_orphan
    // No backfill series was minted for the already-seriesed artifact.
    expect(getArtifactSeries(db, "art_existing")).toBeNull(); // no series_key == 'art_existing'
    expect(getArtifactSeries(db, "art_orphan")).not.toBeNull();
    expect(orphanCount()).toBe(0);
  });

  it("runs inline when already inside a transaction (no nested-transaction error)", () => {
    insertArtifact("art_tx", "managed", "hash_tx");
    expect(() => db.transaction(() => backfillOrphanArtifactSeries(db)).immediate()).not.toThrow();
    const series = getArtifactSeries(db, "art_tx")!;
    expect(listArtifactVersions(db, series.id)).toHaveLength(1);
  });

  it("runs end-to-end through migrate() and passes verifyEveryArtifactHasSeries", () => {
    insertArtifact("art_m1", "managed", "hash_m1");
    insertArtifact("art_m2", "link", "hash_m2");
    expect(orphanCount()).toBe(2);
    const artifactsBefore = artifactCount();

    // Rewind the schema version so migrate() replays v89 (its post-DDL backfill
    // gate sees v89 pending and runs even though openDb already marked it done).
    restorePreV89ArtifactAssociationSchema();
    db.prepare("UPDATE meta SET value = '88' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).not.toThrow();

    expect(orphanCount()).toBe(0);
    expect(artifactCount()).toBe(artifactsBefore);
    for (const id of ["art_m1", "art_m2"]) {
      const series = getArtifactSeries(db, id)!;
      expect(series.version_count).toBe(1);
      expect(series.latest_version_id).not.toBeNull();
    }
  });

  it("does not false-fail when a legitimate pre-existing series_key equals an artifact id with >1 versions", () => {
    insertArtifact("art_multi", "managed", "hash_multi");
    insertArtifact("art_multi_v2", "managed", "hash_multi_v2");
    insertArtifact("art_orphan", "managed", "hash_orphan");

    // v88 allows an explicit series_key, so a real multi-version series can carry
    // a key that equals an artifact id. v89 must NOT assume such a series is a
    // 1-version backfill.
    insertLegacySeriesVersion({
      seriesKey: "art_multi",
      artifactId: "art_multi",
      sourceKind: "managed",
      contentHash: "hash_multi",
      naturalKey: "k1",
    });
    insertLegacySeriesVersion({
      seriesKey: "art_multi",
      artifactId: "art_multi_v2",
      sourceKind: "managed",
      contentHash: "hash_multi_v2",
      naturalKey: "k2",
    });
    expect(getArtifactSeries(db, "art_multi")!.version_count).toBe(2);

    restorePreV89ArtifactAssociationSchema();
    db.prepare("UPDATE meta SET value = '88' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).not.toThrow();

    expect(orphanCount()).toBe(0); // art_orphan covered
    expect(getArtifactSeries(db, "art_multi")!.version_count).toBe(2); // untouched
  });

  it("rolls back ALL backfill writes and leaves the gate unmarked when the post-condition fails", () => {
    insertArtifact("art_other", "managed", "hash_other");
    insertArtifact("art_x", "managed", "hash_x");
    insertArtifact("art_z", "managed", "hash_z");

    // Plant a version-id collision: a version under series_key 'art_x' whose
    // deterministic id equals the one the backfill will compute for art_x, but
    // pointing at a DIFFERENT artifact. The backfill's ON CONFLICT(id) DO NOTHING
    // then leaves art_x uncovered, so verifyEveryArtifactHasSeries throws and the
    // whole immediate transaction (including art_z's successful wrap) rolls back.
    insertLegacySeriesVersion({
      seriesKey: "art_x",
      artifactId: "art_other",
      sourceKind: "managed",
      contentHash: "hash_other",
      naturalKey: "art_x",
    });

    // Model a first-time v88 -> v89 upgrade: the gate was never set (openDb set
    // it on the empty DB, so clear it here).
    db.prepare("DELETE FROM meta WHERE key = ?").run(
      "post_migration.v89_backfill_orphan_artifact_series.complete",
    );
    restorePreV89ArtifactAssociationSchema();
    db.prepare("UPDATE meta SET value = '88' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).toThrow(/migration 89 verification/i);

    // art_x stays orphan (collision) AND art_z's wrap rolled back -> 2 orphans.
    expect(orphanCount()).toBe(2);
    expect(getArtifactSeries(db, "art_z")).toBeNull();
    // The pre-existing series is untouched by the rolled-back backfill.
    expect(getArtifactSeries(db, "art_x")!.version_count).toBe(1);
    // Gate NOT marked complete: a corrected run re-runs on the next startup.
    const gate = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("post_migration.v89_backfill_orphan_artifact_series.complete") as
      | { value: string }
      | undefined;
    expect(gate?.value).not.toBe("done");
  });
});
