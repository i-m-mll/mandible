import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { getOperator, setupOperator } from "../src/users/store.js";
import { assignmentTargetForSession, resolveAssignmentTarget } from "../src/work-unit-assignment.js";
import { mutateWorkUnit } from "../src/work-unit-history.js";
import { setConversationArchiveState } from "../src/conversations/metadata.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";
import { resolveSessionAlias } from "../src/session-liveness.js";
import { getWorkerAssignments, hasArchivedResponsibility } from "../src/work-unit-worker.js";
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
import { useCommandProbe } from "./helpers/event-loop-blocking.js";

let db: Db;
let router: Router;

beforeEach(() => {
  db = migratedMemoryDb();
  setDb(db);
  if (!getOperator(db)) setupOperator(db, { slug: "work-unit-test-operator" });
  const fixtures = addProject(db, { project_key: "mandible", display_name: "Work-unit fixtures" });
  for (const alias of [
    "custody-issue", "pending-branches", "withdrawn-branches", "same-branch", "branch-adoption",
    "dot123", "abc123", "auto123", "header123", "noenv", "release-issue",
  ]) {
    createLedgerIssue(db, { project_id: fixtures.id, alias });
  }
  router = authenticatedTestRouter(getOperator(db)!);
  registerWorkUnitRoutes(router, {} as never);
});

afterEach(() => {
  db.close();
});

describe("work unit routes", () => {
  it("keeps provider-ambiguous aliases unbound and blocks completion of every possible worker", async () => {
    const native = "019a0000-0000-7000-8000-00000000000b";
    const parent = "019a0000-0000-7000-8000-00000000000c";
    db.prepare("INSERT INTO sessions(id,app,status,conversation_id) VALUES ('ambiguous-codex','codex','ended',?),('ambiguous-claude','claude','ended',?)").run(native, native);
    const insert = db.prepare(`INSERT INTO conversations(id,source,session_id,source_path,source_hash,source_mtime,started_at,
      parent_source,parent_session_id,parent_conversation_id,opening_lineage,opening_line)
      VALUES (?, ?, ?, ?, '', 1, '2026-10-01', ?, ?, ?, ?, ?)`);
    insert.run("ambiguous-parent", "claude_code", parent, "/ambiguous-parent", null, null, null, "none", null);
    insert.run("ambiguous-worker", "claude_code", native, "/ambiguous-worker", "claude_code", parent, "ambiguous-parent", "child",
      `[mandible child parent=claude:${parent} parent-role=coordinator role=worker]`);
    const target = assignmentTargetForSession(db, native);
    expect(target).toEqual({ kind: "alias", session_id: native });
    expect(resolveAssignmentTarget(db, target)).toBeNull();
    expect(assignmentTargetForSession(db, "ambiguous-codex")).toEqual({ kind: "native", provider: "codex", session_id: native });
    const pending = await router.invoke({ method: "POST", url: "/api/work-units/claim",
      body: { issue_id: "abc123", repo_id: "mandible", branch: "feature/ambiguous", assigned_session_id: native } });
    expect(pending.status).toBe(201);
    const pendingId = (pending.body as { id: string }).id;
    expect(db.prepare("SELECT assignment_target_json,worker_provider FROM work_units WHERE id = ?").get(pendingId))
      .toEqual({ assignment_target_json: JSON.stringify(target), worker_provider: null });
    const exact = await router.invoke({ method: "POST", url: "/api/work-units/claim",
      ambient_identity: { provider: "claude", provider_session_id: native },
      body: { issue_id: "abc123", repo_id: "mandible", branch: "feature/exact-worker" } });
    const exactId = (exact.body as { id: string }).id;
    mutateWorkUnit(db, exactId, () => db.prepare("UPDATE work_units SET state = 'resolved' WHERE id = ?").run(exactId));
    expect(getWorkerAssignments(db, { provider: "claude_code", provider_session_id: native }))
      .toEqual({ resolvedUnitIds: [exactId], unresolvedUnitIds: [pendingId], complete: false });
    expect(getWorkerAssignments(db, { provider: "codex", provider_session_id: native }).unresolvedUnitIds).toEqual([pendingId]);
    mutateWorkUnit(db, pendingId, () => db.prepare("UPDATE work_units SET state = 'resolved' WHERE id = ?").run(pendingId));
    expect(db.prepare("SELECT worker_provider,worker_provider_session_id FROM work_units WHERE id = ?").get(pendingId))
      .toEqual({ worker_provider: null, worker_provider_session_id: null });
    expect(getWorkerAssignments(db, { provider: "claude_code", provider_session_id: native }).resolvedUnitIds).toEqual([exactId]);
  });
  it("fills existing branch ancestry independently, preserves it on replay, and refuses conflict without mutation", async () => {
    const claim = (body: Record<string, unknown>) => router.invoke({ method: "POST", url: "/api/work-units/claim",
      body: { issue_id: "abc123", repo_id: "mandible", branch: "feature/parent", ...body } });
    const first = await claim({});
    const id = (first.body as { id: string }).id;
    expect(first.status).toBe(201);
    expect((await claim({ parent_branch: "integration/bundle" })).body).toMatchObject({ id, existing: true });
    const before = db.prepare("SELECT * FROM work_units WHERE id = ?").get(id);
    expect(before).toMatchObject({ parent_branch: "integration/bundle" });
    expect((await claim({ parent_branch: "integration/bundle" })).status).toBe(200);
    expect((await claim({})).status).toBe(200);
    expect((await claim({ parent_branch: "integration/other", assigned_session_id: "intruder" })).status).toBe(409);
    expect(db.prepare("SELECT * FROM work_units WHERE id = ?").get(id)).toEqual(before);
    expect((db.prepare("SELECT count(*) AS n FROM work_units").get() as { n: number }).n).toBe(1);
  });

  it("captures assignment before ingestion, keeps it through cleanup and actor mutation, and binds only current lineage", async () => {
    const worker = "019a0000-0000-7000-8000-000000000009";
    const claim = await router.invoke({ method: "POST", url: "/api/work-units/claim",
      ambient_identity: { provider: "codex", provider_session_id: worker },
      body: { issue_id: "abc123", repo_id: "mandible", branch: "feature/late" } });
    expect(claim.status).toBe(201);
    const id = (claim.body as { id: string }).id;
    const pending = await router.invoke({ method: "POST", url: "/api/work-units/claim",
      ambient_identity: { provider: "codex", provider_session_id: worker },
      body: { issue_id: "abc123", repo_id: "mandible", branch: "feature/other-late" } });
    const pendingId = (pending.body as { id: string }).id;
    const target = JSON.stringify({ kind: "native", provider: "codex", session_id: worker });
    const row = () => db.prepare("SELECT * FROM work_units WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row()).toMatchObject({ assignment_target_json: target, worker_provider: null });
    mutateWorkUnit(db, id, () => db.prepare("UPDATE work_units SET assigned_session_id = NULL, provider_session_id = 'coordinator' WHERE id = ?").run(id));
    expect(row()).toMatchObject({ assignment_target_json: target, assigned_session_id: null, worker_provider: null });
    const insert = db.prepare(`INSERT INTO conversations(id,source,session_id,source_path,source_hash,source_mtime,started_at,
      parent_source,parent_session_id,parent_conversation_id,opening_lineage,opening_line)
      VALUES (?, 'codex', ?, ?, '', 1, '2026-10-01', ?, ?, ?, ?, ?)`);
    insert.run("late-parent", "019a0000-0000-7000-8000-000000000008", "/parent", null, null, null, "none", null);
    insert.run("late-child", worker, "/child", "codex", "019a0000-0000-7000-8000-000000000008", "late-parent", "child",
      "[mandible child parent=codex:019a0000-0000-7000-8000-000000000008 parent-role=coordinator role=worker]");
    mutateWorkUnit(db, id, () => db.prepare("UPDATE work_units SET state = 'resolved' WHERE id = ?").run(id));
    expect(row()).toMatchObject({ assignment_target_json: target, assigned_session_id: null,
      provider_session_id: "coordinator", worker_provider: "codex", worker_provider_session_id: worker });
    expect(db.prepare("SELECT worker_provider FROM work_units WHERE id = ?").get(pendingId)).toEqual({ worker_provider: null });
    expect(getWorkerAssignments(db, { provider: "codex", provider_session_id: worker })).toMatchObject({ complete: false, unresolvedUnitIds: [pendingId] });
    mutateWorkUnit(db, pendingId, () => db.prepare("UPDATE work_units SET state = 'resolved' WHERE id = ?").run(pendingId));
    expect(getWorkerAssignments(db, { provider: "codex", provider_session_id: worker }).complete).toBe(true);
    mutateWorkUnit(db, id, () => db.prepare("UPDATE work_units SET state = 'open', assignment_target_json = ? WHERE id = ?")
      .run(JSON.stringify({ kind: "alias", session_id: "unindexed-replacement" }), id));
    expect(row()).toMatchObject({ worker_provider: null, worker_provider_session_id: null });
    mutateWorkUnit(db, id, () => db.prepare("UPDATE work_units SET provider_session_id = ? WHERE id = ?").run(worker, id));
    expect(row()).toMatchObject({ worker_provider: null, worker_provider_session_id: null });
  });
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

  it("corrects an explicit existing kind with exact custody and current umbrella authority", async () => {
    const agent = createUser(db, { slug: "kind-custodian", kind: "agent", display_name: "Custodian" });
    const credential = addCredential(db, agent.id, { type: "api_token", fingerprint: "kind-own" });
    const other = addCredential(db, agent.id, { type: "api_token", fingerprint: "kind-other" });
    const project = addProject(db, { project_key: "kind-project", display_name: "Kind project" });

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
      kind: 'parent-role', payload: { authenticated_user_id: agent.id, responsibility_session_id: null, credential_evidence: ownerCredential, assumed_at: createdAt },
      attribution: systemAction(), created_at: createdAt,
    }).id;
    const previous = checkpoint(credential.id, 1);
    const current = checkpoint(credential.id, 2);
    const promote = { ...request, kind: 'integration', expected_generation: 1, parent_role_checkpoint_id: current };
    for (const [token, body] of [
      ['own', { ...request, kind: 'invalid' }],
      ['own', { ...request, kind: 'integration' }],
      ['own', { ...promote, expected_generation: 0 }],
      ['own', { ...promote, parent_role_checkpoint_id: previous }],
      ['own', { ...promote, branch: 'feature/missing' }],
    ] as const) {
      expect((await guarded.invoke({ method: 'POST', url: '/api/work-units/claim', credential: token, body })).status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
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
      ambient_identity: { provider: "codex", provider_session_id: "same-branch-worker-a" },
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "same-branch",
        repo_id: "mandible",
        branch: "feature/same-branch",
      },
    });

    const activate = await router.invoke({
      ambient_identity: { provider: "codex", provider_session_id: "same-branch-worker-a" },
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
    expect((await ownedRouter.invoke({ credential: "own", method: "PATCH", url: `/api/work-units/${first}`, ambient_identity: { provider, provider_session_id: worker }, body: { expected_generation: 1, state: "resolved" } })).status).toBe(200);
    expect(getWorkerAssignments(db, identity).complete).toBe(false);
    expect((await ownedRouter.invoke({ credential: "own", method: "PATCH", url: `/api/work-units/${second}`, ambient_identity: { provider, provider_session_id: creator }, body: { expected_generation: 1, state: "resolved" } })).status).toBe(200);
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
    expect(db.prepare("SELECT assigned_session_id, responsibility_session_id, custody_generation FROM work_units WHERE id = ?").get(units[0]))
      .toEqual({ assigned_session_id: "retained-native", responsibility_session_id: "retained-native", custody_generation: 1 });
    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = ?").get(units[1])).toEqual({ assigned_session_id: null });
    const parentNative = "019a0000-0000-7000-8000-00000000000a";
    db.prepare(`INSERT INTO conversations(id,source,session_id,source_path,source_hash,source_mtime,started_at)
      VALUES ('retained-parent','claude_code',?,'/retained-parent','',1,'2026-10-01')`).run(parentNative);
    db.prepare(`UPDATE conversations SET parent_source='claude_code',parent_session_id=?,parent_conversation_id='retained-parent',
      opening_lineage='child',opening_line=? WHERE id='retained-chat'`)
      .run(parentNative, `[mandible child parent=claude:${parentNative} parent-role=coordinator role=worker]`);
    mutateWorkUnit(db, units[0]!, () => db.prepare("UPDATE work_units SET continuation = ? WHERE id = ?").run("Keep responsibility", units[0]));
    const bound = db.prepare("SELECT * FROM work_units WHERE id = ?").get(units[0]) as Record<string, unknown>;
    expect(bound.worker_provider).toBe("claude_code");
    expect(hasArchivedResponsibility(db, bound)).toBe(true);
    const check = await owned.invoke({ method: "GET", credential: "own",
      url: "/api/work-units/custody-check?repo_id=mandible&branch=feature/retained-native",
      ambient_identity: { provider: "claude", provider_session_id: "different-native" } });
    expect(check.body).toMatchObject({ outcome: "takeover_available", holder_liveness: { state: "stopped", responsibility_retained: true } });
    const takeover = await owned.invoke({ method: "POST", url: `/api/work-units/${units[0]}/custody/assume`, credential: "own",
      ambient_identity: { provider: "claude", provider_session_id: "different-native" },
      body: { expected_generation: 1, reason: "Try taking over an unloaded holder" } });
    expect(takeover.status, JSON.stringify(takeover.body)).toBe(200);
    expect(db.prepare("SELECT assigned_session_id, responsibility_session_id, custody_generation FROM work_units WHERE id = ?").get(units[0]))
      .toEqual({ assigned_session_id: "retained-native", responsibility_session_id: "different-native", custody_generation: 2 });

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

