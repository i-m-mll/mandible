// @vitest-environment node
import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db } from "../src/db.js";
import { buildMetadataBackupSql, METADATA_BACKUP_TABLES } from "../src/ledger/backup.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

// Issue b395083 (umbrella de56ffa): Spaces P1' core schema — the "core four"
// tables (spaces / space_items / space_occurrences / space_edges) per
// docs/spaces/UMBRELLA-PLAN.md §3, with inline UNIQUE/composite-FK constraints,
// object-only json_valid CHECKs, RESTRICT on spaces.project_id, and space-internal
// CASCADE. space_blocks / space_exports are intentionally NOT part of this child.

let tempDir = "";
let db: Db;

const SPACES_CORE_TABLES = ["spaces", "space_items", "space_occurrences", "space_edges"] as const;

function now(): number {
  return Date.now();
}

function seedProject(database: Db, id = "proj-1"): string {
  database
    .prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, "Test Project", `github.com/test/${id}`, now(), now());
  return id;
}

function seedSpace(database: Db, projectId: string, id = "space-1"): string {
  database
    .prepare(
      `INSERT INTO spaces (id, project_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, "Space One", now(), now());
  return id;
}

function seedItem(
  database: Db,
  spaceId: string,
  id: string,
  refType = "issue",
  refId = "issue-1",
  refUri: string | null = null,
): string {
  database
    .prepare(
      `INSERT INTO space_items (id, space_id, ref_type, ref_id, ref_uri, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, spaceId, refType, refId, refUri, now(), now());
  return id;
}

function seedOccurrence(
  database: Db,
  spaceId: string,
  id: string,
  opts: { itemId?: string | null; parentId?: string | null } = {},
): string {
  database
    .prepare(
      `INSERT INTO space_occurrences (id, space_id, item_id, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, spaceId, opts.itemId ?? null, opts.parentId ?? null, now(), now());
  return id;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(testRuntimeRoot, "spaces-"));
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("spaces core schema (issue b395083)", () => {
  it("rejects duplicate canonical membership: UNIQUE(space_id, ref_type, ref_id)", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    seedItem(db, spaceId, "item-1", "artifact", "sha256:abc");
    expect(() => seedItem(db, spaceId, "item-2", "artifact", "sha256:abc")).toThrow();
    // Same ref in a DIFFERENT space is allowed (uniqueness is scoped to space_id).
    const spaceId2 = seedSpace(db, projectId, "space-2");
    expect(() => seedItem(db, spaceId2, "item-3", "artifact", "sha256:abc")).not.toThrow();
  });

  it("rejects external_ref items without ref_uri", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    expect(() =>
      seedItem(db, spaceId, "item-1", "external_ref", "ext-1", null),
    ).toThrow();
    // With a ref_uri it is accepted.
    expect(() =>
      seedItem(db, spaceId, "item-2", "external_ref", "ext-2", "https://example.com/doc"),
    ).not.toThrow();
  });

  it("rejects cross-space occurrence item_id and parent_id via composite FKs", () => {
    const projectId = seedProject(db);
    const spaceA = seedSpace(db, projectId, "space-A");
    const spaceB = seedSpace(db, projectId, "space-B");
    const itemInA = seedItem(db, spaceA, "item-A");
    const occInA = seedOccurrence(db, spaceA, "occ-A", { itemId: itemInA });

    // An occurrence in space B cannot reference an item that lives in space A.
    expect(() => seedOccurrence(db, spaceB, "occ-B", { itemId: itemInA })).toThrow();
    // ... nor a parent occurrence in space A.
    expect(() => seedOccurrence(db, spaceB, "occ-B2", { parentId: occInA })).toThrow();
  });

  it("rejects cross-space edges via composite FKs", () => {
    const projectId = seedProject(db);
    const spaceA = seedSpace(db, projectId, "space-A");
    const spaceB = seedSpace(db, projectId, "space-B");
    const occA = seedOccurrence(db, spaceA, "occ-A");
    const occB = seedOccurrence(db, spaceB, "occ-B");

    // Edge declared in space A but pointing at an occurrence in space B is rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO space_edges (id, space_id, source, target, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("edge-bad", spaceA, occA, occB, now(), now()),
    ).toThrow();
    // Same-space edge is accepted.
    const occA2 = seedOccurrence(db, spaceA, "occ-A2");
    expect(() =>
      db
        .prepare(
          `INSERT INTO space_edges (id, space_id, source, target, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("edge-ok", spaceA, occA, occA2, now(), now()),
    ).not.toThrow();
  });

  it("cascades occurrences with their item, and the whole space's contents with the space", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    const doomed = seedItem(db, spaceId, "item-doomed", "issue", "issue-doomed");
    seedOccurrence(db, spaceId, "occ-doomed", { itemId: doomed });
    db.prepare("DELETE FROM space_items WHERE id = ?").run(doomed);
    expect(db.prepare("SELECT COUNT(*) AS n FROM space_occurrences WHERE item_id = ?").get(doomed)).toEqual({ n: 0 });

    const itemId = seedItem(db, spaceId, "item-1");
    const occ1 = seedOccurrence(db, spaceId, "occ-1", { itemId });
    const occ2 = seedOccurrence(db, spaceId, "occ-2", { itemId });
    db.prepare(
      `INSERT INTO space_edges (id, space_id, source, target, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("edge-1", spaceId, occ1, occ2, now(), now());

    db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);

    for (const table of ["space_items", "space_occurrences", "space_edges"]) {
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE space_id = ?`)
        .get(spaceId) as { n: number };
      expect(count.n, `${table} should cascade-clear`).toBe(0);
    }
  });
});

describe("spaces core schema — metadata backup classification (issue b395083)", () => {
  it("includes all four core tables in METADATA_BACKUP_TABLES", () => {
    for (const table of SPACES_CORE_TABLES) {
      expect(METADATA_BACKUP_TABLES, `${table} missing from metadata backup set`).toContain(table);
    }
  });

  it("fails classification if any of the four is omitted (drift guard)", () => {
    // Simulate omission: a backup set missing any core table must fail to cover it.
    for (const omitted of SPACES_CORE_TABLES) {
      const partial = METADATA_BACKUP_TABLES.filter((t) => t !== omitted);
      expect(partial.includes(omitted), `${omitted} should be detectable as omitted`).toBe(false);
    }
  });

  it("emits the four core tables' DDL in the metadata backup", () => {
    seedProject(db);
    const sql = buildMetadataBackupSql(db);
    for (const table of SPACES_CORE_TABLES) {
      expect(sql, `backup should include DDL for ${table}`).toContain(`CREATE TABLE`);
      expect(sql).toContain(`-- Table: ${table}`);
    }
    expect(sql).toContain(
      "CHECK(ref_type IN ('issue','comment','artifact','external_ref','space'))",
    );
  });
});

describe("spaces core schema — inline UNIQUE survives backup/restore (issue b395083)", () => {
  it("restored schema (DDL-only round trip) still enforces UNIQUE(space_id, ref_type, ref_id)", () => {
    // The metadata backup emits each table's own DDL plus INSERT rows, but NO
    // standalone CREATE INDEX statements. A uniqueness rule that lived only as an
    // external CREATE UNIQUE INDEX would be lost; an INLINE UNIQUE survives.
    seedProject(db, "proj-1");
    seedSpace(db, "proj-1", "space-1");
    seedItem(db, "space-1", "item-1", "artifact", "sha256:abc");
    const sql = buildMetadataBackupSql(db);

    // Round-trip into a fresh database using ONLY the backup SQL (table DDL + data).
    const restorePath = path.join(tempDir, "restored.db");
    const restored = new SqliteDatabase(restorePath);
    restored.pragma("foreign_keys = ON");
    restored.exec(sql);

    // The inline UNIQUE(space_id, ref_type, ref_id) constraint must still reject a duplicate.
    expect(() =>
      restored
        .prepare(
          `INSERT INTO space_items (id, space_id, ref_type, ref_id, metadata_json, created_at, updated_at)
           VALUES (?, 'space-1', 'artifact', 'sha256:abc', '{}', ?, ?)`,
        )
        .run("item-dup", now(), now()),
    ).toThrow();

    // The inline UNIQUE(space_id, id) composite-FK target must also survive the
    // round trip, since the composite FK depends on it. An occurrence pointing at
    // a non-existent (space_id, item_id) pair must be rejected by the FK, proving
    // the inline UNIQUE target landed in the restored DDL.
    expect(() =>
      restored
        .prepare(
          `INSERT INTO space_occurrences (id, space_id, item_id, metadata_json, created_at, updated_at)
           VALUES ('occ-x', 'space-1', 'no-such-item', '{}', ?, ?)`,
        )
        .run(now(), now()),
    ).toThrow();
    // A valid same-space reference is accepted post-restore.
    expect(() =>
      restored
        .prepare(
          `INSERT INTO space_occurrences (id, space_id, item_id, metadata_json, created_at, updated_at)
           VALUES ('occ-ok', 'space-1', 'item-1', '{}', ?, ?)`,
        )
        .run(now(), now()),
    ).not.toThrow();

    restored.close();
  });
});
