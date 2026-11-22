// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addSpaceNote, readSpaceReview } from "../src/feedback/space-review.js";
import { setupOperator } from "../src/users/store.js";
import { setDb, type Db } from "../src/db.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import {
  generateSortKey,
  isValidSortKey,
  normalizeSortKeys,
} from "../src/ledger/space-blocks.js";
import { registerSpacesRoutes } from "../src/routes/spaces.js";
import { Router } from "../src/server.js";

function allowsFileRpcRoute(method: string, url: string): boolean {
  const router = new Router();
  registerSpacesRoutes(router);
  return router.resolveFileRpcPolicy(method, url);
}

describe("block sort-key generation / normalization (issue d2a8e77)", () => {
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
    db = migratedMemoryDb();
    setDb(db);
    router = new Router();
    registerSpacesRoutes(router);
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(PROJECT_ID, "Blocks Test", "github.com/test/blocks", Date.now(), Date.now());
  });
  afterEach(() => {
    db.close();
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

  it("retains the saved generation when a block command wins a concurrent text edit", async () => {
    const spaceId = await makeSpace();
    const path = `/api/spaces/${spaceId}/document`;
    const original = "same\r\n\r\nsame";
    expect((await call("PATCH", path, { source: original, expected_generation: 0 })).body)
      .toEqual({ source: original, generation: 1 });
    const address = await call("POST", `${path}/address`, { start: 8, end: 12, expected_generation: 1 });
    expect(address.status).toBe(200);
    const { id, generation } = address.body as { id: string; generation: number };
    expect((await call("GET", `/api/spaces/${spaceId}/blocks`)).body)
      .toMatchObject({ blocks: [{ markdown: "same" }, { id, markdown: "same" }] });
    const edited = await call("PATCH", `/api/spaces/${spaceId}/blocks/${id.slice(0, 8)}`, { markdown: "block edit" });
    expect(edited.status).toBe(200);
    const working = "unsaved working text";
    const stale = await call("PATCH", path, { source: working, expected_generation: generation });
    expect(stale.status).toBe(409);
    const saved = (await call("GET", path)).body as { source: string; generation: number };
    expect(saved.generation).toBe(generation + 1);
    expect(saved.source).toContain("block edit");
    expect(stale.body).toEqual({ code: "stale_document", document: saved });
    expect((await call("PATCH", path, { source: saved.source, expected_generation: saved.generation })).body).toEqual(saved);
  });

  it("pins standing notes to a current saved generation and retains the original quote", async () => {
    const spaceId = await makeSpace();
    const path = `/api/spaces/${spaceId}/document`;
    const actor = setupOperator(db, { slug: "reviewer", display_name: "Reviewer" });
    const source = "A😀\r\n\r\nsecond block";
    const quote = "😀\r\n\r\nsecond";
    const range = { start_offset: 1, end_offset: 1 + quote.length, quote };
    await call("PATCH", path, { source, expected_generation: 0 });
    expect(addSpaceNote(db, spaceId, actor.id, 0, range, "Review both blocks."))
      .toEqual({ ok: false, reason: "stale_document" });
    expect(addSpaceNote(db, spaceId, actor.id, 1, range, "Review both blocks.").ok).toBe(true);
    await call("PATCH", path, { source: "Moved " + source, expected_generation: 1 });
    expect(readSpaceReview(db, spaceId)).toMatchObject({ generation: 2, notes: [{
      ...range, source_order: 1, body: "Review both blocks.",
    }] });
    expect(db.pragma("foreign_key_check")).toEqual([]);
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
});

// ============================================================================
// File-RPC self-allowlist (standing AC #1)
// ============================================================================

describe("blocks file-RPC allowlist (issue d2a8e77, standing AC #1)", () => {
  it("allows exactly the block read/write routes, method and path specific", () => {
    expect(allowsFileRpcRoute("GET", "/api/spaces/s1/blocks")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/spaces/s1/blocks")).toBe(true);
    expect(allowsFileRpcRoute("PATCH", "/api/spaces/s1/blocks/b1")).toBe(true);
    expect(allowsFileRpcRoute("DELETE", "/api/spaces/s1/blocks/b1")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/spaces/s1/items/i1/detach-blocks")).toBe(true);
    // No catch-all: an unrelated verb on the blocks collection stays denied.
    expect(allowsFileRpcRoute("PUT", "/api/spaces/s1/blocks")).toBe(false);
    // Nested unknown sub-path is not allowed.
    expect(allowsFileRpcRoute("GET", "/api/spaces/s1/blocks/b1/extra")).toBe(false);
  });
});

// ============================================================================
// C12 round-trip: block identity agrees with the serialization
// ============================================================================
