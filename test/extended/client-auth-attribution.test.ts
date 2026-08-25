import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, setDb, type Db } from "../../src/db.js";
import { AuthAutoApproveManager } from "../../src/auth-auto-approve.js";
import { AuthQueue } from "../../src/auth-queue.js";
import { ClientAuthenticator } from "../../src/client-auth/authenticator.js";
import { resolveProjectForCheckout } from "../../src/ledger/projects.js";
import { registerIssueRoutes } from "../../src/routes/issues.js";
import { registerAuthRoutes } from "../../src/routes/auth.js";
import { Router } from "../../src/server.js";
import type { SseEvent } from "../../src/types.js";
import {
  addAttributionEvidence,
  addBinding,
  addCredential,
  createUser,
  setupAgentUsers,
  setupOperator,
} from "../../src/users/store.js";

describe("client-auth durable attribution", () => {
  let tempDir: string;
  let db: Db;
  let authenticator: ClientAuthenticator;
  let router: Router;
  let projectId: string;
  let operatorId: string;
  let operatorToken: string;
  let sessionCreate: ReturnType<typeof vi.fn>;
  let authEvents: SseEvent[];
  let authQueue: AuthQueue;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-auth-attribution-"));
    db = openDb(path.join(tempDir, "mandible.db"));
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
    sessionCreate = vi.fn(() => ({ id: "managed-issue-session" }));
    authEvents = [];
    authQueue = new AuthQueue({ db, broadcast: (event) => authEvents.push(event) });
    router = new Router({ clientAuth: authenticator });
    registerAuthRoutes(router, authQueue, new AuthAutoApproveManager({ db }));
    registerIssueRoutes(router, {
      getRepos: () => [],
      getRepoById: () => undefined,
      getBranches: () => [],
    } as never, {
      sessionManager: { create: sessionCreate } as never,
    });
  });

  afterEach(() => {
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

  it("stores NULL user attribution for a tokenless ledger write with no ambient signal", async () => {
    // Issue a64d2de: a tokenless compat-mode write must no longer be stamped
    // with the operator. It flows through to NULL user attribution while the
    // legacy provenance columns still populate (generic 'Mandible' display).
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
    expect(response.status).toBe(200);

    const row = db.prepare(
      `SELECT author_user_id, evidence_method, evidence_id,
              author_actor_type, author_display
         FROM ledger_issues WHERE title = ?`,
    ).get("Unattributed tokenless write") as {
      author_user_id: string | null;
      evidence_method: string | null;
      evidence_id: string | null;
      author_actor_type: string;
      author_display: string;
    };
    expect(row.author_user_id).toBeNull();
    expect(row.evidence_method).toBeNull();
    expect(row.evidence_id).toBeNull();
    // Legacy provenance is untouched — the read projection still shows 'Mandible'.
    expect(row.author_actor_type).toBe("mandible_user");
    expect(row.author_display).toBe("Mandible");
  });

  it("resolves a tokenless ledger write to the ambient provider's agent with session_claim", async () => {
    // The CLI/MCP channel send X-Mandible-Ambient-Provider* on mutating calls;
    // the server exposes them as req.ambient_identity. With no bearer token, the
    // write resolves to the agent that owns the provider's session env keys.
    const codex = setupAgentUsers(db).find((user) => user.slug === "codex")!;
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
    expect(response.status).toBe(200);

    const row = db.prepare(
      "SELECT author_user_id, evidence_method FROM ledger_issues WHERE title = ?",
    ).get("Ambient-attributed agent write") as {
      author_user_id: string;
      evidence_method: string;
    };
    expect(row).toEqual({ author_user_id: codex.id, evidence_method: "session_claim" });
  });

  it("admits only the operator before issue spawn can construct a managed backend", async () => {
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
    expect(sessionCreate).not.toHaveBeenCalled();

    const allowed = await request(operatorToken);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ console_session_id: "managed-issue-session" });
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it("resolves a Codex requester from ambient provider identity without a session row", async () => {
    const submit = (sessionId: string) => router.invoke({
      method: "POST",
      url: "/api/auth/request",
      body: {
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
    const codex = setupAgentUsers(db).find((user) => user.slug === "codex")!;
    expect(
      db.prepare("SELECT id FROM sessions WHERE id = ?").get("codex-desktop-thread"),
    ).toBeUndefined();

    const submitted = await submit("codex-desktop-thread");
    expect(submitted.status).toBe(201);
    const requestId = (submitted.body as { request_id: string }).request_id;
    expect(authQueue.getRequest(requestId)?.requested_by_user_id).toBe(codex.id);

    const mismatched = await submit("different-thread");
    expect(mismatched.status).toBe(403);
    expect(mismatched.body).toMatchObject({ code: "requester_session_conflict" });
  });

  it("persists requester and approver users while rejecting conflicting session identity", async () => {
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
        command: "echo attributed",
        title: "Attributed auth request",
        session_id: "auth-request-agent-session",
        execution_mode: "remote",
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

    const denied = await router.invoke({
      method: "POST",
      url: `/api/auth/request/${requestId}/approve`,
      credential: agentToken,
      transport: "http",
    });
    expect(denied.status).toBe(403);

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
    authQueue.update(requestId, { title: "Attributed auth request with signature" });
    expect(authEvents.findLast((event) => event.event === "auth:updated")?.data).toMatchObject({
      request: {
        execution_evidence: {
          evidence_method: "credential_signature",
          credential: { id: signingCredential.id, label: "Operator signing key" },
        },
        merge_signature: { state: "verified" },
      },
    });

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
      body: {
        command: "echo mismatch",
        title: "Mismatched auth request",
        session_id: "auth-request-agent-session",
      },
      credential: operatorToken,
      transport: "http",
    });
    expect(mismatched.status).toBe(403);

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
      body: {
        command: "echo conflict",
        title: "Conflicting session claims",
        session_id: "auth-request-agent-session",
      },
      credential: agentToken,
      transport: "http",
    });
    expect(conflicting.status).toBe(403);
    expect(conflicting.body).toMatchObject({ code: "requester_session_conflict" });
  });
});
