import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let db: Db;
let router: Router;

beforeEach(() => {
  db = migratedMemoryDb();
  const operator = setupOperator(db, { display_name: "Issue title test operator" });
  setDb(db);
  router = authenticatedTestRouter(operator);
  registerIssueRoutes(router as never, { getRepos: () => [], getRepoById: () => undefined, getBranches: () => [] } as never, undefined, inlineLedgerReader());
  addProject(db, { project_key: "alpha", remote_identity: "git@github.com:mll/alpha.git" });
});

afterEach(() => {
  db.close();
});

async function createIssue(title: string): Promise<string> {
  await router.invoke({ method: "POST", url: "/api/issues/alpha", body: { title, body: "Body", kind: "bug", project: "alpha" } });
  return (db.prepare("SELECT id FROM ledger_issues WHERE title = ?").get(title) as { id: string }).id;
}

function retitle(id: string, title: unknown) {
  return router.invoke({ method: "PATCH", url: `/api/ledger/issues/${id}`, body: { title } });
}

function titleHistory(id: string): string[] {
  return db.prepare(
    `SELECT COALESCE(json_extract(payload_json, '$.title'), json_extract(payload_json, '$.patch.title')) AS title
     FROM ledger_events
     WHERE entity_type = 'issue' AND entity_id = ? AND event_type IN ('issue.created', 'issue.updated')
     ORDER BY occurred_at, rowid`,
  ).all(id).map((row) => (row as { title: string }).title);
}

describe("issue retitling", () => {
  it("changes the title everywhere it is read and keeps every prior title in the event history", async () => {
    const id = await createIssue("Original");

    const response = await retitle(id, "  Renamed  ");

    expect(response.status).toBe(200);
    expect((response.body as { title: string }).title).toBe("Renamed");
    const read = await router.invoke({ method: "GET", url: `/api/ledger/issues/${id}` });
    expect((read.body as { title: string }).title).toBe("Renamed");
    const hits = db.prepare("SELECT rowid FROM issue_search WHERE issue_search MATCH 'title : Renamed'").all();
    expect(hits).toHaveLength(1);
    expect(titleHistory(id)).toEqual(["Original", "Renamed"]);
  });

  it.each([["blank", "   "], ["non-string", 7], ["null", null]])("refuses a %s title and leaves the issue unchanged", async (_label, title) => {
    const id = await createIssue("Kept");

    const response = await retitle(id, title);

    expect(response.status).toBe(400);
    expect(titleHistory(id)).toEqual(["Kept"]);
    expect((db.prepare("SELECT title FROM ledger_issues WHERE id = ?").get(id) as { title: string }).title).toBe("Kept");
  });
});
