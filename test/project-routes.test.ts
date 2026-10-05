import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { addProject } from "../src/ledger/project-registry.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerProjectRoutes } from "../src/routes/projects.js";
import { resolveLedgerIssueLinkFromDb } from "../src/routes/redirects.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";

let db: Db;
let router: Router;

const fakeScanner = {
  getRepos: () => [],
  getRepoById: () => undefined,
  getBranches: () => [],
} as never;

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  const operator = setupOperator(db, { display_name: "Route test operator" });
  setDb(db);
  router = authenticatedTestRouter(operator);
  registerProjectRoutes(router);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Project CRUD routes
// ---------------------------------------------------------------------------

describe("project routes", () => {
  it("GET /api/projects returns empty list initially", async () => {
    const res = await router.invoke({ method: "GET", url: "/api/projects" });
    expect(res.status).toBe(200);
    const body = res.body as { projects: unknown[] };
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects).toHaveLength(0);
  });

  it("GET /api/projects returns list after creating a project", async () => {
    addProject(db, { project_key: "feedbax", remote_identity: "git@github.com:mll/feedbax.git" });

    const res = await router.invoke({ method: "GET", url: "/api/projects" });
    expect(res.status).toBe(200);
    const body = res.body as { projects: Array<{ project_key: string }> };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].project_key).toBe("feedbax");
  });

  it("POST /api/projects creates a project and returns 201 with project_key", async () => {
    const res = await router.invoke({
      method: "POST",
      url: "/api/projects",
      body: {
        key: "feedbax",
        display: "Feedbax",
        remote: "git@github.com:mll/feedbax.git",
      },
    });
    expect(res.status).toBe(201);
    const body = res.body as { project: { project_key: string } };
    expect(body.project.project_key).toBe("feedbax");
  });

  it("POST /api/projects returns 400 when key is missing", async () => {
    const res = await router.invoke({
      method: "POST",
      url: "/api/projects",
      body: { display: "No Key Project" },
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("GET /api/projects/:ref returns 200 with matched_by for known project", async () => {
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
      display_name: "Feedbax",
    });

    const res = await router.invoke({ method: "GET", url: "/api/projects/feedbax" });
    expect(res.status).toBe(200);
    const body = res.body as { project: { project_key: string }; matched_by: string };
    expect(body.project.project_key).toBe("feedbax");
    expect(body.matched_by).toBe("project_key");
  });

  it("GET /api/projects/:ref returns 404 with suggestions for unknown ref", async () => {
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
    });

    const res = await router.invoke({ method: "GET", url: "/api/projects/totally-unknown" });
    expect(res.status).toBe(404);
    const body = res.body as { error: string; suggestions: unknown[] };
    expect(body.error).toBeTruthy();
    expect(Array.isArray(body.suggestions)).toBe(true);
  });

  it("GET /api/projects/:ref returns 409 when display_name is ambiguous", async () => {
    addProject(db, {
      project_key: "aa",
      remote_identity: "git@github.com:mll/aa.git",
      display_name: "AmbigName",
    });
    addProject(db, {
      project_key: "bb",
      remote_identity: "git@github.com:mll/bb.git",
      display_name: "AmbigName",
    });

    const res = await router.invoke({ method: "GET", url: "/api/projects/AmbigName" });
    expect(res.status).toBe(409);
    const body = res.body as { candidates: string[] };
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates).toContain("aa");
    expect(body.candidates).toContain("bb");
  });

  it("PATCH /api/projects/:ref updates display_name and returns 200", async () => {
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
      display_name: "Feedbax",
    });

    const res = await router.invoke({
      method: "PATCH",
      url: "/api/projects/feedbax",
      body: { display: "FB Updated" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { project: { display_name: string } };
    expect(body.project.display_name).toBe("FB Updated");
  });

  it("POST /api/projects/:ref/checkouts registers a checkout and returns 200", async () => {
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
    });

    const res = await router.invoke({
      method: "POST",
      url: "/api/projects/feedbax/checkouts",
      body: { root: "/tmp/fb", work_repo_id: "20-feedbax" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { project: { project_key: string }; checkout: { work_repo_id: string } };
    expect(body.project.project_key).toBe("feedbax");
    expect(body.checkout.work_repo_id).toBe("20-feedbax");
  });

  it("POST /api/projects/checkouts registers checkout via project param and returns 200", async () => {
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
    });

    const res = await router.invoke({
      method: "POST",
      url: "/api/projects/checkouts",
      body: { project: "feedbax", root: "/tmp/fb2" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { project: { project_key: string } };
    expect(body.project.project_key).toBe("feedbax");
  });

  it("GET /api/projects/audit returns audit object with arrays", async () => {
    const res = await router.invoke({ method: "GET", url: "/api/projects/audit" });
    expect(res.status).toBe(200);
    const body = res.body as {
      audit: {
        duplicate_display_names: unknown[];
        local_projects: unknown[];
        numbered_repo_ids: unknown[];
        missing_keys: unknown[];
      };
    };
    expect(Array.isArray(body.audit.duplicate_display_names)).toBe(true);
    expect(Array.isArray(body.audit.local_projects)).toBe(true);
    expect(Array.isArray(body.audit.numbered_repo_ids)).toBe(true);
    expect(Array.isArray(body.audit.missing_keys)).toBe(true);
  });

  it("POST /api/projects/repair dry run returns report with applied=false", async () => {
    const res = await router.invoke({
      method: "POST",
      url: "/api/projects/repair",
      body: {},
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      report: { keys_backfilled: number; audit: unknown; applied: boolean };
    };
    expect(body.report.applied).toBe(false);
    expect(typeof body.report.keys_backfilled).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Issue route project rejection (CORE)
// ---------------------------------------------------------------------------

describe("issue route project rejection", () => {
  beforeEach(() => {
    registerIssueRoutes(router as never, fakeScanner);
  });

  it("rejects unknown repo ref with error mentioning registered and a suggestions array", async () => {
    const projCountBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_projects").get() as { n: number }
    ).n;
    const checkoutCountBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_project_checkouts").get() as { n: number }
    ).n;

    const res = await router.invoke({
      method: "POST",
      url: "/api/issues/nonexistent-repo",
      body: { title: "Test", body: "Test body" },
    });

    expect(res.status).toBe(400);
    const body = res.body as { error: string; suggestions: unknown[] };
    expect(body.error).toMatch(/registered/i);
    expect(Array.isArray(body.suggestions)).toBe(true);

    // No project or checkout was auto-created
    const projCountAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_projects").get() as { n: number }
    ).n;
    const checkoutCountAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_project_checkouts").get() as { n: number }
    ).n;
    expect(projCountAfter).toBe(projCountBefore);
    expect(checkoutCountAfter).toBe(checkoutCountBefore);
  });

  it("creates issue when explicit project body param resolves to registered project", async () => {
    // Register a project via project routes
    await router.invoke({
      method: "POST",
      url: "/api/projects",
      body: {
        key: "feedbax",
        display: "Feedbax",
        remote: "git@github.com:mll/feedbax.git",
      },
    });

    // Also register a checkout (required for issue list, not strictly for creation)
    await router.invoke({
      method: "POST",
      url: "/api/projects/feedbax/checkouts",
      body: { root: "/tmp/fbx-explicit" },
    });

    const res = await router.invoke({
      method: "POST",
      url: "/api/issues/anything",
      body: { title: "My Issue", body: "Test body", project: "feedbax" },
    });

    expect(res.status).toBe(200);
    const body = res.body as { project?: { project_key?: string } };
    // The projection includes the project field
    expect(body.project?.project_key).toBe("feedbax");
  });

  it("creates issue via registered checkout root (cwd-inference path)", async () => {
    // Register project and a checkout at a known absolute root
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
    });

    // Register the checkout root
    await router.invoke({
      method: "POST",
      url: "/api/projects/feedbax/checkouts",
      body: { root: "/tmp/fbx-cwd" },
    });

    // POST with the checkout root as `root` field — no explicit project param
    const res = await router.invoke({
      method: "POST",
      url: "/api/issues/feedbax",
      body: { title: "CWD Issue", body: "Test body", root: "/tmp/fbx-cwd" },
    });

    expect(res.status).toBe(200);
    const body = res.body as { project?: { project_key?: string } };
    expect(body.project?.project_key).toBe("feedbax");
  });
});

// ---------------------------------------------------------------------------
// Canonical-key round-trip (codex review #3)
// ---------------------------------------------------------------------------

describe("canonical project_key round-trip", () => {
  function seedFeedbax() {
    const { project } = resolveProjectForCheckout(db, {
      root: "/tmp/feedbax-rt",
      name: "feedbax",
      workRepoId: "20-widgets-widgets",
      remoteUrl: "git@github.com:mll/feedbax.git",
    });
    const issue = new LedgerStore(db).createIssue({
      project_id: project.id,
      title: "Round-trip issue",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
      attribution: systemAction(),
    });
    return { project, issue };
  }

  it("GET /api/issues?repo=<project_key> returns the project's issues", async () => {
    seedFeedbax();
    registerIssueRoutes(router, fakeScanner);

    const byKey = await router.invoke({ method: "GET", url: "/api/issues?repo=feedbax" });
    expect(byKey.status).toBe(200);
    const keyBody = byKey.body as Array<{ repo_id: string; project_key?: string; issues: unknown[] }>;
    expect(keyBody.length).toBe(1);
    expect(keyBody[0].project_key).toBe("feedbax");
    expect(keyBody[0].issues.length).toBe(1);

    // Path-derived checkout ids are no longer public project filters.
    const byWorkRepo = await router.invoke({
      method: "GET",
      url: "/api/issues?repo=20-widgets-widgets",
    });
    expect(byWorkRepo.status).toBe(200);
    expect((byWorkRepo.body as unknown[]).length).toBe(0);
  });

  it("/r/issue redirect resolves the canonical project_key as repo, not work_repo_id", () => {
    const { issue } = seedFeedbax();
    const resolved = resolveLedgerIssueLinkFromDb(db, issue.short_id);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.repoId).toBe("feedbax");
  });

  it("filters lifecycle and resolution independently of free-form labels", async () => {
    const { issue } = seedFeedbax();
    const store = new LedgerStore(db);
    const actor = { actor_type: "system" as const, author_display: "System", attribution: systemAction() };
    store.setIssueStatus(issue.id, "closed", "delivered", actor);
    store.setLabel(issue.id, "merged", true, "mandible", actor);
    registerIssueRoutes(router, fakeScanner);
    const ids = (body: unknown) => (body as Array<{ issues: Array<{ id: string }> }>).flatMap(repo => repo.issues.map(item => item.id));
    const closed = await router.invoke({ method: "GET", url: "/api/issues?status=closed" });
    expect(closed.status).toBe(200);
    expect(ids(closed.body)).toContain(issue.short_id);
    const delivered = await router.invoke({ method: "GET", url: "/api/issues?resolution=delivered" });
    expect(ids(delivered.body)).toContain(issue.short_id);
    const duplicate = await router.invoke({ method: "GET", url: "/api/issues?resolution=duplicate" });
    expect(ids(duplicate.body)).toEqual([]);
    const retired = await router.invoke({ method: "GET", url: "/api/issues?status=merged" });
    expect(retired.status).toBe(400);
  });
});
