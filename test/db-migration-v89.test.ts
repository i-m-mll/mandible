import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  assertMigrationSequence,
  migrate,
  openDb,
  type Db,
} from "../src/db.js";
import { buildMetadataBackupSql } from "../src/ledger/backup.js";

let tempDir = "";
let db: Db;
let savedEnv: Record<string, string | undefined>;

// The exact pre-v89 (migration-67) artifact_links shape: no link_kind /
// series_id / series_ref columns and no v89 indexes. Used to drive the real
// v88 -> v89 transition through migrate().
const ARTIFACT_LINKS_V67_DDL = `CREATE TABLE artifact_links (
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
CREATE INDEX idx_artifact_links_artifact ON artifact_links(artifact_id, link_type);
CREATE INDEX idx_artifact_links_entity ON artifact_links(entity_type, entity_id);
CREATE INDEX idx_artifact_links_repo ON artifact_links(repo_id) WHERE repo_id IS NOT NULL;
CREATE INDEX idx_artifact_links_provider ON artifact_links(provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX idx_artifact_links_role ON artifact_links(role) WHERE role IS NOT NULL`;

beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    MANDIBLE_HOME: process.env.MANDIBLE_HOME,
    MANDIBLE_ARTIFACT_DIR: process.env.MANDIBLE_ARTIFACT_DIR,
  };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v89-"));
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

function insertArtifact(target: Db, id: string, custody: string, hash: string): void {
  target
    .prepare(
      `INSERT INTO artifacts (id, algorithm, content_hash, uri, size_bytes, custody_mode, created_at)
       VALUES (?, 'sha256', ?, ?, 0, ?, 1)`,
    )
    .run(id, hash, `file:///tmp/${id}`, custody);
}

function insertLink(target: Db, id: string, artifactId: string): void {
  target
    .prepare(
      `INSERT INTO artifact_links (id, artifact_id, entity_type, entity_id, created_at, updated_at)
       VALUES (?, ?, 'issue', 'iss-1', 1, 1)`,
    )
    .run(id, artifactId);
}

// Rewind a fresh v89 DB to its pre-v89 artifact_links shape and schema version so
// the next migrate() call replays the real v88 -> v89 transition. Leaves the v89
// backfill completion flag intact (set during openDb on the empty DB) so the
// column-add assertions are isolated from the orphan backfill.
function rewindArtifactLinksToV67(target: Db): void {
  target.exec("DROP TABLE IF EXISTS artifact_links");
  target.exec(ARTIFACT_LINKS_V67_DDL);
  target.prepare("UPDATE meta SET value = '88' WHERE key = 'schema_version'").run();
}

function columnInfo(target: Db, table: string): Map<string, { type: string; notnull: number; dflt: string | null }> {
  const rows = target.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  return new Map(rows.map((r) => [r.name, { type: r.type, notnull: r.notnull, dflt: r.dflt_value }]));
}

function indexNames(target: Db, table: string): Set<string> {
  const rows = target
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe("migration v89: artifact_links typed-series columns", () => {
  it("keeps v89 in the contiguous migration sequence", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(89);
    expect(() => assertMigrationSequence()).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: String(CURRENT_SCHEMA_VERSION),
    });
  });

  it("adds link_kind (NOT NULL DEFAULT 'pinned' + CHECK), nullable series_id/series_ref, and both indexes", () => {
    const cols = columnInfo(db, "artifact_links");
    expect(cols.has("link_kind")).toBe(true);
    expect(cols.has("series_id")).toBe(true);
    expect(cols.has("series_ref")).toBe(true);

    const linkKind = cols.get("link_kind")!;
    expect(linkKind.notnull).toBe(1);
    expect(linkKind.dflt ?? "").toMatch(/'pinned'/);
    expect(cols.get("series_id")!.notnull).toBe(0);
    expect(cols.get("series_ref")!.notnull).toBe(0);

    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact_links'").get() as {
      sql: string;
    }).sql;
    expect(sql).toMatch(/CHECK\s*\(\s*link_kind\s+IN/i);

    const idx = indexNames(db, "artifact_links");
    expect(idx.has("idx_artifact_links_kind")).toBe(true);
    expect(idx.has("idx_artifact_links_series")).toBe(true);
  });

  it("series_id carries NO foreign key into artifact_series (soft reference)", () => {
    const fks = db.prepare("PRAGMA foreign_key_list(artifact_links)").all() as Array<{
      table: string;
      from: string;
    }>;
    expect(fks.some((fk) => fk.from === "series_id")).toBe(false);
    expect(fks.some((fk) => fk.table === "artifact_series")).toBe(false);
  });

  it("CHECK contract: accepts link_kind 'pinned' and 'living', rejects unknown values", () => {
    insertArtifact(db, "art_chk", "managed", "hash_chk");
    const probe = (linkId: string, kind: string) =>
      db
        .prepare(
          `INSERT INTO artifact_links (id, artifact_id, entity_type, entity_id, link_kind, created_at, updated_at)
           VALUES (?, 'art_chk', 'issue', 'iss', ?, 1, 1)`,
        )
        .run(linkId, kind);
    // Both declared link kinds are accepted.
    expect(() => probe("lnk_pinned", "pinned")).not.toThrow();
    expect(() => probe("lnk_living", "living")).not.toThrow();
    // Anything else is rejected by the CHECK.
    expect(() => probe("lnk_bogus", "bogus")).toThrow(/CHECK|constraint/i);
  });

  it("v88 -> v89 backfills link_kind='pinned' on every pre-existing row without retargeting artifact_id", () => {
    insertArtifact(db, "art_a", "managed", "hash_a");
    insertArtifact(db, "art_b", "link", "hash_b");
    rewindArtifactLinksToV67(db);
    insertLink(db, "lnk_a", "art_a");
    insertLink(db, "lnk_b", "art_b");

    const linksBefore = db
      .prepare("SELECT id, artifact_id FROM artifact_links ORDER BY id")
      .all() as Array<{ id: string; artifact_id: string }>;
    const artifactsBefore = db
      .prepare("SELECT id, content_hash, custody_mode FROM artifacts ORDER BY id")
      .all();

    migrate(db);

    const cols = columnInfo(db, "artifact_links");
    expect(cols.has("link_kind") && cols.has("series_id") && cols.has("series_ref")).toBe(true);

    const linksAfter = db
      .prepare("SELECT id, artifact_id, link_kind, series_id, series_ref FROM artifact_links ORDER BY id")
      .all() as Array<{
      id: string;
      artifact_id: string;
      link_kind: string;
      series_id: string | null;
      series_ref: string | null;
    }>;
    // NO SILENT RETARGET: artifact_id values are identical across the migration.
    expect(linksAfter.map((r) => r.artifact_id)).toEqual(linksBefore.map((r) => r.artifact_id));
    for (const row of linksAfter) {
      expect(row.link_kind).toBe("pinned");
      expect(row.series_id).toBeNull();
      expect(row.series_ref).toBeNull();
    }
    // ADDITIVE: artifacts content rows are untouched.
    expect(db.prepare("SELECT id, content_hash, custody_mode FROM artifacts ORDER BY id").all()).toEqual(
      artifactsBefore,
    );

    const idx = indexNames(db, "artifact_links");
    expect(idx.has("idx_artifact_links_kind")).toBe(true);
    expect(idx.has("idx_artifact_links_series")).toBe(true);
  });

  it("fails loudly when a pre-existing artifact_links.link_kind lacks its CHECK constraint", () => {
    db.exec("DROP TABLE IF EXISTS artifact_links");
    // link_kind present (so the guarded ADD COLUMN is skipped) but WITHOUT the
    // CHECK — exactly what a divergent pre-existing column would look like.
    db.exec(`CREATE TABLE artifact_links (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'references',
      role TEXT, repo_id TEXT, provider_id TEXT,
      source TEXT NOT NULL DEFAULT 'artifact_registry',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      link_kind TEXT NOT NULL DEFAULT 'pinned',
      series_id TEXT,
      series_ref TEXT
    )`);
    db.prepare("UPDATE meta SET value = '88' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).toThrow(/migration 89 verification/i);
  });

  it("fails loudly when a wrong same-named idx_artifact_links_series pre-exists (name-only check is not enough)", () => {
    // Recreate artifact_links at its pre-v89 shape, then plant a same-named index
    // on the WRONG column with no partial WHERE. CREATE INDEX IF NOT EXISTS will
    // keep this divergent index, so the verifier must reject it on column/WHERE.
    rewindArtifactLinksToV67(db);
    db.exec("CREATE INDEX idx_artifact_links_series ON artifact_links(repo_id)");
    expect(() => migrate(db)).toThrow(/migration 89 verification: idx_artifact_links_series/i);
  });

  it("re-running migrate() on a current DB is a no-op", () => {
    const sqlBefore = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact_links'").get() as {
      sql: string;
    }).sql;
    migrate(db);
    migrate(db);
    const sqlAfter = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact_links'").get() as {
      sql: string;
    }).sql;
    expect(sqlAfter).toBe(sqlBefore);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: String(CURRENT_SCHEMA_VERSION),
    });
  });

  it("backup restore preserves the three columns AND recreates both indexes", () => {
    insertArtifact(db, "art_x", "managed", "hash_x");
    db.prepare(
      `INSERT INTO artifact_links
         (id, artifact_id, entity_type, entity_id, link_kind, series_id, series_ref, created_at, updated_at)
       VALUES ('lnk_x', 'art_x', 'issue', 'iss', 'living', 'series-1', 'artifact-series:foo', 1, 1)`,
    ).run();

    const dump = buildMetadataBackupSql(db);
    const restored = new Database(path.join(tempDir, "restored.db"));
    restored.pragma("foreign_keys = OFF");
    restored.exec(dump);

    const cols = columnInfo(restored, "artifact_links");
    expect(cols.has("link_kind") && cols.has("series_id") && cols.has("series_ref")).toBe(true);

    const idx = indexNames(restored, "artifact_links");
    expect(idx.has("idx_artifact_links_kind")).toBe(true);
    expect(idx.has("idx_artifact_links_series")).toBe(true);

    const row = restored
      .prepare("SELECT link_kind, series_id, series_ref FROM artifact_links WHERE id = 'lnk_x'")
      .get();
    expect(row).toMatchObject({
      link_kind: "living",
      series_id: "series-1",
      series_ref: "artifact-series:foo",
    });
    restored.close();
  });

  it("fresh-DB schema and migrated-DB schema converge for artifact_links", () => {
    const migratedPath = path.join(tempDir, "migrated.db");
    const migrated = openDb(migratedPath);
    try {
      rewindArtifactLinksToV67(migrated);
      migrate(migrated);

      // Compare semantic column signatures (name/type/notnull/default) and the
      // index name set, not the raw CREATE text (whitespace / IF NOT EXISTS differ).
      const fresh = columnInfo(db, "artifact_links");
      const mig = columnInfo(migrated, "artifact_links");
      expect([...mig.entries()].sort()).toEqual([...fresh.entries()].sort());
      expect([...indexNames(migrated, "artifact_links")].sort()).toEqual(
        [...indexNames(db, "artifact_links")].sort(),
      );
    } finally {
      migrated.close();
    }
  });
});
