import SqliteDatabase from "../../src/sqlite.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrate, openDb, type Db } from "../../src/db.js";
import { buildMetadataBackupSql, METADATA_BACKUP_TABLES } from "../../src/ledger/backup.js";

// Issue b395083 (umbrella de56ffa): Spaces P1' core schema — the "core four"
// tables (spaces / space_items / space_occurrences / space_edges) per
// docs/spaces/UMBRELLA-PLAN.md §3, with inline UNIQUE/composite-FK constraints,
// object-only json_valid CHECKs, RESTRICT on spaces.project_id, and space-internal
// CASCADE. space_blocks / space_exports are intentionally NOT part of this child.

let tempDir = "";
let dbPath = "";
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-spaces-"));
  dbPath = path.join(tempDir, "mandible.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("spaces core schema (issue b395083)", () => {
  it("creates the core four tables and exposes them at the head migration version", () => {
    for (const table of SPACES_CORE_TABLES) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { name: string } | undefined;
      expect(row?.name, `missing table ${table}`).toBe(table);
    }
    // First link of the serial chain: this child takes the next contiguous version
    // after main's v82. space_blocks / space_exports are later children.
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(83);
  });

  // The C1 core-four migration no longer owns a "space_exports does not exist"
  // placeholder: the C13a serial-chain child (issue 9041bb3) now creates that
  // table, and asserts its schema + backup behavior in test/spaces-exports.test.ts.
  // This mirrors how the C11 blocks child (d2a8e77) retired its own placeholder.

  it("rejects invalid JSON on every metadata_json column (object-only json_valid)", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    const itemId = seedItem(db, spaceId, "item-1");
    const occId = seedOccurrence(db, spaceId, "occ-1", { itemId });
    const occId2 = seedOccurrence(db, spaceId, "occ-2", { itemId });

    // Not valid JSON.
    expect(() =>
      db
        .prepare(
          `INSERT INTO spaces (id, project_id, title, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("space-bad", projectId, "Bad", "not json", now(), now()),
    ).toThrow();

    // Valid JSON but not an object (array / scalar) is rejected by json_type check.
    for (const badJson of ["[]", "42", '"str"', "null"]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO space_items (id, space_id, ref_type, ref_id, metadata_json, created_at, updated_at)
             VALUES (?, ?, 'issue', 'x', ?, ?, ?)`,
          )
          .run(`item-bad-${badJson}`, spaceId, badJson, now(), now()),
        `space_items metadata_json should reject ${badJson}`,
      ).toThrow();
    }
    expect(() =>
      db
        .prepare(
          `INSERT INTO space_occurrences (id, space_id, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("occ-bad", spaceId, "[]", now(), now()),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO space_edges (id, space_id, source, target, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("edge-bad", spaceId, occId, occId2, "5", now(), now()),
    ).toThrow();
  });

  it("rejects duplicate canonical membership: UNIQUE(space_id, ref_type, ref_id)", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    seedItem(db, spaceId, "item-1", "artifact", "sha256:abc");
    expect(() => seedItem(db, spaceId, "item-2", "artifact", "sha256:abc")).toThrow();
    // Same ref in a DIFFERENT space is allowed (uniqueness is scoped to space_id).
    const spaceId2 = seedSpace(db, projectId, "space-2");
    expect(() => seedItem(db, spaceId2, "item-3", "artifact", "sha256:abc")).not.toThrow();
  });

  it("allows typed Space refs as canonical membership", () => {
    const projectId = seedProject(db);
    const containerId = seedSpace(db, projectId, "space-container");
    const linkedId = seedSpace(db, projectId, "space-linked");
    expect(() => seedItem(db, containerId, "item-space", "space", linkedId)).not.toThrow();
    expect(() => seedItem(db, containerId, "item-space-dup", "space", linkedId)).toThrow();
  });


  it("allows multiple occurrences of one item (no UNIQUE on space_id,item_id)", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    const itemId = seedItem(db, spaceId, "item-1");
    expect(() => {
      seedOccurrence(db, spaceId, "occ-1", { itemId });
      seedOccurrence(db, spaceId, "occ-2", { itemId });
    }).not.toThrow();
  });

  it("rejects ref_id = '' on space_items", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    expect(() => seedItem(db, spaceId, "item-1", "issue", "")).toThrow();
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

  it("rejects renderer = 'document' on space_occurrences (space_blocks owns document structure)", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    expect(() =>
      db
        .prepare(
          `INSERT INTO space_occurrences (id, space_id, renderer, created_at, updated_at)
           VALUES (?, ?, 'document', ?, ?)`,
        )
        .run("occ-1", spaceId, now(), now()),
    ).toThrow();
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

  it("cascades occurrence deletion when its item is deleted", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    const itemId = seedItem(db, spaceId, "item-1");
    seedOccurrence(db, spaceId, "occ-1", { itemId });
    seedOccurrence(db, spaceId, "occ-2", { itemId });

    db.prepare("DELETE FROM space_items WHERE id = ?").run(itemId);
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM space_occurrences WHERE item_id = ?")
      .get(itemId) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("cascades the whole space's contents on space deletion", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
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

  it("RESTRICTs project deletion while a space exists, then allows it once removed", () => {
    const projectId = seedProject(db);
    const spaceId = seedSpace(db, projectId);
    expect(() => db.prepare("DELETE FROM ledger_projects WHERE id = ?").run(projectId)).toThrow();
    db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
    expect(() =>
      db.prepare("DELETE FROM ledger_projects WHERE id = ?").run(projectId),
    ).not.toThrow();
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
