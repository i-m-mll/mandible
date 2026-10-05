import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, setDb, type Db } from "../../src/db.js";
import { addProject } from "../../src/ledger/project-registry.js";
import { registerIssueRoutes } from "../../src/routes/issues.js";
import { Router } from "../../src/server.js";
import { setupOperator } from "../../src/users/store.js";
import { authenticatedTestRouter } from "../helpers/authenticated-router.js";

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
  const operator = setupOperator(db, { display_name: "Issue route precedence operator" });
  setDb(db);
  addProject(db, { project_key: "mandible", display_name: "Mandible" });
  router = authenticatedTestRouter(operator);
  registerIssueRoutes(router, fakeScanner);
});

afterEach(() => {
  db.close();
});

describe("issue POST route precedence", () => {
  it("routes resolutions to its static handler while preserving repo-scoped creation", async () => {
    const created = await router.invoke({
      method: "POST",
      url: "/api/issues/mandible",
      body: {
        title: "Ordinary issue",
        body: "Created through the repo-scoped route",
        project: "mandible",
      },
    });

    expect(created.status).toBe(200);
    const createdIssue = created.body as { id: string; title: string };
    expect(createdIssue.title).toBe("Ordinary issue");

    const commitSha = "abc123def456";
    const resolved = await router.invoke({
      method: "POST",
      url: "/api/issues/resolutions",
      body: {
        issue_id: createdIssue.id,
        commit_sha: commitSha,
        repo_id: "mandible",
      },
    });

    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ ok: true, ledger_issue_id: createdIssue.id });
    expect(
      db.prepare(
        "SELECT issue_id, commit_sha, repo_id FROM issue_resolutions WHERE issue_id = ?",
      ).get(createdIssue.id),
    ).toEqual({
      issue_id: createdIssue.id,
      commit_sha: commitSha,
      repo_id: "mandible",
    });
  });
});
