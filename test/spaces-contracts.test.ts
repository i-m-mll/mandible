import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb, type Db } from "../src/db.js";
import { registerSpacesRoutes } from "../src/routes/spaces.js";
import { Router } from "../src/server.js";

import type {
  AddSpaceItemResponse,
  BatchSpaceOccurrenceResponse,
  CreateSpaceRequest,
  ResolveRefResponse,
  SeedSpaceResult,
  Space,
  SpaceEdge,
  SpaceEdgeResponse,
  SpaceFactPacket,
  SpaceItem,
  SpaceItemRefType,
  SpaceListResponse,
  SpaceOccurrence,
  SpaceOccurrenceRenderer,
  SpaceOccurrenceResponse,
  SpaceRenderer,
  SpaceResponse,
} from "../src/contracts.js";
import {
  SPACE_ITEM_REF_TYPES,
  SPACE_OCCURRENCE_RENDERERS,
  SPACE_RENDERERS,
} from "../src/contracts.js";

// Backend (C2) source-of-truth record/input types — the contracts in
// `src/contracts.ts` mirror these. The `Expect`/`Equal` checks below fail to
// COMPILE if the two drift, which is the type-level half of this AC.
import type {
  SpaceRecord,
  SpaceItemRecord,
  SpaceOccurrenceRecord,
  SpaceEdgeRecord,
  SpaceRenderer as BackendSpaceRenderer,
  SpaceOccurrenceRenderer as BackendOccurrenceRenderer,
  SpaceItemRefType as BackendRefType,
} from "../src/ledger/spaces.js";
import { loadSpaceFactPacket } from "../src/routes/spaces.js";

// Issue 102d691 (umbrella de56ffa): Spaces shared contracts. This suite proves
// the `src/contracts.ts` Spaces types round-trip against the C2 route shapes
// both at compile time (type-equality assertions) and at runtime (live route
// responses are assignable to the contract types).

// --- compile-time structural equivalence ------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

// These aliases are pure type-level assertions; they have no runtime effect but
// fail `tsc` if a contract record diverges from its backend counterpart.
type _RecordsMatch = [
  Expect<Equal<Space, SpaceRecord>>,
  Expect<Equal<SpaceItem, SpaceItemRecord>>,
  Expect<Equal<SpaceOccurrence, SpaceOccurrenceRecord>>,
  Expect<Equal<SpaceEdge, SpaceEdgeRecord>>,
  Expect<Equal<SpaceRenderer, BackendSpaceRenderer>>,
  Expect<Equal<SpaceOccurrenceRenderer, BackendOccurrenceRenderer>>,
  Expect<Equal<SpaceItemRefType, BackendRefType>>,
  // The read-only fact packet returned by the route helper is assignable to the
  // contract `SpaceFactPacket`.
  Expect<Equal<NonNullable<ReturnType<typeof loadSpaceFactPacket>>, SpaceFactPacket>>,
];

let db: Db;
let router: Router;
const PROJECT_ID = "prj-spaces-contracts";

function seedProject(id: string, name: string): void {
  db.prepare(
    `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, `github.com/test/${id}`, Date.now(), Date.now());
}

async function call(method: string, url: string, body?: unknown) {
  return router.invoke({ method, url, body });
}

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  router = new Router();
  registerSpacesRoutes(router);
  seedProject(PROJECT_ID, "Contracts Test");
});

afterEach(() => {
  db.close();
});

describe("spaces contract enums", () => {
  it("renderer/ref-type enum constants match their literal unions", () => {
    expect(SPACE_RENDERERS).toEqual(["canvas", "document", "board", "collection"]);
    expect(SPACE_OCCURRENCE_RENDERERS).toEqual(["canvas", "board", "collection"]);
    expect(SPACE_ITEM_REF_TYPES).toEqual([
      "issue",
      "comment",
      "artifact",
      "external_ref",
      "space",
    ]);
    // `document` is a Space-level renderer but NOT an occurrence renderer.
    expect(SPACE_OCCURRENCE_RENDERERS).not.toContain("document");
  });
});

describe("spaces route responses satisfy the contract types", () => {
  it("create/get/list/update/delete a space", async () => {
    const createBody: CreateSpaceRequest = {
      project_id: PROJECT_ID,
      title: "Intro",
      default_renderer: "document",
      description: "hello",
      metadata: { pinned: true },
    };
    const created = await call("POST", "/api/spaces", createBody);
    expect(created.status).toBe(201);
    const space = (created.body as SpaceResponse).space;
    // Runtime assignment to the contract type — fields must all be present.
    const typed: Space = space;
    expect(typed.id).toBeTruthy();
    expect(typed.default_renderer).toBe("document");
    expect(typed.metadata).toEqual({ pinned: true });
    expect(typeof typed.created_at).toBe("number");

    const list = await call("GET", `/api/spaces?project_id=${PROJECT_ID}`);
    const spaces = (list.body as SpaceListResponse).spaces;
    expect(spaces).toHaveLength(1);
    const _firstAssignable: Space = spaces[0];
    expect(_firstAssignable.id).toBe(typed.id);

    const got = await call("GET", `/api/spaces/${typed.id}`);
    const _gotAssignable: Space = (got.body as SpaceResponse).space;
    expect(_gotAssignable.title).toBe("Intro");

    const patched = await call("PATCH", `/api/spaces/${typed.id}`, { title: "Renamed" });
    const _patchedAssignable: Space = (patched.body as SpaceResponse).space;
    expect(_patchedAssignable.title).toBe("Renamed");

    const removed = await call("DELETE", `/api/spaces/${typed.id}`);
    expect(removed.body).toEqual({ ok: true, id: typed.id });
  });

  it("add item (idempotent envelope), occurrence, batch, edge, and resolver shapes", async () => {
    const created = await call("POST", "/api/spaces", { project_id: PROJECT_ID, title: "S" });
    const space: Space = (created.body as SpaceResponse).space;

    const refType: SpaceItemRefType = "external_ref";
    const itemRes = await call("POST", `/api/spaces/${space.id}/items`, {
      ref_type: refType,
      ref_id: "https://example.com/doc",
      ref_uri: "https://example.com/doc",
      title: "Doc",
    });
    expect(itemRes.status).toBe(201);
    const itemEnvelope = itemRes.body as AddSpaceItemResponse;
    expect(itemEnvelope.created).toBe(true);
    expect(itemEnvelope.already_present).toBe(false);
    const item: SpaceItem = itemEnvelope.item;
    expect(item.ref_type).toBe("external_ref");

    // Idempotent re-add returns created:false / already_present:true.
    const dup = await call("POST", `/api/spaces/${space.id}/items`, {
      ref_type: refType,
      ref_id: "https://example.com/doc",
      ref_uri: "https://example.com/doc",
    });
    const dupEnvelope = dup.body as AddSpaceItemResponse;
    expect(dupEnvelope.created).toBe(false);
    expect(dupEnvelope.already_present).toBe(true);
    expect(dupEnvelope.item.id).toBe(item.id);

    const occRenderer: SpaceOccurrenceRenderer = "canvas";
    const occRes = await call("POST", `/api/spaces/${space.id}/occurrences`, {
      item_id: item.id,
      renderer: occRenderer,
      x: 10,
      y: 20,
    });
    expect(occRes.status).toBe(201);
    const occurrence: SpaceOccurrence = (occRes.body as SpaceOccurrenceResponse).occurrence;
    expect(occurrence.x).toBe(10);
    expect(occurrence.renderer).toBe("canvas");

    // Batch write: update the existing occurrence and create a new one.
    const batchRes = await call("POST", `/api/spaces/${space.id}/occurrences/batch`, {
      occurrences: [
        { id: occurrence.id, x: 100, y: 200 },
        { item_id: item.id, renderer: "board" },
      ],
    });
    const batch = batchRes.body as BatchSpaceOccurrenceResponse;
    expect(batch.created).toBe(1);
    expect(batch.updated).toBe(1);
    expect(batch.occurrences).toHaveLength(2);
    const _batchOcc: SpaceOccurrence = batch.occurrences[0];
    expect(_batchOcc.space_id).toBe(space.id);

    const edgeRes = await call("POST", `/api/spaces/${space.id}/edges`, {
      source: batch.occurrences[0].id,
      target: batch.occurrences[1].id,
      label: "link",
    });
    expect(edgeRes.status).toBe(201);
    const edge: SpaceEdge = (edgeRes.body as SpaceEdgeResponse).edge;
    expect(edge.label).toBe("link");

    // Unified resolver envelope.
    const resolveRes = await call("GET", "/api/refs/resolve?ref=does-not-exist");
    const resolution = (resolveRes.body as ResolveRefResponse).resolution;
    expect(typeof resolution.ref).toBe("string");
    expect(typeof resolution.resolved).toBe("boolean");
    expect("kind" in resolution).toBe(true);
  });

  it("seed response satisfies SeedSpaceResult", async () => {
    const created = await call("POST", "/api/spaces", { project_id: PROJECT_ID, title: "Seeded" });
    const space: Space = (created.body as SpaceResponse).space;
    const seedRes = await call("POST", `/api/spaces/${space.id}/seed`, {
      predicate: { type: "all" },
      with_shelf_occurrences: false,
    });
    expect(seedRes.status).toBe(200);
    const result = seedRes.body as SeedSpaceResult;
    expect(Array.isArray(result.matched_issue_ids)).toBe(true);
    expect(Array.isArray(result.items)).toBe(true);
    expect(Array.isArray(result.occurrences)).toBe(true);
    expect(typeof result.items_created).toBe("number");
    expect(typeof result.items_existing).toBe("number");
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });
});
