/**
 * Issue 9395f25 — a merge request accounts for every issue it lands. Each test
 * names the wrong behaviour it catches.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { setDb, type Db } from "../src/db.js";
import { LedgerOpenChildrenError, LedgerStore } from "../src/ledger/store.js";
import { registerWorkUnitRoutes } from "../src/routes/work-units.js";
import type { AuthRequestInput } from "../src/types.js";
import { getOperator, setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import {
  AUTH_MERGE_REVIEW, approveFixtureRequest, awaitFixtureResolution, commitOnBranch, createAuthCheckRepo,
  createLedgerProject, createMigratedDb, git, publishFixtureExecution, registerWorkRepo, waitForStatus,
} from "./helpers/auth-queue-fixtures.js";
import { createLedgerIssue, SYSTEM_ACTOR } from "./helpers/ledger-fixtures.js";

let db: Db;
let repo: string;
let projectId: string;
let store: LedgerStore;
let queue: AuthQueue;

beforeEach(() => {
  db = createMigratedDb();
  repo = fs.realpathSync(createAuthCheckRepo());
  projectId = createLedgerProject(db, repo).project.id;
  registerWorkRepo(db, repo);
  store = new LedgerStore(db);
  queue = new AuthQueue({ db, executor: async (options) => publishFixtureExecution(queue, options) });
});

afterEach(async () => {
  await queue.dispose();
  db.close();
});

function issue(title: string, workerStatus: "none" | "blocked" | "done" = "none") {
  const created = createLedgerIssue(db, { project_id: projectId, title, kind: "feature" });
  return workerStatus === "none" ? created : store.setWorkerStatus(created.id, workerStatus, SYSTEM_ACTOR);
}

function parent(of: { id: string }, child: { id: string }) {
  store.linkRelationshipEdges({
    actor: SYSTEM_ACTOR, provenance: "manual", link_type: "parent_child",
    source_entity: { entity_type: "issue", entity_id: of.id },
    target_entities: [{ entity_type: "issue", entity_id: child.id }],
  });
}

function unit(id: string, of: { id: string }, branch: string, state = "committed") {
  db.prepare(`INSERT INTO work_units (id, issue_id, ledger_issue_id, repo_id, branch, kind, state, created_at)
    VALUES (?, ?, ?, ?, ?, 'solo', ?, 1)`).run(id, of.id, of.id, path.basename(repo), branch, state);
}

function submit(head: string, patch: Partial<AuthRequestInput> = {}) {
  return queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", title: `Merge ${head}`,
    command: `mandible auth merge ${head} --into main`, repo: path.basename(repo), cwd: repo, target_repo_root: repo,
    base_branch: "main", head_branch: head, merge_head_sha: git(repo, ["rev-parse", head]), execution_mode: "daemon",
    ...patch });
}

const keepOpen = (target: { short_id: string }, remainder: string) =>
  ({ kind: "issue_keep_open" as const, target_issue_ref: target.short_id, payload: { remainder } });

describe("landed issue accounting", () => {
  it("refuses a request that lands an undecided issue, printing the flags that decide it", async () => {
    const undecided = issue("Partly delivered", "blocked");
    commitOnBranch(repo, "feature/partial", { "partial.txt": "partial\n" });
    unit("wu-partial", undecided, "feature/partial");

    await expect(submit("feature/partial")).rejects.toThrow(
      `--closes-issue ${undecided.short_id}   or   --keeps-open ${undecided.short_id}=<what remains>`);
    const kept = await submit("feature/partial", { actions: [keepOpen(undecided, "Needs a production measurement")] });
    expect(kept.issue_accounting).toMatchObject({
      closing: [], held: [], kept_open: [{ issue_id: undecided.id, remainder: "Needs a production measurement" }],
    });
  });

  it("refuses --closes-issue on an issue an open child holds, and records the hold instead", async () => {
    const umbrella = issue("Umbrella", "done");
    const remaining = issue("Remaining lane");
    parent(umbrella, remaining);
    commitOnBranch(repo, "integration/umbrella", { "umbrella.txt": "umbrella\n" });
    unit("wu-umbrella", umbrella, "integration/umbrella");
    const keep = keepOpen(remaining, "Waits for the operator's migration");

    await expect(submit("integration/umbrella", { issue_closures: [umbrella.short_id], actions: [keep] }))
      .rejects.toThrow(`--closes-issue ${umbrella.short_id} refused: ${umbrella.short_id} stays open after this merge, held by open children ${remaining.short_id}`);
    const request = await submit("integration/umbrella", { actions: [keep] });
    expect(request.issue_accounting!.held).toEqual([expect.objectContaining({
      issue_id: umbrella.id, open_children: [remaining.short_id], unmerged_units: [],
    })]);
    expect(request.issue_closures).toEqual([]);
  });

  it("closes the done children of a closing parent first, and the merge applies exactly the stored decisions", async () => {
    const umbrella = issue("Umbrella", "done");
    const child = issue("Finished lane", "done");
    const fixedLater = issue("Symptom", "done");
    const kept = issue("Follow-up", "blocked");
    parent(umbrella, child);
    store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR, provenance: "manual", link_type: "fixed_by",
      source_entity: { entity_type: "issue", entity_id: fixedLater.id },
      target_entities: [{ entity_type: "issue", entity_id: umbrella.id }],
    });
    commitOnBranch(repo, "integration/delivery", { "delivery.txt": "delivery\n" });
    unit("wu-delivery", umbrella, "integration/delivery");
    unit("wu-follow-up", kept, "integration/delivery");

    const request = await submit("integration/delivery", { actions: [keepOpen(kept, "Second half after [issue:" + child.short_id + "]")] });
    const closing = request.issue_accounting!.closing.map((entry) => entry.issue_id);
    expect(new Set(closing)).toEqual(new Set([umbrella.id, child.id, fixedLater.id]));
    expect(closing.indexOf(child.id)).toBeLessThan(closing.indexOf(umbrella.id));

    await awaitFixtureResolution(queue, request.id, async () => {
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");
    });
    await queue.drainFinalizers();
    for (const closed of [umbrella, child, fixedLater]) expect(store.getIssue(closed.id).status).toBe("closed");
    expect(store.getIssue(kept.id)).toMatchObject({ status: "open", remainder: `Second half after [issue:${child.short_id}]` });
    expect(db.prepare(`SELECT source_issue_id FROM ledger_issue_relationship_sources
      WHERE source_entity_type = 'issue_remainder' AND target_issue_id = ? AND deleted_at IS NULL`).all(child.id))
      .toEqual([{ source_issue_id: kept.id }]);
    const mergeSha = git(repo, ["rev-parse", "main"]);
    expect(db.prepare("SELECT landed_commit FROM work_units WHERE id = 'wu-delivery'").get()).toEqual({ landed_commit: mergeSha });
  });

  it("finds an issue whose unit wt merge resolved into the integration branch after that branch is gone", async () => {
    setDb(db);
    if (!getOperator(db)) setupOperator(db, { slug: "landed-operator" });
    const router = authenticatedTestRouter(getOperator(db)!);
    registerWorkUnitRoutes(router, {} as never);
    const lane = issue("Lane merged by wt merge", "done");
    commitOnBranch(repo, "feature/lane", { "lane.txt": "lane\n" });
    const claim = await router.invoke({ method: "POST", url: "/api/work-units/claim",
      body: { issue_id: lane.id, repo_id: path.basename(repo), branch: "feature/lane" } });
    expect(claim.status).toBe(201);
    const unitId = (claim.body as { id: string }).id;
    git(repo, ["checkout", "-b", "integration/lanes", "main"]);
    git(repo, ["merge", "--no-ff", "--no-edit", "feature/lane"]);
    git(repo, ["checkout", "main"]);
    const tip = git(repo, ["rev-parse", "feature/lane"]);
    const generation = (db.prepare("SELECT custody_generation FROM work_units WHERE id = ?").get(unitId) as { custody_generation: number }).custody_generation;
    const resolved = await router.invoke({ method: "PATCH", url: `/api/work-units/${unitId}`,
      body: { expected_generation: generation, state: "resolved" } });
    expect(resolved.status).toBe(200);
    git(repo, ["branch", "-D", "feature/lane"]);

    expect(db.prepare("SELECT landed_commit FROM work_units WHERE id = ?").get(unitId)).toEqual({ landed_commit: tip });
    const request = await submit("integration/lanes");
    expect(request.issue_accounting!.closing).toEqual([expect.objectContaining({ issue_id: lane.id, by: "done" })]);
  });

  it("refuses to close an issue while it has an open child", () => {
    const umbrella = issue("Umbrella", "done");
    const child = issue("Open lane");
    parent(umbrella, child);
    expect(() => store.setIssueStatus(umbrella.id, "closed", "delivered", SYSTEM_ACTOR)).toThrow(LedgerOpenChildrenError);
    expect(store.getIssue(umbrella.id).status).toBe("open");
    store.setIssueStatus(child.id, "closed", "delivered", SYSTEM_ACTOR);
    expect(store.setIssueStatus(umbrella.id, "closed", "delivered", SYSTEM_ACTOR).status).toBe("closed");
  });
});
