import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

// Issue 2d4f9b8: a project may have at most one open maintenance issue. The
// server refuses every transition that would add a second one and names the
// existing issue; ordinary edits of existing duplicates keep working.

let db: Db;
let router: Router;

const fakeScanner = {
  getRepos: () => [],
  getRepoById: () => undefined,
  getBranches: () => [],
} as never;

beforeEach(() => {
  db = migratedMemoryDb();
  const operator = setupOperator(db, { display_name: "Singleton kind test operator" });
  setDb(db);
  router = authenticatedTestRouter(operator);
  registerIssueRoutes(router as never, fakeScanner);
  addProject(db, { project_key: "alpha", remote_identity: "git@github.com:mll/alpha.git" });
  addProject(db, { project_key: "beta", remote_identity: "git@github.com:mll/beta.git" });
});

afterEach(() => {
  db.close();
});

async function create(title: string, kind: string, project = "alpha") {
  return router.invoke({
    method: "POST",
    url: `/api/issues/${project}`,
    body: { title, body: "Body", kind, project },
  });
}

function issueRow(title: string) {
  return db.prepare("SELECT id, short_id, kind, status FROM ledger_issues WHERE title = ?")
    .get(title) as { id: string; short_id: string; kind: string; status: string };
}

function patch(title: string, body: Record<string, unknown>) {
  return router.invoke({ method: "PATCH", url: `/api/ledger/issues/${issueRow(title).id}`, body });
}

function errorOf(res: { body: unknown }) {
  return res.body as { error: string; code: string; existing_issue_ids: string[] };
}

describe("singleton maintenance issues", () => {
  it("refuses creating a second open maintenance issue and names the existing one", async () => {
    expect((await create("Repo maintenance", "maintenance")).status).toBe(200);
    const existing = issueRow("Repo maintenance").short_id;

    const refused = await create("Another maintenance", "maintenance");
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe("singleton_kind_open");
    expect(errorOf(refused).existing_issue_ids).toEqual([existing]);
    expect(errorOf(refused).error).toContain(existing);
    expect(errorOf(refused).error).toContain("Comment on the existing maintenance issue instead");
    expect(issueRow("Another maintenance")).toBeUndefined();

    // The rule is per project.
    expect((await create("Beta maintenance", "maintenance", "beta")).status).toBe(200);
  });

  it("refuses kind changes and reopens into a second open one, and allows one after the first closes", async () => {
    await create("Repo maintenance", "maintenance");
    await create("Cleanup", "feature");

    const refused = await patch("Cleanup", { kind: "maintenance", title: "Renamed cleanup" });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).error).toContain(issueRow("Repo maintenance").short_id);
    expect(issueRow("Cleanup")).toMatchObject({ kind: "feature" });

    expect((await patch("Repo maintenance", { status: "closed", resolution: "duplicate" })).status).toBe(200);
    expect((await patch("Cleanup", { kind: "maintenance" })).status).toBe(200);

    expect((await patch("Repo maintenance", { status: "open", resolution: null })).status).toBe(409);
    const reopenComment = await router.invoke({
      method: "POST",
      url: `/api/ledger/issues/${issueRow("Repo maintenance").id}/comments`,
      body: { message: "Reopening", reopen: true },
    });
    expect(reopenComment.status).toBe(409);
    expect(issueRow("Repo maintenance")).toMatchObject({ status: "closed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_comments").get()).toEqual({ n: 0 });
  });

  it("keeps ordinary edits working when legacy duplicates are already open", async () => {
    for (const n of [1, 2, 3, 4, 5]) await create(`Legacy ${n}`, "feature");
    db.prepare("UPDATE ledger_issues SET kind = 'maintenance'").run();

    expect((await patch("Legacy 1", { title: "Legacy one", body: "Edited" })).status).toBe(200);
    const comment = await router.invoke({
      method: "POST",
      url: `/api/ledger/issues/${issueRow("Legacy 2").id}/comments`,
      body: { message: "Logged maintenance" },
    });
    expect(comment.status).toBe(200);
    expect((await patch("Legacy 3", { status: "closed", resolution: "duplicate" })).status).toBe(200);

    const refused = await create("Yet another", "maintenance");
    expect(refused.status).toBe(409);
    expect(errorOf(refused).existing_issue_ids).toHaveLength(4);
    expect(errorOf(refused).error).toContain("(and 1 more)");
  });
});
