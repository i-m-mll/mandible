import { execFileSync } from "node:child_process";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { addProject } from "../src/ledger/project-registry.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import type { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { createLedgerIssue } from "./helpers/ledger-fixtures.js";

const fakeScanner = { getRepos: () => [], getRepoById: () => undefined, getBranches: () => [] } as never;

/** The short id the CLI prints for a full id. */
function printed(id: string): string {
  return execFileSync("jq", ["-L", "cli", "-r", 'include "mandible-identity"; mandible_short_id'], {
    input: JSON.stringify(id),
  }).toString().trim();
}

let db: Db;
let router: Router;
let store: LedgerStore;
let issueId: string;

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  const project = addProject(db, { project_key: "refs", display_name: "Refs" });
  issueId = createLedgerIssue(db, { project_id: project.id, alias: "ref1234" }).id;
  store = new LedgerStore(db);
  router = authenticatedTestRouter(setupOperator(db, { display_name: "Operator" }));
  registerIssueRoutes(router, fakeScanner);
});

afterEach(() => {
  db.close();
});

describe("printed short ids", () => {
  it("resolve a comment on every comment route", async () => {
    const comment = store.addComment(issueId, { body: "first", attribution: systemAction() });
    const short = printed(comment.id);
    expect(short.length).toBeLessThan(comment.id.length);

    const shown = await router.invoke({ method: "GET", url: `/api/ledger/comments/${short}/revisions` });
    expect(shown.status).toBe(200);
    expect((shown.body as { revisions: Array<{ entity_id: string }> }).revisions[0].entity_id).toBe(comment.id);

    const edited = await router.invoke({ method: "PATCH", url: `/api/ledger/comments/${short}`, body: { body: "second" } });
    expect(edited.status).toBe(200);
    expect(store.getComment(comment.id).body).toBe("second");

    const last = await router.invoke({ method: "GET", url: `/api/ledger/comments/${encodeURIComponent("ref1234#last")}/revisions` });
    expect((last.body as { revisions: Array<{ entity_id: string }> }).revisions[0].entity_id).toBe(comment.id);
  });

  it("are refused when they name several entities", async () => {
    const shared = "d6de794f";
    for (const suffix of ["a", "b"]) {
      store.addComment(issueId, { id: `${shared}${suffix.repeat(56)}`, body: suffix, attribution: systemAction() });
    }
    const refused = await router.invoke({ method: "PATCH", url: `/api/ledger/comments/${shared}`, body: { body: "x" } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "ambiguous_ref", field: "params.commentId" });

    // Ledger ids print their creation time, so checkpoints made in one millisecond print alike.
    const checkpoint = (createdAt: number) => store.addIssueCheckpoint(issueId, {
      kind: "parent-role", payload: {}, attribution: systemAction(), created_at: createdAt,
    }).id;
    const lone = checkpoint(1);
    const twins = [checkpoint(2), checkpoint(2)];
    expect(printed(twins[0])).toBe(printed(twins[1]));
    const found = await router.invoke({ method: "GET", url: `/api/ledger/issues/ref1234/checkpoints?id=${printed(lone)}` });
    expect(found.body).toMatchObject({ id: lone });
    const ambiguous = await router.invoke({ method: "GET", url: `/api/ledger/issues/ref1234/checkpoints?id=${printed(twins[0])}` });
    expect(ambiguous.status).toBe(409);
  });
});
