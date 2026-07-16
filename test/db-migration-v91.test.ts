import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate, openDb, type Db } from "../src/db.js";
import { resolveArtifactRef } from "../src/provider-artifacts.js";

let tempDir = "";
let db: Db;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    MANDIBLE_HOME: process.env.MANDIBLE_HOME,
    MANDIBLE_ARTIFACT_DIR: process.env.MANDIBLE_ARTIFACT_DIR,
  };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v91-"));
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

function columns(table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
}

function indexNames(table: string): Set<string> {
  return new Set(
    (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
      .all(table) as Array<{ name: string }>).map((row) => row.name),
  );
}

function insertLegacyFixture(): void {
  db.prepare(
    `INSERT INTO ledger_projects (
      id, project_key, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at
    ) VALUES ('prj_mandible', 'mandible', 'Mandible', 'github.com/i-m-mll/mandible', '', 'remote', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO artifacts (
      id, algorithm, content_hash, uri, media_type, role, size_bytes, custody_mode,
      home_repo_id, repo_locator_json, availability, retention_json, reference_json, created_at
    ) VALUES (?, 'sha256', ?, ?, 'text/markdown', 'report', 12, ?, ?, ?, 'present', '{}', '{}', ?)`,
  ).run(
    `artifact:sha256:${"a".repeat(64)}`,
    "a".repeat(64),
    "repo://mandible@abc/docs/report.md",
    "managed",
    "mandible",
    '{"repo":"mandible","path":"docs/report.md"}',
    10,
  );
  db.prepare(
    `INSERT INTO artifacts (
      id, algorithm, content_hash, uri, media_type, role, size_bytes, custody_mode,
      availability, retention_json, reference_json, created_at
    ) VALUES ('art_x', 'sha256', 'hash_x', 'file:///tmp/art_x', 'text/plain', 'note', 5, 'link',
      'unchecked', '{}', '{}', 20)`,
  ).run();
  db.prepare(
    `INSERT INTO artifact_series (
      id, series_key, source_kind, title, repo_id, logical_name, latest_version_id,
      version_count, metadata_json, created_at, updated_at
    ) VALUES (?, 'repo:mandible:docs/report.md', 'tracked_repo', 'Report', 'mandible',
      'docs/report.md', 'artifact-version:v1', 1, '{}', 100, 101)`,
  ).run("artifact-series:report");
  db.prepare(
    `INSERT INTO artifact_series (
      id, series_key, source_kind, title, version_count, metadata_json, created_at, updated_at
    ) VALUES ('series-1', 'managed:test:series-1', 'managed', 'Synthetic', 1, '{}', 200, 201)`,
  ).run();
  db.prepare(
    `INSERT INTO artifact_versions (
      id, series_id, artifact_id, version_no, source_kind, content_hash, commit_sha,
      repo_path, observed_path, custody_mode, label, note, metadata_json, created_at
    ) VALUES (
      'artifact-version:v1', ?, ?, 1, 'tracked_repo', ?, 'abc', 'docs/report.md',
      NULL, 'managed', 'v1', NULL, '{}', 110
    )`,
  ).run("artifact-series:report", `artifact:sha256:${"a".repeat(64)}`, "a".repeat(64));
  db.prepare(
    `INSERT INTO artifact_versions (
      id, series_id, artifact_id, version_no, source_kind, content_hash,
      custody_mode, metadata_json, created_at
    ) VALUES ('v_syn', 'series-1', 'art_x', 1, 'managed', 'hash_x', 'link', '{}', 210)`,
  ).run();
  db.prepare(
    `INSERT INTO artifact_links (
      id, artifact_id, entity_type, entity_id, link_type, link_kind, created_at, updated_at
    ) VALUES ('lnk_pinned', 'art_x', 'issue', 'iss', 'references', 'pinned', 300, 300)`,
  ).run();
  db.prepare(
    `INSERT INTO artifact_links (
      id, artifact_id, entity_type, entity_id, link_type, link_kind, series_id, created_at, updated_at
    ) VALUES (?, ?, 'issue', 'iss', 'references', 'living', ?, 301, 301)`,
  ).run("lnk_living", `artifact:sha256:${"a".repeat(64)}`, "artifact-series:report");
}

describe("migration v91: artifact identity and project associations", () => {
  it("creates the fresh schema with constraints and no blob project/source columns", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(91);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: String(CURRENT_SCHEMA_VERSION),
    });

    const blobColumns = columns("artifact_blob");
    expect(blobColumns.has("home_repo_id")).toBe(false);
    expect(blobColumns.has("repo_locator_json")).toBe(false);
    for (const table of ["artifact_blob", "artifact", "artifact_version", "project_artifact_associations"]) {
      expect(columns(table).size, `${table} columns`).toBeGreaterThan(0);
    }
    expect(indexNames("artifact_blob")).toContain("idx_artifact_blob_custody");
    expect(indexNames("artifact_version")).toContain("idx_artifact_version_blob");
    expect(indexNames("project_artifact_associations")).toContain("idx_project_artifact_assoc_target");

    db.prepare(
      `INSERT INTO artifact_blob (id, algorithm, content_hash, storage_uri, custody_mode, created_at)
       VALUES ('artifact-blob:a', 'sha256', 'hash-a', 'file:///a', 'managed', 1)`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO artifact_blob (id, algorithm, content_hash, storage_uri, custody_mode, created_at)
         VALUES ('artifact-blob:a2', 'sha256', 'hash-a', 'file:///a2', 'managed', 1)`,
      ).run(),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db.prepare(
        `INSERT INTO project_artifact_associations (
          id, project_id, target_type, target_id, association_kind, role, status, source, created_at, updated_at
        ) VALUES ('pa_bad', 'missing', 'blob', 'artifact-blob:a', 'canonical', '', 'active', 'user', 1, 1)`,
      ).run(),
    ).toThrow(/CHECK|constraint/i);
  });

  it("backfills legacy rows into new names, repairs link targets, and creates no inferred associations", () => {
    insertLegacyFixture();
    db.prepare("UPDATE meta SET value = '90' WHERE key = 'schema_version'").run();

    expect(() => migrate(db)).not.toThrow();

    const blobRows = db
      .prepare("SELECT id, storage_uri FROM artifact_blob ORDER BY id")
      .all() as Array<{ id: string; storage_uri: string | null }>;
    expect(blobRows.map((row) => row.id)).toEqual([
      `artifact-blob:${"a".repeat(64)}`,
      "artifact-blob:art_x",
    ]);
    expect(blobRows[0].storage_uri).toBeNull();

    const artifacts = db
      .prepare("SELECT id, identity_key, source_project_id, latest_version_id FROM artifact ORDER BY id")
      .all() as Array<{
      id: string;
      identity_key: string;
      source_project_id: string | null;
      latest_version_id: string | null;
    }>;
    expect(artifacts).toEqual([
      {
        id: "artifact:report",
        identity_key: "repo:mandible:docs/report.md",
        source_project_id: "prj_mandible",
        latest_version_id: "artifact-version:v1",
      },
      {
        id: "artifact:series-1",
        identity_key: "managed:test:series-1",
        source_project_id: null,
        latest_version_id: null,
      },
    ]);

    const versions = db
      .prepare("SELECT id, artifact_id, blob_id, source_project_id FROM artifact_version ORDER BY id")
      .all();
    expect(versions).toEqual([
      {
        id: "artifact-version:v1",
        artifact_id: "artifact:report",
        blob_id: `artifact-blob:${"a".repeat(64)}`,
        source_project_id: "prj_mandible",
      },
      {
        id: "artifact-version:v_syn",
        artifact_id: "artifact:series-1",
        blob_id: "artifact-blob:art_x",
        source_project_id: null,
      },
    ]);

    expect(
      db.prepare("SELECT COUNT(*) AS n FROM project_artifact_associations").get(),
    ).toMatchObject({ n: 0 });
    expect(
      db.prepare(
        `SELECT id, target_type, target_id, fallback_version_id, legacy_blob_id
         FROM artifact_links ORDER BY id`,
      ).all(),
    ).toEqual([
      {
        id: "lnk_living",
        target_type: "artifact",
        target_id: "artifact:report",
        fallback_version_id: "artifact-version:v1",
        legacy_blob_id: `artifact-blob:${"a".repeat(64)}`,
      },
      {
        id: "lnk_pinned",
        target_type: "artifact_version",
        target_id: "artifact-version:v_syn",
        fallback_version_id: null,
        legacy_blob_id: "artifact-blob:art_x",
      },
    ]);
  });

  it("resolves legacy-only rows through canonical refs after migration", () => {
    const hash = "a".repeat(64);
    const blobId = `artifact-blob:${hash}`;
    insertLegacyFixture();
    db.prepare("UPDATE meta SET value = '90' WHERE key = 'schema_version'").run();

    migrate(db);

    const logical = resolveArtifactRef(db, "artifact:report", 1_000);
    expect(logical).toMatchObject({
      status: "resolved",
      normalized_ref: "artifact:report",
      target_type: "artifact",
      target_id: "artifact:report",
      logical_artifact: {
        id: "artifact:report",
        identity_key: "repo:mandible:docs/report.md",
        source_kind: "tracked_repo",
        title: "Report",
        source_project_id: "prj_mandible",
        source_repo_id: "mandible",
        logical_name: "docs/report.md",
        source_path: "docs/report.md",
        latest_version_id: "artifact-version:v1",
        version_count: 1,
        metadata: {},
        created_at: 100,
        updated_at: 101,
      },
      artifact_version: {
        id: "artifact-version:v1",
        artifact_id: "artifact:report",
        version_no: 1,
        blob_id: blobId,
        source_kind: "tracked_repo",
        content_hash: hash,
        source_project_id: "prj_mandible",
        source_repo_id: "mandible",
        repo_path: "docs/report.md",
        commit_sha: "abc",
        observed_path: null,
        source_locator: {
          migrated_from: "artifact_versions",
          legacy_series_id: "artifact-series:report",
          legacy_blob_id: `artifact:sha256:${hash}`,
          legacy_uri: "repo://mandible@abc/docs/report.md",
          legacy_repo_locator: '{"repo":"mandible","path":"docs/report.md"}',
          series_logical_name: "docs/report.md",
        },
        custody_mode: "managed",
        label: "v1",
        note: null,
        metadata: {},
        created_at: 110,
      },
      artifact_blob: {
        id: blobId,
        algorithm: "sha256",
        content_hash: hash,
        storage_uri: null,
        media_type: "text/markdown",
        role: "report",
        size_bytes: 12,
        provider_id: null,
        manifest_id: null,
        metadata: {},
        custody_mode: "managed",
        availability: "present",
        retention: {},
        reference: {},
        created_at: 10,
      },
    });

    expect(resolveArtifactRef(db, "artifact-version:v1", 1_000)).toMatchObject({
      status: "resolved",
      normalized_ref: "artifact-version:v1",
      target_type: "artifact_version",
      target_id: "artifact-version:v1",
      logical_artifact: { id: "artifact:report" },
      artifact_version: {
        id: "artifact-version:v1",
        artifact_id: "artifact:report",
        blob_id: blobId,
      },
      artifact_blob: { id: blobId, content_hash: hash },
    });

    expect(resolveArtifactRef(db, blobId, 1_000)).toMatchObject({
      status: "resolved",
      normalized_ref: blobId,
      target_type: "artifact_blob",
      target_id: blobId,
      artifact_blob: { id: blobId, content_hash: hash },
    });
  });

  it("is idempotent when v91 is replayed on a current database", () => {
    insertLegacyFixture();
    db.prepare("UPDATE meta SET value = '90' WHERE key = 'schema_version'").run();
    migrate(db);

    const before = {
      blobs: db.prepare("SELECT * FROM artifact_blob ORDER BY id").all(),
      artifacts: db.prepare("SELECT * FROM artifact ORDER BY id").all(),
      versions: db.prepare("SELECT * FROM artifact_version ORDER BY id").all(),
      links: db.prepare("SELECT id, target_type, target_id, fallback_version_id, legacy_blob_id FROM artifact_links ORDER BY id").all(),
    };

    db.prepare("UPDATE meta SET value = '90' WHERE key = 'schema_version'").run();
    migrate(db);
    migrate(db);

    expect(db.prepare("SELECT * FROM artifact_blob ORDER BY id").all()).toEqual(before.blobs);
    expect(db.prepare("SELECT * FROM artifact ORDER BY id").all()).toEqual(before.artifacts);
    expect(db.prepare("SELECT * FROM artifact_version ORDER BY id").all()).toEqual(before.versions);
    expect(
      db.prepare("SELECT id, target_type, target_id, fallback_version_id, legacy_blob_id FROM artifact_links ORDER BY id").all(),
    ).toEqual(before.links);
  });
});
