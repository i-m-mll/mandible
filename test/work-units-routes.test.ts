import http from "node:http";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAmbientProviderIdentity } from "../src/ambient-provider-identity.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { registerWorkUnitRoutes } from "../src/routes/work-units.js";
import { Router, type ClientAuthGate } from "../src/server.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { addCredential, createUser } from "../src/users/store.js";

let db: Db;
let router: Router;

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  router = new Router();
  registerWorkUnitRoutes(router, {} as never, {} as never);
});

afterEach(() => {
  db.close();
});

describe("work unit routes", () => {
  it("retains the exact credential owner from claim through activation", async () => {
    const agent = createUser(db, { slug: "custodian", kind: "agent", display_name: "Custodian" });
    const credential = addCredential(db, agent.id, { type: "api_token", fingerprint: "test-custody-token" });
    const gate: ClientAuthGate = {
      authenticate: (token) => token === "test-token" ? {
        user_id: agent.id, slug: agent.slug, method: "api_token", source: "in_process",
        credential_id: credential.id, effect_ceiling: PRODUCTION_EFFECTS,
      } : null,
      mode: () => "strict",
      recordUnattributedWrite: () => undefined,
    };
    const credentialRouter = new Router({ clientAuth: gate });
    registerWorkUnitRoutes(credentialRouter, {} as never, {} as never);
    const request = { issue_id: "custody-issue", repo_id: "mandible", branch: "feature/custody" };
    const claimed = await credentialRouter.invoke({ method: "POST", url: "/api/work-units/claim",
      credential: "test-token", body: request });
    expect(claimed.status).toBe(201);
    const id = (claimed.body as { id: string }).id;
    const activated = await credentialRouter.invoke({ method: "POST", url: "/api/work-units/activate",
      credential: "test-token", body: request });
    expect(activated.status).toBe(200);
    expect(db.prepare("SELECT owner_user_id, owner_credential_id, custody_generation, state FROM work_units WHERE id = ?")
      .get(id)).toEqual({ owner_user_id: agent.id, owner_credential_id: credential.id,
        custody_generation: 1, state: "committed" });
  });

  async function createBoundWorkUnit(
    issueId: string,
    branch: string,
    authRequestId: string,
    authStatus: "pending" | "withdrawn",
  ): Promise<string> {
    const response = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      ambient_identity: { provider: "codex", provider_session_id: `${issueId}-worker-a` },
      body: { issue_id: issueId, repo_id: "mandible", branch },
    });
    const id = (response.body as { id: string }).id;
    const now = Date.now();
    db.prepare(
      `INSERT INTO auth_requests
       (id, command, title, status, created_at, updated_at, expires_at, output)
       VALUES (?, 'git merge', 'Bound request', ?, ?, ?, ?, '')`,
    ).run(authRequestId, authStatus, now, now, now + 60_000);
    db.prepare("UPDATE work_units SET auth_request_id = ? WHERE id = ?")
      .run(authRequestId, id);
    return id;
  }

  it("keeps a pending request on branch A when branch B activates", async () => {
    const branchAId = await createBoundWorkUnit(
      "pending-branches",
      "feature/pending-a",
      "auth-pending-a",
      "pending",
    );

    const branchB = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      ambient_identity: { provider: "codex", provider_session_id: "pending-branches-worker-b" },
      body: {
        issue_id: "pending-branches",
        repo_id: "mandible",
        branch: "feature/pending-b",
      },
    });

    expect(branchB.status).toBe(201);
    expect((branchB.body as { id: string }).id).not.toBe(branchAId);
    expect(db.prepare(
      `SELECT branch, state, auth_request_id, provider_session_id
       FROM work_units WHERE id = ?`,
    ).get(branchAId)).toEqual({
      branch: "feature/pending-a",
      state: "committed",
      auth_request_id: "auth-pending-a",
      provider_session_id: "pending-branches-worker-a",
    });
  });

  it("keeps withdrawn auth history on superseded branch A when replacement branch B activates", async () => {
    const branchAId = await createBoundWorkUnit(
      "withdrawn-branches",
      "feature/superseded-a",
      "auth-withdrawn-a",
      "withdrawn",
    );

    const branchB = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      ambient_identity: { provider: "codex", provider_session_id: "withdrawn-branches-worker-b" },
      body: {
        issue_id: "withdrawn-branches",
        repo_id: "mandible",
        branch: "feature/replacement-b",
      },
    });

    expect(branchB.status).toBe(201);
    expect((branchB.body as { id: string }).id).not.toBe(branchAId);
    expect(db.prepare(
      `SELECT branch, auth_request_id FROM work_units WHERE id = ?`,
    ).get(branchAId)).toEqual({
      branch: "feature/superseded-a",
      auth_request_id: "auth-withdrawn-a",
    });
  });

  it("keeps exact same-branch claim and activation idempotent", async () => {
    const id = await createBoundWorkUnit(
      "same-branch",
      "feature/same-branch",
      "auth-same-branch",
      "pending",
    );

    const claim = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "same-branch",
        repo_id: "mandible",
        branch: "feature/same-branch",
      },
    });

    const activate = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      body: {
        issue_id: "same-branch",
        repo_id: "mandible",
        branch: "feature/same-branch",
      },
    });

    expect(claim.body).toMatchObject({ id, state: "committed", existing: true });
    expect(activate.body).toMatchObject({ id, state: "committed" });
    expect(db.prepare(
      `SELECT COUNT(*) AS count, MIN(auth_request_id) AS auth_request_id
       FROM work_units WHERE issue_id = 'same-branch'`,
    ).get()).toEqual({ count: 1, auth_request_id: "auth-same-branch" });
  });

  it("adopts only an unbound null-branch unit and keeps later branches unique", async () => {
    const branchless = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: { issue_id: "branch-adoption", repo_id: "mandible" },
    });
    const adoptedId = (branchless.body as { id: string }).id;

    const adopted = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "branch-adoption",
        repo_id: "mandible",
        branch: "feature/adopted",
      },
    });
    const sibling = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "branch-adoption",
        repo_id: "mandible",
        branch: "feature/sibling",
      },
    });

    expect(adopted.body).toMatchObject({ id: adoptedId, existing: true });
    expect(sibling.status).toBe(201);
    expect((sibling.body as { id: string }).id).not.toBe(adoptedId);
    expect(db.prepare(
      `SELECT branch FROM work_units WHERE issue_id = 'branch-adoption' ORDER BY branch`,
    ).all()).toEqual([
      { branch: "feature/adopted" },
      { branch: "feature/sibling" },
    ]);
  });

  it("canonicalizes project aliases across claim, activate, and find", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO ledger_projects (
        id, project_key, display_name, remote_identity, upstream_identity,
        namespace_policy, created_at, updated_at
      ) VALUES ('project-dotfiles', 'dotfiles', 'dotfiles', 'example/dotfiles', '', 'remote', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO ledger_project_checkouts (
        id, project_id, work_repo_id, root, name, default_branch, remote_url,
        created_at, updated_at
      ) VALUES ('checkout-dotfiles', 'project-dotfiles', '.dotfiles', '/registered/dotfiles',
                '.dotfiles', 'main', '', ?, ?)`,
    ).run(now, now);

    const claim = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "dot123",
        repo_id: ".dotfiles",
        branch: "feature/dot123",
      },
    });
    expect(claim.status).toBe(201);
    const id = (claim.body as { id: string }).id;
    expect(db.prepare("SELECT repo_id FROM work_units WHERE id = ?").get(id))
      .toEqual({ repo_id: "dotfiles" });

    const activate = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      body: {
        issue_id: "dot123",
        repo_id: "/registered/dotfiles",
        branch: "feature/dot123",
      },
    });
    expect(activate.body).toMatchObject({ id, state: "committed" });

    const found = await router.invoke({
      method: "GET",
      url: "/api/work-units?repo_id=.dotfiles&issue_id=dot123",
    });
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      work_units: [expect.objectContaining({ id, repo_id: "dotfiles", state: "committed" })],
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_units").get()).toEqual({ count: 1 });
  });

  it("reuses an existing issue/repo/branch claim and normalizes blank session ids", async () => {
    const first = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        assigned_session_id: "",
      },
    });

    expect(first.status).toBe(201);
    const firstBody = first.body as { id: string };
    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = ?").get(firstBody.id))
      .toEqual({ assigned_session_id: null });

    const second = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        assigned_session_id: "  session-1  ",
      },
    });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ id: firstBody.id, existing: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_units").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = ?").get(firstBody.id))
      .toEqual({ assigned_session_id: "session-1" });
  });

  it("persists explicit ambient identity from claim, activate, and patch requests", async () => {
    const identity = resolveAmbientProviderIdentity({ CODEX_THREAD_ID: "thread-claim" });
    const claim = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      ambient_identity: identity,
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
      },
    });

    expect(claim.status).toBe(201);
    const claimBody = claim.body as { id: string };
    expect(
      db.prepare(
        `SELECT provider, provider_session_id, worker_provider_session_id
         FROM work_units WHERE id = ?`,
      ).get(claimBody.id),
    ).toEqual({
      provider: "codex",
      provider_session_id: "thread-claim",
      worker_provider_session_id: null,
    });

    await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        ambient_identity: { provider: "codex", provider_session_id: "thread-activate" },
      },
    });
    expect(
      db.prepare(
        `SELECT state, provider, provider_session_id, worker_provider_session_id
         FROM work_units WHERE id = ?`,
      ).get(claimBody.id),
    ).toEqual({
      state: "committed",
      provider: "codex",
      provider_session_id: "thread-activate",
      worker_provider_session_id: null,
    });

    const workerActivate = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        worker_owner: true,
        ambient_identity: { provider: "codex", provider_session_id: "thread-worker" },
      },
    });
    expect(workerActivate.status).toBe(200);
    expect(db.prepare(
      `SELECT provider, provider_session_id, worker_provider_session_id
       FROM work_units WHERE id = ?`,
    ).get(claimBody.id)).toEqual({
      provider: "codex",
      provider_session_id: "thread-worker",
      worker_provider_session_id: "thread-worker",
    });

    const patch = await router.invoke({
      method: "PATCH",
      url: `/api/work-units/${claimBody.id}`,
      body: {
        provider: "codex",
        provider_session_id: "thread-patch",
      },
    });
    expect(patch.status).toBe(200);
    expect(
      db.prepare(
        `SELECT provider, provider_session_id, worker_provider_session_id
         FROM work_units WHERE id = ?`,
      ).get(claimBody.id),
    ).toEqual({
      provider: "codex",
      provider_session_id: "thread-patch",
      worker_provider_session_id: "thread-worker",
    });
  });

  it("binds explicit worker ownership when activate auto-creates the work unit", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      ambient_identity: { provider: "codex", provider_session_id: "thread-auto-worker" },
      body: {
        issue_id: "auto123",
        repo_id: "mandible",
        branch: "feature/auto123",
        worker_owner: true,
      },
    });

    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    expect(db.prepare(
      `SELECT state, provider, provider_session_id, worker_provider_session_id
       FROM work_units WHERE id = ?`,
    ).get(id)).toEqual({
      state: "committed",
      provider: "codex",
      provider_session_id: "thread-auto-worker",
      worker_provider_session_id: "thread-auto-worker",
    });
  });

  it("rejects explicit worker ownership without ambient Codex identity", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        worker_owner: true,
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "worker_owner requires an allowlisted ambient Codex provider identity",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_units").get()).toEqual({ count: 0 });

    const nonCodex = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      ambient_identity: { provider: "claude", provider_session_id: "claude-coordinator" },
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        worker_owner: true,
      },
    });
    expect(nonCodex.status).toBe(400);
    expect(nonCodex.body).toEqual(response.body);
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_units").get()).toEqual({ count: 0 });
  });

  it("persists explicit ambient identity from release requests", async () => {
    const claim = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
      },
    });
    expect(claim.status).toBe(201);
    const claimBody = claim.body as { id: string };

    const bindWorker = await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      ambient_identity: { provider: "codex", provider_session_id: "thread-bound-worker" },
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        worker_owner: true,
      },
    });
    expect(bindWorker.status).toBe(200);

    const release = await router.invoke({
      method: "POST",
      url: "/api/work-units/release",
      ambient_identity: { provider: "codex", provider_session_id: "thread-release" },
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
      },
    });

    expect(release.status).toBe(200);
    expect(release.body).toMatchObject({ ok: true, released: 1 });
    expect(
      db.prepare(
        `SELECT state, assigned_session_id, provider, provider_session_id,
                worker_provider_session_id
         FROM work_units WHERE id = ?`,
      ).get(claimBody.id),
    ).toEqual({
      state: "open",
      assigned_session_id: null,
      provider: "codex",
      provider_session_id: "thread-release",
      worker_provider_session_id: "thread-bound-worker",
    });
  });

  it("persists explicit ambient identity from HTTP headers", async () => {
    const server = http.createServer((req, res) => {
      void router.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/work-units/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mandible-Ambient-Provider": "codex",
          "X-Mandible-Ambient-Provider-Session-Id": "thread-header",
        },
        body: JSON.stringify({
          issue_id: "header123",
          repo_id: "mandible",
          branch: "feature/header123",
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { id: string };
      expect(
        db.prepare("SELECT provider, provider_session_id FROM work_units WHERE id = ?").get(body.id),
      ).toEqual({ provider: "codex", provider_session_id: "thread-header" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("does not read daemon process CODEX_THREAD_ID without explicit request identity", async () => {
    const original = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "daemon-thread";
    try {
      const response = await router.invoke({
        method: "POST",
        url: "/api/work-units/claim",
        body: {
          issue_id: "noenv",
          repo_id: "mandible",
          branch: "feature/noenv",
        },
      });

      expect(response.status).toBe(201);
      const body = response.body as { id: string };
      expect(
        db.prepare("SELECT provider, provider_session_id FROM work_units WHERE id = ?").get(body.id),
      ).toEqual({ provider: null, provider_session_id: null });
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_THREAD_ID;
      } else {
        process.env.CODEX_THREAD_ID = original;
      }
    }
  });

  it("normalizes blank session ids written directly to the table", () => {
    db.prepare(
      `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, assigned_session_id, created_at)
       VALUES ('wu-direct', 'abc123', 'mandible', 'feature/direct', 'solo', 'open', '   ', 1)`
    ).run();

    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-direct'").get())
      .toEqual({ assigned_session_id: null });

    db.prepare("UPDATE work_units SET assigned_session_id = '' WHERE id = 'wu-direct'").run();

    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-direct'").get())
      .toEqual({ assigned_session_id: null });
  });

});
