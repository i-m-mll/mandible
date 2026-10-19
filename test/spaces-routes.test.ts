import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { createUser } from "../src/users/store.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { addOrUpdateCheckout } from "../src/ledger/project-registry.js";
import { parseAuthoredReferences } from "../src/ledger/authored-references.js";
import type { ResolveRefResponse } from "../src/contracts.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerSpacesRoutes } from "../src/routes/spaces.js";
import { Router } from "../src/server.js";
import { SPACE_EVENT_VALUES, SPACE_EVENTS, isSpaceEvent } from "../src/spaces/events.js";

// Issue f108bba (umbrella de56ffa): Spaces REST API — CRUD, batch occurrences,
// backend-evaluated seed, unified ref resolver, and the frozen space:* event enum.

let db: Db;
let router: Router;
let approvalRouter: Router | null = null;
let approvalToken = "";
let approvalSecrets = "";
const SYSTEM_ACTOR = { attribution: systemAction() };

const PROJECT_ID = "prj_00spaces_test_unique";
const OTHER_PROJECT_ID = "prj_00spaces_other_unique";

function seedProject(id: string, name: string, projectKey = ""): void {
  db.prepare(
    `INSERT INTO ledger_projects (id, project_key, display_name, remote_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectKey, name, `github.com/test/${id}`, Date.now(), Date.now());
}

function createIssue(projectId: string, title: string, opts: { labels?: string[] } = {}): string {
  const store = new LedgerStore(db);
  const issue = store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: projectId,
    title,
    body: "",
    kind: "feature",
    priority: "normal",
    actor_type: "agent",
    author_display: "Codex",
  });
  for (const label of opts.labels ?? []) {
    store.setLabel(issue.id, label, true, "mandible", SYSTEM_ACTOR);
  }
  return issue.id;
}

function insertArtifact(_id: string, hash: string): string {
  db.prepare(
    `INSERT INTO artifact_blob (id, algorithm, content_hash, storage_uri, created_at)
     VALUES (?, 'sha256', ?, ?, ?)`,
  ).run(`artifact-blob:${hash}`, hash, `artifact:sha256:${hash}`, Date.now());
  return `artifact:sha256:${hash}`;
}

function linkArtifactToIssue(artifactId: string, issueId: string): void {
  const blobId = artifactId.replace(/^artifact:sha256:/, "artifact-blob:");
  db.prepare(
    `INSERT INTO artifact_links (
       id, blob_id, entity_type, entity_id, link_type, source,
       target_type, target_id, created_at, updated_at
     ) VALUES (
       ?, ?, 'issue', ?, 'references', 'test', 'artifact_blob', ?, ?, ?
     )`,
  ).run(
    `link-${artifactId}-${issueId}`,
    blobId,
    issueId,
    blobId,
    Date.now(),
    Date.now(),
  );
}

async function call(method: string, url: string, body?: unknown) {
  return router.invoke({ method, url, body });
}

async function checkedResolve(url: string): Promise<ResolveRefResponse> {
  if (!approvalRouter) {
    approvalSecrets = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-ref-test-"));
    const authenticator = new ClientAuthenticator(db, { secretsDir: approvalSecrets });
    const reader = createUser(db, { slug: "approval-reader", kind: "agent", display_name: "Approval Reader" });
    approvalToken = authenticator.mintApiToken(reader.id).token;
    approvalRouter = new Router({ clientAuth: authenticator });
    registerSpacesRoutes(approvalRouter);
  }
  const response = await approvalRouter.invoke({ method: "GET", url, credential: approvalToken, transport: "http" });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as ResolveRefResponse;
}

function allowsFileRpcRoute(method: string, url: string): boolean {
  return router.resolveFileRpcPolicy(method, url);
}

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  router = new Router();
  registerSpacesRoutes(router);
  seedProject(PROJECT_ID, "Spaces Test", "spaces-test");
  seedProject(OTHER_PROJECT_ID, "Other Project");
});

afterEach(() => {
  approvalRouter = null;
  if (approvalSecrets) fs.rmSync(approvalSecrets, { recursive: true, force: true });
  approvalSecrets = "";
  db.close();
});

async function makeSpace(title = "My Space"): Promise<string> {
  const res = await call("POST", "/api/spaces", { project_id: PROJECT_ID, title });
  expect(res.status).toBe(201);
  return (res.body as { space: { id: string } }).space.id;
}

describe("spaces CRUD", () => {
  it("resolves full and unique-short Space refs and rejects zero or many matches honestly", async () => {
    const first = "7038d21f-b494-47fb-b9b8-d5fb93b3309a";
    const second = "7038d21f-aaaa-47fb-b9b8-d5fb93b3309a";
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO spaces (id, project_id, title, default_renderer, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'canvas', '{}', ?, ?)`,
    );
    insert.run(first, PROJECT_ID, "First", now, now);

    expect((await call("GET", `/api/spaces/${first}`)).status).toBe(200);
    expect((await call("GET", "/api/spaces/7038d21f")).status).toBe(200);
    expect((await call("PATCH", "/api/spaces/7038d21f", { title: "Short patched" })).body)
      .toMatchObject({ space: { id: first, title: "Short patched" } });
    expect((await call("GET", "/api/spaces/ffffffff")).status).toBe(404);

    insert.run(second, PROJECT_ID, "Second", now, now);
    const ambiguous = await call("GET", "/api/spaces/7038d21f");
    expect(ambiguous.status).toBe(409);
    expect((ambiguous.body as { error: string }).error).toMatch(/ambiguous/i);
  });

  it("filters by canonical project key or full id and rejects unknown or ambiguous keyless prefixes", async () => {
    await makeSpace("Key parity");
    expect((await call("GET", `/api/spaces?project_id=${PROJECT_ID}`)).body).toMatchObject({ spaces: [{ title: "Key parity" }] });
    expect((await call("GET", "/api/spaces?project_id=spaces-test")).body).toMatchObject({ spaces: [{ title: "Key parity" }] });

    seedProject("prj_00keyless_alpha", "Keyless Alpha");
    expect((await call("GET", "/api/spaces?project_id=prj_00keyless_a")).status).toBe(200);
    expect((await call("GET", "/api/spaces?project_id=prj_00missing")).status).toBe(404);

    seedProject("prj_00keyless_alpine", "Keyless Alpine");
    const ambiguous = await call("GET", "/api/spaces?project_id=prj_00keyless_al");
    expect(ambiguous.status).toBe(409);
    expect((ambiguous.body as { error: string }).error).toMatch(/ambiguous/i);
  });

  it("creates, reads, lists, updates, and deletes a space", async () => {
    const created = await call("POST", "/api/spaces", {
      project_id: PROJECT_ID,
      title: "Intro",
      default_renderer: "document",
      description: "hello",
      metadata: { pinned: true },
    });
    expect(created.status).toBe(201);
    const space = (created.body as { space: Record<string, unknown> }).space;
    expect(space).toMatchObject({
      project_id: PROJECT_ID,
      title: "Intro",
      default_renderer: "document",
      description: "hello",
      metadata: { pinned: true },
    });
    const id = space.id as string;

    const got = await call("GET", `/api/spaces/${id}`);
    expect(got.status).toBe(200);

    const list = await call("GET", `/api/spaces?project_id=${PROJECT_ID}`);
    expect(list.status).toBe(200);
    expect((list.body as { spaces: unknown[] }).spaces).toHaveLength(1);

    const patched = await call("PATCH", `/api/spaces/${id}`, { title: "Renamed" });
    expect(patched.status).toBe(200);
    expect((patched.body as { space: { title: string } }).space.title).toBe("Renamed");

    const deleted = await call("DELETE", `/api/spaces/${id}`);
    expect(deleted.status).toBe(200);
    expect((await call("GET", `/api/spaces/${id}`)).status).toBe(404);
  });

  it("lists grouped without project_id, allows top-level create, rejects unknown project, bad renderer, and missing space", async () => {
    // Issue 812df41: GET without project_id now returns the grouped list (200),
    // and POST without project_id now creates a top-level / global Space (201).
    expect((await call("GET", "/api/spaces")).status).toBe(200);
    expect((await call("POST", "/api/spaces", { title: "x" })).status).toBe(201);
    expect((await call("POST", "/api/spaces", { project_id: "nope", title: "x" })).status).toBe(400);
    expect(
      (await call("POST", "/api/spaces", { project_id: PROJECT_ID, title: "x", default_renderer: "bogus" })).status,
    ).toBe(400);
    expect((await call("GET", "/api/spaces/does-not-exist")).status).toBe(404);
    expect((await call("PATCH", "/api/spaces/does-not-exist", { title: "y" })).status).toBe(404);
    expect((await call("DELETE", "/api/spaces/does-not-exist")).status).toBe(404);
  });

  it("rejects non-object metadata", async () => {
    const res = await call("POST", "/api/spaces", { project_id: PROJECT_ID, title: "x", metadata: [1, 2] });
    expect(res.status).toBe(400);
  });
});

describe("space items + project scoping + idempotency", () => {
  it("adds an issue item belonging to the space project", async () => {
    const spaceId = await makeSpace();
    const issueId = createIssue(PROJECT_ID, "In project");
    const res = await call("POST", `/api/spaces/${spaceId}/items`, { ref_type: "issue", ref_id: issueId });
    expect(res.status).toBe(201);
    expect((res.body as { created: boolean }).created).toBe(true);
  });

  it("is idempotent on repeated adds (already present, no hard failure)", async () => {
    const spaceId = await makeSpace();
    const issueId = createIssue(PROJECT_ID, "Repeat");
    const first = await call("POST", `/api/spaces/${spaceId}/items`, { ref_type: "issue", ref_id: issueId });
    expect(first.status).toBe(201);
    const second = await call("POST", `/api/spaces/${spaceId}/items`, { ref_type: "issue", ref_id: issueId });
    expect(second.status).toBe(200);
    expect((second.body as { created: boolean; already_present: boolean })).toMatchObject({
      created: false,
      already_present: true,
    });
    const items = db.prepare("SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?").get(spaceId) as { n: number };
    expect(items.n).toBe(1);
  });

  it("accepts a cross-project issue ref into a project-scoped space (universal membership, 812df41)", async () => {
    // makeSpace() is owned by PROJECT_ID; the issue belongs to OTHER_PROJECT_ID.
    // Cross-project membership is item-level and universal, so the add succeeds
    // and the item persists. project_id only governs sidebar placement.
    const spaceId = await makeSpace();
    const foreignIssue = createIssue(OTHER_PROJECT_ID, "Foreign");
    const added = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "issue",
      ref_id: foreignIssue,
    });
    expect(added.status).toBe(201);
    expect((added.body as { created: boolean }).created).toBe(true);
    const persisted = db
      .prepare("SELECT COUNT(*) AS n FROM space_items WHERE space_id = ? AND ref_type = 'issue' AND ref_id = ?")
      .get(spaceId, foreignIssue) as { n: number };
    expect(persisted.n).toBe(1);

    // A missing issue ref still 400s (existence check is preserved).
    const missing = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "issue",
      ref_id: "issue-does-not-exist",
    });
    expect(missing.status).toBe(400);
    expect((missing.body as { error: string }).error).toMatch(/not found/);

    // artifact refs may also cross project boundaries (stated policy)
    const ok = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "artifact",
      ref_id: "artifact:sha256:deadbeef",
    });
    expect(ok.status).toBe(201);
  });

  it("accepts a cross-project comment ref into a project-scoped space (universal membership, 812df41)", async () => {
    const spaceId = await makeSpace();
    const foreignIssue = createIssue(OTHER_PROJECT_ID, "Foreign with comment");
    const comment = new LedgerStore(db).addComment(
      foreignIssue,
      { body: "hi", source: "mandible", ...SYSTEM_ACTOR },
    );
    const added = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "comment",
      ref_id: comment.id,
    });
    expect(added.status).toBe(201);
    expect((added.body as { created: boolean }).created).toBe(true);
    const persisted = db
      .prepare("SELECT COUNT(*) AS n FROM space_items WHERE space_id = ? AND ref_type = 'comment' AND ref_id = ?")
      .get(spaceId, comment.id) as { n: number };
    expect(persisted.n).toBe(1);

    // A missing comment ref still 400s (existence check is preserved).
    const missing = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "comment",
      ref_id: "comment-does-not-exist",
    });
    expect(missing.status).toBe(400);
    expect((missing.body as { error: string }).error).toMatch(/not found/);
  });

  it("links real typed Spaces as items, including explicit cross-project targets", async () => {
    const canvasId = await makeSpace("Canvas");
    const sameProjectDoc = await makeSpace("Doc");
    const otherSpace = await call("POST", "/api/spaces", {
      project_id: OTHER_PROJECT_ID,
      title: "Other Board",
      default_renderer: "board",
    });
    expect(otherSpace.status).toBe(201);
    const otherSpaceId = (otherSpace.body as { space: { id: string } }).space.id;

    const sameProject = await call("POST", `/api/spaces/${canvasId}/items`, {
      ref_type: "space",
      ref_id: sameProjectDoc,
      title: "Doc node",
    });
    expect(sameProject.status).toBe(201);
    expect((sameProject.body as { item: { ref_type: string; ref_id: string } }).item).toMatchObject({
      ref_type: "space",
      ref_id: sameProjectDoc,
    });

    const crossProject = await call("POST", `/api/spaces/${canvasId}/items`, {
      ref_type: "space",
      ref_id: otherSpaceId,
    });
    expect(crossProject.status).toBe(201);
    expect((crossProject.body as { item: { ref_type: string; ref_id: string } }).item).toMatchObject({
      ref_type: "space",
      ref_id: otherSpaceId,
    });

    const dup = await call("POST", `/api/spaces/${canvasId}/items`, {
      ref_type: "space",
      ref_id: otherSpaceId,
    });
    expect(dup.status).toBe(200);
    expect((dup.body as { created: boolean; already_present: boolean })).toMatchObject({
      created: false,
      already_present: true,
    });
  });

  it("rejects missing Space refs and self-links", async () => {
    const canvasId = await makeSpace("Canvas");
    const missing = await call("POST", `/api/spaces/${canvasId}/items`, {
      ref_type: "space",
      ref_id: "space-does-not-exist",
    });
    expect(missing.status).toBe(400);
    expect((missing.body as { error: string }).error).toMatch(/space ref not found/);

    const self = await call("POST", `/api/spaces/${canvasId}/items`, {
      ref_type: "space",
      ref_id: canvasId,
    });
    expect(self.status).toBe(400);
    expect((self.body as { error: string }).error).toMatch(/cannot link to its containing space/);
  });

  it("requires external_ref items to carry a ref_uri (schema CHECK)", async () => {
    const spaceId = await makeSpace();
    const res = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "external_ref",
      ref_id: "ext-1",
    });
    expect(res.status).toBe(400);
    const ok = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "external_ref",
      ref_id: "ext-1",
      ref_uri: "https://example.com",
    });
    expect(ok.status).toBe(201);
  });

  it("patches and deletes items; 404 for unknown item", async () => {
    const spaceId = await makeSpace();
    const issueId = createIssue(PROJECT_ID, "Editable");
    const add = await call("POST", `/api/spaces/${spaceId}/items`, { ref_type: "issue", ref_id: issueId });
    const itemId = (add.body as { item: { id: string } }).item.id;

    const patched = await call("PATCH", `/api/spaces/${spaceId}/items/${itemId}`, { title: "Pinned title" });
    expect(patched.status).toBe(200);
    expect((patched.body as { item: { title: string } }).item.title).toBe("Pinned title");

    expect((await call("PATCH", `/api/spaces/${spaceId}/items/nope`, { title: "x" })).status).toBe(404);
    expect((await call("DELETE", `/api/spaces/${spaceId}/items/${itemId}`)).status).toBe(200);
    expect((await call("DELETE", `/api/spaces/${spaceId}/items/${itemId}`)).status).toBe(404);
  });

  it("rejects a malformed ref_type and missing ref_id", async () => {
    const spaceId = await makeSpace();
    expect((await call("POST", `/api/spaces/${spaceId}/items`, { ref_type: "bogus", ref_id: "x" })).status).toBe(400);
    expect((await call("POST", `/api/spaces/${spaceId}/items`, { ref_type: "issue" })).status).toBe(400);
  });
});

describe("occurrences + batch", () => {
  it("creates, updates, and deletes occurrences", async () => {
    const spaceId = await makeSpace();
    const created = await call("POST", `/api/spaces/${spaceId}/occurrences`, { x: 1, y: 2, renderer: "canvas" });
    expect(created.status).toBe(201);
    const occ = (created.body as { occurrence: { id: string } }).occurrence;

    const patched = await call("PATCH", `/api/spaces/${spaceId}/occurrences/${occ.id}`, { x: 10, y: 20 });
    expect(patched.status).toBe(200);
    expect((patched.body as { occurrence: { x: number; y: number } }).occurrence).toMatchObject({ x: 10, y: 20 });

    expect((await call("DELETE", `/api/spaces/${spaceId}/occurrences/${occ.id}`)).status).toBe(200);
    expect((await call("DELETE", `/api/spaces/${spaceId}/occurrences/${occ.id}`)).status).toBe(404);
  });

  it("writes N positions in one batch (create + update)", async () => {
    const spaceId = await makeSpace();
    const seedOcc = await call("POST", `/api/spaces/${spaceId}/occurrences`, { x: 0, y: 0 });
    const existingId = (seedOcc.body as { occurrence: { id: string } }).occurrence.id;

    const batch = await call("POST", `/api/spaces/${spaceId}/occurrences/batch`, {
      occurrences: [
        { id: existingId, x: 100, y: 100 },
        { x: 5, y: 5 },
        { x: 6, y: 6 },
      ],
    });
    expect(batch.status).toBe(200);
    expect(batch.body).toMatchObject({ created: 2, updated: 1 });
    const total = db.prepare("SELECT COUNT(*) AS n FROM space_occurrences WHERE space_id = ?").get(spaceId) as {
      n: number;
    };
    expect(total.n).toBe(3);
    const moved = db.prepare("SELECT x, y FROM space_occurrences WHERE id = ?").get(existingId) as {
      x: number;
      y: number;
    };
    expect(moved).toMatchObject({ x: 100, y: 100 });
  });

  it("rejects a non-array batch payload and an occurrence referencing a missing item", async () => {
    const spaceId = await makeSpace();
    expect((await call("POST", `/api/spaces/${spaceId}/occurrences/batch`, { occurrences: "no" })).status).toBe(400);
    expect(
      (await call("POST", `/api/spaces/${spaceId}/occurrences`, { item_id: "ghost" })).status,
    ).toBe(400);
  });
});

describe("edges", () => {
  it("creates an edge between two occurrences and rejects dangling endpoints", async () => {
    const spaceId = await makeSpace();
    const a = (await call("POST", `/api/spaces/${spaceId}/occurrences`, { x: 0, y: 0 })).body as {
      occurrence: { id: string };
    };
    const b = (await call("POST", `/api/spaces/${spaceId}/occurrences`, { x: 1, y: 1 })).body as {
      occurrence: { id: string };
    };

    const edge = await call("POST", `/api/spaces/${spaceId}/edges`, {
      source: a.occurrence.id,
      target: b.occurrence.id,
      label: "supports",
    });
    expect(edge.status).toBe(201);
    const edgeId = (edge.body as { edge: { id: string } }).edge.id;

    const patched = await call("PATCH", `/api/spaces/${spaceId}/edges/${edgeId}`, { label: "refutes" });
    expect(patched.status).toBe(200);
    expect((patched.body as { edge: { label: string } }).edge.label).toBe("refutes");

    const dangling = await call("POST", `/api/spaces/${spaceId}/edges`, {
      source: a.occurrence.id,
      target: "ghost",
    });
    expect(dangling.status).toBe(400);

    expect((await call("DELETE", `/api/spaces/${spaceId}/edges/${edgeId}`)).status).toBe(200);
    expect((await call("DELETE", `/api/spaces/${spaceId}/edges/${edgeId}`)).status).toBe(404);
  });
});

describe("seed-from-filter", () => {
  it("seeds matching issues + their artifacts deterministically and idempotently", async () => {
    const spaceId = await makeSpace();
    const matchA = createIssue(PROJECT_ID, "Alpha", { labels: ["seed-me"] });
    const matchB = createIssue(PROJECT_ID, "Bravo", { labels: ["seed-me"] });
    createIssue(PROJECT_ID, "Charlie"); // no label → excluded
    createIssue(OTHER_PROJECT_ID, "Delta", { labels: ["seed-me"] }); // other project → excluded

    const artId = insertArtifact("art-1", "aaaa1111".repeat(8));
    linkArtifactToIssue(artId, matchA);

    const seed = await call("POST", `/api/spaces/${spaceId}/seed`, {
      predicate: { type: "label", name: "seed-me" },
      with_shelf_occurrences: true,
    });
    expect(seed.status).toBe(200);
    const body = seed.body as {
      matched_issue_ids: string[];
      items_created: number;
      items_existing: number;
      occurrences: unknown[];
    };
    expect(body.matched_issue_ids.sort()).toEqual([matchA, matchB].sort());
    // 2 issue items + 1 artifact item
    expect(body.items_created).toBe(3);
    expect(body.occurrences).toHaveLength(3);

    // Re-running the same seed is idempotent: nothing new is created.
    const reseed = await call("POST", `/api/spaces/${spaceId}/seed`, {
      predicate: { type: "label", name: "seed-me" },
    });
    expect(reseed.status).toBe(200);
    expect((reseed.body as { items_created: number; items_existing: number })).toMatchObject({
      items_created: 0,
      items_existing: 3,
    });
    const totalItems = db.prepare("SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?").get(spaceId) as {
      n: number;
    };
    expect(totalItems.n).toBe(3);
  });

  it("accepts the `scope` alias and can skip artifacts", async () => {
    const spaceId = await makeSpace();
    const match = createIssue(PROJECT_ID, "Echo", { labels: ["x"] });
    const artId = insertArtifact("art-2", "bbbb2222".repeat(8));
    linkArtifactToIssue(artId, match);

    const seed = await call("POST", `/api/spaces/${spaceId}/seed`, {
      scope: { type: "label", name: "x" },
      include_artifacts: false,
    });
    expect(seed.status).toBe(200);
    expect((seed.body as { items_created: number }).items_created).toBe(1);
  });

  it("requires a predicate object and reports a missing space", async () => {
    const spaceId = await makeSpace();
    expect((await call("POST", `/api/spaces/${spaceId}/seed`, {})).status).toBe(400);
    expect((await call("POST", `/api/spaces/${spaceId}/seed`, { predicate: [1] })).status).toBe(400);
    expect((await call("POST", "/api/spaces/ghost/seed", { predicate: { type: "label", name: "x" } })).status).toBe(404);
  });
});

describe("unified ref resolver", () => {
  it("resolves issue, comment, artifact, mandible, and repo refs to typed results", async () => {
    const issueId = createIssue(PROJECT_ID, "Resolvable");
    const comment = new LedgerStore(db).addComment(
      issueId,
      { body: "c", source: "mandible", ...SYSTEM_ACTOR },
    );
    const artifactHash = "be22e0e199e2253c034e9eff70a5c37ba19a483f3e3f3d3270c596d1c1b60cf4";
    insertArtifact("art-3", artifactHash);

    const issueRes = await call("GET", `/api/spaces/resolve?ref=issue:${issueId}`);
    expect(issueRes.status).toBe(200);
    expect((issueRes.body as { resolution: { kind: string; resolved: boolean } }).resolution).toMatchObject({
      kind: "issue",
      resolved: true,
    });

    const commentRes = await call("GET", `/api/spaces/resolve?ref=comment:${comment.id}`);
    expect((commentRes.body as { resolution: { kind: string; resolved: boolean } }).resolution).toMatchObject({
      kind: "comment",
      resolved: true,
    });

    type Resolution = { resolution: { kind: string; resolved: boolean; entity: { id?: string } | null } };
    const resolve = async (ref: string) =>
      ((await call("GET", `/api/spaces/resolve?ref=${encodeURIComponent(ref)}`)).body as Resolution).resolution;
    expect(await resolve(`issue:${issueId}#${comment.ordinal}`)).toMatchObject({
      kind: "comment",
      resolved: true,
      entity: { id: comment.id },
    });
    expect(await resolve(`comment:${issueId}#${comment.ordinal}`)).toMatchObject({
      kind: "comment",
      resolved: true,
      entity: { id: comment.id },
    });
    expect(await resolve(`issue:${issueId}#0`)).toMatchObject({ kind: "issue", resolved: true, entity: { id: issueId } });
    expect(await resolve(`issue:${issueId}#99`)).toMatchObject({ kind: "comment", resolved: false });

    const artifactRes = await call("GET", `/api/spaces/resolve?ref=artifact-blob:${artifactHash}`);
    expect((artifactRes.body as { resolution: { kind: string; resolved: boolean } }).resolution).toMatchObject({
      kind: "artifact",
      resolved: true,
    });

    const legacyArtifactRes = await call("GET", `/api/spaces/resolve?ref=artifact:sha256:${artifactHash}`);
    expect((legacyArtifactRes.body as { resolution: { kind: string; resolved: boolean; detail?: { resolution?: { status?: string } } } }).resolution).toMatchObject({
      kind: "artifact",
      resolved: false,
    });

    const mandibleRes = await call(
      "GET",
      `/api/refs/resolve?ref=${encodeURIComponent(`mandible:///issues?issue=${issueId}`)}`,
    );
    expect((mandibleRes.body as { resolution: { kind: string; resolved: boolean } }).resolution).toMatchObject({
      kind: "issue",
      resolved: true,
    });

    const repoRes = await call("GET", `/api/spaces/resolve?ref=${encodeURIComponent("repo://mandible/missing.txt")}`);
    const repoResolution = (repoRes.body as { resolution: { kind: string; detail?: unknown } }).resolution;
    expect(repoResolution.kind).toBe("repo");
    expect(repoResolution.detail).toBeTruthy();
  });

  it("resolves exact and unique approval prefixes without writing issue links or closure actions", async () => {
    const ids = ["2257522a-39a2-467b-b3f8-491aea66754c", "2257522a-49a2-467b-b3f8-491aea66754c"];
    const insert = db.prepare(`INSERT INTO auth_requests (id, command, title, repo, created_at, updated_at, expires_at)
      VALUES (?, 'true', 'Merge feature/x', 'spaces-test', 1, 1, 9999999999999)`);
    ids.forEach(id => insert.run(id));
    const resolve = async (ref: string) => (await checkedResolve(`/api/refs/resolve?ref=${encodeURIComponent(ref)}`)).resolution;
    expect(await resolve(`auth:${ids[0]}`)).toMatchObject({ kind: "auth", resolved: true, entity: { id: "2257522a-3", title: "Merge feature/x" } });
    expect(await resolve("auth:2257522a-4")).toMatchObject({ resolved: true, entity: { id: "2257522a-4" } });
    expect(await resolve("auth:2257522a")).toMatchObject({ kind: "auth", resolved: false, error: "ambiguous", entity: null });
    expect(await resolve("auth:ffffffff")).toMatchObject({ kind: "auth", resolved: false, error: "not_found", entity: null });
    expect(await resolve(`mandible:///auth?request=${ids[0]}`)).toMatchObject({ kind: "auth", resolved: true, entity: { id: "2257522a-3" } });
    expect(await resolve(`mandible:///auth?request=${ids[0]}&issue=missing`)).toMatchObject({ kind: "auth", resolved: true });
    const refs = parseAuthoredReferences("See [auth:2257522a-3], not [auth:spaces-test/2257522a-4], `[auth:2257522a-4]`, or \n```\n[auth:2257522a-4]\n```\n[link](https://example.test/[auth:2257522a-4]).");
    expect(refs.map(ref => [ref.kind, ref.target])).toEqual([["auth", "2257522a-3"]]);
    const store = new LedgerStore(db);
    const issue = store.createIssue({ ...SYSTEM_ACTOR, project_id: PROJECT_ID, title: "Approval mention", body: `[auth:${ids[0]}]`, kind: "feature" });
    store.addComment(issue.id, { ...SYSTEM_ACTOR, body: `[auth:${ids[1]}]` });
    for (const table of ["ledger_issue_relationships", "ledger_relationship_edges", "ledger_auth_issue_links", "auth_request_actions"]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.prepare("SELECT status FROM auth_requests ORDER BY id").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
  });

  it("refuses approval metadata when its project is absent, ambiguous, or conflicting", async () => {
    const id = "2257522a-39a2-467b-b3f8-491aea66754c";
    db.prepare(`INSERT INTO auth_requests (id, command, title, created_at, updated_at, expires_at)
      VALUES (?, 'true', 'Hidden metadata', 1, 1, 9999999999999)`).run(id);
    const resolve = async () => (await checkedResolve(`/api/spaces/resolve?ref=auth:${id}`)).resolution;
    expect(await resolve()).toMatchObject({ resolved: false, entity: null, error: "project_unresolved" });
    db.prepare("UPDATE auth_requests SET repo = 'unknown-project'").run();
    expect(await resolve()).toMatchObject({ resolved: false, entity: null, error: "project_unresolved" });
    db.prepare("UPDATE ledger_projects SET display_name = 'Shared'").run();
    db.prepare("UPDATE auth_requests SET repo = 'Shared'").run();
    expect(await resolve()).toMatchObject({ resolved: false, entity: null, error: "project_unresolved" });
    db.prepare("UPDATE auth_requests SET repo = ?, target_repo_root = ?").run(PROJECT_ID, OTHER_PROJECT_ID);
    expect(await resolve()).toMatchObject({ resolved: false, entity: null, error: "project_unresolved" });
    addOrUpdateCheckout(db, PROJECT_ID, { root: "/fixture/approval-checkout", name: "Approval checkout", default_branch: "main" });
    db.prepare("UPDATE auth_requests SET repo = NULL, target_repo_root = ?").run("/fixture/approval-checkout");
    expect(await resolve()).toMatchObject({ resolved: true, entity: { id: "2257522a" } });
  });

  it("returns an unresolved result for unknown refs and 400 for a missing ref param", async () => {
    const res = await call("GET", "/api/spaces/resolve?ref=issue:zzz999");
    expect(res.status).toBe(200);
    expect((res.body as { resolution: { resolved: boolean } }).resolution.resolved).toBe(false);
    expect((await call("GET", "/api/spaces/resolve")).status).toBe(400);
  });
});

describe("event enum (frozen contract)", () => {
  it("exposes the frozen space:* names and the extension guard", () => {
    expect(SPACE_EVENTS.SPACE_CREATED).toBe("space:created");
    expect(SPACE_EVENTS.SPACE_OCCURRENCE_MOVED).toBe("space:occurrence:moved");
    expect(SPACE_EVENTS.SPACE_SEEDED).toBe("space:seeded");
    expect(SPACE_EVENT_VALUES.every((value) => value.startsWith("space:"))).toBe(true);
    expect(isSpaceEvent("space:created")).toBe(true);
    expect(isSpaceEvent("space:not-real")).toBe(false);
  });
});

describe("file-rpc allowlist (self-allowlisted routes)", () => {
  it("allows the spaces read/write routes including batch and resolver", () => {
    expect(allowsFileRpcRoute("GET", "/api/spaces")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/spaces")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/spaces/abc")).toBe(true);
    expect(allowsFileRpcRoute("PATCH", "/api/spaces/abc")).toBe(true);
    expect(allowsFileRpcRoute("DELETE", "/api/spaces/abc")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/spaces/abc/items")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/spaces/abc/occurrences/batch")).toBe(true);
    expect(allowsFileRpcRoute("DELETE", "/api/spaces/abc/edges/e1")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/spaces/abc/seed")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/spaces/resolve")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/refs/resolve")).toBe(true);
  });

  it("denies unrelated/unknown methods on spaces routes", () => {
    expect(allowsFileRpcRoute("PUT", "/api/spaces/abc")).toBe(false);
    expect(allowsFileRpcRoute("GET", "/api/spaces/abc/items")).toBe(false);
  });
});
