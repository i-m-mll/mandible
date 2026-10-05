import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate, openDb, setDb, type Db } from "../src/db.js";
import {
  buildMetadataBackupSql,
  METADATA_BACKUP_TABLES,
} from "../src/ledger/backup.js";
import {
  generateSortKey,
  isValidSortKey,
  normalizeSortKeys,
  toDocBlock,
  BLOCK_TYPES,
} from "../src/ledger/space-blocks.js";
import { registerSpacesRoutes } from "../src/routes/spaces.js";
import { Router } from "../src/server.js";
import { SPACE_EVENTS, isSpaceEvent } from "../src/spaces/events.js";
import { exportDocument, importDocument, type DocBlock } from "../src/spaces/serialize.js";

// Issue d2a8e77 (umbrella de56ffa): Spaces document/canvas blocks — the
// space_blocks table (second serial-chain migration), the /blocks* REST routes,
// the space:block:changed event, and the cycle/sort-key/detach logic. Block
// identity agrees with the C12 spaces-doc.v1 serialization.

function now(): number {
  return Date.now();
}

function allowsFileRpcRoute(method: string, url: string): boolean {
  const router = new Router();
  registerSpacesRoutes(router);
  return router.resolveFileRpcPolicy(method, url);
}

// ============================================================================
// Schema / migration (direct DB)
// ============================================================================

describe("space_blocks schema (issue d2a8e77)", () => {
  let tempDir = "";
  let dbPath = "";
  let db: Db;

  function seedProject(id = "proj-1"): string {
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, "Test Project", `github.com/test/${id}`, now(), now());
    return id;
  }
  function seedSpace(projectId: string, id = "space-1"): string {
    db.prepare(
      `INSERT INTO spaces (id, project_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, projectId, "Space One", now(), now());
    return id;
  }
  function seedItem(spaceId: string, id: string, refType = "issue", refId = "issue-1"): string {
    db.prepare(
      `INSERT INTO space_items (id, space_id, ref_type, ref_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, spaceId, refType, refId, now(), now());
    return id;
  }
  function insertBlock(
    spaceId: string,
    id: string,
    opts: {
      parentId?: string | null;
      blockType?: string;
      itemId?: string | null;
      snapshot?: string | null;
      sortKey?: string;
    } = {},
  ): void {
    db.prepare(
      `INSERT INTO space_blocks (
         id, space_id, parent_id, block_type, item_id, item_snapshot_json,
         sort_key, markdown, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '{}', ?, ?)`,
    ).run(
      id,
      spaceId,
      opts.parentId ?? null,
      opts.blockType ?? "paragraph",
      opts.itemId ?? null,
      opts.snapshot ?? null,
      opts.sortKey ?? "m",
      now(),
      now(),
    );
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-blocks-"));
    dbPath = path.join(tempDir, "mandible.db");
    db = openDb(dbPath);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the space_blocks table at the head migration version", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'space_blocks'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("space_blocks");
    // Second serial-chain link: contiguous version after C1's spaces_core (v83).
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(84);
  });

  it("rejects invalid block_type via CHECK (lockstep with C12 BLOCK_TYPES)", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    expect(() => insertBlock(spaceId, "b-bad", { blockType: "not-a-type" })).toThrow();
    // Every C12 BLOCK_TYPES value is accepted by the CHECK.
    for (const t of BLOCK_TYPES) {
      expect(() => insertBlock(spaceId, `b-${t}`, { blockType: t })).not.toThrow();
    }
  });

  it("rejects non-object metadata_json and item_snapshot_json (object-only json_valid)", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    expect(() =>
      db
        .prepare(
          `INSERT INTO space_blocks (id, space_id, block_type, sort_key, metadata_json, created_at, updated_at)
           VALUES ('b1', ?, 'paragraph', 'm', 'not json', ?, ?)`,
        )
        .run(spaceId, now(), now()),
    ).toThrow();
    for (const bad of ["[]", "5", '"s"', "null"]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO space_blocks (id, space_id, block_type, sort_key, metadata_json, created_at, updated_at)
             VALUES (?, ?, 'paragraph', 'm', ?, ?, ?)`,
          )
          .run(`b-meta-${bad}`, spaceId, bad, now(), now()),
        `metadata_json should reject ${bad}`,
      ).toThrow();
    }
    const itemId = seedItem(spaceId, "item-1");
    // item_snapshot_json that is valid-but-not-an-object is rejected.
    expect(() => insertBlock(spaceId, "b-snap-bad", { itemId, snapshot: "[]" })).toThrow();
    // a real object snapshot is accepted.
    expect(() =>
      insertBlock(spaceId, "b-snap-ok", { itemId, snapshot: '{"item_id":"item-1"}' }),
    ).not.toThrow();
  });

  it("enforces CHECK(item_id IS NULL OR item_snapshot_json IS NOT NULL)", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    const itemId = seedItem(spaceId, "item-1");
    // item_id set but NO snapshot → rejected by the invariant CHECK.
    expect(() => insertBlock(spaceId, "b-no-snap", { itemId, snapshot: null })).toThrow();
    // item_id set WITH snapshot → accepted.
    expect(() =>
      insertBlock(spaceId, "b-with-snap", { itemId, snapshot: '{"item_id":"item-1"}' }),
    ).not.toThrow();
    // item_id NULL with no snapshot → accepted (prose block).
    expect(() => insertBlock(spaceId, "b-prose", { itemId: null, snapshot: null })).not.toThrow();
    // a snapshot WITHOUT an item_id is allowed (detached placeholder).
    expect(() =>
      insertBlock(spaceId, "b-detached", { itemId: null, snapshot: '{"item_id":"gone"}' }),
    ).not.toThrow();
  });

  it("rejects cross-space parent_id and item_id via composite FKs", () => {
    const projectId = seedProject();
    const spaceA = seedSpace(projectId, "space-A");
    const spaceB = seedSpace(projectId, "space-B");
    const parentInA = ((): string => {
      insertBlock(spaceA, "p-A", {});
      return "p-A";
    })();
    const itemInA = seedItem(spaceA, "item-A");
    // A block in B cannot point its parent at a block in A.
    expect(() => insertBlock(spaceB, "child-B", { parentId: parentInA })).toThrow();
    // ... nor embed an item that lives in A.
    expect(() =>
      insertBlock(spaceB, "embed-B", { itemId: itemInA, snapshot: '{"item_id":"item-A"}' }),
    ).toThrow();
  });

  it("RESTRICTs deleting an item embedded in a block; detach-then-delete works", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    const itemId = seedItem(spaceId, "item-1");
    insertBlock(spaceId, "b-embed", { itemId, snapshot: '{"item_id":"item-1","title":"X"}' });

    // ON DELETE RESTRICT blocks the item deletion while a block embeds it.
    expect(() => db.prepare("DELETE FROM space_items WHERE id = ?").run(itemId)).toThrow();

    // Detach: drop item_id, KEEP the snapshot placeholder.
    db.prepare("UPDATE space_blocks SET item_id = NULL WHERE id = 'b-embed'").run();
    const row = db
      .prepare("SELECT item_id, item_snapshot_json FROM space_blocks WHERE id = 'b-embed'")
      .get() as { item_id: string | null; item_snapshot_json: string | null };
    expect(row.item_id).toBeNull();
    expect(row.item_snapshot_json).toContain("item-1");

    // Now the item can be deleted.
    expect(() => db.prepare("DELETE FROM space_items WHERE id = ?").run(itemId)).not.toThrow();
  });

  it("cascades blocks on space deletion and on parent block deletion", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    insertBlock(spaceId, "root", {});
    insertBlock(spaceId, "child", { parentId: "root" });
    // Deleting the parent cascades to the child (self-referential FK CASCADE).
    db.prepare("DELETE FROM space_blocks WHERE id = 'root'").run();
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM space_blocks WHERE space_id = ?")
      .get(spaceId) as { n: number };
    expect(remaining.n).toBe(0);

    insertBlock(spaceId, "root2", {});
    db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
    const afterSpace = db
      .prepare("SELECT COUNT(*) AS n FROM space_blocks WHERE space_id = ?")
      .get(spaceId) as { n: number };
    expect(afterSpace.n).toBe(0);
  });
});

// ============================================================================
// Backup classification + restore round trip
// ============================================================================

describe("space_blocks metadata backup classification (issue d2a8e77)", () => {
  let tempDir = "";
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-blocks-bk-"));
    db = openDb(path.join(tempDir, "mandible.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("includes space_blocks in METADATA_BACKUP_TABLES (drift guard fails if omitted)", () => {
    expect(METADATA_BACKUP_TABLES).toContain("space_blocks");
    const partial = METADATA_BACKUP_TABLES.filter((t) => t !== "space_blocks");
    expect(partial.includes("space_blocks" as never)).toBe(false);
  });

  it("lists space_blocks AFTER its parents (spaces, space_items)", () => {
    const idx = (t: string) => METADATA_BACKUP_TABLES.indexOf(t as never);
    expect(idx("space_blocks")).toBeGreaterThan(idx("spaces"));
    expect(idx("space_blocks")).toBeGreaterThan(idx("space_items"));
  });

  it("emits space_blocks DDL in the backup", () => {
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES ('p', 'P', 'github.com/test/p', ?, ?)`,
    ).run(now(), now());
    const sql = buildMetadataBackupSql(db);
    expect(sql).toContain("-- Table: space_blocks");
    expect(sql).toContain("CREATE TABLE");
  });

  it("inline UNIQUE/CHECK/composite-FK survive a DDL-only restore round trip", () => {
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES ('p', 'P', 'github.com/test/p', ?, ?)`,
    ).run(now(), now());
    db.prepare(
      `INSERT INTO spaces (id, project_id, title, created_at, updated_at)
       VALUES ('s', 'p', 'S', ?, ?)`,
    ).run(now(), now());
    db.prepare(
      `INSERT INTO space_items (id, space_id, ref_type, ref_id, created_at, updated_at)
       VALUES ('item-1', 's', 'issue', 'i1', ?, ?)`,
    ).run(now(), now());
    db.prepare(
      `INSERT INTO space_blocks (id, space_id, block_type, item_id, item_snapshot_json, sort_key, markdown, metadata_json, created_at, updated_at)
       VALUES ('b1', 's', 'reference', 'item-1', '{"item_id":"item-1"}', 'm', '', '{}', ?, ?)`,
    ).run(now(), now());

    const sql = buildMetadataBackupSql(db);
    const restorePath = path.join(tempDir, "restored.db");
    const restored = new SqliteDatabase(restorePath);
    restored.pragma("foreign_keys = ON");
    restored.exec(sql);

    // The invariant CHECK survives: item_id with no snapshot is rejected post-restore.
    expect(() =>
      restored
        .prepare(
          `INSERT INTO space_blocks (id, space_id, block_type, item_id, sort_key, markdown, metadata_json, created_at, updated_at)
           VALUES ('b-no-snap', 's', 'reference', 'item-1', 'n', '', '{}', ?, ?)`,
        )
        .run(now(), now()),
    ).toThrow();

    // The composite item FK (depending on the inline UNIQUE target) survives.
    expect(() =>
      restored
        .prepare(
          `INSERT INTO space_blocks (id, space_id, block_type, item_id, item_snapshot_json, sort_key, markdown, metadata_json, created_at, updated_at)
           VALUES ('b-bad-item', 's', 'reference', 'no-such', '{"x":1}', 'o', '', '{}', ?, ?)`,
        )
        .run(now(), now()),
    ).toThrow();

    // The inline UNIQUE(space_id, id) survives (duplicate id rejected).
    expect(() =>
      restored
        .prepare(
          `INSERT INTO space_blocks (id, space_id, block_type, sort_key, markdown, metadata_json, created_at, updated_at)
           VALUES ('b1', 's', 'paragraph', 'p', '', '{}', ?, ?)`,
        )
        .run(now(), now()),
    ).toThrow();

    restored.close();
  });
});

// ============================================================================
// Sort-key generation / normalization (deterministic)
// ============================================================================

describe("block sort-key generation / normalization (issue d2a8e77)", () => {
  it("generateSortKey produces a key strictly between bounds (deterministic)", () => {
    const a = generateSortKey(null, null);
    const b = generateSortKey(a, null);
    const c = generateSortKey(b, null);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    // Deterministic: same inputs → same output.
    expect(generateSortKey(a, c)).toBe(generateSortKey(a, c));
    const mid = generateSortKey(a, c);
    expect(a < mid && mid < c).toBe(true);
    expect(isValidSortKey(mid)).toBe(true);
  });

  it("generateSortKey inserts between adjacent keys without collision", () => {
    let lo = generateSortKey(null, null);
    let hi = generateSortKey(lo, null);
    // Repeatedly bisect; every key must stay strictly ordered and unique.
    const seen = new Set([lo, hi]);
    for (let i = 0; i < 50; i++) {
      const mid = generateSortKey(lo, hi);
      expect(lo < mid && mid < hi, `bisect ${i}: ${lo} < ${mid} < ${hi}`).toBe(true);
      expect(seen.has(mid)).toBe(false);
      seen.add(mid);
      hi = mid;
    }
  });

  it("generateSortKey rejects inverted bounds", () => {
    expect(() => generateSortKey("z", "a")).toThrow();
  });

  it("normalizeSortKeys returns N strictly-increasing deterministic keys", () => {
    for (const n of [1, 2, 5, 37, 100]) {
      const keys = normalizeSortKeys(n);
      expect(keys.length).toBe(n);
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i - 1] < keys[i], `n=${n} idx=${i}: ${keys[i - 1]} < ${keys[i]}`).toBe(true);
      }
      expect(keys.every((k) => isValidSortKey(k))).toBe(true);
      // Deterministic.
      expect(normalizeSortKeys(n)).toEqual(keys);
    }
    expect(normalizeSortKeys(0)).toEqual([]);
  });
});

// ============================================================================
// Routes (full HTTP shell over the helpers)
// ============================================================================

describe("blocks routes (issue d2a8e77)", () => {
  let db: Db;
  let router: Router;
  const PROJECT_ID = "prj-blocks";

  async function call(method: string, url: string, body?: unknown) {
    return router.invoke({ method, url, body });
  }
  async function makeSpace(): Promise<string> {
    const res = await call("POST", "/api/spaces", { project_id: PROJECT_ID, title: "Doc" });
    expect(res.status).toBe(201);
    return (res.body as { space: { id: string } }).space.id;
  }
  async function addItem(spaceId: string): Promise<string> {
    const res = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "artifact",
      ref_id: `sha256:${"a".repeat(8)}`,
    });
    expect(res.status).toBeLessThan(300);
    return (res.body as { item: { id: string } }).item.id;
  }

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    db.pragma("foreign_keys = ON");
    setDb(db);
    router = new Router();
    registerSpacesRoutes(router);
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(PROJECT_ID, "Blocks Test", "github.com/test/blocks", now(), now());
  });
  afterEach(() => {
    db.close();
  });

  it("creates, lists, updates, and deletes a block", async () => {
    const spaceId = await makeSpace();
    const created = await call("POST", `/api/spaces/${spaceId}/blocks`, {
      block_type: "paragraph",
      markdown: "hello",
    });
    expect(created.status).toBe(201);
    const block = (created.body as { block: { id: string; sort_key: string } }).block;
    expect(isValidSortKey(block.sort_key)).toBe(true);

    const listed = await call("GET", `/api/spaces/${spaceId}/blocks`);
    expect(listed.status).toBe(200);
    expect((listed.body as { blocks: unknown[] }).blocks.length).toBe(1);

    const patched = await call("PATCH", `/api/spaces/${spaceId}/blocks/${block.id}`, {
      markdown: "updated",
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { block: { markdown: string } }).block.markdown).toBe("updated");

    const deleted = await call("DELETE", `/api/spaces/${spaceId}/blocks/${block.id}`);
    expect(deleted.status).toBe(200);
    const after = await call("GET", `/api/spaces/${spaceId}/blocks`);
    expect((after.body as { blocks: unknown[] }).blocks.length).toBe(0);
  });

  it("auto-orders nested blocks depth-first by sort_key (matches C12 order)", async () => {
    const spaceId = await makeSpace();
    const mk = async (parentId: string | null, sortKey?: string) => {
      const res = await call("POST", `/api/spaces/${spaceId}/blocks`, {
        block_type: "paragraph",
        parent_id: parentId,
        sort_key: sortKey,
      });
      expect(res.status).toBe(201);
      return (res.body as { block: { id: string } }).block.id;
    };
    const a = await mk(null, "a");
    const b = await mk(null, "c");
    const a1 = await mk(a, "a");
    const a2 = await mk(a, "b");
    const listed = await call("GET", `/api/spaces/${spaceId}/blocks`);
    const ids = (listed.body as { blocks: { id: string }[] }).blocks.map((x) => x.id);
    // Depth-first: a, then its children a1,a2 (by sort_key), then b.
    expect(ids).toEqual([a, a1, a2, b]);
  });

  it("rejects a parent cycle via the API (400)", async () => {
    const spaceId = await makeSpace();
    const mk = async (parentId: string | null) => {
      const res = await call("POST", `/api/spaces/${spaceId}/blocks`, {
        block_type: "paragraph",
        parent_id: parentId,
      });
      return (res.body as { block: { id: string } }).block.id;
    };
    const a = await mk(null);
    const b = await mk(a);
    const c = await mk(b);
    // Re-parenting `a` under its own descendant `c` would create a cycle.
    const res = await call("PATCH", `/api/spaces/${spaceId}/blocks/${a}`, { parent_id: c });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("cycle");
    // Self-parent is also rejected.
    const selfRes = await call("PATCH", `/api/spaces/${spaceId}/blocks/${a}`, { parent_id: a });
    expect(selfRes.status).toBe(400);
  });

  it("rejects assigning item_id without item_snapshot (route + DB invariant)", async () => {
    const spaceId = await makeSpace();
    const itemId = await addItem(spaceId);
    const res = await call("POST", `/api/spaces/${spaceId}/blocks`, {
      block_type: "reference",
      item_id: itemId,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("item_snapshot");

    // With a snapshot it is accepted.
    const ok = await call("POST", `/api/spaces/${spaceId}/blocks`, {
      block_type: "reference",
      item_id: itemId,
      item_snapshot: { item_id: itemId, title: "X" },
    });
    expect(ok.status).toBe(201);
  });

  it("rejects an embed item_id on a non-embed block_type", async () => {
    const spaceId = await makeSpace();
    const itemId = await addItem(spaceId);
    const res = await call("POST", `/api/spaces/${spaceId}/blocks`, {
      block_type: "paragraph",
      item_id: itemId,
      item_snapshot: { item_id: itemId },
    });
    expect(res.status).toBe(400);
  });

  it("rejects cross-space / missing parent_id and item_id refs (400, not 500)", async () => {
    const spaceId = await makeSpace();
    const missingParent = await call("POST", `/api/spaces/${spaceId}/blocks`, {
      block_type: "paragraph",
      parent_id: "no-such-block",
    });
    expect(missingParent.status).toBe(400);
    const missingItem = await call("POST", `/api/spaces/${spaceId}/blocks`, {
      block_type: "reference",
      item_id: "no-such-item",
      item_snapshot: { item_id: "no-such-item" },
    });
    expect(missingItem.status).toBe(400);
  });

  it("detaches an embedded item, preserving the snapshot, then allows item delete", async () => {
    const spaceId = await makeSpace();
    const itemId = await addItem(spaceId);
    const created = await call("POST", `/api/spaces/${spaceId}/blocks`, {
      block_type: "reference",
      item_id: itemId,
      item_snapshot: { item_id: itemId, title: "Embedded" },
    });
    const blockId = (created.body as { block: { id: string } }).block.id;

    // Deleting the item directly is RESTRICTed (DB-level).
    const blockedDelete = await call("DELETE", `/api/spaces/${spaceId}/items/${itemId}`);
    expect(blockedDelete.status).toBe(400);

    // Detach drops the embed but keeps the snapshot placeholder.
    const detach = await call("POST", `/api/spaces/${spaceId}/items/${itemId}/detach-blocks`);
    expect(detach.status).toBe(200);
    expect((detach.body as { detached: unknown[] }).detached.length).toBe(1);

    const block = await call("GET", `/api/spaces/${spaceId}/blocks`);
    const row = (block.body as { blocks: { id: string; item_id: string | null; item_snapshot: unknown }[] }).blocks.find(
      (x) => x.id === blockId,
    )!;
    expect(row.item_id).toBeNull();
    expect(row.item_snapshot).toMatchObject({ item_id: itemId, title: "Embedded" });

    // Now the item delete succeeds.
    const okDelete = await call("DELETE", `/api/spaces/${spaceId}/items/${itemId}`);
    expect(okDelete.status).toBe(200);
  });

  it("404s on blocks for a missing space / missing block", async () => {
    const spaceId = await makeSpace();
    expect((await call("GET", `/api/spaces/no-space/blocks`)).status).toBe(404);
    expect((await call("PATCH", `/api/spaces/${spaceId}/blocks/no-block`, {})).status).toBe(404);
    expect((await call("DELETE", `/api/spaces/${spaceId}/blocks/no-block`)).status).toBe(404);
  });

  it("block mutations are reachable only through the space:block:changed event enum", () => {
    expect(SPACE_EVENTS.SPACE_BLOCK_CHANGED).toBe("space:block:changed");
    expect(isSpaceEvent("space:block:changed")).toBe(true);
  });
});

// ============================================================================
// File-RPC self-allowlist (standing AC #1)
// ============================================================================

describe("blocks file-RPC allowlist (issue d2a8e77, standing AC #1)", () => {
  it("allowlists exactly the block read/write routes (method+path specific)", () => {
    expect(allowsFileRpcRoute("GET", "/api/spaces/s1/blocks")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/spaces/s1/blocks")).toBe(true);
    expect(allowsFileRpcRoute("PATCH", "/api/spaces/s1/blocks/b1")).toBe(true);
    expect(allowsFileRpcRoute("DELETE", "/api/spaces/s1/blocks/b1")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/spaces/s1/items/i1/detach-blocks")).toBe(true);
  });

  it("does NOT blanket-allow other methods/shapes", () => {
    // No catch-all: an unrelated verb on the blocks collection stays denied.
    expect(allowsFileRpcRoute("PUT", "/api/spaces/s1/blocks")).toBe(false);
    // Nested unknown sub-path is not allowed.
    expect(allowsFileRpcRoute("GET", "/api/spaces/s1/blocks/b1/extra")).toBe(false);
  });
});

// ============================================================================
// C12 round-trip: block identity agrees with the serialization
// ============================================================================

describe("block identity agrees with C12 serialization (issue d2a8e77)", () => {
  let db: Db;
  let router: Router;
  const PROJECT_ID = "prj-rt";

  async function call(method: string, url: string, body?: unknown) {
    return router.invoke({ method, url, body });
  }

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    db.pragma("foreign_keys = ON");
    setDb(db);
    router = new Router();
    registerSpacesRoutes(router);
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(PROJECT_ID, "RT", "github.com/test/rt", now(), now());
  });
  afterEach(() => db.close());

  it("toDocBlock projects the C12 DocBlock fields and round-trips through export/import", async () => {
    const sp = await call("POST", "/api/spaces", { project_id: PROJECT_ID, title: "Doc" });
    const spaceId = (sp.body as { space: { id: string } }).space.id;
    const mk = async (parentId: string | null, sortKey: string, markdown: string) => {
      const res = await call("POST", `/api/spaces/${spaceId}/blocks`, {
        block_type: "paragraph",
        parent_id: parentId,
        sort_key: sortKey,
        markdown,
      });
      return (res.body as { block: { id: string } }).block.id;
    };
    const h = await mk(null, "a", "# Title");
    await mk(h, "a", "child one");
    await mk(null, "c", "tail");

    const listed = await call("GET", `/api/spaces/${spaceId}/blocks`);
    const stored = (listed.body as {
      blocks: Array<Parameters<typeof toDocBlock>[0]>;
    }).blocks;

    // The stored records project onto the frozen C12 DocBlock shape.
    const docBlocks: DocBlock[] = stored.map(toDocBlock);
    for (const b of docBlocks) {
      expect(new Set(Object.keys(b))).toEqual(
        new Set(["id", "parent_id", "block_type", "item_id", "sort_key", "markdown"]),
      );
    }

    // Round-trip: export → import reconstructs id/parent/sort/type/item/markdown.
    const text = exportDocument({ frontmatter: { space: spaceId }, blocks: docBlocks });
    const { tree, conflicts } = importDocument(text);
    expect(conflicts).toEqual([]);
    const byId = new Map(tree.blocks.map((b) => [b.id, b]));
    for (const original of docBlocks) {
      const round = byId.get(original.id);
      expect(round, `block ${original.id} survived round trip`).toBeTruthy();
      expect(round).toMatchObject({
        id: original.id,
        parent_id: original.parent_id,
        block_type: original.block_type,
        item_id: original.item_id,
        sort_key: original.sort_key,
      });
    }
  });
});
