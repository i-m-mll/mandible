import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
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
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let db: Db;
let router: Router;

const fakeScanner = {
  getRepos: () => [],
  getRepoById: () => undefined,
  getBranches: () => [],
} as never;

beforeEach(() => {
  db = migratedMemoryDb();
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

});

// ---------------------------------------------------------------------------
// Issue route project rejection (CORE)
// ---------------------------------------------------------------------------

describe("issue route project rejection", () => {
  beforeEach(() => {
    registerIssueRoutes(router as never, fakeScanner, undefined, inlineLedgerReader());
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
    registerIssueRoutes(router, fakeScanner, undefined, inlineLedgerReader());
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

describe("issue search route", () => {
  it("ranks title, body, and comment matches across projects and keeps the index current", async () => {
    const store = new LedgerStore(db);
    const author = { actor_type: "agent" as const, author_display: "Test", attribution: systemAction() };
    const project = (key: string) => addProject(db, { project_key: key, remote_identity: `git@github.com:mll/${key}.git` }).id;
    const issue = (project_id: string, title: string, body: string) =>
      store.createIssue({ project_id, title, body, ...author });
    const [alpha, beta] = [project("alpha"), project("beta")];
    const titled = issue(alpha, "Zebrafish dashboard", "layout");
    const bodied = issue(alpha, "Daemon stalls", "the loop blocks on zebrafish parsing");
    const commented = issue(beta, "Unrelated", "nothing here");
    store.addComment(commented.id, { body: "a zebrafish shows up here too", ...author });
    issue(beta, "Other", "no match");
    registerIssueRoutes(router, fakeScanner, undefined, inlineLedgerReader());
    const search = async (query: string) => {
      const res = await router.invoke({ method: "GET", url: `/api/issues/search?${query}` });
      expect(res.status).toBe(200);
      return res.body as Array<{ id: string; project: string; excerpt: string }>;
    };

    const all = await search("q=zebra");
    expect(all[0].id).toBe(titled.id);
    expect(all.map(hit => hit.id).sort()).toEqual([titled.id, bodied.id, commented.id].sort());
    expect(all.find(hit => hit.id === commented.id)).toMatchObject({ project: "beta", excerpt: expect.stringContaining("zebrafish shows up") });
    expect(all.find(hit => hit.id === bodied.id)?.excerpt).toContain("zebrafish parsing");

    expect((await search("q=zebra&repo=beta")).map(hit => hit.id)).toEqual([commented.id]);
    store.updateIssue(bodied.id, { body: "fixed" }, author);
    expect((await search("q=zebrafish+parsing")).map(hit => hit.id)).toEqual([]);
  });
});
