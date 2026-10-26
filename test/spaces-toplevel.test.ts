// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { createSpace, getSpace } from "../src/ledger/spaces.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerSpacesRoutes } from "../src/routes/spaces.js";
import { Router } from "../src/server.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

// Issue 812df41 (umbrella de56ffa): top-level / global Spaces + grouped-list API +
// cross-project item resolution. The v86 migration rebuilds `spaces` with a
// NULLABLE project_id (a top-level Space has no owning project).

let tempDir = "";
const SYSTEM_ACTOR = { attribution: systemAction() };

function now(): number {
  return Date.now();
}

function seedProject(db: Db, id: string, name = `Project ${id}`): string {
  db.prepare(
    `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, `github.com/test/${id}`, now(), now());
  return id;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(testRuntimeRoot, "spaces-toplevel-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("spaces v86 nullable project_id schema (issue 812df41)", () => {
  it("accepts a top-level Space (project_id NULL) and still RESTRICTs a project with Spaces", () => {
    const db = migratedMemoryDb();
    try {
      const projectId = seedProject(db, "proj-1");
      // Top-level Space: project_id NULL.
      const top = createSpace(db, { title: "Global" });
      expect(top.project_id).toBeNull();
      // Project-scoped Space still works.
      db.prepare("INSERT INTO spaces (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("scoped", projectId, "Scoped", now(), now());
      const scoped = getSpace(db, "scoped")!;
      expect(scoped.project_id).toBe(projectId);
      // RESTRICT still guards a project that owns a Space.
      expect(() => db.prepare("DELETE FROM ledger_projects WHERE id = ?").run(projectId)).toThrow();
      db.prepare("DELETE FROM spaces WHERE id = ?").run(scoped.id);
      expect(() =>
        db.prepare("DELETE FROM ledger_projects WHERE id = ?").run(projectId),
      ).not.toThrow();
      // A surviving top-level Space is unaffected by project deletion.
      expect(getSpace(db, top.id)?.project_id).toBeNull();
    } finally {
      db.close();
    }
  });

});

describe("cross-project item resolution on a top-level Space (issue 812df41)", () => {
  let db: Db;
  let router: Router;

  async function call(method: string, url: string, body?: unknown) {
    return router.invoke({ method, url, body });
  }

  beforeEach(() => {
    db = migratedMemoryDb();
    setDb(db);
    router = new Router();
    registerSpacesRoutes(router);
  });

  afterEach(() => {
    db.close();
  });

  it("adds a cross-project issue to a top-level Space and a cross-project artifact to a project-B Space; both resolve", async () => {
    seedProject(db, "proj-a", "Alpha");
    seedProject(db, "proj-b", "Beta");
    const store = new LedgerStore(db);
    const issueA = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: "proj-a",
      title: "Issue in A",
      body: "",
      kind: "feature",
      priority: "normal",
      actor_type: "agent",
      author_display: "Codex",
    });
    // A canonical artifact version (project-agnostic custody) discovered in
    // project A's context.
    const artifact = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "spaces-toplevel-test",
      logical_name: "cross-project.md",
      content: "cross-project artifact\n",
      media_type: "text/markdown",
    }, now());
    const artifactRef = artifact.version.id;

    // Top-level Space: NO owning project, so an issue ref from ANY project is accepted.
    const topRes = await call("POST", "/api/spaces", { title: "Global" });
    expect(topRes.status).toBe(201);
    const topId = (topRes.body as { space: { id: string } }).space.id;
    const addTopIssue = await call("POST", `/api/spaces/${topId}/items`, {
      ref_type: "issue",
      ref_id: issueA.id,
    });
    expect(addTopIssue.status).toBe(201);

    // Space owned by project B: a cross-project artifact crosses freely too.
    const bRes = await call("POST", "/api/spaces", { project_id: "proj-b", title: "B Space" });
    const bId = (bRes.body as { space: { id: string } }).space.id;
    const addBArtifact = await call("POST", `/api/spaces/${bId}/items`, {
      ref_type: "artifact",
      ref_id: artifactRef,
    });
    expect(addBArtifact.status).toBe(201);

    // Both refs resolve through the unified resolver to their real entities.
    const resolvedIssue = await call(
      "GET",
      `/api/spaces/resolve?ref=${encodeURIComponent(`issue:${issueA.id}`)}`,
    );
    expect(resolvedIssue.status).toBe(200);
    const issueResolution = (resolvedIssue.body as { resolution: { resolved: boolean; kind: string; entity: { id: string } | null } }).resolution;
    expect(issueResolution.resolved).toBe(true);
    expect(issueResolution.kind).toBe("issue");
    expect(issueResolution.entity?.id).toBe(issueA.id);

    const resolvedArtifact = await call(
      "GET",
      `/api/spaces/resolve?ref=${encodeURIComponent(artifactRef)}`,
    );
    expect(resolvedArtifact.status).toBe(200);
    const artifactResolution = (resolvedArtifact.body as { resolution: { resolved: boolean; entity: { content_hash: string } | null } }).resolution;
    expect(artifactResolution.resolved).toBe(true);
    expect(artifactResolution.entity?.content_hash).toBe(artifact.artifact.content_hash);
  });

  it("lists top-level Spaces via ?scope=top-level and grouped via no query", async () => {
    seedProject(db, "proj-a", "Alpha");
    await call("POST", "/api/spaces", { title: "Global" });
    await call("POST", "/api/spaces", { project_id: "proj-a", title: "Scoped" });

    const top = await call("GET", "/api/spaces?scope=top-level");
    expect(top.status).toBe(200);
    const topSpaces = (top.body as { spaces: Array<{ project_id: string | null }> }).spaces;
    expect(topSpaces).toHaveLength(1);
    expect(topSpaces[0].project_id).toBeNull();

    const grouped = await call("GET", "/api/spaces");
    expect(grouped.status).toBe(200);
    const body = grouped.body as {
      groups: Array<{ project_id: string | null }>;
      spaces: Array<{ project_id: string | null }>;
    };
    expect(body.groups[0].project_id).toBeNull();
    expect(body.spaces).toHaveLength(2);
  });
});
