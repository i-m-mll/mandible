/**
 * Issue 9395f25 — a merge request accounts for every issue it lands. Each test
 * names the wrong behaviour it catches.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { setDb, type Db } from "../src/db.js";
import { triageLandedOpen } from "../src/landed-issues.js";
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

function unit(id: string, of: { id: string }, branch: string, state = "committed", repoId = path.basename(repo)) {
  db.prepare(`INSERT INTO work_units (id, issue_id, ledger_issue_id, repo_id, branch, kind, state, created_at)
    VALUES (?, ?, ?, ?, ?, 'solo', ?, 1)`).run(id, of.id, of.id, repoId, branch, state);
}

async function land(requestId: string) {
  await awaitFixtureResolution(queue, requestId, async () => {
    await approveFixtureRequest(queue, requestId);
    await waitForStatus(queue, requestId, "completed");
  });
  await queue.drainFinalizers();
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

  it("closes a named child before its parent, derives the parent above and the issue it fixes, and the merge applies exactly that", async () => {
    const program = issue("Program", "done");
    const umbrella = issue("Umbrella", "done");
    const child = issue("Finished lane");
    const fixedLater = issue("Symptom");
    const kept = issue("Follow-up", "blocked");
    parent(program, umbrella);
    parent(umbrella, child);
    store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR, provenance: "manual", link_type: "fixed_by",
      source_entity: { entity_type: "issue", entity_id: fixedLater.id },
      target_entities: [{ entity_type: "issue", entity_id: umbrella.id }],
    });
    db.prepare(`INSERT INTO work_units (id, issue_id, ledger_issue_id, repo_id, branch, kind, state, created_at)
      VALUES ('wu-program', ?, ?, ?, NULL, 'solo', 'resolved', 1)`).run(program.id, program.id, path.basename(repo));
    commitOnBranch(repo, "integration/delivery", { "delivery.txt": "delivery\n" });
    unit("wu-delivery", umbrella, "integration/delivery");
    unit("wu-follow-up", kept, "integration/delivery");

    const request = await submit("integration/delivery", {
      issue_closures: [child.short_id],
      actions: [keepOpen(kept, "Second half after [issue:" + child.short_id + "]")],
    });
    const closing = request.issue_accounting!.closing.map((entry) => entry.issue_id);
    expect(new Set(closing)).toEqual(new Set([program.id, umbrella.id, child.id, fixedLater.id]));
    expect(closing.indexOf(child.id)).toBeLessThan(closing.indexOf(umbrella.id));
    expect(closing.indexOf(umbrella.id)).toBeLessThan(closing.indexOf(program.id));

    await land(request.id);
    for (const closed of [program, umbrella, child, fixedLater]) expect(store.getIssue(closed.id).status).toBe("closed");
    expect(store.getIssue(kept.id)).toMatchObject({ status: "open", remainder: `Second half after [issue:${child.short_id}]` });
    expect(db.prepare(`SELECT source_issue_id FROM ledger_issue_relationship_sources
      WHERE source_entity_type = 'issue_remainder' AND target_issue_id = ? AND deleted_at IS NULL`).all(child.id))
      .toEqual([{ source_issue_id: kept.id }]);
    const mergeSha = git(repo, ["rev-parse", "main"]);
    expect(db.prepare("SELECT landed_commit FROM work_units WHERE id = 'wu-delivery'").get()).toEqual({ landed_commit: mergeSha });
  });

  it("does not derive children: an open child nothing lands holds its parent and stays out of the set", async () => {
    const umbrella = issue("Umbrella", "done");
    const untouched = issue("Untouched lane");
    const doneElsewhere = issue("Done lane, not landed here", "done");
    parent(umbrella, untouched);
    parent(umbrella, doneElsewhere);
    commitOnBranch(repo, "integration/partial", { "partial.txt": "partial\n" });
    unit("wu-umbrella", umbrella, "integration/partial");

    const { closing, kept_open, held } = (await submit("integration/partial")).issue_accounting!;
    expect({ closing, kept_open, held: held.map((entry) => entry.issue_id) }).toEqual({ closing: [], kept_open: [], held: [umbrella.id] });
    expect(new Set(held[0]!.open_children)).toEqual(new Set([untouched.short_id, doneElsewhere.short_id]));
  });

  it("holds an issue whose other unit is in another repository, even on a branch of the same name", async () => {
    const multi = issue("Two-repository issue", "done");
    commitOnBranch(repo, "feature/multi", { "multi.txt": "multi\n" });
    unit("wu-here", multi, "feature/multi");
    unit("wu-there", multi, "feature/multi", "committed", "other-repository");

    const request = await submit("feature/multi");
    expect(request.issue_accounting).toMatchObject({
      closing: [], held: [{ issue_id: multi.id, unmerged_units: [{ id: "wu-there", branch: "feature/multi" }] }],
    });
  });

  it("holds an issue whose unit's last known commit this repository does not have, instead of failing submission", async () => {
    const issueWithGoneWork = issue("Work recorded elsewhere", "done");
    commitOnBranch(repo, "feature/here", { "here.txt": "here\n" });
    unit("wu-here", issueWithGoneWork, "feature/here");
    unit("wu-gone", issueWithGoneWork, "feature/gone");
    db.prepare("INSERT INTO branches (repo_root, branch, last_commit_hash) VALUES (?, 'feature/gone', ?)").run(repo, "ab".repeat(20));

    const request = await submit("feature/here");
    expect(request.issue_accounting).toMatchObject({
      closing: [], held: [{ issue_id: issueWithGoneWork.id, unmerged_units: [{ id: "wu-gone", branch: "feature/gone" }] }],
    });
  });

  it("accounts for an abandoned unit whose branch the head lands, as the finalizer resolves it", async () => {
    const abandoned = issue("Abandoned, then merged", "blocked");
    commitOnBranch(repo, "feature/abandoned", { "abandoned.txt": "abandoned\n" });
    unit("wu-abandoned", abandoned, "feature/abandoned", "abandoned");

    await expect(submit("feature/abandoned")).rejects.toThrow(`--closes-issue ${abandoned.short_id}`);
  });

  it("accounts for a request submitted while a queued request's branch is gone", async () => {
    commitOnBranch(repo, "feature/stale", { "stale.txt": "stale\n" });
    await submit("feature/stale");
    git(repo, ["branch", "-D", "feature/stale"]);
    const undecided = issue("Partly delivered", "blocked");
    commitOnBranch(repo, "feature/live", { "live.txt": "live\n" });
    unit("wu-live", undecided, "feature/live");

    await expect(submit("feature/live")).rejects.toThrow(`--closes-issue ${undecided.short_id}`);
  });

  it("refuses revising what an accounted request closes, so a held issue stays open through the merge", async () => {
    const held = issue("Held by other work", "done");
    commitOnBranch(repo, "feature/one", { "one.txt": "one\n" });
    commitOnBranch(repo, "feature/two", { "two.txt": "two\n" });
    unit("wu-one", held, "feature/one");
    unit("wu-two", held, "feature/two");
    const request = await submit("feature/one");
    expect(request.issue_accounting!.held).toEqual([expect.objectContaining({ issue_id: held.id })]);

    await expect(queue.update(request.id, { issue_closures: [held.short_id] })).rejects.toMatchObject({ status: 409 });
    await expect(queue.update(request.id, { issues: [held.short_id] })).rejects.toMatchObject({ status: 409 });
    await land(request.id);
    expect(store.getIssue(held.id).status).toBe("open");
  });

  it("refuses vetoing a closure of an accounted request, since its parent's closure depends on it", async () => {
    const umbrella = issue("Umbrella", "done");
    const child = issue("Lane", "done");
    parent(umbrella, child);
    commitOnBranch(repo, "feature/veto", { "veto.txt": "veto\n" });
    unit("wu-umbrella", umbrella, "feature/veto");
    unit("wu-child", child, "feature/veto");
    const request = await submit("feature/veto");
    const childClosure = queue.listActions(request.id).find((action) => action.target_issue_ref === child.short_id)!;

    expect(() => queue.setActionVeto(request.id, childClosure.id, true)).toThrow("--supersedes");
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

  it("refuses staging a closure or remainder after submission, since only resubmission accounts again", async () => {
    const undecided = issue("Partly delivered", "blocked");
    commitOnBranch(repo, "feature/frozen", { "frozen.txt": "frozen\n" });
    unit("wu-frozen", undecided, "feature/frozen");
    const request = await submit("feature/frozen", { actions: [keepOpen(undecided, "Needs a measurement")] });
    const other = issue("Unrelated");
    expect(() => queue.addAction(request.id, { kind: "issue_close", target_issue_ref: other.short_id, payload: {} }))
      .toThrow("--supersedes");
    const keep = queue.listActions(request.id).find((action) => action.kind === "issue_keep_open")!;
    expect(() => queue.deleteAction(request.id, keep.id)).toThrow("--supersedes");
  });

  it("clears a remainder when its issue closes", () => {
    const kept = issue("Kept open", "done");
    store.setIssueRemainder(kept.id, "Waits on the release", SYSTEM_ACTOR);
    store.setIssueStatus(kept.id, "closed", "delivered", SYSTEM_ACTOR);
    expect(store.getIssue(kept.id)).toMatchObject({ remainder: null, remainder_set_at: null });
  });

  it("triages landed open issues by reach and groups them by remainder and parent", async () => {
    commitOnBranch(repo, "integration/lanes", { "lanes.txt": "lanes\n" });
    const onIntegration = git(repo, ["rev-parse", "integration/lanes"]);
    const onMain = git(repo, ["rev-parse", "main"]);
    const requestId = "11111111-0000-4000-8000-000000000000";
    db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, output, created_at, updated_at, expires_at)
      VALUES (?, 'merge', 'true', 'Fixture', 'completed', '', 1, 1, 1)`).run(requestId);
    const resolved = (id: string, of: { id: string }, landed: string | null, authRequestId: string | null = null) =>
      db.prepare(`INSERT INTO work_units (id, issue_id, ledger_issue_id, repo_id, branch, kind, state, landed_commit, auth_request_id, created_at)
        VALUES (?, ?, ?, ?, NULL, 'solo', 'resolved', ?, ?, 1)`).run(id, of.id, of.id, path.basename(repo), landed, authRequestId);

    const byRequest = issue("Merged by request", "done");
    resolved("wu-request", byRequest, null, requestId);
    const onProtected = issue("Landed on main", "done");
    resolved("wu-main", onProtected, onMain);
    const inIntegration = issue("Sitting in integration");
    resolved("wu-integration", inIntegration, onIntegration);
    const legacy = issue("Resolved before landed commits", "done");
    resolved("wu-legacy", legacy, null);
    const kept = issue("Kept open", "done");
    resolved("wu-kept", kept, onMain);
    store.setIssueRemainder(kept.id, "Waits on the release", SYSTEM_ACTOR);
    const live = issue("Still worked on", "done");
    resolved("wu-live-old", live, onMain);
    unit("wu-live", live, "feature/live");
    const holder = issue("Has an open child", "done");
    resolved("wu-holder", holder, onMain);
    const closedParent = issue("Closed parent", "done");
    store.setIssueStatus(closedParent.id, "closed", "delivered", SYSTEM_ACTOR);
    const orphan = issue("Open under a closed parent");
    parent(closedParent, orphan);
    parent(holder, issue("Open child"));

    const triage = await triageLandedOpen(db, projectId);
    const reach = Object.fromEntries(triage.without_remainder.map((row) => [row.issue_id, row.reach]));
    expect(reach).toEqual({
      [byRequest.id]: "protected", [onProtected.id]: "protected", [inIntegration.id]: "unprotected", [legacy.id]: "unknown",
    });
    expect(triage.with_remainder).toEqual([expect.objectContaining({ issue_id: kept.id, remainder: "Waits on the release", reach: "protected" })]);
    expect(triage.under_closed_parent).toEqual([expect.objectContaining({
      issue_id: orphan.id, parent: { issue: closedParent.short_id, status: "closed" }, reach: null,
    })]);
  });
});
