// @vitest-environment node
/**
 * The one home for migration tests.
 *
 * The schema has two representations: src/db-baseline.ts creates the head shape
 * outright for a fresh database, and src/db-migrations.ts moves a supported
 * existing database to it. The premise checked here is that a floor-version
 * database migrated to head is indistinguishable from a fresh one.
 *
 * A migration gets a test only when it transforms data. Such a test starts from
 * `migrateFixtureThrough(N - 1)`, which is the frozen floor fixture moved forward
 * by the production runner, seeds the legacy rows, migrates, and asserts what
 * became of them. Nothing here edits `schema_version` or drops a table to fake
 * history, and no other test file builds a pre-head database. A migration that
 * only adds shape needs no test: the floor-to-head equality below covers it.
 *
 * Raising the floor (`MINIMUM_SUPPORTED_SCHEMA_VERSION`):
 *   1. Dump a database at the new floor version, built by migrating the old
 *      floor fixture, to `test/fixtures/schema-v<floor>.sql`, and delete the old
 *      fixture.
 *   2. Delete the migrations at or below the new floor from MIGRATIONS.
 *   3. Delete every case here whose migration is at or below the new floor.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  MINIMUM_SUPPORTED_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  migrate,
  openDb,
  type Db,
} from "../src/db.js";
import { MIGRATIONS } from "../src/db-migrations.js";
import { startDaemon } from "../src/index.js";
import { checkHealth } from "../src/lifecycle.js";
import { readArtifactBytesFull } from "../src/artifact-content.js";
import { authSnapshotDigest } from "../src/auth-lifecycle.js";
import { buildMetadataBackupSql } from "../src/ledger/backup.js";
import { readLedgerChangeFeed } from "../src/ledger/change-feed.js";
import { addProject } from "../src/ledger/project-registry.js";
import { createSpaceBlock } from "../src/ledger/space-blocks.js";
import { createSpace } from "../src/ledger/spaces.js";
import { LedgerStore } from "../src/ledger/store.js";
import { serializeSpaceDocument } from "../src/spaces/export.js";
import { listDocumentHistory } from "../src/spaces/history.js";
import { setupOperator } from "../src/users/store.js";
import { insertRawLedgerIssue, insertRawLedgerProject, SYSTEM_ACTOR } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import {
  builtinAuthHooks,
  FLOOR_FIXTURE,
  metaRows,
  migrateFixtureThrough,
  schemaVersion,
  seededUsers,
  settingsRows,
  sqliteMaster,
  tableInfo,
} from "./helpers/schema-snapshot.js";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(testRuntimeRoot, "migration-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

function makeRepo(repo: string, files: Record<string, string>): string {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), body);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fixture");
  return git(repo, "rev-parse", "HEAD");
}

describe("floor to head", () => {
  it("migrates the floor fixture to the schema a fresh database gets, and a daemon boots on the result", async () => {
    const freshPath = path.join(tempDir, "fresh.db");
    const migratedPath = path.join(tempDir, "migrated.db");
    new SqliteDatabase(migratedPath).exec(FLOOR_FIXTURE).close();

    const fresh = openDb(freshPath);
    const migrated = openDb(migratedPath);
    try {
      for (const db of [fresh, migrated]) {
        expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
        expect(db.pragma("foreign_key_check")).toEqual([]);
        expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      }
      expect(sqliteMaster(migrated)).toEqual(sqliteMaster(fresh));
      expect(tableInfo(migrated)).toEqual(tableInfo(fresh));
      expect(metaRows(migrated)).toEqual(metaRows(fresh));
      expect(settingsRows(migrated)).toEqual(settingsRows(fresh));
      expect(builtinAuthHooks(migrated)).toEqual(builtinAuthHooks(fresh));
      expect(seededUsers(migrated)).toEqual(seededUsers(fresh));
    } finally {
      migrated.close();
      fresh.close();
    }

    const priorSessionAuthorityDir = process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR;
    const priorSocket = process.env.MANDIBLE_SOCKET;
    process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR = path.join(tempDir, "local-sessions");
    process.env.MANDIBLE_SOCKET = path.join(tempDir, "api.sock");
    const daemon = await startDaemon({ port: 0, dbPath: migratedPath, pidFilePath: path.join(tempDir, "daemon.pid"), handleSignals: false });
    try {
      expect(await checkHealth(daemon.port)).toMatchObject({ status: "ok", ready: true });
    } finally {
      await daemon.close();
      if (priorSocket === undefined) delete process.env.MANDIBLE_SOCKET;
      else process.env.MANDIBLE_SOCKET = priorSocket;
      if (priorSessionAuthorityDir === undefined) delete process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR;
      else process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR = priorSessionAuthorityDir;
    }
  });

  it("drops the retired tables and column, keeps nonempty patch history, and disturbs no surviving row", () => {
    const RETIRED_TABLES = [
      "ledger_external_refs", "ledger_sync_jobs", "ledger_outbox", "ledger_conflicts",
      "starred_chats", "presets", "preset_nodes", "preset_diffs", "session_presets",
      "convention_setting_links", "session_instruction_artifacts",
    ];
    const tableExists = (db: Db, table: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    const db = migrateFixtureThrough(MINIMUM_SUPPORTED_SCHEMA_VERSION);
    try {
      // The floor really carries these tables and the chain's completion
      // markers, so the drop below does work rather than passing over absences.
      for (const table of RETIRED_TABLES) expect(tableExists(db, table)).toBe(true);
      expect((db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'post_migration.%'").get() as { n: number }).n)
        .toBeGreaterThan(0);
      db.prepare("INSERT INTO presets (id, name, created_at, updated_at) VALUES ('p1', 'Preset', 1, 1)").run();
      db.prepare("INSERT INTO preset_nodes (id, preset_id, created_at, updated_at) VALUES ('n1', 'p1', 1, 1)").run();
      db.prepare(`INSERT INTO message_params (session_id, message_index, model, preset_ids, created_at)
        VALUES ('s1', 0, 'opus', '["p1"]', 7)`).run();
      db.prepare(`INSERT INTO runtime_patches
        (id, fingerprint, commit_hash, diff_summary, applied_at, source, submitted)
        VALUES ('historical-patch', 'fingerprint', 'commit', 'unique patch history', 123, 'manual', 1)`).run();

      migrate(db);

      for (const table of RETIRED_TABLES) expect(tableExists(db, table)).toBe(false);
      expect(db.prepare("PRAGMA table_info(message_params)").all())
        .not.toContainEqual(expect.objectContaining({ name: "preset_ids" }));
      expect(db.prepare("SELECT session_id, message_index, model, created_at FROM message_params").all())
        .toEqual([{ session_id: "s1", message_index: 0, model: "opus", created_at: 7 }]);
      expect(db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'post_migration.%'").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT id, diff_summary FROM runtime_patches").all())
        .toEqual([{ id: "historical-patch", diff_summary: "unique patch history" }]);
      const backup = buildMetadataBackupSql(db);
      expect(backup).toContain('INSERT INTO "runtime_patches"');
      expect(backup).toContain("unique patch history");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("supported version range", () => {
  /** A database recording a version outside what this build serves. */
  function databaseRecording(version: number): Db {
    const db = new SqliteDatabase(path.join(tempDir, `v${version}.db`)).exec(FLOOR_FIXTURE);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
    return db;
  }

  it("refuses a database below the floor and says what to do about it", () => {
    const belowFloor = MINIMUM_SUPPORTED_SCHEMA_VERSION - 1;
    const db = databaseRecording(belowFloor);
    try {
      let thrown: unknown;
      try {
        migrate(db);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnsupportedSchemaVersionError);
      // The operator must be able to act on this without reading the source.
      const message = (thrown as Error).message;
      expect(message).toContain(`v${belowFloor}`);
      expect(message).toContain(`v${MINIMUM_SUPPORTED_SCHEMA_VERSION}`);
      expect(message).toContain(db.name);
      expect(message).toMatch(/older Mandible|move it aside/);
      expect(schemaVersion(db)).toBe(String(belowFloor));
    } finally {
      db.close();
    }
  });

  it("refuses a database newer than the head this build serves", () => {
    const db = databaseRecording(CURRENT_SCHEMA_VERSION + 1);
    try {
      expect(() => migrate(db)).toThrow(UnsupportedSchemaVersionError);
      expect(() => migrate(db)).toThrow(new RegExp(`newer than the v${CURRENT_SCHEMA_VERSION} this build serves`));
    } finally {
      db.close();
    }
  });
});

describe("v159 legacy artifact retirement", () => {
  const hash = (seed: string) => seed.repeat(64).slice(0, 64);
  /** A blob-only row: content represented canonically, no logical version. */
  const BLOB_ONLY = hash("a");
  /** A series with one legacy version and one canonical version: the ordinary case. */
  const SERIES_V1 = hash("b");
  /** The second canonical version of the superset series, which legacy never had. */
  const SUPERSET_V2 = hash("c");
  /** An external-reference locator whose legacy id is not the sha256 spelling. */
  const REF_LOCATOR = hash("d");
  /** The same, but whose blob id was built from the legacy id by an old backfill. */
  const MALFORMED_ID = hash("e");
  /** A legacy row whose uri the canonical blob never recorded. */
  const URI_ONLY = hash("f");
  /** A link-custody row whose repo locator lives only on the legacy row. */
  const REPO_LOCATOR = hash("2");
  /** Bytes referenced by the Space export and the provider manifest. */
  const EXPORTED = hash("1");

  function seedCorpus(db: Db): void {
    db.pragma("foreign_keys = OFF");
    const blob = db.prepare(
      `INSERT INTO artifact_blob (id, algorithm, content_hash, storage_uri, metadata_json,
                                  custody_mode, availability, reference_json, created_at)
       VALUES (?, 'sha256', ?, ?, '{}', 'managed', 'present', '{}', 1000)`,
    );
    const legacy = db.prepare(
      `INSERT INTO artifacts (id, algorithm, content_hash, uri, custody_mode, availability, created_at)
       VALUES (?, 'sha256', ?, ?, 'managed', 'present', 1000)`,
    );
    const linkedLegacy = db.prepare(
      `INSERT INTO artifacts (id, algorithm, content_hash, uri, custody_mode, home_repo_id,
                              repo_locator_json, availability, created_at)
       VALUES (?, 'sha256', ?, ?, 'link', ?, ?, 'present', 1000)`,
    );
    const logical = db.prepare(
      `INSERT INTO artifact (id, identity_key, source_kind, latest_version_id, version_count, created_at, updated_at)
       VALUES (?, ?, 'managed', ?, ?, 1000, 1000)`,
    );
    const version = db.prepare(
      `INSERT INTO artifact_version (id, artifact_id, version_no, blob_id, source_kind, content_hash, created_at)
       VALUES (?, ?, ?, ?, 'managed', ?, 1000)`,
    );

    // 1. blob-only content, referenced by an alias and a pinned link.
    blob.run(`artifact-blob:${BLOB_ONLY}`, BLOB_ONLY, "file:///corpus/blob-only");
    legacy.run(`artifact:sha256:${BLOB_ONLY}`, BLOB_ONLY, "file:///corpus/blob-only");
    // 2. the superset series: legacy stops at v1, canonical carries v2 as latest.
    blob.run(`artifact-blob:${SERIES_V1}`, SERIES_V1, "file:///corpus/series-v1");
    blob.run(`artifact-blob:${SUPERSET_V2}`, SUPERSET_V2, "file:///corpus/series-v2");
    legacy.run(`artifact:sha256:${SERIES_V1}`, SERIES_V1, "file:///corpus/series-v1");
    legacy.run(`artifact:sha256:${SUPERSET_V2}`, SUPERSET_V2, "file:///corpus/series-v2");
    logical.run("artifact:superset", "managed:corpus:superset", "artifact-version:superset-2", 2);
    version.run("artifact-version:superset-1", "artifact:superset", 1, `artifact-blob:${SERIES_V1}`, SERIES_V1);
    version.run("artifact-version:superset-2", "artifact:superset", 2, `artifact-blob:${SUPERSET_V2}`, SUPERSET_V2);
    db.prepare(`INSERT INTO artifact_series (id, series_key, source_kind, latest_version_id, version_count, created_at, updated_at)
      VALUES ('artifact-series:superset', 'managed:corpus:superset', 'managed', 'artifact-version:superset-1', 1, 1000, 1000)`).run();
    db.prepare(`INSERT INTO artifact_versions (id, series_id, artifact_id, version_no, source_kind, content_hash, created_at)
      VALUES ('artifact-version:superset-1', 'artifact-series:superset', ?, 1, 'managed', ?, 1000)`)
      .run(`artifact:sha256:${SERIES_V1}`, SERIES_V1);
    // 3. an artifact:ref: locator whose compatibility id is not yet recorded.
    blob.run(`artifact-blob:${REF_LOCATOR}`, REF_LOCATOR, null);
    legacy.run(`artifact:ref:${REF_LOCATOR}`, REF_LOCATOR, "repo://corpus/ref-locator.md");
    // 4. the same, plus the malformed blob id an older backfill wrote, referenced
    //    from a version, an alias, a link target, and a Space export.
    blob.run(`artifact-blob:artifact:ref:${MALFORMED_ID}`, MALFORMED_ID, null);
    legacy.run(`artifact:ref:${MALFORMED_ID}`, MALFORMED_ID, "repo://corpus/malformed.md");
    logical.run("artifact:malformed", "managed:corpus:malformed", "artifact-version:malformed-1", 1);
    version.run("artifact-version:malformed-1", "artifact:malformed", 1, `artifact-blob:artifact:ref:${MALFORMED_ID}`, MALFORMED_ID);
    // 5. link custody whose repo locator exists only on the legacy row; losing
    //    it makes the bytes unreadable while the row survives.
    blob.run(`artifact-blob:${REPO_LOCATOR}`, REPO_LOCATOR, null);
    linkedLegacy.run(`artifact:sha256:${REPO_LOCATOR}`, REPO_LOCATOR, "repo://corpus/tracked.md", "corpus",
      JSON.stringify({ repo_id: "corpus", path: "docs/tracked.md", root: "/corpus" }));
    // 6. a legacy uri the canonical blob never recorded.
    blob.run(`artifact-blob:${URI_ONLY}`, URI_ONLY, null);
    legacy.run(`artifact:sha256:${URI_ONLY}`, URI_ONLY, "repo://corpus/uri-only.md");
    // 7. exported bytes for the Space export and the provider manifest.
    blob.run(`artifact-blob:${EXPORTED}`, EXPORTED, "file:///corpus/exported");
    legacy.run(`artifact:sha256:${EXPORTED}`, EXPORTED, "file:///corpus/exported");
    // 8. an unreferenced artifact:ref: placeholder with no canonical blob at all.
    legacy.run(`artifact:ref:${hash("9")}`, hash("9"), "repo://corpus/placeholder.md");

    const alias = db.prepare(
      `INSERT INTO artifact_aliases (id, artifact_id, blob_id, scheme, alias, normalized_ref, resolution_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'resolved', 1000, 1000)`,
    );
    alias.run("alias-blob-only", `artifact:sha256:${BLOB_ONLY}`, `artifact-blob:${BLOB_ONLY}`,
      "file", "file:///corpus/blob-only", "file:///corpus/blob-only");
    alias.run("alias-malformed", `artifact:ref:${MALFORMED_ID}`, `artifact-blob:artifact:ref:${MALFORMED_ID}`,
      "repo", "repo://corpus/malformed.md", "repo://corpus/malformed.md");

    db.prepare(
      `INSERT INTO artifact_links (id, artifact_id, blob_id, legacy_blob_id, entity_type, entity_id,
                                   link_type, link_kind, series_id, series_ref,
                                   target_type, target_id, fallback_version_id, created_at, updated_at)
       VALUES ('link-pinned-blob', ?, ?, ?, 'issue', 'issue-corpus', 'references', 'pinned',
               NULL, NULL, 'artifact_blob', ?, NULL, 1000, 1000)`,
    ).run(`artifact:sha256:${BLOB_ONLY}`, `artifact-blob:${BLOB_ONLY}`, `artifact-blob:${BLOB_ONLY}`, `artifact-blob:${BLOB_ONLY}`);
    db.prepare(
      `INSERT INTO artifact_links (id, artifact_id, blob_id, entity_type, entity_id,
                                   link_type, link_kind, target_type, target_id, created_at, updated_at)
       VALUES ('link-pinned-malformed', NULL, ?, 'issue', 'issue-corpus', 'references', 'pinned', 'artifact_blob', ?, 1000, 1000)`,
    ).run(`artifact-blob:artifact:ref:${MALFORMED_ID}`, `artifact-blob:artifact:ref:${MALFORMED_ID}`);
    db.prepare(
      `INSERT INTO artifact_links (id, artifact_id, blob_id, entity_type, entity_id,
                                   link_type, link_kind, series_id, series_ref,
                                   target_type, target_id, fallback_version_id, created_at, updated_at)
       VALUES ('link-living', NULL, ?, 'issue', 'issue-corpus', 'references', 'living',
               'artifact-series:superset', 'artifact-series:superset',
               'artifact', 'artifact:superset', 'artifact-version:superset-2', 1000, 1000)`,
    ).run(`artifact-blob:${SUPERSET_V2}`);
    db.prepare(
      `INSERT INTO artifact_drafts (id, artifact_id, version_id, series_id, base_version_id, content, created_at, updated_at)
       VALUES ('draft-superset', 'artifact:superset', 'artifact-version:superset-1',
               'artifact-series:superset', 'artifact-version:superset-1', 'draft body', 1000, 1000)`,
    ).run();
    db.prepare("INSERT INTO ledger_projects (id, display_name, created_at, updated_at) VALUES ('prj-corpus', 'Corpus', 1000, 1000)").run();
    db.prepare(`INSERT INTO ledger_project_checkouts (id, project_id, root, name, created_at, updated_at)
      VALUES ('checkout-corpus', 'prj-corpus', '/corpus', 'corpus', 1000, 1000)`).run();
    db.prepare("INSERT INTO spaces (id, project_id, title, created_at, updated_at) VALUES ('space-corpus', 'prj-corpus', 'Corpus', 1000, 1000)").run();
    db.prepare(
      `INSERT INTO space_exports (id, space_id, repo_id, branch, path, authority, status,
                                  last_export_artifact_id, pre_export_snapshot_artifact_id,
                                  last_export_blob_id, pre_export_snapshot_blob_id,
                                  last_export_commit, created_at, updated_at)
       VALUES ('export-corpus', 'space-corpus', 'checkout-corpus', 'docs', 'docs/corpus.md',
               'mandible', 'clean', ?, ?, ?, ?, 'c-corpus', 1000, 1000)`,
    ).run(`artifact:sha256:${EXPORTED}`, `artifact:ref:${MALFORMED_ID}`,
      `artifact-blob:${EXPORTED}`, `artifact-blob:artifact:ref:${MALFORMED_ID}`);
    db.prepare(
      `INSERT INTO provider_manifests (id, provider_id, manifest_type, content_hash, artifact_id, source, content_json, created_at)
       VALUES ('manifest-corpus', 'provider-corpus', 'provider_manifest', ?, ?, 'ingest', '{}', 1000)`,
    ).run(EXPORTED, `artifact:sha256:${EXPORTED}`);
    db.pragma("foreign_keys = ON");
  }

  it("ports one row of every supported artifact shape to the canonical model without losing a fact", () => {
    const db = migrateFixtureThrough(MINIMUM_SUPPORTED_SCHEMA_VERSION);
    try {
      seedCorpus(db);
      // The v185 custody recovery owns these synthetic descriptors, so stop before it.
      migrate(db, 184);

      expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      for (const table of ["artifacts", "artifact_series", "artifact_versions"]) {
        expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
      }
      // Port 1: artifact:ref: locators keep resolving through the blob's compatibility id.
      expect(db.prepare(
        `SELECT content_hash, json_extract(metadata_json, '$.compatibility_artifact_id') AS id
           FROM artifact_blob WHERE json_extract(metadata_json, '$.compatibility_artifact_id') IS NOT NULL
          ORDER BY content_hash`,
      ).all()).toEqual([
        { content_hash: REF_LOCATOR, id: `artifact:ref:${REF_LOCATOR}` },
        { content_hash: MALFORMED_ID, id: `artifact:ref:${MALFORMED_ID}` },
      ].sort((a, b) => a.content_hash.localeCompare(b.content_hash)));
      // Port 2: a legacy uri with no canonical equivalent lands in the locator slot.
      const uri = db.prepare("SELECT json_extract(reference_json, '$.uri') AS uri FROM artifact_blob WHERE content_hash = ?");
      expect(uri.get(URI_ONLY)).toEqual({ uri: "repo://corpus/uri-only.md" });
      expect(uri.get(BLOB_ONLY)).toEqual({ uri: null });
      // Port 3: the repo locator only the legacy row carried lands where readers look.
      expect(db.prepare(
        `SELECT json_extract(metadata_json, '$.home_repo_id') AS repo, json_extract(metadata_json, '$.repo_locator') AS locator
           FROM artifact_blob WHERE content_hash = ?`,
      ).get(REPO_LOCATOR)).toEqual({
        repo: "corpus",
        locator: JSON.stringify({ repo_id: "corpus", path: "docs/tracked.md", root: "/corpus" }),
      });
      expect(db.prepare("SELECT json_extract(metadata_json, '$.repo_locator') AS locator FROM artifact_blob WHERE content_hash = ?")
        .get(BLOB_ONLY)).toEqual({ locator: null });
      // Port 4: the malformed blob id is normalized everywhere it was referenced.
      expect(db.prepare("SELECT id FROM artifact_blob WHERE id <> 'artifact-blob:' || content_hash").all()).toEqual([]);
      const normalized = `artifact-blob:${MALFORMED_ID}`;
      expect(db.prepare("SELECT blob_id FROM artifact_version WHERE id = 'artifact-version:malformed-1'").get())
        .toEqual({ blob_id: normalized });
      expect(db.prepare("SELECT blob_id FROM artifact_aliases WHERE id = 'alias-malformed'").get())
        .toEqual({ blob_id: normalized });
      expect(db.prepare("SELECT blob_id, target_id FROM artifact_links WHERE id = 'link-pinned-malformed'").get())
        .toEqual({ blob_id: normalized, target_id: normalized });
      expect(db.prepare("SELECT pre_export_snapshot_blob_id FROM space_exports WHERE id = 'export-corpus'").get())
        .toEqual({ pre_export_snapshot_blob_id: normalized });
      // Canonical state is a superset and was never pulled back to the legacy counts.
      expect(db.prepare("SELECT latest_version_id, version_count FROM artifact WHERE id = 'artifact:superset'").get())
        .toEqual({ latest_version_id: "artifact-version:superset-2", version_count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_aliases").get()).toEqual({ n: 2 });
      expect(db.prepare("SELECT id, link_kind, target_type, target_id FROM artifact_links ORDER BY id").all()).toEqual([
        { id: "link-living", link_kind: "living", target_type: "artifact", target_id: "artifact:superset" },
        { id: "link-pinned-blob", link_kind: "pinned", target_type: "artifact_blob", target_id: `artifact-blob:${BLOB_ONLY}` },
        { id: "link-pinned-malformed", link_kind: "pinned", target_type: "artifact_blob", target_id: normalized },
      ]);
      for (const [table, column] of [
        ["artifact_aliases", "artifact_id"], ["artifact_links", "artifact_id"], ["artifact_links", "legacy_blob_id"],
        ["artifact_links", "series_id"], ["artifact_drafts", "series_id"], ["artifact_drafts", "base_version_id"],
        ["space_exports", "last_export_artifact_id"], ["space_exports", "pre_export_snapshot_artifact_id"],
        ["provider_manifests", "artifact_id"],
      ]) {
        expect(db.prepare(`PRAGMA table_info(${table})`).all()).not.toContainEqual(expect.objectContaining({ name: column }));
      }
      expect(db.prepare("SELECT artifact_id, version_id FROM artifact_drafts").get())
        .toEqual({ artifact_id: "artifact:superset", version_id: "artifact-version:superset-1" });
      expect(db.prepare("SELECT blob_id FROM provider_manifests WHERE id = 'manifest-corpus'").get())
        .toEqual({ blob_id: `artifact-blob:${EXPORTED}` });
    } finally {
      db.close();
    }
  });
});

describe("v161 Briefing lineage", () => {
  function seedBriefingLineage(db: Db, mixed: boolean): unknown[] {
    for (const suffix of ["a", "b"]) {
      const hash = suffix.repeat(64);
      db.prepare(`INSERT INTO artifact_blob
        (id, content_hash, size_bytes, metadata_json, custody_mode, availability, retention_json, reference_json, created_at)
        VALUES (?, ?, 1, '{}', 'managed', 'present', '{}', '{}', 1)`).run(`artifact-blob:${suffix}`, hash);
      db.prepare(`INSERT INTO artifact
        (id, identity_key, source_kind, logical_name, latest_version_id, version_count, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'managed', ?, ?, 1, '{}', 1, 1)`)
        .run(`artifact:${suffix}`, `lineage-${suffix}`, `${suffix}.md`, `artifact-version:${suffix}`);
      db.prepare(`INSERT INTO artifact_version
        (id, artifact_id, version_no, blob_id, source_kind, content_hash, source_locator_json, custody_mode, metadata_json, created_at)
        VALUES (?, ?, 1, ?, 'managed', ?, '{}', 'managed', '{}', 1)`)
        .run(`artifact-version:${suffix}`, `artifact:${suffix}`, `artifact-blob:${suffix}`, hash);
    }
    db.prepare(`INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
      VALUES ('briefing-lineage', 'lineage', 'Lineage', 'round-2', 2, 1, 2)`).run();
    const round = db.prepare(`INSERT INTO briefing_rounds
      (id, briefing_id, ordinal, artifact_version_id, comparison_base_artifact_version_id, previous_round_id, profile, binding_digest, created_at)
      VALUES (?, 'briefing-lineage', ?, ?, NULL, ?, 'mandible-briefing.v3', ?, ?)`);
    round.run("round-1", 1, "artifact-version:a", null, "1".repeat(64), 1);
    round.run("round-2", 2, mixed ? "artifact-version:b" : "artifact-version:a", "round-1", "2".repeat(64), 2);
    return db.prepare("SELECT * FROM briefing_rounds ORDER BY ordinal").all();
  }

  it("records the one logical Artifact of a single-lineage Briefing and leaves its rounds untouched", () => {
    const db = migrateFixtureThrough(160);
    try {
      const rounds = seedBriefingLineage(db, false);
      migrate(db, 161);
      expect(db.prepare("SELECT logical_artifact_id FROM briefings WHERE id = 'briefing-lineage'").get())
        .toEqual({ logical_artifact_id: "artifact:a" });
      expect(db.prepare("SELECT * FROM briefing_rounds ORDER BY ordinal").all()).toEqual(rounds);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("refuses mixed logical Artifact history and leaves the database at v160", () => {
    const db = migrateFixtureThrough(160);
    try {
      seedBriefingLineage(db, true);
      expect(() => migrate(db)).toThrow(/briefing_lineage_guard|CHECK constraint failed/);
      expect(schemaVersion(db)).toBe("160");
      expect(db.prepare("PRAGMA table_info(briefings)").all())
        .not.toContainEqual(expect.objectContaining({ name: "logical_artifact_id" }));
      expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
});

describe("v171 Briefing destination ownership", () => {
  it("rolls back completely when destination ownership is ambiguous", () => {
    const db = migrateFixtureThrough(170);
    try {
      db.prepare(`INSERT INTO artifact (id, identity_key, source_kind, logical_name, latest_version_id, version_count, metadata_json, created_at, updated_at)
        VALUES ('artifact:destination', 'destination', 'managed', 'Destination.md', NULL, 0, '{}', 1, 1)`).run();
      const group = db.prepare("INSERT INTO briefing_groups (id, name, current_bundle_id, created_at, updated_at, archived_at) VALUES (?, ?, NULL, 1, 1, NULL)");
      group.run("group-one", "One");
      group.run("group-two", "Two");
      const route = db.prepare(`INSERT INTO briefing_destination_routes (
        route_key, group_id, logical_artifact_id, heading, composer_kind, active_template_version,
        max_contributions, max_document_bytes, max_directives, created_at, updated_at
      ) VALUES (?, ?, 'artifact:destination', ?, 'deterministic', 1, 1, 1000, 0, 1, 1)`);
      route.run("destination.one", "group-one", "One");
      route.run("destination.two", "group-two", "Two");

      expect(() => migrate(db)).toThrow(/group_count/);

      expect(schemaVersion(db)).toBe("170");
      expect(db.prepare("SELECT COUNT(*) AS count FROM briefing_destination_routes").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('briefing_groups') WHERE name = 'key'").get())
        .toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'briefing_destination_owners'").get())
        .toEqual({ count: 0 });
      expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      db.close();
    }
  });
});

describe("v172 Chat click preference", () => {
  it("moves the operator's click preference into the canonical app setting", () => {
    const db = migrateFixtureThrough(171);
    try {
      const operator = db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string };
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('user.operator_id', ?, 1)").run(operator.id);
      db.prepare("INSERT INTO user_settings (user_id, key, value, revision, updated_at) VALUES (?, 'chat_bottom_shelf', ?, 1, 9)")
        .run(operator.id, JSON.stringify({ version: 1, visible: true, tab: "overview", clickAction: "open" }));
      migrate(db, 172);
      expect(db.prepare("SELECT value FROM settings WHERE key = 'chat_entity_link_action'").get()).toEqual({ value: "open" });
      expect(db.prepare("SELECT 1 FROM user_settings WHERE key = 'chat_bottom_shelf'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("v173 auth request lifecycle", () => {
  it("gives each historical request an honest baseline receipt", () => {
    const db = migrateFixtureThrough(172);
    try {
      db.prepare(`INSERT INTO auth_requests (id, command, title, status, created_at, updated_at, expires_at)
        VALUES ('legacy-request', 'echo old', 'Old request', 'rejected', 10, 20, 30)`).run();
      migrate(db, 173);
      const event = db.prepare("SELECT * FROM auth_request_lifecycle_events WHERE auth_request_id = 'legacy-request'")
        .get() as Record<string, unknown>;
      expect(event).toMatchObject({
        revision: 1,
        event_type: "legacy_snapshot",
        prior_status: null,
        next_status: "rejected",
        actor_user_id: null,
        evidence_method: null,
        credential_id: null,
        reason: "Baseline captured during migration; earlier transition provenance is unknown.",
      });
      expect(event.snapshot_sha256).toBe(authSnapshotDigest(String(event.snapshot_json)));
    } finally {
      db.close();
    }
  });
});

describe("v174 Artifact parent locators", () => {
  it("backfills only missing parent locators without changing identity", () => {
    const db = migrateFixtureThrough(173);
    try {
      for (const suffix of ["1", "2", "3", "4"]) {
        db.prepare(`INSERT INTO artifact_blob
          (id, content_hash, size_bytes, metadata_json, custody_mode, availability, retention_json, reference_json, created_at)
          VALUES (?, ?, 1, '{}', 'managed', 'present', '{}', '{}', 1)`).run(`artifact-blob:${suffix}`, suffix.repeat(64));
      }
      db.prepare(`INSERT INTO artifact (id, identity_key, source_kind, latest_version_id, version_count, metadata_json, created_at, updated_at)
        VALUES ('artifact:lineage', 'lineage', 'managed', 'artifact-version:4', 4, '{}', 1, 4)`).run();
      const insertVersion = db.prepare(`INSERT INTO artifact_version
        (id, artifact_id, version_no, blob_id, source_kind, content_hash, source_locator_json, custody_mode, metadata_json, created_at)
        VALUES (?, 'artifact:lineage', ?, ?, 'managed', ?, ?, 'managed', '{}', ?)`);
      insertVersion.run("artifact-version:1", 1, "artifact-blob:1", "1".repeat(64), '{"parent_version_id":null}', 1);
      insertVersion.run("artifact-version:2", 2, "artifact-blob:2", "2".repeat(64), "{}", 2);
      insertVersion.run("artifact-version:3", 3, "artifact-blob:3", "3".repeat(64), '{"parent_version_id":"artifact-version:explicit"}', 3);
      insertVersion.run("artifact-version:4", 4, "artifact-blob:4", "4".repeat(64), '{"parent_version_id":null}', 4);
      db.prepare(`INSERT INTO briefings (id, briefing_key, title, logical_artifact_id, latest_round_id, round_count, created_at, updated_at)
        VALUES ('briefing:lineage', 'lineage', 'Lineage', 'artifact:lineage', 'round:lineage', 1, 1, 1)`).run();
      db.prepare(`INSERT INTO briefing_rounds (id, briefing_id, ordinal, artifact_version_id, profile, binding_digest, created_at)
        VALUES ('round:lineage', 'briefing:lineage', 1, 'artifact-version:4', 'mandible-briefing.v3', ?, 1)`).run("a".repeat(64));

      migrate(db, 174);

      expect((db.prepare("SELECT id, source_locator_json FROM artifact_version ORDER BY version_no").all() as
        Array<{ id: string; source_locator_json: string }>).map((row) => ({
        id: row.id,
        parent: JSON.parse(row.source_locator_json).parent_version_id ?? null,
      }))).toEqual([
        { id: "artifact-version:1", parent: null },
        { id: "artifact-version:2", parent: "artifact-version:1" },
        { id: "artifact-version:3", parent: "artifact-version:explicit" },
        { id: "artifact-version:4", parent: "artifact-version:3" },
      ]);
      expect(db.prepare("SELECT id, latest_version_id, version_count FROM artifact WHERE id = 'artifact:lineage'").get())
        .toEqual({ id: "artifact:lineage", latest_version_id: "artifact-version:4", version_count: 4 });
      expect(db.prepare("SELECT briefing_id, artifact_version_id FROM briefing_rounds WHERE id = 'round:lineage'").get())
        .toEqual({ briefing_id: "briefing:lineage", artifact_version_id: "artifact-version:4" });
    } finally {
      db.close();
    }
  });
});

describe("v177 Chat preview collision", () => {
  // The persistent Chat preview recorded its lifecycle and archive migrations as
  // v176 and v177 while main used v176 for auth change reports. That lineage is
  // not reachable through MIGRATIONS, so it is built by hand. Delete this case
  // when the floor passes 177.
  it("reconciles the retained Chat preview schema-version collision without losing archive state", () => {
    const db = migrateFixtureThrough(175);
    try {
      db.transaction(() => {
        for (const name of ["unified_chat_creation_lifecycle", "mandible_conversation_archive_state"]) {
          for (const statement of MIGRATIONS.find((candidate) => candidate.name === name)!.statements) db.exec(statement);
        }
        db.prepare("UPDATE meta SET value = '177' WHERE key = 'schema_version'").run();
      })();
      expect(db.prepare("SELECT 1 FROM pragma_table_info('auth_requests') WHERE name = 'change_report_json'").get()).toBeUndefined();

      migrate(db);

      expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
      expect(db.prepare(`SELECT "notnull" FROM pragma_table_info('briefing_group_review_dispositions')
        WHERE name = 'composition_run_id'`).get()).toEqual({ notnull: 0 });
      expect(db.prepare("SELECT 1 FROM pragma_table_info('briefing_composition_inputs') WHERE name = 'expected_current_round_id'").get())
        .toBeDefined();
      expect(db.prepare("SELECT 1 FROM pragma_table_info('auth_requests') WHERE name = 'change_report_json'").get()).toBeDefined();
      expect(db.prepare("SELECT 1 FROM conversation_archive_states").all()).toEqual([]);
    } finally {
      db.close();
    }
  });});

describe("v183 issue metadata", () => {
  function legacyMetadataDatabase(): Db {
    const db = migrateFixtureThrough(182);
    insertRawLedgerProject(db, { id: "metadata-project", name: "Metadata" });
    insertRawLedgerIssue(db, { id: "parent", projectId: "metadata-project", kind: "feature" });
    insertRawLedgerIssue(db, { id: "child", projectId: "metadata-project", kind: "unknown" });
    return db;
  }

  it("migrates rules without installation-specific records and leaves v183 data unchanged on reopen", () => {
    const db = legacyMetadataDatabase();
    try {
      db.exec(`UPDATE ledger_issues SET status = 'closed', resolution = 'fixed' WHERE id = 'parent';
        INSERT INTO ledger_labels (issue_id, label, created_at) VALUES
          ('child', 'coordination', 1), ('child', 'parent:parent', 1),
          ('child', 'user-action-required', 1), ('child', 'general-topic', 1)`);
      migrate(db);
      expect(db.prepare("SELECT resolution FROM ledger_issues WHERE id = 'parent'").get()).toEqual({ resolution: "delivered" });
      expect(db.prepare("SELECT kind, work_notes FROM ledger_issues WHERE id = 'child'").get())
        .toEqual({ kind: "tracker", work_notes: "user action required" });
      expect(db.prepare("SELECT label FROM ledger_labels WHERE deleted_at IS NULL").all()).toEqual([{ label: "general-topic" }]);
      expect(db.prepare("SELECT source_issue_id, target_issue_id FROM ledger_relationship_edges WHERE link_type = 'parent_child'").all())
        .toEqual([{ source_issue_id: "parent", target_issue_id: "child" }]);
      expect(db.prepare("SELECT snapshot_body FROM ledger_body_revisions WHERE entity_type = 'issue_work_notes'").get())
        .toEqual({ snapshot_body: "user action required" });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      const snapshot = db.serialize();
      migrate(db);
      expect(db.serialize().equals(snapshot)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("records retired kinds, labels and resolutions as working notes and events", () => {
    const db = migrateFixtureThrough(182);
    try {
      const projectId = "project-working-notes";
      db.prepare(`INSERT INTO ledger_projects (id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at)
        VALUES (?, 'Working notes', '', '', 'local', 1, 1)`).run(projectId);
      const issue = db.prepare(`INSERT INTO ledger_issues
        (id, short_id, project_id, title, body, status, resolution, kind, priority, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', ?, ?, ?, 'unknown', 'mandible', 1, 1)`);
      for (const kind of ["deferred", "task", "question"]) issue.run(`issue-${kind}`, kind, projectId, kind, "open", null, kind);
      issue.run("issue-label", "label", projectId, "Label", "open", null, "unknown");
      for (const resolution of ["fixed", "merged", "obsolete"]) {
        issue.run(`issue-${resolution}`, resolution, projectId, resolution, "closed", resolution, "feature");
      }
      db.prepare(`INSERT INTO ledger_labels (issue_id, label, source, created_at)
        VALUES ('issue-deferred', 'deferred', 'mandible', 1), ('issue-label', 'deferred', 'mandible', 1)`).run();

      migrate(db);

      expect(db.prepare("SELECT id, kind, work_notes FROM ledger_issues ORDER BY id").all()).toEqual([
        { id: "issue-deferred", kind: "unknown", work_notes: "this issue had kind 'deferred', when 'deferred' was a kind\nthis issue had an active 'deferred' label, when 'deferred' was an active label" },
        { id: "issue-fixed", kind: "feature", work_notes: "" },
        { id: "issue-label", kind: "unknown", work_notes: "this issue had an active 'deferred' label, when 'deferred' was an active label" },
        { id: "issue-merged", kind: "feature", work_notes: "" },
        { id: "issue-obsolete", kind: "feature", work_notes: "" },
        { id: "issue-question", kind: "unknown", work_notes: "" },
        { id: "issue-task", kind: "unknown", work_notes: "" },
      ]);
      expect(db.prepare(`SELECT entity_id, json_extract(payload_json, '$.previous_resolution') AS previous,
          json_extract(payload_json, '$.replacement_resolution') AS replacement
        FROM ledger_events WHERE event_type = 'issue.updated' AND json_extract(payload_json, '$.migration') = 'resolution_retirement'
        ORDER BY entity_id`).all()).toEqual([
        { entity_id: "issue-fixed", previous: "fixed", replacement: "delivered" },
        { entity_id: "issue-merged", previous: "merged", replacement: "delivered" },
        { entity_id: "issue-obsolete", previous: "obsolete", replacement: "wontfix" },
      ]);
      expect(db.prepare("SELECT issue_id FROM ledger_labels WHERE label = 'deferred' ORDER BY issue_id").all())
        .toEqual([{ issue_id: "issue-deferred" }, { issue_id: "issue-label" }]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each([
    "UPDATE ledger_issues SET status = 'closed', resolution = NULL WHERE id = 'child'",
    "INSERT INTO ledger_labels (issue_id, label, created_at) VALUES ('child', 'bug', 1), ('child', 'feature', 1)",
    "INSERT INTO ledger_labels (issue_id, label, created_at) VALUES ('child', 'parent:missing', 1)",
  ])("refuses unresolved legacy metadata without changing the database: %s", (seed) => {
    const db = legacyMetadataDatabase();
    try {
      db.exec(seed);
      const snapshot = db.serialize();
      expect(() => migrate(db)).toThrow("v183_metadata_requires_explicit_review");
      expect(schemaVersion(db)).toBe("182");
      expect(db.serialize().equals(snapshot)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("v185 artifact custody", () => {
  const originalArtifactDir = process.env.MANDIBLE_ARTIFACT_DIR;
  afterEach(() => {
    if (originalArtifactDir === undefined) delete process.env.MANDIBLE_ARTIFACT_DIR;
    else process.env.MANDIBLE_ARTIFACT_DIR = originalArtifactDir;
  });

  it("recovers populated v184 custody before installing two custodies and preserves exact version identity", () => {
    const db = migrateFixtureThrough(184);
    process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "cas");
    try {
      const repo = path.join(tempDir, "repo");
      const commit = makeRepo(repo, { "report.md": "committed bytes", "collision.md": "collision bytes" });
      db.prepare("INSERT INTO ledger_projects(id,project_key,display_name,created_at,updated_at) VALUES('prj_fixture','fixture','fixture',1,1)").run();
      db.prepare("INSERT INTO ledger_project_checkouts(id,project_id,root,name,work_repo_id,created_at,updated_at) VALUES('checkout_fixture','prj_fixture',?,'fixture','fixture',1,1)").run(repo);
      for (const [name, body] of [["git", "committed bytes"], ["managed", "stored bytes"], ["collision-a", "collision bytes"], ["collision-b", "collision bytes"]]) {
        const hash = sha256(body);
        const file = path.join(tempDir, name);
        fs.writeFileSync(file, body);
        const tracked = name !== "managed";
        db.prepare("INSERT OR IGNORE INTO artifact_blob(id,content_hash,storage_uri,custody_mode,availability,created_at) VALUES(?,?,?,?,?,1)")
          .run(`artifact-blob:${hash}`, hash, tracked ? null : `file://${file}`, tracked ? "link" : "copy", "present");
        db.prepare("INSERT INTO artifact(id,identity_key,source_kind,latest_version_id,version_count,created_at,updated_at) VALUES(?,?,'managed',?,1,1,1)")
          .run(`artifact:${name}`, name, `artifact-version:${name}`);
        db.prepare(`INSERT INTO artifact_version(id,artifact_id,version_no,blob_id,source_kind,content_hash,source_project_id,source_repo_id,repo_path,commit_sha,custody_mode,created_at)
          VALUES(?,?,1,?,?,?,?,?,?,?,?,1)`).run(`artifact-version:${name}`, `artifact:${name}`, `artifact-blob:${hash}`,
          tracked ? "tracked_repo" : "managed", hash, "prj_fixture", "fixture",
          name === "git" ? "report.md" : name.startsWith("collision") ? "collision.md" : null,
          tracked ? commit : null, tracked ? "link" : "copy");
      }
      db.exec("INSERT INTO artifact_source SELECT id,NULL,1,'historical_source_ambiguous',1 FROM artifact");
      const metadata = JSON.stringify({ title: "keep", custom: { caption: "keep" }, provenance: { author: "keep", artifact_recovery: { original: { repo_locator: { path: "old" } } } }, nested: { custody: { mode: "external" }, description: "keep" }, repo_locator: { path: "old" }, git: { commit: "old" } });
      for (const table of ["artifact", "artifact_blob", "artifact_version"]) db.prepare(`UPDATE ${table} SET metadata_json=?`).run(metadata);

      migrate(db);

      for (const table of ["artifact", "artifact_blob", "artifact_version"]) {
        for (const row of db.prepare(`SELECT metadata_json FROM ${table}`).all() as Array<{ metadata_json: string }>) {
          expect(JSON.parse(row.metadata_json)).toEqual({ title: "keep", custom: { caption: "keep" }, provenance: { author: "keep" }, nested: { description: "keep" } });
        }
      }
      expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
      expect(db.prepare("SELECT id,custody_mode,source_project_id FROM artifact_version ORDER BY id").all()).toEqual([
        { id: "artifact-version:collision-a", custody_mode: "git", source_project_id: "prj_fixture" },
        { id: "artifact-version:collision-b", custody_mode: "git", source_project_id: "prj_fixture" },
        { id: "artifact-version:git", custody_mode: "git", source_project_id: "prj_fixture" },
        { id: "artifact-version:managed", custody_mode: "managed", source_project_id: null },
      ]);
      fs.unlinkSync(path.join(tempDir, "managed"));
      fs.writeFileSync(path.join(repo, "report.md"), "changed");
      expect(readArtifactBytesFull(db, "artifact-version:git")).toMatchObject({ ok: true, bytes: Buffer.from("committed bytes") });
      expect(readArtifactBytesFull(db, "artifact-version:managed")).toMatchObject({ ok: true, bytes: Buffer.from("stored bytes") });
      expect(git(repo, "rev-parse", `refs/mandible/artifacts/${commit}`)).toBe(commit);
      expect(db.prepare("SELECT project_id FROM project_artifact_associations WHERE target_id='artifact-version:managed' AND role='historical-source-access'").get())
        .toEqual({ project_id: "prj_fixture" });
      expect(db.prepare("SELECT COUNT(*) n FROM artifact_source WHERE reconciliation_reason IS NOT NULL").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) n FROM artifact_source_move").get()).toEqual({ n: 4 });
      const receipts = path.join(tempDir, "repairs", "artifact-recovery");
      const receiptName = fs.readdirSync(receipts).find((name) => name.endsWith(".receipt.json"))!;
      const receipt = JSON.parse(fs.readFileSync(path.join(receipts, receiptName), "utf8"));
      expect(receipt.artifacts.every((row: { metadata_json: string }) => row.metadata_json === metadata)).toBe(true);
      expect(receipt.sources).toHaveLength(4);
      const sources = JSON.parse(fs.readFileSync(path.join(receipts, `${receiptName}.sources.json`), "utf8"));
      expect(sources.decisions.filter((row: { basis: string }) => row.basis === "collision-managed")).toHaveLength(2);
      for (const id of ["artifact:collision-a", "artifact:collision-b"]) {
        expect(JSON.parse((db.prepare("SELECT source_json FROM artifact_source WHERE artifact_id=?").get(id) as { source_json: string }).source_json))
          .toEqual({ kind: "managed", key: id });
      }
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(() => migrate(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("v188 reminder attribution", () => {
  it("preserves existing reminder events while admitting truthful local attribution", () => {
    const db = migrateFixtureThrough(187);
    try {
      const project = addProject(db, { project_key: "reminder-upgrade", display_name: "Reminder upgrade" });
      const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
      db.transaction(() => {
        db.prepare(`INSERT INTO managed_tasks (id, project_id, kind, lifecycle, active_revision_id, created_by_user_id, created_at, updated_at)
          VALUES ('reminder', ?, 'mandible-reminder', 'armed', 'revision', ?, 1, 1)`).run(project.id, operator.id);
        db.prepare(`INSERT INTO managed_task_revisions (id, task_id, revision_no, schema_id, payload_json, payload_digest, created_by_user_id, created_at)
          VALUES ('revision', 'reminder', 1, 'mandible-reminder@1', ?, ?, ?, 1)`)
          .run('{"schema":"mandible-reminder@1","effect":{"kind":"inbox_occurrence"}}', "a".repeat(64), operator.id);
      })();
      const event = db.prepare(`INSERT INTO managed_task_events
        (id, task_id, revision_id, project_id, event_type, actor_user_id, evidence_method, occurred_at)
        VALUES (?, 'reminder', 'revision', ?, ?, ?, ?, ?)`);
      event.run("old-event", project.id, "created", operator.id, "api_token", 1);

      migrate(db);

      expect(db.prepare("SELECT evidence_method FROM managed_task_events WHERE id = 'old-event'").get()).toEqual({ evidence_method: "api_token" });
      event.run("local-event", project.id, "cancelled", operator.id, "session_claim", 2);
      expect(db.prepare("SELECT evidence_method FROM managed_task_events WHERE id = 'local-event'").get()).toEqual({ evidence_method: "session_claim" });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("v190 managed document publications", () => {
  it("separates clean, managed-only, Git-only, divergent and unreachable legacy documents", () => {
    const db = migrateFixtureThrough(189);
    try {
      const repo = path.join(tempDir, "repo");
      const commit = makeRepo(repo, { "doc.md": "published" });
      db.prepare("INSERT INTO ledger_projects (id,project_key,display_name,remote_identity,created_at,updated_at) VALUES ('p','fixture','Fixture','local:fixture',1,1)").run();
      db.prepare("INSERT INTO ledger_project_checkouts (id,project_id,root,name,default_branch,created_at,updated_at) VALUES ('c','p',?,'fixture','main',1,1)").run(repo);
      const unexported = createSpace(db, { project_id: "p", title: "Unexported", default_renderer: "document" });
      createSpaceBlock(db, unexported.id, { block_type: "paragraph", markdown: "original" });
      const snapshots = new Map<string, string>();
      for (const kind of ["clean", "managed-only", "git-only", "both", "unreachable"]) {
        const document = createSpace(db, { project_id: "p", title: kind, default_renderer: "document" });
        const managedChanged = kind === "managed-only" || kind === "both";
        createSpaceBlock(db, document.id, { block_type: "paragraph", markdown: managedChanged ? "managed change" : "published", metadata: { fixture: kind } });
        const worktree = path.join(repo, ".git", "mandible-docs-worktrees", `docs_${kind}`);
        if (kind !== "unreachable") {
          fs.mkdirSync(worktree, { recursive: true });
          fs.writeFileSync(path.join(worktree, "doc.md"), kind === "git-only" || kind === "both" ? "Git change" : "published");
          fs.writeFileSync(path.join(worktree, "unique-ignored"), "retained");
        }
        db.prepare(`INSERT INTO space_exports (id,space_id,repo_id,branch,path,authority,status,last_export_commit,created_at,updated_at)
          VALUES (?,?,'c',?,'doc.md','repo','conflict',?,1,1)`).run(kind, document.id, `docs/${kind}`, commit);
        snapshots.set(document.id, serializeSpaceDocument(db, document.id));
      }

      migrate(db);

      for (const [id, content] of snapshots) {
        const history = listDocumentHistory(db, id);
        expect(history.find((entry) => entry.kind === "managed-before-migration")?.content).toBe(content);
        expect(history.find((entry) => entry.kind === "published-git")?.content).toBe("published");
        expect(serializeSpaceDocument(db, id)).toBe(content);
        const kind = (db.prepare("SELECT title FROM spaces WHERE id=?").get(id) as { title: string }).title;
        expect(history.find((entry) => entry.kind === "checkout-file")?.content)
          .toBe(kind === "unreachable" ? null : kind === "git-only" || kind === "both" ? "Git change" : "published");
        if (kind !== "unreachable") {
          expect(fs.readFileSync(path.join(repo, ".git", "mandible-docs-worktrees", `docs_${kind}`, "unique-ignored"), "utf8")).toBe("retained");
        }
      }
      expect(listDocumentHistory(db, unexported.id)).toEqual([]);
      const before = db.prepare("SELECT * FROM space_document_history ORDER BY id").all();
      migrate(db);
      expect(db.prepare("SELECT * FROM space_document_history ORDER BY id").all()).toEqual(before);
    } finally {
      db.close();
    }
  });
});

describe("v197 issue priority", () => {
  it("converts unknown priority to normal, keeps search rows, records events, and rejects unknown afterwards", () => {
    const db = migrateFixtureThrough(196);
    try {
      insertRawLedgerProject(db, { id: "priority-project", name: "Priority" });
      insertRawLedgerIssue(db, { id: "issue-gap", projectId: "priority-project", priority: "unknown" });
      insertRawLedgerIssue(db, { id: "issue-unknown", projectId: "priority-project", title: "Quokka unknown", priority: "unknown" });
      insertRawLedgerIssue(db, { id: "issue-high", projectId: "priority-project", title: "Wombat high", priority: "high" });
      db.prepare("DELETE FROM ledger_issues WHERE id = 'issue-gap'").run();
      const rowidsBefore = db.prepare("SELECT id, rowid FROM ledger_issues ORDER BY id").all();

      migrate(db);

      expect(db.prepare("SELECT id, priority, updated_at FROM ledger_issues ORDER BY id").all()).toEqual([
        { id: "issue-high", priority: "high", updated_at: 1 },
        { id: "issue-unknown", priority: "normal", updated_at: 1 },
      ]);
      expect(db.prepare("SELECT id, rowid FROM ledger_issues ORDER BY id").all()).toEqual(rowidsBefore);
      expect(db.prepare(`SELECT i.id FROM issue_search JOIN ledger_issues i ON i.rowid = issue_search.rowid
        WHERE issue_search MATCH 'quokka'`).all()).toEqual([{ id: "issue-unknown" }]);
      expect(db.prepare(`SELECT e.entity_id, json_extract(e.payload_json, '$.patch.priority') AS priority, l.sequence
        FROM ledger_events e JOIN ledger_change_log l ON l.event_id = e.id
        WHERE e.actor_id = 'schema-migration-v197'`).all())
        .toEqual([{ entity_id: "issue-unknown", priority: "normal", sequence: 1 }]);
      expect(db.prepare("SELECT next_sequence FROM ledger_change_feed_state WHERE project_id = 'priority-project'").get())
        .toEqual({ next_sequence: 2 });
      insertRawLedgerIssue(db, { id: "issue-default", projectId: "priority-project", title: "Default" });
      expect(db.prepare("SELECT priority FROM ledger_issues WHERE id = 'issue-default'").get()).toEqual({ priority: "normal" });
      expect(db.prepare("SELECT 1 FROM issue_search WHERE issue_search MATCH 'default'").all()).toHaveLength(1);
      expect(() => db.prepare("UPDATE ledger_issues SET priority = 'unknown' WHERE id = 'issue-high'").run())
        .toThrow(/CHECK constraint failed/);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("v199 roundless legacy Briefings", () => {
  it("archives only roundless Briefings held in v1 custody and records one event for each", () => {
    const db = migrateFixtureThrough(198);
    try {
      const briefing = db.prepare(`INSERT INTO briefings
        (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, NULL, 0, 1, 1, ?)`);
      const custody = db.prepare(`INSERT INTO briefing_legacy_custody
        (id, briefing_id, source_profile, disposition, reason, packet_json, packet_digest, created_at)
        VALUES (?, ?, 'mandible-briefing.v1', 'sealed_verified', 'sealed', '{}', ?, 2)`);
      briefing.run("briefing:sealed", "legacy:sealed", "arxiv-scan", null);
      custody.run("custody-sealed", "briefing:sealed", "a".repeat(64));
      briefing.run("briefing:archived", "legacy:archived", "task-health", 5);
      custody.run("custody-archived", "briefing:archived", "b".repeat(64));
      briefing.run("quiet-feed", "quiet-feed", "Quiet feed", null);

      migrate(db);

      const rows = db.prepare("SELECT id, archived_at FROM briefings ORDER BY id").all() as Array<{ id: string; archived_at: number | null }>;
      expect(rows.map((row) => [row.id, row.archived_at === null ? null : row.archived_at > 5 ? "migrated" : row.archived_at]))
        .toEqual([["briefing:archived", 5], ["briefing:sealed", "migrated"], ["quiet-feed", null]]);
      expect(db.prepare(`SELECT entity_type, entity_id, event_type, actor_type,
          json_extract(payload_json, '$.legacy_custody_id') AS custody_id, occurred_at
        FROM ledger_events WHERE actor_id = 'schema-migration-v199'`).all())
        .toEqual([{ entity_type: "briefing", entity_id: "briefing:sealed", event_type: "briefing.archived",
          actor_type: "system", custody_id: "custody-sealed",
          occurred_at: rows.find((row) => row.id === "briefing:sealed")?.archived_at }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_legacy_custody").get()).toEqual({ n: 2 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("v200 derived in-progress worker status", () => {
  it("clears stored in_progress to none with one event each and keeps explicit statuses", () => {
    const db = migrateFixtureThrough(199);
    try {
      insertRawLedgerProject(db, { id: "status-project", name: "status-project" });
      for (const [id, status] of [["issue-stale", "in_progress"], ["issue-done", "done"]]) {
        insertRawLedgerIssue(db, { id, projectId: "status-project" });
        db.prepare("UPDATE ledger_issues SET worker_status = ? WHERE id = ?").run(status, id);
      }

      migrate(db);

      expect(db.prepare("SELECT id, worker_status FROM ledger_issues ORDER BY id").all())
        .toEqual([{ id: "issue-done", worker_status: "done" }, { id: "issue-stale", worker_status: "none" }]);
      expect(db.prepare(`SELECT entity_id, event_type, json_extract(payload_json, '$.previous_worker_status') AS previous
        FROM ledger_events WHERE actor_id = 'schema-migration-v200'`).all())
        .toEqual([{ entity_id: "issue-stale", event_type: "issue.worker_status.updated", previous: "in_progress" }]);
    } finally {
      db.close();
    }
  });
});

describe("v204 session issue links", () => {
  it("rekeys links to the provider session, deletes projection rows, and carries resolvable legacy links", () => {
    const THREAD = "01a072f2-0e05-7a91-abcd-df4dc6a64e62";
    const CLAUDE = "4be0c2a1-6b44-4a43-9d2e-0d6f1c9a7e21";
    const db = migrateFixtureThrough(203);
    try {
      const project = addProject(db, { project_key: "mandible", display_name: "Mandible" });
      const store = new LedgerStore(db);
      const first = store.createIssue({ ...SYSTEM_ACTOR, project_id: project.id, title: "First" });
      const second = store.createIssue({ ...SYSTEM_ACTOR, project_id: project.id, title: "Second" });
      const insertSession = db.prepare("INSERT INTO sessions (id, app, status, agent_type, conversation_id) VALUES (?, ?, 'ended', ?, ?)");
      insertSession.run(`codex-${THREAD}`, "codex", "provider-session", THREAD);
      insertSession.run("wrap-1", "claude", null, CLAUDE);
      insertSession.run("hook-1", "claude", null, null);
      const insertLink = db.prepare("INSERT INTO ledger_session_issue_links (session_id, issue_id, created_at) VALUES (?, ?, 1)");
      for (const session of [`codex-${THREAD}`, "wrap-1", "hook-1"]) insertLink.run(session, first.id);
      const insertLegacy = db.prepare("INSERT INTO session_issues (session_id, issue_id, repo_id, created_at) VALUES (?, ?, 'mandible', 2)");
      insertLegacy.run("wrap-1", second.id.slice(0, 7));
      insertLegacy.run("wrap-1", "0000000");

      migrate(db);

      expect(db.prepare("SELECT session_id, issue_id FROM ledger_session_issue_links ORDER BY session_id, issue_id").all())
        .toEqual([
          { session_id: THREAD, issue_id: first.id },
          { session_id: CLAUDE, issue_id: first.id },
          { session_id: CLAUDE, issue_id: second.id },
          { session_id: "hook-1", issue_id: first.id },
        ].sort((a, b) => a.session_id.localeCompare(b.session_id) || a.issue_id.localeCompare(b.issue_id)));
      expect(db.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "hook-1" }, { id: "wrap-1" }]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('session_issues', 'session_projects')").all()).toEqual([]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("one version behind head", () => {
  it("the ledger change feed refuses to read until the database is migrated", () => {
    const db = migrateFixtureThrough(CURRENT_SCHEMA_VERSION - 1);
    try {
      const project = addProject(db, { project_key: "alpha" });
      expect(() => readLedgerChangeFeed(db, { project_id: project.id, project_key: project.project_key }))
        .toThrowError(expect.objectContaining({ code: "database_schema_mismatch" }));
      migrate(db);
      expect(readLedgerChangeFeed(db, { project_id: project.id, project_key: project.project_key }))
        .toMatchObject({ changes: [] });
    } finally {
      db.close();
    }
  });
});
