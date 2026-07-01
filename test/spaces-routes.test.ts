import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb, type Db } from "../src/db.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerSpacesRoutes } from "../src/routes/spaces.js";
import { Router } from "../src/server.js";
import { SPACE_EVENT_VALUES, SPACE_EVENTS, isSpaceEvent } from "../src/spaces/events.js";
import { isAllowedFileRpcRoute } from "../src/file-rpc-transport.js";

// Issue f108bba (umbrella de56ffa): Spaces REST API — CRUD, batch occurrences,
// backend-evaluated seed, unified ref resolver, and the frozen space:* event enum.

let db: Db;
let router: Router;

const PROJECT_ID = "prj-spaces-test";
const OTHER_PROJECT_ID = "prj-spaces-other";

function seedProject(id: string, name: string): void {
  db.prepare(
    `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, `github.com/test/${id}`, Date.now(), Date.now());
}

function createIssue(projectId: string, title: string, opts: { labels?: string[] } = {}): string {
  const store = new LedgerStore(db);
  const issue = store.createIssue({
    project_id: projectId,
    title,
    body: "",
    kind: "feature",
    priority: "normal",
    actor_type: "agent",
    author_display: "Codex",
  });
  for (const label of opts.labels ?? []) {
    store.setLabel(issue.id, label, true);
  }
  return issue.id;
}

function insertArtifact(_id: string, hash: string): string {
  const id = `artifact:sha256:${hash}`;
  db.prepare(
    `INSERT INTO artifacts (id, algorithm, content_hash, uri, created_at)
     VALUES (?, 'sha256', ?, ?, ?)`,
  ).run(id, hash, id, Date.now());
  db.prepare(
    `INSERT INTO artifact_blob (id, algorithm, content_hash, storage_uri, custody_mode, availability, created_at)
     VALUES (?, 'sha256', ?, ?, 'managed', 'present', ?)`,
  ).run(`artifact-blob:${hash}`, hash, id, Date.now());
  return id;
}

function linkArtifactToIssue(artifactId: string, issueId: string): void {
  db.prepare(
    `INSERT INTO artifact_links (id, artifact_id, entity_type, entity_id, link_type, source, created_at, updated_at)
     VALUES (?, ?, 'issue', ?, 'references', 'test', ?, ?)`,
  ).run(`link-${artifactId}-${issueId}`, artifactId, issueId, Date.now(), Date.now());
}

async function call(method: string, url: string, body?: unknown) {
  return router.invoke({ method, url, body });
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  setDb(db);
  router = new Router();
  registerSpacesRoutes(router);
  seedProject(PROJECT_ID, "Spaces Test");
  seedProject(OTHER_PROJECT_ID, "Other Project");
});

afterEach(() => {
  db.close();
});

async function makeSpace(title = "My Space"): Promise<string> {
  const res = await call("POST", "/api/spaces", { project_id: PROJECT_ID, title });
  expect(res.status).toBe(201);
  return (res.body as { space: { id: string } }).space.id;
}

describe("spaces CRUD", () => {
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
    const comment = new LedgerStore(db).addComment(foreignIssue, { body: "hi", source: "mandible" });
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

    const artId = insertArtifact("art-1", "aaaa1111");
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
    const artId = insertArtifact("art-2", "bbbb2222");
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
    const comment = new LedgerStore(db).addComment(issueId, { body: "c", source: "mandible" });
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
    expect(isAllowedFileRpcRoute("GET", "/api/spaces")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/spaces")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/spaces/abc")).toBe(true);
    expect(isAllowedFileRpcRoute("PATCH", "/api/spaces/abc")).toBe(true);
    expect(isAllowedFileRpcRoute("DELETE", "/api/spaces/abc")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/spaces/abc/items")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/spaces/abc/occurrences/batch")).toBe(true);
    expect(isAllowedFileRpcRoute("DELETE", "/api/spaces/abc/edges/e1")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/spaces/abc/seed")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/spaces/resolve")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/refs/resolve")).toBe(true);
  });

  it("denies unrelated/unknown methods on spaces routes", () => {
    expect(isAllowedFileRpcRoute("PUT", "/api/spaces/abc")).toBe(false);
    expect(isAllowedFileRpcRoute("GET", "/api/spaces/abc/items")).toBe(false);
  });
});
