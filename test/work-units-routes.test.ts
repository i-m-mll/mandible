import { setConversationArchiveState } from "../src/conversations/metadata.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";
import { resolveSessionAlias } from "../src/session-liveness.js";
import { getWorkerAssignments } from "../src/work-unit-worker.js";
import { registerHookRoutes } from "../src/routes/hooks.js";
import { SessionExecutionStore, applyExecutionEnvelope } from "../src/session-execution.js";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAmbientProviderIdentity } from "../src/ambient-provider-identity.js";
import { setDb, type Db } from "../src/db.js";
import { registerWorkUnitRoutes } from "../src/routes/work-units.js";
import { Router, type ClientAuthGate } from "../src/server.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { addProject } from "../src/ledger/project-registry.js";
import { LedgerStore } from "../src/ledger/store.js";
import { systemAction } from "../src/identity/resolver.js";
import { addGrant } from "../src/permissions/store.js";
import { createLedgerIssue, migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { addCredential, createUser } from "../src/users/store.js";
import { AuthQueue } from "../src/auth-queue.js";
import {
  configureSigningCredential, createAuthCheckRepo, createLedgerIssue as createAuthLedgerIssue,
  createLedgerProject, createMigratedDb, createNoopHookManager,
} from "./helpers/auth-queue-fixtures.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearCodexTaskLivenessCache } from "../src/codex-task-liveness.js";
import { longestEventLoopBlockMs, useStubCommand, SYNCHRONOUS_WAIT_MS, SLOW_COMMAND_SECONDS } from "./helpers/event-loop-blocking.js";

let db: Db;
let router: Router;

beforeEach(() => {
  db = migratedMemoryDb();
  setDb(db);
  const fixtures = addProject(db, { project_key: "work-unit-fixtures", display_name: "Work-unit fixtures" });
  for (const alias of [
    "custody-issue", "pending-branches", "withdrawn-branches", "same-branch", "branch-adoption",
    "dot123", "abc123", "auto123", "header123", "noenv", "release-issue",
  ]) {
    createLedgerIssue(db, { project_id: fixtures.id, alias });
  }
  router = new Router();
  registerWorkUnitRoutes(router, {} as never);
});

afterEach(() => {
  db.close();
});

describe("work unit routes", () => {
  it("lists in-progress units' liveness with a fixed number of queries, matching each unit's own read", async () => {
    db.prepare("INSERT INTO sessions (id, app, status, last_active, branch, conversation_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sess-live", "claude", "active", "2026-10-01T00:00:00Z", "feature/live-branch", "conv-live");
    db.prepare("INSERT INTO sessions (id, app, status, last_active, conversation_id) VALUES (?, ?, ?, ?, ?)")
      .run("sess-ended", "codex", "ended", "2026-09-01T00:00:00Z", "conv-ended");
    db.prepare(`INSERT INTO console_sessions (id, label, command, status, mandible_session_id, provider_session_id, created_at, updated_at)
      VALUES ('console-run', 'run', 'claude', 'running', NULL, 'thread-run', 1, 1)`).run();
    const identities: Array<Partial<Record<"assigned_session_id" | "provider_session_id" | "worker_provider_session_id" | "branch", string>>> = [
      { assigned_session_id: "sess-live" },
      { provider_session_id: "conv-ended" },
      { provider_session_id: "thread-run", worker_provider_session_id: "sess-ended" },
      { assigned_session_id: "never-recorded" },
      { branch: "feature/live-branch" },
      { branch: "feature/nobody" },
    ];
    const insert = db.prepare(`INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, assigned_session_id,
      provider_session_id, worker_provider_session_id, created_at) VALUES (?, 'abc123', 'mandible', ?, 'solo', ?, ?, ?, ?, ?)`);
    const seed = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        const identity = identities[i % identities.length]!;
        insert.run(`wu-${String(i).padStart(3, "0")}`, identity.branch ?? `feature/unit-${i}`, ["open", "committed", "resolved", "abandoned"][i % 4],
          identity.assigned_session_id ?? null, identity.provider_session_id ?? null, identity.worker_provider_session_id ?? null, i);
      }
    };
    const listed = async () => {
      const prepare = vi.spyOn(db, "prepare");
      const response = await router.invoke({ method: "GET", url: "/api/work-units" });
      const queries = prepare.mock.calls.length;
      prepare.mockRestore();
      expect(response.status).toBe(200);
      return { queries, units: (response.body as { work_units: Array<{ id: string; state: string; liveness?: { state: string } }> }).work_units };
    };

    seed(0, identities.length);
    const few = await listed();
    seed(identities.length, 10 * identities.length);
    const many = await listed();
    expect(many.units).toHaveLength(10 * identities.length);
    expect(many.queries).toBe(few.queries);
    const inProgress = many.units.filter((unit) => unit.state === "open" || unit.state === "committed");
    expect(new Set(inProgress.map((unit) => unit.liveness?.state))).toEqual(new Set(["live", "stopped"]));
    expect(many.units.filter((unit) => "liveness" in unit)).toEqual(inProgress);
    for (const unit of many.units) {
      const own = await router.invoke({ method: "GET", url: `/api/work-units/${unit.id}` });
      expect(unit, unit.id).toEqual(own.body);
    }
  });

  it("binds a claim to an issue in another project and refuses a ref that names no issue", async () => {
    const other = addProject(db, { project_key: "elsewhere", display_name: "Elsewhere" });
    const issue = createLedgerIssue(db, { project_id: other.id, alias: "far1234" });

    for (const [ref, branch] of [["far1234", "feature/bare"], ["elsewhere/far1234", "feature/qualified"]] as const) {
      const claim = await router.invoke({
        method: "POST", url: "/api/work-units/claim", body: { issue_id: ref, repo_id: "mandible", branch },
      });
      expect(claim.status).toBe(201);
      expect(claim.body).toMatchObject({ ledger_issue_id: issue.id });
    }

    const before = db.prepare("SELECT COUNT(*) AS count FROM work_units").get();
    for (const url of ["/api/work-units/claim", "/api/work-units/activate"]) {
      const refused = await router.invoke({
        method: "POST", url, body: { issue_id: "nosuch99", repo_id: "mandible", branch: "feature/none" },
      });
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ error: "issue_not_found" });
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_units").get()).toEqual(before);
  });

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
    registerWorkUnitRoutes(credentialRouter, {} as never);
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

  it("corrects an explicit existing kind with exact custody and current umbrella authority", async () => {
    const agent = createUser(db, { slug: "kind-custodian", kind: "agent", display_name: "Custodian" });
    const credential = addCredential(db, agent.id, { type: "api_token", fingerprint: "kind-own" });
    const other = addCredential(db, agent.id, { type: "api_token", fingerprint: "kind-other" });
    const project = addProject(db, { project_key: "kind-project", display_name: "Kind project" });
    addGrant(db, { subject_type: "user", subject: agent.id, resource_type: "project", resource: project.id, permission: "write" });
    const issue = createLedgerIssue(db, { project_id: project.id, kind: "umbrella" });
    const store = new LedgerStore(db);
    const guarded = new Router({ clientAuth: {
      authenticate: token => token === 'own' || token === 'other' ? {
        user_id: agent.id, slug: agent.slug, method: "api_token", source: "in_process",
        credential_id: token === 'own' ? credential.id : other.id, effect_ceiling: PRODUCTION_EFFECTS,
      } : null,
      mode: () => 'strict', recordUnattributedWrite: () => undefined,
    } });
    registerWorkUnitRoutes(guarded, {} as never);
    const request = { issue_id: issue.id, repo_id: 'kind-project', branch: 'feature/integration' };
    const claimed = await guarded.invoke({ method: 'POST', url: '/api/work-units/claim', credential: 'own', body: request });
    expect(claimed.status).toBe(201);
    const id = (claimed.body as { id: string }).id;
    const before = db.prepare('SELECT * FROM work_units WHERE id = ?').get(id) as Record<string, unknown>;
    const checkpoint = (ownerCredential: string, createdAt: number) => store.addIssueCheckpoint(issue.id, {
      kind: 'parent-role', payload: { authenticated_user_id: agent.id, authenticated_credential_id: ownerCredential, assumed_at: createdAt },
      attribution: systemAction(), created_at: createdAt,
    }).id;
    const previous = checkpoint(credential.id, 1);
    const current = checkpoint(credential.id, 2);
    const promote = { ...request, kind: 'integration', expected_generation: 1, parent_role_checkpoint_id: current };
    for (const [token, body] of [
      ['own', { ...request, kind: 'invalid' }],
      ['own', { ...request, kind: 'integration' }],
      ['own', { ...promote, expected_generation: 0 }],
      ['other', promote],
      ['own', { ...promote, parent_role_checkpoint_id: previous }],
      ['own', { ...promote, branch: 'feature/missing' }],
    ] as const) {
      expect((await guarded.invoke({ method: 'POST', url: '/api/work-units/claim', credential: token, body })).status).toBeGreaterThanOrEqual(400);
      expect(db.prepare('SELECT * FROM work_units WHERE id = ?').get(id)).toEqual(before);
    }
    // The short checkpoint id `parent-role assume` prints (chk_ + ten characters) is accepted.
    const promoted = await guarded.invoke({ method: 'POST', url: '/api/work-units/claim', credential: 'own',
      body: { ...promote, parent_role_checkpoint_id: current.slice(0, 'chk_'.length + 10) } });
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ id, kind: 'integration', custody_generation: 1, existing: true });
    expect(db.prepare('SELECT * FROM work_units WHERE id = ?').get(id)).toEqual({ ...before!, kind: 'integration' });
    const retry = await guarded.invoke({ method: 'POST', url: '/api/work-units/claim', credential: 'own', body: promote });
    expect(retry.status).toBe(200);
    expect(store.listIssueCheckpoints(issue.id, 'work-unit-kind')).toHaveLength(1);
    expect((await guarded.invoke({ method: 'POST', url: '/api/work-units/claim', credential: 'own',
      body: { ...promote, kind: 'solo' } })).status).toBe(409);
    expect(db.prepare('SELECT kind FROM work_units WHERE id = ?').get(id)).toEqual({ kind: 'integration' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM work_units').get()).toEqual({ count: 1 });
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
      worker_provider_session_id: null,
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
      worker_provider_session_id: null,
    });
  });

  it.each(["codex", "claude"] as const)("automatically binds the actual %s child worker and completes only its resolved assignments", async (provider) => {
    const source = provider === "claude" ? "claude_code" : provider;
    const agent = createUser(db, { slug: "automatic-owner", kind: "agent", display_name: "Owner" });
    const credential = addCredential(db, agent.id, { type: "api_token", fingerprint: "automatic-owner" });
    const ownedRouter = new Router({ clientAuth: { authenticate: () => ({ user_id: agent.id, slug: agent.slug,
      method: "api_token", source: "in_process", credential_id: credential.id, effect_ceiling: PRODUCTION_EFFECTS }),
      mode: () => "strict", recordUnattributedWrite: () => undefined } });
    registerWorkUnitRoutes(ownedRouter, {} as never);
    const parent = "019a0000-0000-7000-8000-000000000001";
    const worker = "019a0000-0000-7000-8000-000000000002";
    const creator = "019a0000-0000-7000-8000-000000000003";
    const insert = db.prepare(`INSERT INTO conversations
      (id,source,session_id,source_path,source_hash,source_mtime,started_at,parent_source,parent_session_id,
       parent_conversation_id,opening_lineage,opening_line) VALUES (?, ?, ?, ?, '', 1, '2026-10-01', ?, ?, ?, ?, ?)`);
    insert.run("parent", source, parent, "/parent", null, null, null, "none", null);
    insert.run("worker", source, worker, "/worker", source, parent, "parent", "child",
      `[mandible child parent=${provider}:${parent} parent-role=coordinator role=worker]`);
    insert.run("creator", source, creator, "/creator", source, parent, "parent", "child",
      `[mandible child parent=${provider}:${parent} parent-role=coordinator role=coordinator]`);
    db.prepare("INSERT INTO sessions (id,app,status,conversation_id) VALUES (?, ?, 'ended', ?)").run(worker, provider, worker);
    const claim = await ownedRouter.invoke({ credential: "own", method: "POST", url: "/api/work-units/claim",
      ambient_identity: { provider, provider_session_id: worker },
      body: { issue_id: "abc123", repo_id: "mandible", branch: "feature/own-worker" } });
    expect(claim.status).toBe(201);
    const first = (claim.body as { id: string }).id;
    const create = await ownedRouter.invoke({ credential: "own", method: "POST", url: "/api/work-units/activate",
      ambient_identity: { provider, provider_session_id: creator },
      body: { issue_id: "auto123", repo_id: "mandible", branch: "feature/dispatched" } });
    const second = (create.body as { id: string }).id;
    expect(db.prepare("SELECT worker_provider_session_id FROM work_units WHERE id = ?").get(second))
      .toEqual({ worker_provider_session_id: null });
    expect((await ownedRouter.invoke({ credential: "own", method: "PATCH", url: `/api/work-units/${second}`,
      ambient_identity: { provider, provider_session_id: creator },
      body: { expected_generation: 1, assigned_session_id: worker } })).status).toBe(200);
    expect(db.prepare("SELECT provider_session_id, worker_provider, worker_provider_session_id FROM work_units WHERE id = ?").get(second))
      .toEqual({ provider_session_id: creator, worker_provider: source, worker_provider_session_id: worker });
    const identity = { provider: source, provider_session_id: worker };
    expect(getWorkerAssignments(db, identity).unresolvedUnitIds.sort()).toEqual([first, second].sort());
    expect((await ownedRouter.invoke({ credential: "own", method: "PATCH", url: `/api/work-units/${first}`, body: { expected_generation: 1, state: "resolved" } })).status).toBe(200);
    expect(getWorkerAssignments(db, identity).complete).toBe(false);
    expect((await ownedRouter.invoke({ credential: "own", method: "PATCH", url: `/api/work-units/${second}`, body: { expected_generation: 1, state: "resolved" } })).status).toBe(200);
    expect(getWorkerAssignments(db, identity).complete).toBe(true);
    expect(new LedgerStore(db).getIssue((db.prepare("SELECT ledger_issue_id FROM work_units WHERE id = ?").get(first) as { ledger_issue_id: string }).ledger_issue_id)?.status).toBe("open");
  });

  it("retains archived and restored responsibility after unload while ordinary dead assignments clear", async () => {
    const agent = createUser(db, { slug: "resume-owner", kind: "agent", display_name: "Owner" });
    const credential = addCredential(db, agent.id, { type: "api_token", fingerprint: "resume-owner" });
    const owned = new Router({ clientAuth: { authenticate: () => ({ user_id: agent.id, slug: agent.slug,
      method: "api_token", source: "in_process", credential_id: credential.id, effect_ceiling: PRODUCTION_EFFECTS }),
      mode: () => "strict", recordUnattributedWrite: () => undefined } });
    registerWorkUnitRoutes(owned, {} as never);
    db.prepare(`INSERT INTO conversations(id,source,session_id,source_path,source_hash,source_mtime,started_at)
      VALUES ('retained-chat','claude_code','retained-native','/retained','',1,'2026-10-01')`).run();
    const units: string[] = [];
    for (const native of ["retained-native", "ordinary-native"]) {
      db.prepare("INSERT INTO sessions(id,app,status,conversation_id) VALUES (?, 'claude', 'ended', ?)").run(native, native);
      const claim = await owned.invoke({ method: "POST", url: "/api/work-units/claim", credential: "own",
        ambient_identity: { provider: "claude", provider_session_id: native },
        body: { issue_id: "abc123", repo_id: "mandible", branch: `feature/${native}`, assigned_session_id: native } });
      expect(claim.status).toBe(201);
      units.push((claim.body as { id: string }).id);
    }
    setConversationArchiveState(db, { conversation_id: "retained-chat", archived: true, cause: "manual" }, { attribution: systemAction() });
    setConversationArchiveState(db, { conversation_id: "retained-chat", archived: false, cause: "manual" }, { attribution: systemAction() });
    await new WorkUnitReconciler(() => undefined, { archiver: { archive: async () => undefined, unarchive: async () => undefined },
      resolveSession: (database, id) => resolveSessionAlias(database, id) }).reconcile();
    expect(db.prepare("SELECT assigned_session_id, owner_credential_id, custody_generation FROM work_units WHERE id = ?").get(units[0]))
      .toEqual({ assigned_session_id: "retained-native", owner_credential_id: credential.id, custody_generation: 1 });
    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = ?").get(units[1])).toEqual({ assigned_session_id: null });
    const check = await owned.invoke({ method: "GET", credential: "own",
      url: "/api/work-units/custody-check?repo_id=mandible&branch=feature/retained-native",
      ambient_identity: { provider: "claude", provider_session_id: "different-native" } });
    expect(check.body).toMatchObject({ outcome: "held", holder_liveness: { state: "stopped", responsibility_retained: true } });
    const takeover = await owned.invoke({ method: "POST", url: `/api/work-units/${units[0]}/custody/assume`, credential: "own",
      ambient_identity: { provider: "claude", provider_session_id: "different-native" },
      body: { expected_generation: 1, reason: "Try taking over an unloaded holder" } });
    expect(takeover.status).toBe(409);
    const resumed = await owned.invoke({ method: "POST", url: "/api/work-units/activate", credential: "own",
      ambient_identity: { provider: "claude", provider_session_id: "retained-native" },
      body: { issue_id: "abc123", repo_id: "mandible", branch: "feature/retained-native" } });
    expect(resumed.status).toBe(200);
    expect(db.prepare("SELECT assigned_session_id, owner_credential_id, custody_generation FROM work_units WHERE id = ?").get(units[0]))
      .toEqual({ assigned_session_id: "retained-native", owner_credential_id: credential.id, custody_generation: 1 });
    const reassigned = await owned.invoke({ method: "PATCH", url: `/api/work-units/${units[0]}`, credential: "own",
      body: { expected_generation: 1, assigned_session_id: "ordinary-native" } });
    expect(reassigned.status).toBe(200);
    await new WorkUnitReconciler(() => undefined, { archiver: { archive: async () => undefined, unarchive: async () => undefined },
      resolveSession: (database, id) => resolveSessionAlias(database, id) }).reconcile();
    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = ?").get(units[0])).toEqual({ assigned_session_id: null });
  });

  it("guards exact releases and authority-bearing updates without changing sibling assignments", async () => {
    const agent = createUser(db, { slug: "release-owner", kind: "agent", display_name: "Owner" });
    const own = addCredential(db, agent.id, { type: "api_token", fingerprint: "release-own" });
    const other = addCredential(db, agent.id, { type: "api_token", fingerprint: "release-other" });
    const guarded = new Router({ clientAuth: {
      authenticate: token => token === 'own' || token === 'other' ? {
        user_id: agent.id, slug: agent.slug, method: "api_token", source: "in_process",
        credential_id: token === 'own' ? own.id : other.id, effect_ceiling: PRODUCTION_EFFECTS,
      } : null,
      mode: () => 'strict', recordUnattributedWrite: () => undefined,
    } });
    registerWorkUnitRoutes(guarded, {} as never);
    const create = async (branch: string) => {
      const response = await guarded.invoke({ method: 'POST', url: '/api/work-units/activate',
        credential: 'own', body: { issue_id: 'release-issue', repo_id: 'mandible', branch } });
      expect(response.status).toBe(201);
      return (response.body as { id: string }).id;
    };
    const first = await create('feature/first');
    const second = await create('feature/second');
    const before = db.prepare('SELECT * FROM work_units ORDER BY id').all();
    expect((await guarded.invoke({ method: 'POST', url: '/api/work-units/activate', credential: 'own',
      body: { issue_id: 'release-issue', repo_id: 'mandible' } })).status).toBe(409);
    for (const body of [
      { issue_id: 'release-issue', repo_id: 'mandible', expected_generation: 1 },
      { id: first, expected_generation: 0 },
    ]) {
      expect((await guarded.invoke({ method: 'POST', url: '/api/work-units/release', credential: 'own', body })).status).toBeGreaterThanOrEqual(400);
    }
    for (const [method, url, body] of [
      ['POST', '/api/work-units/release', { id: first, expected_generation: 1 }],
      ['PATCH', `/api/work-units/${first}`, { state: 'resolved', expected_generation: 1 }],
      ['POST', '/api/work-units/activate', { issue_id: 'release-issue', repo_id: 'mandible', branch: 'feature/first' }],
    ] as const) {
      expect((await guarded.invoke({ method, url, credential: 'other', body })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await guarded.invoke({ method: 'PATCH', url: `/api/work-units/${first}`, credential: 'own',
      body: { state: 'resolved', expected_generation: 0 } })).status).toBe(409);
    expect(db.prepare('SELECT * FROM work_units ORDER BY id').all()).toEqual(before);
    const metadata = await guarded.invoke({ method: 'PATCH', url: `/api/work-units/${second}`, credential: 'other',
      body: { continuation: 'Review the lane' } });
    expect(metadata.status).toBe(200);
    db.prepare('UPDATE work_units SET continuation = NULL WHERE id = ?').run(second);
    const snapshot = [{ id: first, expected_generation: 1 }, { id: second, expected_generation: 0 }];
    expect((await guarded.invoke({ method: 'POST', url: '/api/work-units/release-issue', credential: 'own',
      body: { issue_id: 'release-issue', repo_id: 'mandible', work_units: snapshot } })).status).toBe(409);
    expect(db.prepare('SELECT * FROM work_units ORDER BY id').all()).toEqual(before);
    const release = await guarded.invoke({ method: 'POST', url: '/api/work-units/release', credential: 'own',
      body: { repo_id: 'mandible', branch: 'feature/first', expected_generation: 1 } });
    expect(release.status).toBe(200);
    expect(db.prepare('SELECT state FROM work_units WHERE id = ?').get(first)).toEqual({ state: 'abandoned' });
    expect(db.prepare('SELECT * FROM work_units WHERE id = ?').get(second)).toEqual(before.find((row: any) => row.id === second));
    const retry = await guarded.invoke({ method: 'POST', url: '/api/work-units/release', credential: 'own',
      body: { id: first, expected_generation: 1 } });
    expect(retry.body).toMatchObject({ released: 0, unchanged: true });
    expect((await guarded.invoke({ method: 'PATCH', url: `/api/work-units/${second}`, credential: 'own',
      body: { state: 'resolved', expected_generation: 1 } })).status).toBe(200);
    const third = await create('feature/third');
    const fourth = await create('feature/fourth');
    expect((await guarded.invoke({ method: 'POST', url: '/api/work-units/release-issue', credential: 'own',
      body: { issue_id: 'release-issue', repo_id: 'mandible', work_units: [
        { id: third, expected_generation: 1 }, { id: fourth, expected_generation: 1 },
      ] } })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_units WHERE state IN ('open', 'committed')").get()).toEqual({ count: 0 });
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

// Issue 72b00f8 — agents take over a stopped holder's unit; a live holder needs
// the operator, whose approval hands custody to the requesting agent.
describe("work-unit custody takeover", () => {
  let repo: string;
  let queue: AuthQueue;
  let guarded: Router;
  let projectKey: string;
  let issueId: string;
  let operatorId: string;
  let codexScan: "live" | "not_live" | "unavailable";
  let clientAuth: ClientAuthGate;
  const credentials: Record<string, { user_id: string; credential_id: string; slug: string }> = {};

  beforeEach(() => {
    db.close();
    db = createMigratedDb();
    setDb(db);
    repo = createAuthCheckRepo();
    operatorId = configureSigningCredential(db, repo, "ssh_key").operatorId;
    const project = createLedgerProject(db, repo);
    projectKey = project.project.id;
    issueId = createAuthLedgerIssue(db, project.project.id, "takeover").id;
    for (const [token, slug] of [["holder", "codex-holder"], ["taker", "claude-taker"], ["rival", "gemini-rival"]] as const) {
      const user = createUser(db, { slug, kind: "agent", display_name: slug });
      const credential = addCredential(db, user.id, { type: "api_token", fingerprint: `${slug}-token` });
      credentials[token] = { user_id: user.id, credential_id: credential.id, slug };
    }
    queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false,
      executor: async () => { throw new Error("custody transfers never reach the executor"); } });
    clientAuth = {
      authenticate: (token) => credentials[token] ? {
        user_id: credentials[token].user_id, slug: credentials[token].slug, method: "api_token", source: "in_process",
        credential_id: credentials[token].credential_id, effect_ceiling: PRODUCTION_EFFECTS,
      } : null,
      mode: () => "strict",
      recordUnattributedWrite: () => undefined,
    };
    guarded = new Router({ clientAuth });
    registerHookRoutes(guarded);
    codexScan = "unavailable";
    registerWorkUnitRoutes(guarded, {} as never, undefined, {
      authQueue: queue, readCodexTaskLiveness: () => ({ status: codexScan }) });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearCodexTaskLivenessCache();
    (await queue.dispose());
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("reads a Codex holder's writer lock off the event loop for the custody check", async () => {
    const thread = "019a0000-0000-7000-8000-0000000000e5";
    const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "custody-codex-"));
    const lockDir = path.join(codexRoot, "thread-writer-locks");
    fs.mkdirSync(lockDir);
    db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, session_id, cwd, branch, updated_at)
      VALUES ('codex-holder', 'codex', ?, 'sha', 1, 'Codex holder', '2026-10-24T00:00:00Z', ?, ?, 'feature/takeover', '2026-10-24T00:00:00Z')`)
      .run(path.join(codexRoot, "sessions", "2026", "10", "24", `rollout-${thread}.jsonl`), thread, repo);
    const scanned = new Router({ clientAuth });
    registerWorkUnitRoutes(scanned, {} as never, undefined, { authQueue: queue });
    expect((await scanned.invoke({ method: "POST", url: "/api/work-units/claim", credential: "holder",
      ambient_identity: { provider: "codex", provider_session_id: thread },
      body: { issue_id: issueId, repo_id: projectKey, branch: "feature/takeover" } })).status).toBe(201);
    clearCodexTaskLivenessCache();
    useStubCommand("lsof", `sleep ${SLOW_COMMAND_SECONDS}\nprintf 'p4242\\nccodex\\nn%s\\n' ${JSON.stringify(path.join(lockDir, `${thread}.lock`))}`);

    let body: unknown;
    const blockedMs = await longestEventLoopBlockMs(async () => {
      body = (await scanned.invoke({ method: "GET", credential: "taker",
        url: `/api/work-units/custody-check?repo_id=${encodeURIComponent(projectKey)}&branch=feature/takeover` })).body;
    });

    expect(blockedMs).toBeLessThan(SYNCHRONOUS_WAIT_MS);
    expect(body).toMatchObject({ outcome: "held", holder_liveness: { state: "live" } });
    fs.rmSync(codexRoot, { recursive: true, force: true });
  });

  async function heldUnit(holderStatus: "active" | "dead"): Promise<string> {
    const claimed = await guarded.invoke({ method: "POST", url: "/api/work-units/claim", credential: "holder",
      ambient_identity: { provider: "codex", provider_session_id: "holder-thread" },
      body: { issue_id: issueId, repo_id: projectKey, branch: "feature/takeover" } });
    expect(claimed.status).toBe(201);
    db.prepare("INSERT INTO sessions (id, app, status, pid, conversation_id) VALUES ('holder-session', 'codex', ?, 4242, 'holder-thread')")
      .run(holderStatus);
    return (claimed.body as { id: string }).id;
  }

  const assume = (token: string, id: string, extra: Record<string, unknown> = {}) => guarded.invoke({
    method: "POST", url: `/api/work-units/${id}/custody/assume`, credential: token,
    ambient_identity: { provider: "claude", provider_session_id: `${token}-session` },
    body: { expected_generation: 1, reason: "Continue the stopped holder's branch.", ...extra },
  });
  const check = (token: string, session?: string) => guarded.invoke({ method: "GET", credential: token,
    ...(session ? { ambient_identity: { provider: "codex", provider_session_id: session } } : {}),
    url: `/api/work-units/custody-check?repo_id=${encodeURIComponent(projectKey)}&branch=feature/takeover` });
  const owner = (id: string) => db.prepare("SELECT owner_credential_id, custody_generation FROM work_units WHERE id = ?").get(id);

  it.each(["claude", "codex"])("keeps live %s custody through native turn stops, then permits physical-stop takeover", async (provider) => {
    const id = await heldUnit("active");
    db.prepare("UPDATE sessions SET app = ? WHERE id = 'holder-session'").run(provider);
    db.prepare("UPDATE work_units SET provider = ? WHERE id = ?").run(provider, id);
    const report = (hook_event_name: string, extra: Record<string, unknown> = {}) => applyExecutionEnvelope(new SessionExecutionStore(db),
      { provider, session_id: "holder-thread", hook_event_name, turn_id: "native-turn", ...extra }, Date.now());
    for (const [event, extra, kind] of [
      ["UserPromptSubmit", {}, "working"], ["Stop", {}, "stopped"], ["UserPromptSubmit", {}, "working"],
      ...(provider === "claude"
        ? [["StopFailure", { error: "rate_limit", error_details: "429 Too Many Requests", last_assistant_message: "API Error" }, "failure"]] as const
        : [["Interrupt", {}, "interrupted"]] as const),
      ["UserPromptSubmit", {}, "working"], ["SessionEnd", { reason: "exit" }, "ended"],
    ] as const) {
      const result = report(event, extra);
      if (!result.ok) throw new Error(result.error);
      expect(result.value).toMatchObject({ status: "applied", observation: { turn_id: "native-turn", state: { kind } } });
      const observation = result.value.observation as { state: Record<string, unknown> };
      if (kind === "failure") expect(observation.state.error).toEqual({ type: "rate_limit", details: "429 Too Many Requests", message: "API Error", data: null });
      else expect(observation.state).not.toHaveProperty("error");
      expect((await assume("taker", id)).body).toMatchObject({ code: "custody_holder_live", holder_liveness: { state: "live", execution: { state: { kind } } } });
    }
    expect(owner(id)).toMatchObject({ custody_generation: 1 });
    db.prepare("UPDATE sessions SET status = 'dead' WHERE id = 'holder-session'").run();
    expect((await assume("taker", id)).status).toBe(200);
    expect((await assume("rival", id)).body).toMatchObject({ code: "custody_generation_conflict" });
    const receipt = db.prepare("SELECT prior_holder_liveness_json FROM work_unit_custody_events WHERE work_unit_id = ? AND authority_path = 'stopped_holder_takeover'").get(id) as { prior_holder_liveness_json: string };
    expect(JSON.parse(receipt.prior_holder_liveness_json)).toMatchObject({ state: "stopped", execution: { state: { kind: "ended", reason: "exit" } } });
  });

  it("lets one agent take over a stopped holder's unit and fences the previous holder", async () => {
    const id = await heldUnit("dead");
    expect((await check("taker")).body).toMatchObject({ outcome: "takeover_available", may_commit: false,
      holder: { user_slug: "codex-holder" }, holder_liveness: { state: "stopped", status: "dead" } });

    const [won, lost] = [await assume("taker", id), await assume("rival", id)];
    expect(won.status).toBe(200);
    expect(won.body).toMatchObject({ authority_path: "stopped_holder_takeover",
      work_unit: { owner_credential_id: credentials.taker.credential_id, custody_generation: 2,
        provider: "claude", provider_session_id: "taker-session" } });
    expect(lost.status).toBe(409);
    expect(lost.body).toMatchObject({ code: "custody_generation_conflict" });
    expect(owner(id)).toEqual({ owner_credential_id: credentials.taker.credential_id, custody_generation: 2 });

    const receipts = db.prepare("SELECT authority_path, prior_credential_id, new_credential_id, prior_holder_liveness_json FROM work_unit_custody_events WHERE work_unit_id = ? AND authority_path != 'initial_assignment'").all(id) as Array<Record<string, string>>;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ authority_path: "stopped_holder_takeover",
      prior_credential_id: credentials.holder.credential_id, new_credential_id: credentials.taker.credential_id });
    expect(JSON.parse(receipts[0]!.prior_holder_liveness_json)).toMatchObject({ state: "stopped", session_id: "holder-session" });
    const comments = db.prepare("SELECT body FROM ledger_comments WHERE issue_id = ?").all(issueId) as Array<{ body: string }>;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("moved from codex-holder (credential");
    expect(comments[0]!.body).toContain("to claude-taker (credential");

    const stale = await guarded.invoke({ method: "POST", url: "/api/work-units/release", credential: "holder",
      body: { id, expected_generation: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "custody_generation_conflict" });
    expect((await check("taker")).body).toMatchObject({ outcome: "clear", may_commit: true });
  });

  it("decides a Codex holder with no session record from its thread-writer lock", async () => {
    const thread = "01a0c6e2-4442-7640-a0c4-230134688d18";
    const claimed = await guarded.invoke({ method: "POST", url: "/api/work-units/claim", credential: "holder",
      ambient_identity: { provider: "codex", provider_session_id: thread },
      body: { issue_id: issueId, repo_id: projectKey, branch: "feature/takeover" } });
    expect(claimed.status).toBe(201);
    db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title,
        started_at, ended_at, session_id, updated_at)
      VALUES ('holder-rollout', 'codex', ?, 'sha', 1, 'Holder', '2026-09-22T02:11:53Z', '2026-09-28T01:03:52.054Z', ?, '2026-09-28 01:17:54')`)
      .run(`/tmp/.codex/sessions/2026/09/21/rollout-${thread}.jsonl`, thread);

    expect((await check("taker")).body).toMatchObject({ outcome: "held", holder_liveness: { state: "unknown" } });
    codexScan = "not_live";
    expect((await check("taker")).body).toMatchObject({ outcome: "takeover_available",
      holder_liveness: { state: "stopped", session_id: thread, last_activity: Date.parse("2026-09-28T01:03:52.054Z") } });
  });

  it("holds a unit for its recorded session against another session of the same credential", async () => {
    const id = await heldUnit("active");
    const twin = (body: Record<string, unknown> = {}) => guarded.invoke({
      method: "POST", url: `/api/work-units/${id}/custody/assume`, credential: "holder",
      ambient_identity: { provider: "codex", provider_session_id: "twin-thread" },
      body: { expected_generation: 1, reason: "Second session on the same branch.", ...body },
    });
    expect((await check("holder", "holder-thread")).body).toMatchObject({ outcome: "clear" });
    expect((await check("holder", "twin-thread")).body).toMatchObject({ outcome: "held",
      holder_liveness: { state: "live", session_id: "holder-session" } });
    const refused = await twin();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "custody_holder_live", holder_liveness: { session_id: "holder-session" } });
    expect((await guarded.invoke({ method: "POST", url: "/api/work-units/activate", credential: "holder",
      ambient_identity: { provider: "codex", provider_session_id: "twin-thread" },
      body: { issue_id: issueId, repo_id: projectKey, branch: "feature/takeover" } })).body)
      .toMatchObject({ code: "custody_holder_live" });
    expect(owner(id)).toEqual({ owner_credential_id: credentials.holder.credential_id, custody_generation: 1 });

    db.prepare("UPDATE sessions SET status = 'dead' WHERE id = 'holder-session'").run();
    expect((await check("holder", "twin-thread")).body).toMatchObject({ outcome: "takeover_available" });
    const taken = await twin();
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ authority_path: "stopped_holder_takeover", work_unit: {
      owner_credential_id: credentials.holder.credential_id, custody_generation: 2, provider_session_id: "twin-thread" } });
    expect((await check("holder", "twin-thread")).body).toMatchObject({ outcome: "clear" });
    expect((db.prepare("SELECT body FROM ledger_comments WHERE issue_id = ?").get(issueId) as { body: string }).body)
      .toContain("moved from session holder-s to session twin-thr of codex-holder");
  });

  it("refuses a live holder, names it, and transfers custody to the agent on operator approval", async () => {
    const id = await heldUnit("active");
    expect((await check("taker")).body).toMatchObject({ outcome: "held", may_commit: false,
      holder_liveness: { state: "live" } });

    const refused = await assume("taker", id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "custody_holder_live", holder: { user_slug: "codex-holder" } });
    expect((refused.body as { takeover_command: string }).takeover_command).toContain("--request-approval");
    expect(owner(id)).toEqual({ owner_credential_id: credentials.holder.credential_id, custody_generation: 1 });

    const requested = await assume("taker", id, { request_approval: true });
    expect(requested.status).toBe(202);
    const requestId = (requested.body as { approval_request_id: string }).approval_request_id;
    const again = await assume("taker", id, { request_approval: true });
    expect(again.body).toMatchObject({ approval_request_id: requestId, existing: true });
    expect((await queue.getRequest(requestId))).toMatchObject({ type: "custody-transfer", status: "pending",
      requested_by_user_id: credentials.taker.user_id, requester_credential_id: credentials.taker.credential_id });

    expect((await queue.getRequest(requestId))!.commit_message_digest).toBeNull();
    const completed = await queue.approveWithOperatorProof(requestId, operatorId);
    expect(completed).toMatchObject({ status: "completed", exit_code: 0, approved_by_user_id: operatorId });
    expect(owner(id)).toEqual({ owner_credential_id: credentials.taker.credential_id, custody_generation: 2 });
    expect(db.prepare("SELECT authority_path, auth_request_id FROM work_unit_custody_events WHERE work_unit_id = ? AND new_generation = 2").get(id))
      .toEqual({ authority_path: "operator_approval", auth_request_id: requestId });
  });
});

