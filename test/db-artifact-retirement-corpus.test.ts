import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MINIMUM_SUPPORTED_SCHEMA_VERSION } from "../src/db.js";
import { MIGRATIONS } from "../src/db-migrations.js";

// The live database proves only that the live database migrates. This is the
// support floor: a v158 database carrying one row of every artifact shape the
// historical retirement migration accepts, migrated through v184, with every surviving fact
// asserted. The migration's guards fail closed, so a corpus that trips one
// aborts the transaction and fails here rather than silently losing rows.

const FLOOR_FIXTURE = fs.readFileSync(
  path.join(process.cwd(), "test", "fixtures", `schema-v${MINIMUM_SUPPORTED_SCHEMA_VERSION}.sql`),
  "utf8",
);

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

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-retirement-corpus-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedFloorCorpus(dbPath: string): void {
  const db = new SqliteDatabase(dbPath);
  try {
    db.exec(FLOOR_FIXTURE);
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
      `INSERT INTO artifact (id, identity_key, source_kind, latest_version_id, version_count,
                             created_at, updated_at)
       VALUES (?, ?, 'managed', ?, ?, 1000, 1000)`,
    );
    const version = db.prepare(
      `INSERT INTO artifact_version (id, artifact_id, version_no, blob_id, source_kind,
                                     content_hash, created_at)
       VALUES (?, ?, ?, ?, 'managed', ?, 1000)`,
    );

    // 1. blob-only content, referenced by an alias and a pinned link.
    blob.run(`artifact-blob:${BLOB_ONLY}`, BLOB_ONLY, `file:///corpus/blob-only`);
    legacy.run(`artifact:sha256:${BLOB_ONLY}`, BLOB_ONLY, `file:///corpus/blob-only`);

    // 2. the superset series: legacy stops at v1, canonical carries v2 as latest.
    blob.run(`artifact-blob:${SERIES_V1}`, SERIES_V1, `file:///corpus/series-v1`);
    blob.run(`artifact-blob:${SUPERSET_V2}`, SUPERSET_V2, `file:///corpus/series-v2`);
    legacy.run(`artifact:sha256:${SERIES_V1}`, SERIES_V1, `file:///corpus/series-v1`);
    legacy.run(`artifact:sha256:${SUPERSET_V2}`, SUPERSET_V2, `file:///corpus/series-v2`);
    logical.run("artifact:superset", "managed:corpus:superset", "artifact-version:superset-2", 2);
    version.run("artifact-version:superset-1", "artifact:superset", 1, `artifact-blob:${SERIES_V1}`, SERIES_V1);
    version.run("artifact-version:superset-2", "artifact:superset", 2, `artifact-blob:${SUPERSET_V2}`, SUPERSET_V2);
    db.prepare(
      `INSERT INTO artifact_series (id, series_key, source_kind, latest_version_id, version_count,
                                    created_at, updated_at)
       VALUES ('artifact-series:superset', 'managed:corpus:superset', 'managed',
               'artifact-version:superset-1', 1, 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO artifact_versions (id, series_id, artifact_id, version_no, source_kind,
                                      content_hash, created_at)
       VALUES ('artifact-version:superset-1', 'artifact-series:superset', ?, 1, 'managed', ?, 1000)`,
    ).run(`artifact:sha256:${SERIES_V1}`, SERIES_V1);

    // 3. an artifact:ref: locator: canonical blob present, compatibility id not yet
    //    recorded, so today it resolves only through the legacy table.
    blob.run(`artifact-blob:${REF_LOCATOR}`, REF_LOCATOR, null);
    legacy.run(`artifact:ref:${REF_LOCATOR}`, REF_LOCATOR, "repo://corpus/ref-locator.md");

    // 4. the same, plus the malformed blob id an older backfill wrote, referenced
    //    from a version, an alias, a link target, and a Space export.
    blob.run(`artifact-blob:artifact:ref:${MALFORMED_ID}`, MALFORMED_ID, null);
    legacy.run(`artifact:ref:${MALFORMED_ID}`, MALFORMED_ID, "repo://corpus/malformed.md");
    logical.run("artifact:malformed", "managed:corpus:malformed", "artifact-version:malformed-1", 1);
    version.run(
      "artifact-version:malformed-1", "artifact:malformed", 1,
      `artifact-blob:artifact:ref:${MALFORMED_ID}`, MALFORMED_ID,
    );

    // 5b. link custody whose repo locator exists only on the legacy row. This is
    //     the only fact that lets the blob's bytes be found, so losing it makes
    //     the content unreadable while the row itself survives.
    blob.run(`artifact-blob:${REPO_LOCATOR}`, REPO_LOCATOR, null);
    linkedLegacy.run(
      `artifact:sha256:${REPO_LOCATOR}`, REPO_LOCATOR, "repo://corpus/tracked.md", "corpus",
      JSON.stringify({ repo_id: "corpus", path: "docs/tracked.md", root: "/corpus" }),
    );

    // 5. a legacy uri the canonical blob never recorded.
    blob.run(`artifact-blob:${URI_ONLY}`, URI_ONLY, null);
    legacy.run(`artifact:sha256:${URI_ONLY}`, URI_ONLY, "repo://corpus/uri-only.md");

    // 6. exported bytes for the Space export and the provider manifest.
    blob.run(`artifact-blob:${EXPORTED}`, EXPORTED, `file:///corpus/exported`);
    legacy.run(`artifact:sha256:${EXPORTED}`, EXPORTED, `file:///corpus/exported`);

    // 7. an unreferenced artifact:ref: placeholder with no canonical blob at all.
    legacy.run(`artifact:ref:${hash("9")}`, hash("9"), "repo://corpus/placeholder.md");

    // aliases: one on the ordinary blob, one on the malformed id.
    const alias = db.prepare(
      `INSERT INTO artifact_aliases (id, artifact_id, blob_id, scheme, alias, normalized_ref,
                                     resolution_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'resolved', 1000, 1000)`,
    );
    alias.run("alias-blob-only", `artifact:sha256:${BLOB_ONLY}`, `artifact-blob:${BLOB_ONLY}`,
      "file", "file:///corpus/blob-only", "file:///corpus/blob-only");
    alias.run("alias-malformed", `artifact:ref:${MALFORMED_ID}`,
      `artifact-blob:artifact:ref:${MALFORMED_ID}`,
      "repo", "repo://corpus/malformed.md", "repo://corpus/malformed.md");

    // links: a pinned blob link, a pinned version link on the malformed blob id,
    // and a living link whose series_id duplicates its canonical target.
    db.prepare(
      `INSERT INTO artifact_links (id, artifact_id, blob_id, legacy_blob_id, entity_type, entity_id,
                                   link_type, link_kind, series_id, series_ref,
                                   target_type, target_id, fallback_version_id, created_at, updated_at)
       VALUES ('link-pinned-blob', ?, ?, ?, 'issue', 'issue-corpus', 'references', 'pinned',
               NULL, NULL, 'artifact_blob', ?, NULL, 1000, 1000)`,
    ).run(`artifact:sha256:${BLOB_ONLY}`, `artifact-blob:${BLOB_ONLY}`,
      `artifact-blob:${BLOB_ONLY}`, `artifact-blob:${BLOB_ONLY}`);
    db.prepare(
      `INSERT INTO artifact_links (id, artifact_id, blob_id, entity_type, entity_id,
                                   link_type, link_kind, target_type, target_id, created_at, updated_at)
       VALUES ('link-pinned-malformed', NULL, ?, 'issue', 'issue-corpus', 'references', 'pinned',
               'artifact_blob', ?, 1000, 1000)`,
    ).run(`artifact-blob:artifact:ref:${MALFORMED_ID}`, `artifact-blob:artifact:ref:${MALFORMED_ID}`);
    db.prepare(
      `INSERT INTO artifact_links (id, artifact_id, blob_id, entity_type, entity_id,
                                   link_type, link_kind, series_id, series_ref,
                                   target_type, target_id, fallback_version_id, created_at, updated_at)
       VALUES ('link-living', NULL, ?, 'issue', 'issue-corpus', 'references', 'living',
               'artifact-series:superset', 'artifact-series:superset',
               'artifact', 'artifact:superset', 'artifact-version:superset-2', 1000, 1000)`,
    ).run(`artifact-blob:${SUPERSET_V2}`);

    // a draft carrying only the legacy series/base pair.
    db.prepare(
      `INSERT INTO artifact_drafts (id, artifact_id, version_id, series_id, base_version_id,
                                    content, created_at, updated_at)
       VALUES ('draft-superset', 'artifact:superset', 'artifact-version:superset-1',
               'artifact-series:superset', 'artifact-version:superset-1',
               'draft body', 1000, 1000)`,
    ).run();

    // a Space export carrying both representations, the canonical one malformed.
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, created_at, updated_at)
       VALUES ('prj-corpus', 'Corpus', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO ledger_project_checkouts (id, project_id, root, name, created_at, updated_at)
       VALUES ('checkout-corpus', 'prj-corpus', '/corpus', 'corpus', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO spaces (id, project_id, title, created_at, updated_at)
       VALUES ('space-corpus', 'prj-corpus', 'Corpus', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO space_exports (id, space_id, repo_id, branch, path, authority, status,
                                  last_export_artifact_id, pre_export_snapshot_artifact_id,
                                  last_export_blob_id, pre_export_snapshot_blob_id,
                                  last_export_commit, created_at, updated_at)
       VALUES ('export-corpus', 'space-corpus', 'checkout-corpus', 'docs', 'docs/corpus.md',
               'mandible', 'clean', ?, ?, ?, ?, 'c-corpus', 1000, 1000)`,
    ).run(
      `artifact:sha256:${EXPORTED}`, `artifact:ref:${MALFORMED_ID}`,
      `artifact-blob:${EXPORTED}`, `artifact-blob:artifact:ref:${MALFORMED_ID}`,
    );

    // a provider manifest keyed by the legacy artifact id.
    db.prepare(
      `INSERT INTO provider_manifests (id, provider_id, manifest_type, content_hash, artifact_id,
                                       source, content_json, created_at)
       VALUES ('manifest-corpus', 'provider-corpus', 'provider_manifest', ?, ?,
               'ingest', '{}', 1000)`,
    ).run(EXPORTED, `artifact:sha256:${EXPORTED}`);
  } finally {
    db.close();
  }
}

describe.sequential("artifact retirement support floor", () => {
  it("migrates one row of every supported artifact shape without losing a fact", () => {
    const dbPath = path.join(tempDir, "corpus.db");
    seedFloorCorpus(dbPath);

    // This corpus exercises the legacy-table retirement ports, including intentionally
    // unmaterializable descriptors. The subsequent v185 custody recovery owns their
    // verified recovery or dependency-guarded retirement in its separate corpus.
    const db = new SqliteDatabase(dbPath);
    db.function('mandible_sha256',{deterministic:true},(value:unknown)=>createHash('sha256').update(String(value)).digest('hex'));
    for (const migration of MIGRATIONS.filter(m=>m.version>MINIMUM_SUPPORTED_SCHEMA_VERSION && m.version<=184)) {
      db.transaction(()=>{for (const sql of migration.statements) db.exec(sql);})();
    }
    try {
      expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      for (const table of ["artifacts", "artifact_series", "artifact_versions"]) {
        expect(db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table)).toBeUndefined();
      }

      // Port 1: the artifact:ref: locators keep resolving, because the id the
      // canonical resolver looks for is now recorded on the blob.
      const compatibilityIds = db.prepare(
        `SELECT content_hash, json_extract(metadata_json, '$.compatibility_artifact_id') AS id
           FROM artifact_blob
          WHERE json_extract(metadata_json, '$.compatibility_artifact_id') IS NOT NULL
          ORDER BY content_hash`,
      ).all();
      expect(compatibilityIds).toEqual([
        { content_hash: REF_LOCATOR, id: `artifact:ref:${REF_LOCATOR}` },
        { content_hash: MALFORMED_ID, id: `artifact:ref:${MALFORMED_ID}` },
      ].sort((a, b) => a.content_hash.localeCompare(b.content_hash)));

      // Port 2: a legacy uri with no canonical equivalent lands in the locator slot.
      expect(db.prepare(
        "SELECT json_extract(reference_json, '$.uri') AS uri FROM artifact_blob WHERE content_hash = ?",
      ).get(URI_ONLY)).toEqual({ uri: "repo://corpus/uri-only.md" });
      // A blob that already had a storage_uri is left alone.
      expect(db.prepare(
        "SELECT json_extract(reference_json, '$.uri') AS uri FROM artifact_blob WHERE content_hash = ?",
      ).get(BLOB_ONLY)).toEqual({ uri: null });

      // Port 3: the repo locator that only the legacy row carried lands in the
      // slots projectCanonicalArtifactRecord reads.
      expect(db.prepare(
        `SELECT json_extract(metadata_json, '$.home_repo_id') AS repo,
                json_extract(metadata_json, '$.repo_locator') AS locator
           FROM artifact_blob WHERE content_hash = ?`,
      ).get(REPO_LOCATOR)).toEqual({
        repo: "corpus",
        locator: JSON.stringify({ repo_id: "corpus", path: "docs/tracked.md", root: "/corpus" }),
      });
      // A blob with no legacy locator to inherit is left alone.
      expect(db.prepare(
        `SELECT json_extract(metadata_json, '$.repo_locator') AS locator
           FROM artifact_blob WHERE content_hash = ?`,
      ).get(BLOB_ONLY)).toEqual({ locator: null });

      // Port 4: the malformed blob id is normalized, and so is every column
      // that referenced it.
      expect(db.prepare(
        "SELECT id FROM artifact_blob WHERE id <> 'artifact-blob:' || content_hash",
      ).all()).toEqual([]);
      const normalized = `artifact-blob:${MALFORMED_ID}`;
      expect(db.prepare("SELECT blob_id FROM artifact_version WHERE id = 'artifact-version:malformed-1'")
        .get()).toEqual({ blob_id: normalized });
      expect(db.prepare("SELECT blob_id FROM artifact_aliases WHERE id = 'alias-malformed'")
        .get()).toEqual({ blob_id: normalized });
      expect(db.prepare(
        "SELECT blob_id, target_id FROM artifact_links WHERE id = 'link-pinned-malformed'",
      ).get()).toEqual({ blob_id: normalized, target_id: normalized });
      expect(db.prepare(
        "SELECT pre_export_snapshot_blob_id FROM space_exports WHERE id = 'export-corpus'",
      ).get()).toEqual({ pre_export_snapshot_blob_id: normalized });

      // Canonical state is a superset and was never pulled back to the legacy counts.
      expect(db.prepare(
        "SELECT latest_version_id, version_count FROM artifact WHERE id = 'artifact:superset'",
      ).get()).toEqual({ latest_version_id: "artifact-version:superset-2", version_count: 2 });

      // Every surviving row kept its identity, and the dropped columns are gone.
      expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_aliases").get()).toEqual({ n: 2 });
      expect(db.prepare(
        "SELECT id, link_kind, target_type, target_id FROM artifact_links ORDER BY id",
      ).all()).toEqual([
        {
          id: "link-living", link_kind: "living",
          target_type: "artifact", target_id: "artifact:superset",
        },
        {
          id: "link-pinned-blob", link_kind: "pinned",
          target_type: "artifact_blob", target_id: `artifact-blob:${BLOB_ONLY}`,
        },
        {
          id: "link-pinned-malformed", link_kind: "pinned",
          target_type: "artifact_blob", target_id: normalized,
        },
      ]);
      for (const [table, column] of [
        ["artifact_aliases", "artifact_id"],
        ["artifact_links", "artifact_id"],
        ["artifact_links", "legacy_blob_id"],
        ["artifact_links", "series_id"],
        ["artifact_drafts", "series_id"],
        ["artifact_drafts", "base_version_id"],
        ["space_exports", "last_export_artifact_id"],
        ["space_exports", "pre_export_snapshot_artifact_id"],
        ["provider_manifests", "artifact_id"],
      ]) {
        expect(db.prepare(`PRAGMA table_info(${table})`).all())
          .not.toContainEqual(expect.objectContaining({ name: column }));
      }

      // The draft carried only the legacy pair and still resolves canonically.
      expect(db.prepare("SELECT artifact_id, version_id FROM artifact_drafts").get()).toEqual({
        artifact_id: "artifact:superset",
        version_id: "artifact-version:superset-1",
      });

      // The provider manifest's legacy id became its canonical blob.
      expect(db.prepare("SELECT blob_id FROM provider_manifests WHERE id = 'manifest-corpus'")
        .get()).toEqual({ blob_id: `artifact-blob:${EXPORTED}` });
    } finally {
      db.close();
    }
  });
});
