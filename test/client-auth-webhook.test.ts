import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientAuthenticator } from "../../src/client-auth/authenticator.js";
import { openDb, setDb, type Db } from "../../src/db.js";
import { registerWebhookRoutes } from "../../src/routes/webhooks.js";
import { Router } from "../../src/server.js";
import { addBinding, createUser, setupOperator } from "../../src/users/store.js";

describe("client-auth operator webhook delivery", () => {
  let tempDir: string;
  let db: Db;
  let authenticator: ClientAuthenticator;
  let router: Router;
  let operatorToken: string;
  let agentToken: string;
  let sendPrompt: ReturnType<typeof vi.fn>;
  let agentSendPrompt: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-auth-webhook-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    setDb(db);
    const operator = setupOperator(db, { display_name: "Operator" });
    const agent = createUser(db, {
      slug: "agent-webhook",
      kind: "agent",
      display_name: "Agent Webhook",
    });
    addBinding(db, agent.id, { binding_type: "app_name", value: "agent-cli" });
    authenticator = new ClientAuthenticator(db, {
      secretsDir: path.join(tempDir, "client-auth"),
    });
    operatorToken = authenticator.mintApiToken(operator.id).token;
    agentToken = authenticator.mintApiToken(agent.id).token;
    db.prepare(
      "UPDATE settings SET value = ? WHERE key = 'console_operator_session_id'",
    ).run("operator-session");
    db.prepare(
      `INSERT INTO sessions (id, app, cwd, branch, status, created_at, updated_at)
       VALUES (?, 'codex', ?, 'feature/operator', 'active', datetime('now'), datetime('now'))`,
    ).run("operator-ledger-session", tempDir);
    db.prepare(
      `INSERT INTO sessions (id, app, cwd, branch, status, created_at, updated_at)
       VALUES (?, 'codex', ?, 'feature/agent', 'active', datetime('now'), datetime('now'))`,
    ).run("agent-ledger-session", tempDir);

    sendPrompt = vi.fn();
    const backend = {
      id: "operator-session",
      meta: {
        id: "operator-session",
        status: "running",
        is_operator: true,
        cwd: tempDir,
        mandible_session_id: "operator-ledger-session",
      },
      sendPrompt,
    };
    agentSendPrompt = vi.fn();
    const agentBackend = {
      id: "agent-session",
      meta: {
        id: "agent-session",
        command: "agent-cli",
        status: "running",
        is_operator: false,
        cwd: tempDir,
        mandible_session_id: "agent-ledger-session",
      },
      sendPrompt: agentSendPrompt,
    };
    const manager = {
      get: (id: string) => id === backend.id
        ? backend
        : id === agentBackend.id
          ? agentBackend
          : undefined,
      getAll: () => [backend, agentBackend],
      isCredentialBearing: (id: string) => id === backend.id || id === agentBackend.id,
    };
    router = new Router({ clientAuth: authenticator });
    registerWebhookRoutes(
      router,
      manager as never,
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function ingest(
    body: Record<string, unknown>,
    credential?: string,
  ): Promise<{ status: number; body: unknown }> {
    return router.invoke({
      method: "POST",
      url: "/api/webhooks/ingest",
      body: { source: `test-${Math.random()}`, event_type: "alert", data: {}, ...body },
      credential,
      transport: "http",
    });
  }

  it("blocks direct, issue-resolved, and branch-resolved operator delivery", async () => {
    const anonymous = await ingest({ target_session: "operator-session" });
    expect(anonymous.status).toBe(401);
    const ordinary = await ingest({ target_session: "operator-session" }, agentToken);
    expect(ordinary.status).toBe(403);
    expect(sendPrompt).not.toHaveBeenCalled();

    db.prepare(
      `INSERT INTO work_units (
        id, issue_id, repo_id, branch, kind, state, assigned_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      "work-unit-operator",
      "issue-operator",
      "mandible",
      "feature/test",
      "solo",
      "operator-session",
      Date.now(),
    );
    const resolved = await ingest({ target_issue: "issue-operator" }, agentToken);
    expect(resolved.status).toBe(403);
    expect(sendPrompt).not.toHaveBeenCalled();

    const branchResolved = await ingest({ target_branch: "feature/operator" }, agentToken);
    expect(branchResolved.status).toBe(403);
    expect(sendPrompt).not.toHaveBeenCalled();

    const allowed = await ingest({ target_session: "operator-session" }, operatorToken);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ status: "queued", delivered_to: null });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("protects manual delivery of a queued webhook", async () => {
    const queued = await ingest({}, operatorToken);
    const webhookId = (queued.body as { id: string }).id;
    const denied = await router.invoke({
      method: "POST",
      url: `/api/webhooks/${webhookId}/deliver`,
      body: { target_session: "operator-session" },
      credential: agentToken,
      transport: "http",
    });
    expect(denied.status).toBe(403);
    expect(sendPrompt).not.toHaveBeenCalled();

    const allowed = await router.invoke({
      method: "POST",
      url: `/api/webhooks/${webhookId}/deliver`,
      body: { target_session: "operator-session" },
      credential: operatorToken,
      transport: "http",
    });
    expect(allowed.status).toBe(422);
    expect(allowed.body).toMatchObject({ error: "delivery_failed" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("protects every selector for an app-bound non-operator session", async () => {
    const direct = await ingest({ target_session: "agent-session" }, agentToken);
    expect(direct.status).toBe(403);

    db.prepare(
      `INSERT INTO work_units (
        id, issue_id, repo_id, branch, kind, state, assigned_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      "work-unit-agent",
      "issue-agent",
      "mandible",
      "feature/agent",
      "solo",
      "agent-session",
      Date.now(),
    );
    const issue = await ingest({ target_issue: "issue-agent" }, agentToken);
    expect(issue.status).toBe(403);
    const branch = await ingest({ target_branch: "feature/agent" }, agentToken);
    expect(branch.status).toBe(403);

    const queued = await ingest({}, operatorToken);
    const webhookId = (queued.body as { id: string }).id;
    const manual = await router.invoke({
      method: "POST",
      url: `/api/webhooks/${webhookId}/deliver`,
      body: { target_session: "agent-session" },
      credential: agentToken,
      transport: "http",
    });
    expect(manual.status).toBe(403);
    expect(agentSendPrompt).not.toHaveBeenCalled();

    const allowed = await ingest({ target_session: "agent-session" }, operatorToken);
    expect(allowed.status).toBe(200);
    expect(agentSendPrompt).not.toHaveBeenCalled();
  });
});
