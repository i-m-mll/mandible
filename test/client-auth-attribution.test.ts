import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, setDb, type Db } from "../src/db.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { AuthQueue } from "../src/auth-queue.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { addBinding, createUser, setupOperator } from "../src/users/store.js";

describe("client-auth durable attribution", () => {
  let tempDir: string;
  let db: Db;
  let authenticator: ClientAuthenticator;
  let router: Router;
  let projectId: string;
  let operatorId: string;
  let operatorToken: string;
  let sessionCreate: ReturnType<typeof vi.fn>;

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
    router = new Router({ clientAuth: authenticator });
    registerAuthRoutes(router, new AuthQueue({ db }), new AuthAutoApproveManager({ db }));
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
      execution_evidence_id: null,
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
