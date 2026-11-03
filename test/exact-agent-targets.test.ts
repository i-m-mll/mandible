import { getRetainedChild } from "../src/conversations/retention-policy.js";
import { createUser } from "../src/users/store.js";
import { SessionRegistry } from "../src/registry.js";
import { getWorkerAssignments } from "../src/work-unit-worker.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Db, setDb } from "../src/db.js";
import { Router } from "../src/server.js";
import { registerWorkUnitRoutes } from "../src/routes/work-units.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { mapWorkUnitRow } from "../src/work-unit-utils.js";
import { assignmentTargetForSession, parseAssignmentTarget } from "../src/work-unit-assignment.js";
import { resolveSessionAlias, sessionAliasIds } from "../src/session-liveness.js";
import { responsibilityActor, sameResponsibilitySession } from "../src/responsibility.js";
import { resolveProviderSessionIngestions } from "../src/provider-session-ingestion.js";
import { recordConversationParent, linkWaitingChildren } from "../src/conversation-lineage.js";
import { ConversationControlStore } from "../src/conversation-control/store.js";
import { summarizeSessionKey } from "../src/session-summary.js";
import { getOperator } from "../src/users/store.js";
import { createMigratedDb, createLedgerProject, createLedgerIssue } from "./helpers/auth-queue-fixtures.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";

let db: Db;
let router: Router;
let repo: string;
let issue: string;
beforeEach(() => {
  db = createMigratedDb(); setDb(db);
  const project = createLedgerProject(db, process.cwd()); repo = project.project.id;
  issue = createLedgerIssue(db, repo, "Exact agents").id;
  const user = getOperator(db)!;
  router = new Router({ clientAuth: { authenticate: () => ({ user_id: user.id, slug: user.slug,
    method: "local_socket", source: "local_socket", credential_id: null, effect_ceiling: PRODUCTION_EFFECTS }),
    mode: () => "strict", recordUnattributedWrite: () => undefined } });
  registerWorkUnitRoutes(router, {} as never);
});
afterEach(() => db.close());
const context = (agent: string, session = "enclosing") => ({ provider: "claude", agent_id: agent, session_id: session });
const ref = (agent: string, session = "enclosing") => `agent:claude:${session}:${agent}`;
const claim = (agent: string, branch: string, session = "enclosing") => router.invoke({ method: "POST", url: "/api/work-units/claim",
  ambient_identity: context(agent, session), body: { issue_id: issue, repo_id: repo, branch } });
function transcript(id: string, session: string, agent: string | null) {
  db.prepare(`INSERT INTO conversations(id, source, session_id, agent_id, source_path, source_hash, source_mtime, started_at)
    VALUES (?, 'claude_code', ?, ?, ?, '', 1, '2026-11-01')`).run(id, session, agent, `/private/${id}`);
}

it("keeps siblings and nested agents in separate custody even when their wrapper principal is shared", async () => {
  const a = await claim("a", "feature/a"), b = await claim("b", "feature/b"), nested = await claim("nested", "feature/nested");
  expect([a.status, b.status, nested.status]).toEqual([201, 201, 201]);
  const id = (a.body as { id: string }).id;
  const snapshot = db.prepare("SELECT * FROM work_units WHERE id = ?").get(id);
  const conflict = await router.invoke({ method: "POST", url: "/api/work-units/activate", ambient_identity: context("b"),
    body: { issue_id: issue, repo_id: repo, branch: "feature/a" } });
  expect(conflict.status).toBe(409);
  expect(db.prepare("SELECT * FROM work_units WHERE id = ?").get(id)).toEqual(snapshot);
  expect(mapWorkUnitRow(snapshot as Record<string, unknown>)).toMatchObject({ assignment_target: { kind: "native", agent_ref: ref("a") },
    responsibility_session_id: ref("a"), execution_identity: context("a"), custody_generation: 1 });
  expect(sameResponsibilitySession(db, ref("a"), ref("a", "other"))).toBe(false);
  expect(sameResponsibilitySession(db, ref("a"), ref("b"))).toBe(false);
});

it("refuses custody from session-only Claude context even with an explicit exact target", async () => {
  const result = await router.invoke({ method: "POST", url: "/api/work-units/claim",
    ambient_identity: { provider: "claude", provider_session_id: "enclosing" },
    body: { issue_id: issue, repo_id: repo, branch: "feature/unknown", assigned_session_id: ref("a") } });
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ code: "agent_identity_required" });
  expect(db.prepare("SELECT count(*) AS n FROM work_units").get()).toEqual({ n: 0 });
});

it("resolves main and scoped child transcripts independently and rejects a repeated bare child id", () => {
  transcript("root", "enclosing", null); transcript("a", "enclosing", "a"); transcript("other-a", "other", "a");
  db.prepare("INSERT INTO sessions(id, app, status, conversation_id, pid) VALUES ('parent', 'claude', 'active', 'enclosing', 123)").run();
  expect(resolveProviderSessionIngestions(db, ["enclosing"]).get("enclosing")).toMatchObject({ source_path: "/private/root" });
  expect(resolveProviderSessionIngestions(db, ["a"]).get("a")).toMatchObject({ status: "ambiguous" });
  expect(resolveSessionAlias(db, "a")).toBeNull();
  const child = resolveSessionAlias(db, ref("a"))!;
  expect(child).toMatchObject({ provider_session_id: "a", mandible_session_id: null, console_session_id: null, liveness: "unknown" });
  expect(sessionAliasIds(child)).toEqual([ref("a")]);
  expect(summarizeSessionKey(db, ref("a"))).toMatchObject({ conversation_id: "a", process: null, liveness: "unknown" });
  expect(summarizeSessionKey(db, ref("a", "other"))).toMatchObject({ conversation_id: "other-a" });
  expect(assignmentTargetForSession(db, "a")).toEqual({ kind: "alias", session_id: "a" });
});

it("retains old Codex custody while preserving uncertainty in historical Claude assignment", () => {
  expect(parseAssignmentTarget({ kind: "native", provider: "codex", session_id: "thread" })).toEqual({ kind: "native", agent_ref: "agent:codex:thread" });
  expect(parseAssignmentTarget({ kind: "native", provider: "claude_code", session_id: "enclosing" })).toBeNull();
  expect(sameResponsibilitySession(db, "thread", "agent:codex:thread")).toBe(true);
  expect(sameResponsibilitySession(db, "enclosing", ref("enclosing"))).toBe(false);
  const actor = responsibilityActor({ client_identity: { user_id: "agent", session_id: "wrapper" }, ambient_identity: context("a") } as never);
  expect(actor.session_id).toBe(ref("a"));
});

it("links scoped native parents through ingestion without selecting their enclosing root", () => {
  transcript("nested", "enclosing", "nested");
  recordConversationParent(db, "nested", { source: "claude_code", sessionId: ref("a") });
  transcript("root", "enclosing", null); transcript("a", "enclosing", "a");
  linkWaitingChildren(db, { source: "claude_code", session_id: "enclosing" });
  expect(db.prepare("SELECT parent_conversation_id FROM conversations WHERE id = 'nested'").get()).toEqual({ parent_conversation_id: "a" });
  expect(db.prepare("SELECT parent_conversation_id FROM conversations WHERE id = 'a'").get()).toEqual({ parent_conversation_id: null });
});

it("withholds whole-session continuation from native Claude children before lineage is indexed", () => {
  transcript("a", "enclosing", "a");
  const store = new ConversationControlStore(db);
  const snapshot = store.snapshot("a", { send: true, resume_provider_session: true, resume_message_anchor: true } as never, "claude");
  expect(snapshot).toMatchObject({ ok: true, value: { capability: { kind: "unavailable", reason: "subagent" } } });
});

it("refuses child end and kill before touching the enclosing process", async () => {
  let calls = 0;
  registerSessionRoutes(router, { endSession: () => { calls++; }, killSession: () => { calls++; } } as never);
  for (const [method, path] of [["PATCH", "/end"], ["POST", "/kill"], ["PATCH", ""]]) {
    const result = await router.invoke({ method, url: `/api/sessions/parent${path}`, ambient_identity: context("a"), body: { status: "ended" } });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: "unsupported-scope" });
  }
  expect(calls).toBe(0);
});

it("keeps resolved-worker retention scoped when two Claude sessions reuse the same child id", async () => {
  for (const [session, childId, rootId] of [["enclosing", "child-a", "root-a"], ["other", "child-b", "root-b"]]) {
    transcript(rootId, session, null); transcript(childId, session, "a");
    const parent = ref(session, session);
    db.prepare(`UPDATE conversations SET parent_conversation_id = ?, parent_source = 'claude_code', parent_session_id = ?,
      opening_lineage = 'child', opening_line = ? WHERE id = ?`).run(rootId, parent,
      `[mandible child parent=claude:${parent} parent-role=coordinator role=worker]`, childId);
  }
  const first = await claim("a", "feature/scoped-retention"), second = await claim("a", "feature/other-retention", "other");
  expect([first.status, second.status]).toEqual([201, 201]);
  const id = (first.body as { id: string }).id;
  const resolve = await router.invoke({ method: "PATCH", url: `/api/work-units/${id}`, ambient_identity: context("a"),
    body: { expected_generation: 1, state: "resolved" } });
  expect(resolve.status).toBe(200);
  expect(db.prepare("SELECT worker_provider_session_id, worker_agent_ref FROM work_units WHERE id = ?").get(id))
    .toEqual({ worker_provider_session_id: "a", worker_agent_ref: ref("a") });
  expect(getWorkerAssignments(db, { provider: "claude_code", provider_session_id: "a", agent_ref: ref("a") }))
    .toMatchObject({ resolvedUnitIds: [id], unresolvedUnitIds: [], complete: true });
  expect(getWorkerAssignments(db, { provider: "claude_code", provider_session_id: "a", agent_ref: ref("a", "other") }).complete).toBe(false);
});

it("registers and stops equal native child ids independently under distinct enclosing sessions", () => {
  const registry = new SessionRegistry(db);
  registry.registerSession({ id: "root-one", app: "claude", conversation_id: "one" });
  registry.registerSession({ id: "root-two", app: "claude", conversation_id: "two" });
  const first = registry.registerChildSession("root-one", { id: "same-child" });
  const second = registry.registerChildSession("root-two", { id: "same-child" });
  expect(first).toMatchObject({ id: "agent:claude:one:same-child", parent_id: "root-one", status: "active", pid: null });
  expect(second).toMatchObject({ id: "agent:claude:two:same-child", parent_id: "root-two", status: "active", pid: null });
  expect(registry.updateChildStatus("root-one", "same-child", "ended")).toMatchObject({ id: first!.id, status: "ended" });
  expect(registry.getSession(second!.id)).toMatchObject({ status: "active", parent_id: "root-two" });
  expect(resolveSessionAlias(db, second!.id)).toMatchObject({ agent_ref: second!.id, liveness: "live", provider_session_id: "same-child" });
  expect(registry.getSession("root-one")).toMatchObject({ status: "active" });
  expect(registry.getSession("root-two")).toMatchObject({ status: "active" });
});

it("uses Codex thread ids even when siblings share a display nickname", () => {
  db.prepare(`INSERT INTO conversations(id, source, session_id, agent_id, source_path, source_hash, source_mtime, started_at)
    VALUES ('codex-parent', 'codex', 'parent-thread', NULL, '/private/parent', '', 1, '2026-11-01'),
    ('codex-one', 'codex', 'thread-one', 'Worker', '/private/one', '', 1, '2026-11-01'),
    ('codex-two', 'codex', 'thread-two', 'Worker', '/private/two', '', 1, '2026-11-01')`).run();
  db.prepare(`UPDATE conversations SET parent_source = 'codex', parent_session_id = 'agent:codex:parent-thread',
    parent_conversation_id = 'codex-parent', opening_lineage = 'child', opening_line = ? WHERE id IN ('codex-one','codex-two')`)
    .run('[mandible child parent=codex:agent:codex:parent-thread parent-role=coordinator role=worker]');
  for (const [id, thread] of [["codex-one", "thread-one"], ["codex-two", "thread-two"]]) {
    expect(resolveSessionAlias(db, `agent:codex:${thread}`)).toMatchObject({ agent_ref: `agent:codex:${thread}`, provider_session_id: thread });
    expect(summarizeSessionKey(db, `agent:codex:${thread}`)).toMatchObject({ conversation_id: id });
    expect(getRetainedChild(db, id)).toMatchObject({ sessionId: thread, agentRef: `agent:codex:${thread}` });
    expect(assignmentTargetForSession(db, thread)).toEqual({ kind: "native", agent_ref: `agent:codex:${thread}` });
  }
  expect(resolveSessionAlias(db, "Worker")).toBeNull();
  transcript("claude-collision", "enclosing", "thread-one");
  expect(resolveProviderSessionIngestions(db, ["thread-one"]).get("thread-one")).toMatchObject({ status: "ambiguous" });
  expect(resolveSessionAlias(db, "thread-one")).toBeNull();
  expect(resolveSessionAlias(db, "agent:codex:thread-one")).toMatchObject({ provider_session_id: "thread-one" });
  expect(resolveSessionAlias(db, "agent:claude:enclosing:thread-one")).toMatchObject({ provider_session_id: "thread-one" });
});

it("requires exact context from agent principals even when every managed marker is omitted", async () => {
  const user = createUser(db, { slug: "agent-without-context", display_name: "Agent", kind: "agent" });
  const agentRouter = new Router({ clientAuth: { authenticate: () => ({ user_id: user.id, slug: user.slug,
    method: "api_token", source: "in_process", session_id: "wrapper", credential_id: null, effect_ceiling: PRODUCTION_EFFECTS }),
    mode: () => "strict", recordUnattributedWrite: () => undefined } });
  registerWorkUnitRoutes(agentRouter, {} as never);
  const result = await agentRouter.invoke({ method: "POST", url: "/api/work-units/claim", body: { issue_id: issue, repo_id: repo, branch: "feature/no-context" } });
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ code: "agent_identity_required" });
  expect(db.prepare("SELECT count(*) AS n FROM work_units").get()).toEqual({ n: 0 });
});
