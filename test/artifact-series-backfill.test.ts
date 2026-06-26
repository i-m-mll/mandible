import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";
import {
  appendArtifactVersion,
  backfillOrphanArtifactSeries,
  ensureArtifactSeries,
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

describe("backfillOrphanArtifactSeries (migration v89)", () => {
  it("wraps every series-less artifact into a deterministic 1-version series", () => {
    insertArtifact("art_1", "managed", "hash_1");
    insertArtifact("art_2", "managed", "hash_2");

    const wrapped = backfillOrphanArtifactSeries(db);
    expect(wrapped).toBe(2);
    expect(orphanCount()).toBe(0);

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
    const existingSeries = ensureArtifactSeries(db, {
      series_key: "managed:custom:report",
      source_kind: "managed",
    });
    appendArtifactVersion(db, {
      series_id: existingSeries.id,
      artifact_id: "art_existing",
      source_kind: "managed",
      content_hash: "hash_existing",
      natural_key: "art_existing",
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
    const series = ensureArtifactSeries(db, { series_key: "art_multi", source_kind: "managed" });
    appendArtifactVersion(db, {
      series_id: series.id,
      artifact_id: "art_multi",
      source_kind: "managed",
      content_hash: "hash_multi",
      natural_key: "k1",
    });
    appendArtifactVersion(db, {
      series_id: series.id,
      artifact_id: "art_multi_v2",
      source_kind: "managed",
      content_hash: "hash_multi_v2",
      natural_key: "k2",
    });
    expect(getArtifactSeries(db, "art_multi")!.version_count).toBe(2);

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
    const series = ensureArtifactSeries(db, { series_key: "art_x", source_kind: "managed" });
    appendArtifactVersion(db, {
      series_id: series.id,
      artifact_id: "art_other",
      source_kind: "managed",
      content_hash: "hash_other",
      natural_key: "art_x",
    });

    // Model a first-time v88 -> v89 upgrade: the gate was never set (openDb set
    // it on the empty DB, so clear it here).
    db.prepare("DELETE FROM meta WHERE key = ?").run(
      "post_migration.v89_backfill_orphan_artifact_series.complete",
    );
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
