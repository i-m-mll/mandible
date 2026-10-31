import { afterEach, beforeEach, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { Router } from "../src/server.js";
import { registerWorkUnitRoutes } from "../src/routes/work-units.js";
import { AuthQueue } from "../src/auth-queue.js";
import { getOperator } from "../src/users/store.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { createMigratedDb, createLedgerProject, createLedgerIssue, AUTH_COMMAND_REVIEW } from "./helpers/auth-queue-fixtures.js";

let db: Db;
let router: Router;
let user: ReturnType<typeof getOperator> & {};
let repo: string;
let issue: string;
beforeEach(() => {
  db = createMigratedDb(); setDb(db); user = getOperator(db)!;
  const project = createLedgerProject(db, process.cwd()); repo = project.project.id;
  issue = createLedgerIssue(db, repo, "transfer").id;
  db.prepare("INSERT INTO sessions (id, app, status, conversation_id, owner_user_id) VALUES ('old','codex','active','old',?),('new','codex','active','new',?),('next','codex','active','next',?)").run(user.id, user.id, user.id);
  router = new Router({ clientAuth: { authenticate: () => ({ user_id: user.id, slug: user.slug,
    method: "local_socket", source: "local_socket", credential_id: null, effect_ceiling: PRODUCTION_EFFECTS }),
    mode: () => "strict", recordUnattributedWrite: () => undefined } });
  registerWorkUnitRoutes(router, {} as never);
});
afterEach(() => db.close());
const call = (session: string, method: string, url: string, body: unknown) => router.invoke({ method, url, body,
  ambient_identity: { provider: "codex", provider_session_id: session } });

it("explicitly transfers live responsibility, fences stale actors, and hands off without abandoning or stopping execution", async () => {
  const claimed = await call("old", "POST", "/api/work-units/claim", { issue_id: issue, repo_id: repo, branch: "feature/transfer", assigned_session_id: "old" });
  expect(claimed.status).toBe(201);
  const id = (claimed.body as { id: string }).id;
  const execution = db.prepare("SELECT provider, provider_session_id, assigned_session_id, assignment_target_json FROM work_units WHERE id = ?").get(id);
  expect((await call("new", "POST", "/api/work-units/activate", { issue_id: issue, repo_id: repo, branch: "feature/transfer" })).status).toBe(409);
  const assume = (session: string, generation: number, target?: string) => call(session, "POST", `/api/work-units/${id}/custody/assume`, {
    expected_generation: generation, reason: "Continue implementation", ...(target ? { target_session_id: target } : {}) });
  expect((await assume("new", 1)).status).toBe(200);
  expect(db.prepare("SELECT provider, provider_session_id, assigned_session_id, assignment_target_json FROM work_units WHERE id = ?").get(id)).toEqual(execution);
  expect((await call("old", "PATCH", `/api/work-units/${id}`, { expected_generation: 1, state: "committed" })).status).toBe(409);
  expect((await call("old", "PATCH", `/api/work-units/${id}`, { expected_generation: 2, state: "committed" })).status).toBe(403);
  expect((await assume("old", 1)).status).toBe(409);
  expect((await assume("new", 2, "next")).status).toBe(200);
  expect((await call("next", "POST", "/api/work-units/release", { id, expected_generation: 3, reason: "Ready for successor" })).status).toBe(200);
  expect(db.prepare("SELECT owner_user_id, responsibility_session_id, custody_generation, state FROM work_units WHERE id = ?").get(id))
    .toEqual({ owner_user_id: null, responsibility_session_id: null, custody_generation: 4, state: "open" });
  expect((await call("new", "POST", "/api/work-units/claim", { issue_id: issue, repo_id: repo, branch: "feature/transfer" })).status).toBe(409);
  expect((await assume("new", 4)).status).toBe(200);
  expect(db.prepare("SELECT count(*) AS count FROM responsibility_events WHERE entity_kind = 'work_unit' AND entity_id = ?").get(id)).toEqual({ count: 4 });
});

it("lets the successor withdraw an unbound approval request while preserving authorship, review revisions and approval state", async () => {
  const queue = new AuthQueue({ db });
  const request = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "command", command: "printf reviewed", title: "Reviewed command", repo,
    session_id: "old", requester_evidence_method: "session_claim" }, user.id);
  const actor = (session: string) => ({ user_id: user.id, session_id: session, evidence_method: "session_claim" });
  queue.assumeRequestResponsibility(request.id, actor("new"), "Continue review", 1, 0);
  expect(() => queue.assumeRequestResponsibility(request.id, actor("old"), "Stale takeover", 1, 0)).toThrow();
  await expect(queue.withdraw(request.id, "Stale author", actor("old"), 1, 1)).rejects.toMatchObject({ code: "custody_required" });
  await expect(queue.withdraw(request.id, "Stale review", actor("new"), 0, 1)).rejects.toMatchObject({ code: "lifecycle_conflict" });
  expect(await queue.getRequest(request.id)).toMatchObject({ status: "pending", session_id: "old", requested_by_user_id: user.id, approved_by_user_id: null, execution_evidence_id: null });
  await queue.withdraw(request.id, "Replacement planned", actor("new"), 1, 1);
  expect(await queue.getRequest(request.id)).toMatchObject({ status: "withdrawn", session_id: "old", requested_by_user_id: user.id, approved_by_user_id: null });
  expect(queue.listLifecycleEvents(request.id).map(event => event.event_type)).toEqual(["submitted", "withdrawn"]);
});
