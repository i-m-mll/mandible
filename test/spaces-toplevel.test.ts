import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { buildMetadataBackupSql, METADATA_BACKUP_TABLES } from "../src/ledger/backup.js";
import {
  createSpace,
  getSpace,
  listSpaces,
  listSpacesGrouped,
  listTopLevelSpaces,
  listAllSpaces,
  addSpaceItem,
} from "../src/ledger/spaces.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerSpacesRoutes } from "../src/routes/spaces.js";
import { Router } from "../src/server.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-spaces-toplevel-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("spaces v86 nullable project_id schema (issue 812df41)", () => {
  it("declares project_id NULLABLE at the head migration version", () => {
    const db = openDb(path.join(tempDir, "head.db"));
    try {
      const columns = db.prepare("PRAGMA table_info(spaces)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const projectId = columns.find((c) => c.name === "project_id");
      expect(projectId, "spaces.project_id column should exist").toBeTruthy();
      expect(projectId!.notnull, "spaces.project_id must be nullable").toBe(0);
    } finally {
      db.close();
    }
  });

  it("accepts a top-level Space (project_id NULL) and still RESTRICTs a project with Spaces", () => {
    const db = openDb(path.join(tempDir, "toplevel.db"));
    try {
      const projectId = seedProject(db, "proj-1");
      // Top-level Space: project_id NULL.
      const top = createSpace(db, { title: "Global" });
      expect(top.project_id).toBeNull();
      // Project-scoped Space still works.
      const scoped = createSpace(db, { project_id: projectId, title: "Scoped" });
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

  it("keeps `spaces` in METADATA_BACKUP_TABLES and round-trips a top-level row", () => {
    const dbPath = path.join(tempDir, "backup.db");
    const db = openDb(dbPath);
    try {
      expect(METADATA_BACKUP_TABLES).toContain("spaces");
      seedProject(db, "proj-1");
      createSpace(db, { project_id: "proj-1", title: "Scoped" });
      createSpace(db, { title: "Global" }); // top-level, project_id NULL
      const sql = buildMetadataBackupSql(db);
      expect(sql).toContain("-- Table: spaces");

      // Restore into a fresh DB using ONLY the backup SQL.
      const restored = new SqliteDatabase(path.join(tempDir, "restored.db"));
      restored.pragma("foreign_keys = ON");
      restored.exec(sql);
      const rows = restored
        .prepare("SELECT project_id FROM spaces ORDER BY title")
        .all() as Array<{ project_id: string | null }>;
      expect(rows).toEqual([{ project_id: null }, { project_id: "proj-1" }]);
      // The restored schema still permits a NULL project_id (nullability survived).
      expect(() =>
        restored
          .prepare(
            `INSERT INTO spaces (id, project_id, title, metadata_json, created_at, updated_at)
             VALUES ('s-new', NULL, 'Another Global', '{}', ?, ?)`,
          )
          .run(now(), now()),
      ).not.toThrow();
      restored.close();
    } finally {
      db.close();
    }
  });
});

describe("spaces grouped + top-level listing (issue 812df41)", () => {
  it("partitions Spaces into a top-level group first, then project groups by name", () => {
    const db = openDb(path.join(tempDir, "grouped.db"));
    try {
      seedProject(db, "proj-b", "Beta");
      seedProject(db, "proj-a", "Alpha");
      const top1 = createSpace(db, { title: "Top One" });
      const top2 = createSpace(db, { title: "Top Two" });
      const a1 = createSpace(db, { project_id: "proj-a", title: "Alpha Space" });
      const b1 = createSpace(db, { project_id: "proj-b", title: "Beta Space" });

      const groups = listSpacesGrouped(db);
      // Top-level group first.
      expect(groups[0]).toMatchObject({ project_id: null, project_name: null });
      expect(groups[0].spaces.map((s) => s.id).sort()).toEqual([top1.id, top2.id].sort());
      // Project groups ordered by display name: Alpha before Beta.
      expect(groups[1]).toMatchObject({ project_id: "proj-a", project_name: "Alpha" });
      expect(groups[1].spaces.map((s) => s.id)).toEqual([a1.id]);
      expect(groups[2]).toMatchObject({ project_id: "proj-b", project_name: "Beta" });
      expect(groups[2].spaces.map((s) => s.id)).toEqual([b1.id]);

      // listTopLevelSpaces returns only the NULL-project Spaces.
      expect(listTopLevelSpaces(db).map((s) => s.id).sort()).toEqual([top1.id, top2.id].sort());
      // listSpaces(project) excludes top-level.
      expect(listSpaces(db, "proj-a").map((s) => s.id)).toEqual([a1.id]);
      // listAllSpaces returns everything.
      expect(listAllSpaces(db)).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  it("excludes projects with zero spaces from grouped output (issue 6fdd924)", () => {
    // Empty project headers were causing duplicate/empty headings in the sidebar.
    // listSpacesGrouped now suppresses projects that own zero Spaces.
    const db = openDb(path.join(tempDir, "empty-group.db"));
    try {
      seedProject(db, "proj-a", "Alpha");
      seedProject(db, "proj-empty", "Empty");
      createSpace(db, { project_id: "proj-a", title: "Only Space" });
      const groups = listSpacesGrouped(db);
      // Only the project that actually has a space appears.
      expect(groups.map((g) => g.project_id)).toEqual(["proj-a"]);
      expect(groups.find((g) => g.project_id === "proj-empty")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("returns an empty array when no spaces exist (no empty project groups)", () => {
    // Previously returned empty groups for every project; now returns nothing when
    // there are no spaces to display (issue 6fdd924).
    const db = openDb(path.join(tempDir, "all-empty.db"));
    try {
      seedProject(db, "proj-b", "Beta");
      seedProject(db, "proj-a", "Alpha");
      const groups = listSpacesGrouped(db);
      // No spaces → no groups (empty projects are suppressed).
      expect(groups).toHaveLength(0);
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
    db = openDb(path.join(tempDir, "cross.db"));
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

    // Space owned by project B: a cross-project ARTIFACT crosses freely (item-level
    // cross-project capability). Issue/comment refs stay project-scoped (covered by
    // the sibling routes test); artifacts are the cross-project item type here.
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

  it("accepts a cross-project issue ref on a PROJECT-SCOPED Space (cross-project membership is universal)", async () => {
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
    const bRes = await call("POST", "/api/spaces", { project_id: "proj-b", title: "B Space" });
    const bId = (bRes.body as { space: { id: string } }).space.id;
    // Cross-project membership is universal: project_id only governs sidebar placement.
    // A project-B-scoped Space accepts issue refs from project A.
    const add = await call("POST", `/api/spaces/${bId}/items`, {
      ref_type: "issue",
      ref_id: issueA.id,
    });
    expect(add.status).toBe(201);
    expect((add.body as { created: boolean }).created).toBe(true);
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
