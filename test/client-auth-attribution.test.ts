import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureSigningCredential, git } from "./helpers/auth-queue-fixtures.js";
import { setDb, type Db } from "../src/db.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { AuthQueue } from "../src/auth-queue.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import type { SseEvent } from "../src/types.js";
import {
  addAttributionEvidence,
  addBinding,
  addCredential,
  createUser,
  setupAgentUsers,
  setupOperator,
} from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { LedgerStore } from "../src/ledger/store.js";
import { readLedgerChangeFeed } from "../src/ledger/change-feed.js";
import { withRequestOrigin } from "../src/request-origin.js";
import { systemAction } from "../src/identity/resolver.js";

describe("client-auth durable attribution", () => {
  let tempDir: string;
  let db: Db;
  let authenticator: ClientAuthenticator;
  let router: Router;
  let projectId: string;
  let operatorId: string;
  let operatorToken: string;
  let controllerSnapshot: ReturnType<typeof vi.fn>;
  let authEvents: SseEvent[];
  let authQueue: AuthQueue;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-auth-attribution-"));
    db = migratedMemoryDb();
    setDb(db);
    const operator = setupOperator(db, {
      display_name: "Operator",
      email: "operator@example.com",
    });
    operatorId = operator.id;
    projectId = resolveProjectForCheckout(db, {
      root: tempDir,
      name: "mandible",
      workRepoId: "mandible",
    }).project.id;
    authenticator = new ClientAuthenticator(db, {
      secretsDir: path.join(tempDir, "client-auth"),
    });
    operatorToken = authenticator.mintApiToken(operator.id).token;
    controllerSnapshot = vi.fn();
    authEvents = [];
    authQueue = new AuthQueue({ db, broadcast: (event) => authEvents.push(event), backgroundMaintenance: false });
    router = new Router({ clientAuth: authenticator });
    registerAuthRoutes(router, authQueue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => authQueue.db));
    registerIssueRoutes(router, {
      getRepos: () => [],
      getRepoById: () => undefined,
      getBranches: () => [],
    } as never, {
      conversationControl: { getSnapshot: controllerSnapshot } as never,
    }, inlineLedgerReader());
  });

  afterEach(async () => {
    (await authQueue.dispose());
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(["api_token", "ephemeral"] as const)(
    "records a %s-authenticated mutation as the token user with api_token evidence",
    async (method) => {
      const agent = createUser(db, {
        slug: `agent-${method}`,
        kind: "agent",
        display_name: `Agent ${method}`,
      });
      const credential = method === "api_token"
        ? authenticator.mintApiToken(agent.id).token
        : authenticator.issueEphemeralToken(
            { user_id: agent.id, slug: agent.slug },
            "attribution-test",
          );
      const response = await router.invoke({
        method: "POST",
        url: "/api/issues/mandible",
        body: {
          title: `Attributed ${method}`,
          kind: "feature",
          body: "A durable token-authenticated write.",
          project: projectId,
        },
        credential,
        transport: method === "api_token" ? "http" : "file-rpc",
      });

      expect(response.status).toBe(200);
      const row = db.prepare(
        "SELECT author_user_id, evidence_method FROM ledger_issues WHERE title = ?",
      ).get(`Attributed ${method}`) as { author_user_id: string; evidence_method: string };
      expect(row).toEqual({ author_user_id: agent.id, evidence_method: "api_token" });
    },
  );

  it("persists native origins independently of one bearer author across issue writes and rollback", async () => {
    const store = new LedgerStore(db);
    const before = readLedgerChangeFeed(db, { project_id: projectId, project_key: "mandible" });
    const origins = [
      { provider: "codex", provider_session_id: "native-codex-1" },
      { provider: "codex", provider_session_id: "native-codex-2" },
      { provider: "claude", provider_session_id: "native-claude-1" },
      null,
    ];
    const issueIds: string[] = [];
    for (const [index, origin] of origins.entries()) {
      const response = await router.invoke({ method: "POST", url: "/api/issues/mandible",
        transport: index % 2 ? "file-rpc" : "http", credential: operatorToken,
        ambient_identity: origin, body: { title: `Native origin ${index}`, kind: "feature", body: "Initial", project: projectId } });
      expect(response.status).toBe(200);
      const issue = db.prepare("SELECT * FROM ledger_issues WHERE title = ?").get(`Native origin ${index}`)!;
      issueIds.push(issue.id);
      expect(issue.author_user_id).toBe(operatorId);
      expect(issue.evidence_method).toBe("api_token");
      const event = store.listEvents({ entity_type: "issue", entity_id: issue.id }).find(event => event.event_type === "issue.created")!;
      expect(JSON.parse(event.payload_json).request_origin).toEqual(origin);
      const revisions = await router.invoke({ method: "GET", url: `/api/ledger/issues/${issue.id}/body/revisions`, credential: operatorToken, transport: "http" });
      expect(revisions.status).toBe(200);
      expect((revisions.body as any).revisions[0].request_origin).toEqual(origin);
    }
    const commentResponse = await router.invoke({ method: "POST", url: `/api/ledger/issues/${issueIds[0]}/comments`,
      credential: operatorToken, transport: "http", ambient_identity: origins[2],
      body: { body: `Related work [issue:${issueIds[1].slice(0, 7)}]` } });
    expect(commentResponse.status).toBe(200);
    const nativeComment = db.prepare('SELECT * FROM ledger_comments WHERE issue_id = ?').get(issueIds[0])!;
    expect(store.listBodyRevisions({ entity_type: "comment_body", entity_id: nativeComment.id })[0].request_origin).toEqual(origins[2]);
    const updated = await router.invoke({ method: "PATCH", url: `/api/ledger/issues/${issueIds[0]}`,
      credential: operatorToken, transport: "file-rpc", ambient_identity: origins[1], body: { body: "Changed native contribution" } });
    expect(updated.status).toBe(200);
    expect(store.listBodyRevisions({ entity_type: "issue_body", entity_id: issueIds[0] }).at(-1)?.request_origin).toEqual(origins[1]);
    const feed = readLedgerChangeFeed(db, { project_id: projectId, project_key: "mandible", cursor: before.next_cursor as string });
    expect((feed.changes as Array<{ event_type: string; request_origin: unknown }>).filter(change => change.event_type === "issue.created").map(change => change.request_origin)).toEqual(origins);
    expect((feed.changes as Array<{ event_type: string; request_origin: unknown }>).filter(change => change.event_type === "relationship.upserted"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ request_origin: origins[2] })]));
    const counts = () => db.prepare("SELECT (SELECT count(*) FROM ledger_events) AS events, (SELECT count(*) FROM ledger_body_revisions) AS revisions, (SELECT count(*) FROM ledger_comments) AS comments").get();
    const prior = counts();
    expect(() => withRequestOrigin(origins[0], () => db.transaction(() => {
      store.addComment(issueIds[0], { body: "Rolled back", actor_type: "system", author_display: "System", attribution: systemAction() });
      throw new Error("abort write");
    })())).toThrow("abort write");
    expect(counts()).toEqual(prior);
    const comment = store.addComment(issueIds[0], { body: "Outside any request", actor_type: "system", author_display: "System", attribution: systemAction() });
    expect(store.listBodyRevisions({ entity_type: "comment_body", entity_id: comment.id })[0].request_origin).toBeNull();
  });

  it("rejects a tokenless HTTP ledger write with no ambient signal", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/issues/mandible",
      body: {
        title: "Unattributed tokenless write",
        body: "A compat-mode write with neither a credential nor an ambient session.",
        project: projectId,
      },
      transport: "http",
    });
    expect(response).toMatchObject({ status: 401, body: { error: "authentication_required" } });
    expect(db.prepare("SELECT id FROM ledger_issues WHERE title = ?").get("Unattributed tokenless write"))
      .toBeUndefined();
  });

  it("does not treat ambient provider headers as HTTP authentication", async () => {
    setupAgentUsers(db);
    const response = await router.invoke({
      method: "POST",
      url: "/api/issues/mandible",
      body: {
        title: "Ambient-attributed agent write",
        body: "A tokenless write carrying an ambient codex session signal.",
        project: projectId,
      },
      ambient_identity: {
        provider: "codex",
        provider_session_id: "codex-ledger-thread",
      },
      transport: "http",
    });
    expect(response).toMatchObject({ status: 401, body: { error: "authentication_required" } });
    expect(db.prepare("SELECT id FROM ledger_issues WHERE title = ?").get("Ambient-attributed agent write"))
      .toBeUndefined();
  });

  it("admits only the operator before validating exact issue continuation custody", async () => {
    const createIssue = await router.invoke({
      method: "POST",
      url: "/api/issues/mandible",
      body: {
        title: "Managed spawn authorization",
        body: "The issue target for a managed-session authorization test.",
        project: projectId,
      },
      credential: operatorToken,
    });
    expect(createIssue.status).toBe(200);
    const issue = db.prepare(
      "SELECT short_id FROM ledger_issues WHERE title = ?",
    ).get("Managed spawn authorization") as { short_id: string };
    const agent = createUser(db, {
      slug: "agent-spawn-denied",
      kind: "agent",
      display_name: "Agent Spawn Denied",
    });
    const agentToken = authenticator.mintApiToken(agent.id).token;
    const request = (credential?: string) => router.invoke({
      method: "POST",
      url: `/api/issues/mandible/${issue.short_id}/spawn`,
      body: {},
      credential,
    });

    const anonymous = await request();
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).not.toHaveProperty("console_session_id");
    const ordinary = await request(agentToken);
    expect(ordinary.status).toBe(403);
    expect(ordinary.body).not.toHaveProperty("console_session_id");
    expect(controllerSnapshot).not.toHaveBeenCalled();

    const allowed = await request(operatorToken);
    expect(allowed).toMatchObject({ status: 400, body: { error: "exact_work_unit_required" } });
    expect(controllerSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an auth requester that supplies only ambient provider identity", async () => {
    const submit = (sessionId: string) => router.invoke({
      method: "POST",
      url: "/api/auth/request",
      body: { ...AUTH_MERGE_REVIEW,
        command: "echo codex",
        title: "Codex desktop auth request",
        session_id: sessionId,
      },
      ambient_identity: {
        provider: "codex",
        provider_session_id: "codex-desktop-thread",
      },
      transport: "http",
    });

    expect((await submit("codex-desktop-thread")).status).toBe(401);
    setupAgentUsers(db);
    expect(
      db.prepare("SELECT id FROM sessions WHERE id = ?").get("codex-desktop-thread"),
    ).toBeUndefined();

    expect((await submit("codex-desktop-thread"))).toMatchObject({
      status: 401,
      body: { error: "authentication_required" },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_requests").get()).toEqual({ n: 0 });
  });

  it("persists requester and approver users while treating session ids as credential-bound provenance", async () => {
    const agent = createUser(db, {
      slug: "auth-request-agent",
      kind: "agent",
      display_name: "Auth Request Agent",
    });
    addBinding(db, agent.slug, {
      binding_type: "provider_session_env",
      value: "auth-request-agent-session",
    });
    const agentToken = authenticator.mintApiToken(agent.id).token;

    const submitted = await router.invoke({
      method: "POST",
      url: "/api/auth/request",
      body: {
        ...AUTH_MERGE_REVIEW,
        command: "echo attributed",
        title: "Attributed auth request",
        session_id: "auth-request-agent-session",
        execution_mode: "remote",
        cwd: tempDir,
      },
      credential: agentToken,
      transport: "http",
    });
    expect(submitted.status).toBe(201);
    const requestId = (submitted.body as { request_id: string }).request_id;
    expect(authEvents.find((event) => event.event === "auth:new")?.data).toMatchObject({
      request: {
        id: requestId,
        requester: { id: agent.id, display_name: "Auth Request Agent", kind: "agent" },
      },
    });

    const signingCredential = addCredential(db, operatorId, {
      type: "ssh_key",
      fingerprint: `SHA256:${"S".repeat(43)}`,
      label: "Operator signing key",
    });
    const executionEvidence = addAttributionEvidence(db, {
      evidence_method: "credential_signature",
      credential_id: signingCredential.id,
      // The recorded verification RESULT. The projection reads this, not the
      // method name — evidence is written with this method even when
      // verification fails, so the method name alone claims nothing.
      details: { verified: true, fingerprint: `SHA256:${"S".repeat(43)}` },
    });
    db.prepare("UPDATE auth_requests SET execution_evidence_id = ? WHERE id = ?")
      .run(executionEvidence.id, requestId);
    (await authQueue.update(requestId, { title: "Attributed auth request with signature" }));
    expect(authEvents.findLast((event) => event.event === "auth:updated")?.data).toMatchObject({
      request: {
        execution_evidence: {
          evidence_method: "credential_signature",
          credential: { id: signingCredential.id, label: "Operator signing key" },
        },
        merge_signature: { state: "verified" },
      },
    });

    const denied = await router.invoke({
      method: "POST",
      url: `/api/auth/request/${requestId}/approve`,
      credential: agentToken,
      transport: "http",
    });
    expect(denied.status).toBe(403);

    git(tempDir, ["init", "--initial-branch=main"]);
    configureSigningCredential(db, tempDir, "ssh_key");
    const approved = await router.invoke({
      method: "POST",
      url: `/api/auth/request/${requestId}/approve`,
      credential: operatorToken,
      transport: "http",
    });
    expect(approved.status).toBe(202);
    expect(authEvents.findLast((event) => event.event === "auth:updated")?.data).toMatchObject({
      request: {
        id: requestId,
        approver: { id: operatorId, display_name: "Operator", kind: "human" },
      },
    });
    db.prepare("UPDATE auth_requests SET execution_evidence_id = ? WHERE id = ?")
      .run(executionEvidence.id, requestId);

    const detail = await router.invoke({
      method: "GET",
      url: `/api/auth/request/${requestId}`,
      credential: operatorToken,
      transport: "http",
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      requested_by_user_id: agent.id,
      approved_by_user_id: operatorId,
      execution_evidence_id: executionEvidence.id,
      requester: { id: agent.id, display_name: "Auth Request Agent", kind: "agent" },
      approver: { id: operatorId, display_name: "Operator", kind: "human" },
      execution_evidence: {
        evidence_method: "credential_signature",
        credential: { id: signingCredential.id, label: "Operator signing key" },
      },
      merge_signature: { state: "verified" },
    });

    // A signature that did not verify must report `unverified`, never
    // `verified` and never silently absent.
    db.prepare("UPDATE attribution_evidence SET details_json = ? WHERE id = ?")
      .run(JSON.stringify({ verified: false, reason: "verification_error" }), executionEvidence.id);
    const failedDetail = await router.invoke({
      method: "GET",
      url: `/api/auth/request/${requestId}`,
    });
    expect(failedDetail.body).toMatchObject({
      merge_signature: { state: "unverified", reason: "verification_error" },
    });

    db.prepare("UPDATE attribution_evidence SET evidence_method = 'session_claim' WHERE id = ?")
      .run(executionEvidence.id);
    const nonSignatureDetail = await router.invoke({
      method: "GET",
      url: `/api/auth/request/${requestId}`,
    });
    expect(nonSignatureDetail.body).toMatchObject({
      execution_evidence: { evidence_method: "session_claim" },
      merge_signature: { state: "none" },
    });

    const mismatched = await router.invoke({
      method: "POST",
      url: "/api/auth/request",
      body: { ...AUTH_MERGE_REVIEW,
        command: "echo mismatch",
        title: "Mismatched auth request",
        session_id: "auth-request-agent-session",
      },
      credential: operatorToken,
      transport: "http",
    });
    expect(mismatched.status).toBe(201);
    expect((await authQueue.getRequest((mismatched.body as { request_id: string }).request_id))?.requested_by_user_id)
      .toBe(operatorId);

    const conflictingAgent = createUser(db, {
      slug: "auth-conflicting-app-agent",
      kind: "agent",
      display_name: "Auth Conflicting App Agent",
    });
    addBinding(db, conflictingAgent.slug, {
      binding_type: "app_name",
      value: "conflicting-auth-app",
    });
    db.prepare("INSERT INTO sessions (id, app, status) VALUES (?, ?, 'active')")
      .run("auth-request-agent-session", "conflicting-auth-app");
    const conflicting = await router.invoke({
      method: "POST",
      url: "/api/auth/request",
      body: { ...AUTH_MERGE_REVIEW,
        command: "echo conflict",
        title: "Conflicting session claims",
        session_id: "auth-request-agent-session",
      },
      credential: agentToken,
      transport: "http",
    });
    expect(conflicting.status).toBe(201);
    expect((await authQueue.getRequest((conflicting.body as { request_id: string }).request_id))?.requested_by_user_id)
      .toBe(agent.id);
  });
});
