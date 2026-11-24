// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { appendAuthLifecycleEvent } from "../src/auth-lifecycle.js";
import { ClientAuthzError } from "../src/client-auth/authz.js";
import { setDb, type Db } from "../src/db.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { createOutcomeReporter } from "../src/notices/report.js";
import { custodyGate, responsibilityActor, type ResponsibilityActor } from "../src/responsibility.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { Router, type RequestLike, type ResolvedClientIdentity } from "../src/server.js";
import { createUser, getOperator } from "../src/users/store.js";
import { AUTH_COMMAND_REVIEW, createLedgerIssue, createLedgerProject, createMigratedDb, createNoopHookManager } from "./helpers/auth-queue-fixtures.js";

const HOLDER = { provider: "claude" as const, agent_id: "holder", session_id: "holder" };
const HOLDER_REF = "agent:claude:holder:holder";
const OTHER = { provider: "claude" as const, agent_id: "other", session_id: "other" };

let db: Db;
let operator: NonNullable<ReturnType<typeof getOperator>>;
beforeEach(() => { db = createMigratedDb(); setDb(db); operator = getOperator(db)!; });
afterEach(() => db.close());

const identity = (method: ResolvedClientIdentity["method"]): ResolvedClientIdentity => ({ user_id: operator.id, slug: operator.slug,
  method, source: method === "local_socket" ? "local_socket" : "http_bearer", credential_id: null, effect_ceiling: PRODUCTION_EFFECTS });

describe("custody gate", () => {
  it("never refuses the user, passes over only another holder, and refuses an agent that does not hold the item", () => {
    const agent = createUser(db, { slug: "gate-agent", display_name: "Agent", kind: "agent" });
    const owners = {
      unheld: { owner_user_id: null, responsibility_session_id: null },
      user: { owner_user_id: operator.id, responsibility_session_id: null },
      agent: { owner_user_id: agent.id, responsibility_session_id: HOLDER_REF },
    };
    const actors: Record<string, ResponsibilityActor> = {
      user: { kind: "user", user_id: operator.id },
      holder: { kind: "agent", user_id: agent.id, session_id: HOLDER_REF },
      stranger: { kind: "agent", user_id: agent.id, session_id: "agent:claude:other:other" },
    };
    const table = Object.fromEntries(Object.entries(actors).map(([actor, value]) => [actor, Object.fromEntries(
      Object.entries(owners).map(([owner, row]) => {
        const decision = custodyGate(db, row, value);
        return [owner, decision.allowed ? decision.passed_over ? "passes over" : "allowed" : "refused"];
      }))]));
    expect(table).toEqual({
      user: { unheld: "allowed", user: "allowed", agent: "passes over" },
      holder: { unheld: "refused", user: "refused", agent: "allowed" },
      stranger: { unheld: "refused", user: "refused", agent: "refused" },
    });
  });

  it("treats the operator's identity as the user only without an agent marker, on the socket and on a bearer transport", () => {
    const actor = (req: Partial<RequestLike>) => {
      try { return responsibilityActor({ method: "POST", params: {}, query: {}, body: {}, ...req } as RequestLike); }
      catch (error) { if (error instanceof ClientAuthzError) return error.code; throw error; }
    };
    for (const method of ["local_socket", "api_token"] as const) {
      expect(actor({ client_identity: identity(method) })).toEqual({ kind: "user", user_id: operator.id });
      expect(actor({ client_identity: identity(method), managed_client: true } as Partial<RequestLike>)).toBe("agent_identity_required");
      expect(actor({ client_identity: identity(method), local_managed_identity: { app_name: "claude", session_id: "x" } } as Partial<RequestLike>))
        .toBe("agent_identity_required");
      expect(actor({ client_identity: identity(method), ambient_identity: HOLDER }))
        .toEqual({ kind: "agent", user_id: operator.id, session_id: HOLDER_REF });
    }
  });
});

describe("the user acting on an agent-held approval request", () => {
  let queue: AuthQueue;
  let router: Router;
  let repo: string;
  beforeEach(() => {
    repo = createLedgerProject(db, process.cwd()).project.id;
    const hookManager = { ...createNoopHookManager(), verifyCurrentRuntimeHandoff: async (_request: unknown, _actor: unknown, guard: () => void) => {
      guard();
      return { outcome: "pending", reason: "Observing the running installation." };
    } } as unknown as ReturnType<typeof createNoopHookManager>;
    queue = new AuthQueue({ db, hookManager, backgroundMaintenance: false, outcomeReporter: createOutcomeReporter(db) });
    router = new Router({ clientAuth: { authenticate: () => identity("api_token"), mode: () => "strict", recordUnattributedWrite: () => undefined } });
    registerAuthRoutes(router, queue, inlineLedgerReader(() => db));
  });
  afterEach(async () => { await queue.dispose(); });

  const submit = () => queue.submit({ ...AUTH_COMMAND_REVIEW, type: "command", command: "printf reviewed", title: "Held request", repo,
    session_id: HOLDER_REF, requester_evidence_method: "session_claim" }, operator.id);
  const preconditions = (id: string) => ({ expected_revision: queue.lifecycleRevision(id),
    expected_custody_generation: queue.requestResponsibility(queue.getRequestExact(id)!).custody_generation });
  const responsibility = (id: string) => queue.requestResponsibility(queue.getRequestExact(id)!);
  const owed = (session: string) => queue.notices!.collect({ provider: "claude", session_id: session }).map(notice => notice.text);

  it("recovers a handoff whose bound work unit an agent holds, leaving its holder and generation unchanged", async () => {
    const request = await submit();
    const agent = createUser(db, { slug: "delivery-agent", display_name: "Agent", kind: "agent" });
    db.prepare(`INSERT INTO work_units (id, issue_id, repo_id, branch, state, created_at, auth_request_id, owner_user_id,
      responsibility_session_id, custody_generation) VALUES ('held-unit', 'i1', ?, 'feature/held', 'committed', 1, ?, ?, ?, 3)`)
      .run(repo, request.id, agent.id, HOLDER_REF);
    db.prepare("UPDATE auth_requests SET custody_work_unit_id = 'held-unit', type = 'commit', status = 'completed', exit_code = 0 WHERE id = ?").run(request.id);
    const unit = () => db.prepare("SELECT owner_user_id, responsibility_session_id, custody_generation FROM work_units WHERE id = 'held-unit'").get();
    const before = unit();
    const url = `/api/auth/request/${request.id}/retry-convergence`;

    const other = await router.invoke({ method: "POST", url, ambient_identity: OTHER, body: { mode: "verify-current" } });
    expect(other).toMatchObject({ status: 403, body: { code: "custody_required" } });
    const recovered = await router.invoke({ method: "POST", url, body: { mode: "verify-current" } });
    expect(recovered).toMatchObject({ status: 200, body: { verification: { outcome: "pending" },
      custody_passed_over: { user_id: agent.id, session_id: HOLDER_REF } } });
    expect(unit()).toEqual(before);
  });

  it("withdraws it over the holder, who keeps custody, is named in the reply, and is told", async () => {
    const request = await submit();
    const held = responsibility(request.id);
    const url = `/api/auth/request/${request.id}/withdraw`;
    const other = await router.invoke({ method: "POST", url, ambient_identity: OTHER, body: { reason: "Not mine", ...preconditions(request.id) } });
    expect(other).toMatchObject({ status: 403, body: { code: "custody_required" } });

    const withdrawn = await router.invoke({ method: "POST", url, body: { reason: "Superseded by hand", ...preconditions(request.id) } });
    expect(withdrawn).toMatchObject({ status: 200, body: { status: "withdrawn",
      custody_passed_over: { user_id: operator.id, session_id: HOLDER_REF } } });
    expect(responsibility(request.id)).toEqual(held);
    expect(queue.listLifecycleEvents(request.id).at(-1)).toMatchObject({ event_type: "withdrawn", actor_user_id: operator.id, authority_path: "operator" });
    expect(owed("holder")).toEqual([expect.stringContaining("withdrawn")]);
  });

  it("raises the holder's notice when the user revises it without a status change", async () => {
    const request = await submit();
    const issue = createLedgerIssue(db, repo, "revise");
    db.prepare("UPDATE auth_requests SET status = 'failed', exit_code = 1 WHERE id = ?").run(request.id);
    appendAuthLifecycleEvent(db, { requestId: request.id, eventType: "failed", priorStatus: "pending", nextStatus: "failed", occurredAt: Date.now() });
    queue.raiseNotice(request.id, { kind: "transition", actor: null });
    queue.notices!.delivered(queue.notices!.collect({ provider: "claude", session_id: "holder" }).map(notice => notice.id));
    expect(owed("holder")).toEqual([]);

    const added = await router.invoke({ method: "POST", url: `/api/auth/request/${request.id}/actions`, body: {
      kind: "comment_add", target_issue_ref: issue.short_id, payload: { body: "Follow up" }, ...preconditions(request.id) } });
    expect(added).toMatchObject({ status: 201, body: { custody_passed_over: { session_id: HOLDER_REF } } });
    expect(responsibility(request.id).owner_user_id).toBe(operator.id);
    expect(responsibility(request.id).responsibility_session_id).toBe(HOLDER_REF);
    expect(owed("holder")).toHaveLength(1);
  });
});
