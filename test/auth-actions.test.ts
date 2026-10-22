import { AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { approvePausedFixtureRequest, completeFixturePublication, seedHistoricalAuthCompletion, createAuthCheckRepo, commitOnBranch, git, registerWorkRepo } from "./helpers/auth-queue-fixtures.js";

import fs from "node:fs";

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { normalizeAuthActionInput } from "../src/auth-actions.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { AUTH_REQUEST_ACTION_KINDS } from "../src/contracts.js";
import type { Db } from "../src/db.js";
import { getLedgerIssueHead } from "../src/ledger/issue-heads.js";
import { systemAction } from "../src/identity/resolver.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { addBinding, addCredential, getOperator } from "../src/users/store.js";
import {
  SYSTEM_ACTOR,
  createLedgerIssue as createSharedLedgerIssue,
  createLedgerProject,
  createMigratedDb as createSharedMigratedDb,
} from "./helpers/ledger-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createMigratedDb(): Db {
  return createSharedMigratedDb({
    // Route handlers in this file resolve state through the getDb() singleton.
    setGlobal: true,
    operator: { slug: "auth-action-test", display_name: "Auth Action Test" },
    // Issue a64d2de: provider-session bindings resolve to session_claim attribution
    // only for agent principals. The auth-request requester is an agent session, so
    // bind the route session env to an agent rather than the human operator.
    agent: { slug: "auth-action-agent", display_name: "Auth Action Agent" },
    now: 1,
  });
}

function createLedgerIssue(db: Db, alias = "act123", branch?: string) {
  const repoRoot = createAuthCheckRepo();
  registerWorkRepo(db, repoRoot);
  if (branch) commitOnBranch(repoRoot, `feature/${branch}`, { [`${branch}.txt`]: `${branch}\n` });
  tempDirs.push(repoRoot);
  const project = createLedgerProject(db, repoRoot, { defaultBranch: "main", remoteUrl: "" });
  const issue = createSharedLedgerIssue(db, {
    project_id: project.project.id,
    title: "Auth action target",
    kind: "feature",
    priority: "normal",
    actor_type: "agent",
    author_display: "Codex",
    alias,
  });
  return { repoRoot, issue };
}

function submitActionMerge(queue: AuthQueue, payload: Parameters<AuthQueue['submit']>[0]) {
  const head = payload.command.match(/auth merge ([^ ]+)/)![1];
  return queue.submit({ ...AUTH_MERGE_REVIEW,  ...payload, execution_mode: 'daemon', base_branch: 'main', head_branch: head,
    merge_head_sha: git(payload.cwd!, ['rev-parse', head]) });
}

describe("auth request action schema", () => {
  it("matches the SQL CHECK constraint on auth_request_actions.kind", () => {
    // The SQL vocabulary cannot import the TypeScript array; read it back from
    // the schema the migrations produce. A kind the code accepts but the DB
    // rejects fails at INSERT; one the DB accepts but the code does not handle
    // is the silent no-op that used to be recorded as `applied`.
    const db = createMigratedDb();
    try {
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_request_actions'")
        .get() as { sql: string };
      const check = /kind\s+TEXT\s+NOT NULL\s+CHECK\(kind IN \(([^)]*)\)\)/i.exec(row.sql);
      expect(check, `could not find the kind CHECK constraint in: ${row.sql}`).toBeTruthy();
      const sqlKinds = check![1].split(",").map((part) => part.trim().replace(/^'|'$/g, "")).filter(Boolean);
      expect([...sqlKinds].sort()).toEqual([...AUTH_REQUEST_ACTION_KINDS].sort());
    } finally {
      db.close();
    }
  });


  it("normalizes one declarative exact Briefing promotion action", () => {
    expect(normalizeAuthActionInput({
      kind: "briefing_group_promote",
      target_issue_ref: "policy-issue",
      payload: {
        group_ref: "group-12345678",
        expected_base_bundle_ref: "base-12345678",
        proposal_bundle_ref: "proposal-12345678",
      },
    })).toEqual({
      kind: "briefing_group_promote",
      target_issue_ref: "policy-issue",
      payload: {
        group_ref: "group-12345678",
        expected_base_bundle_ref: "base-12345678",
        proposal_bundle_ref: "proposal-12345678",
      },
    });
    expect(() => normalizeAuthActionInput({
      kind: "briefing_group_promote",
      target_issue_ref: "policy-issue",
      payload: { group_ref: "group", expected_base_bundle_ref: "base", proposal_bundle_ref: "proposal",
        command: "rm -rf /" },
    })).toThrow(/unsupported field 'command'/);
  });

});

describe("auth request action execution", () => {
  it("applies staged actions once in ordinal order when a merge succeeds", async () => {
    const db = createMigratedDb();
    try {
      const { repoRoot, issue } = createLedgerIssue(db, "exec123", "exec");
      let now = 10_000;
      const queue = new AuthQueue({ db, now: () => now });
      const request = submitActionMerge(queue, {
        type: "merge",
        command: "mandible auth merge feature/exec --into main",
        title: "Execute staged actions",
        cwd: repoRoot,
        repo: path.basename(repoRoot),
        execution_mode: "remote",
        actions: [
          { kind: "comment_add", target_issue_ref: issue.short_id, payload: { body: "Closeout comment" } },
          { kind: "label_add", target_issue_ref: issue.short_id, payload: { label: "verified" } },
          { kind: "worker_status_set", target_issue_ref: issue.short_id, payload: { value: "done" } },
          { kind: "checkpoint_add", target_issue_ref: issue.short_id, payload: { kind: "handoff", payload: { ok: true } } },
          { kind: "issue_close", target_issue_ref: issue.short_id, payload: { reason_comment: "Merged cleanly" } },
        ],
      });

      // Issue 08a5f04 (review F2) — canonical-command verification needs the
      // structured branches; the fixture cwd is not a git repo, so they are
      // recorded directly instead of via submit-time preflight.
      await approvePausedFixtureRequest(queue, request.id);
      now = 11_000;
      await completeFixturePublication(queue, request.id);

      const finalized = queue.getRequest(request.id)!;
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM auth_request_merge_succeeded_facts WHERE auth_request_id = ?",
      ).get(request.id)).toEqual({ count: 1 });
      const completionEvent = db.prepare(
        `SELECT actor_type, actor_user_id, evidence_method, evidence_id
         FROM ledger_events
         WHERE entity_type = 'auth_request' AND entity_id = ? AND event_type = 'auth_request.completed'
         LIMIT 1`,
      ).get(request.id);
      expect(completionEvent).toEqual({
        actor_type: "system",
        actor_user_id: systemAction().user_id,
        evidence_method: "credential_signature",
        evidence_id: finalized.execution_evidence_id,
      });
      const evidence = db.prepare("SELECT details_json FROM attribution_evidence WHERE id = ?")
        .get(finalized.execution_evidence_id) as { details_json: string };
      expect(JSON.parse(evidence.details_json)).toMatchObject({
        authorizer_user_id: finalized.approved_by_user_id,
        executor_user_id: systemAction().user_id,
        verified: true,
        authorization_evidence_method: "credential_signature",
      });
      const authorizationEvidenceId = JSON.parse(evidence.details_json)
        .authorization_evidence_id as string;
      expect(db.prepare("SELECT evidence_method FROM attribution_evidence WHERE id = ?")
        .get(authorizationEvidenceId)).toEqual({ evidence_method: "credential_signature" });

      expect(queue.listActions(request.id).map((action) => action.state)).toEqual([
        "applied",
        "applied",
        "applied",
        "applied",
        "applied",
      ]);
      expect(new LedgerStore(db).getIssue(issue.id)).toMatchObject({
        status: "closed",
        resolution: "delivered",
        worker_status: "done",
      });
      expect(
        db.prepare("SELECT label FROM ledger_labels WHERE issue_id = ? AND label = 'verified' AND deleted_at IS NULL")
          .get(issue.id),
      ).toEqual({ label: "verified" });
      expect(
        db.prepare("SELECT body FROM ledger_comments WHERE issue_id = ? ORDER BY ordinal").all(issue.id),
      ).toEqual([{ body: "Closeout comment" }, { body: "Merged cleanly" }]);
      expect(
        db.prepare("SELECT kind FROM ledger_issue_checkpoints WHERE issue_id = ?").get(issue.id),
      ).toEqual({ kind: "handoff" });

      now = 12_000;
      const restarted = new AuthQueue({ db, now: () => now });
      try {
        restarted.getRequest(request.id);
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM ledger_comments WHERE issue_id = ?").get(issue.id),
        ).toEqual({ count: 2 });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM ledger_issue_checkpoints WHERE issue_id = ?").get(issue.id),
        ).toEqual({ count: 1 });
        expect(db.prepare(
          "SELECT COUNT(*) AS count FROM auth_request_merge_succeeded_facts WHERE auth_request_id = ?",
        ).get(request.id)).toEqual({ count: 1 });
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
    }
  });

  it("records failed actions and continues applying remaining staged actions", async () => {
    const db = createMigratedDb();
    try {
      const { repoRoot, issue } = createLedgerIssue(db, "fail123", "fail");
      const queue = new AuthQueue({ db, now: () => 20_000 });
      const request = submitActionMerge(queue, {
        type: "merge",
        command: "mandible auth merge feature/fail --into main",
        title: "Failure isolation",
        cwd: repoRoot,
        repo: path.basename(repoRoot),
        execution_mode: "remote",
        actions: [
          { kind: "comment_add", target_issue_ref: "missing123", payload: { body: "Will fail" } },
          { kind: "label_add", target_issue_ref: issue.short_id, payload: { label: "still-applied" } },
          { kind: "comment_add", target_issue_ref: issue.short_id, payload: { body: "Vetoed" } },
        ],
      });
      const actions = queue.listActions(request.id);
      const operator = getOperator(db)!;
      const credential = addCredential(db, operator.id, { type: "api_token", fingerprint: `action-fixture-${crypto.randomUUID()}` });
      queue.setActionVeto(request.id, actions[2].id, true, {
        user_id: operator.id, evidence_method: 'api_token', credential_id: credential.id, authority_path: 'operator_recovery',
      }, 1, 0);

      // Issue 08a5f04 (review F2) — canonical-command verification needs the
      // structured branches; the fixture cwd is not a git repo, so they are
      // recorded directly instead of via submit-time preflight.
      await approvePausedFixtureRequest(queue, request.id);
      await completeFixturePublication(queue, request.id);

      const after = queue.listActions(request.id);
      expect(after.map((action) => action.state)).toEqual(["failed", "applied", "vetoed"]);
      expect(after[0].outcome_detail).toContain("could not be resolved");
      expect(
        db.prepare("SELECT label FROM ledger_labels WHERE issue_id = ? AND label = 'still-applied' AND deleted_at IS NULL")
          .get(issue.id),
      ).toEqual({ label: "still-applied" });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM ledger_comments WHERE issue_id = ?").get(issue.id),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  // Each staged closure is guarded on its own: a stale target with on_stale
  // skip stays open, a stale target without it closes with an annotation, and
  // a failed or refused close never blocks or undoes its siblings, even when
  // request-wide completion and withheld-closure release are replayed.
  it("guards each staged closure independently", async () => {
    const db = createMigratedDb();
    let queue: AuthQueue | undefined;
    try {
      const { repoRoot, issue: fresh } = createLedgerIssue(db, "guard1", "stale");
      const store = new LedgerStore(db);
      const target = (alias: string, kind: "feature" | "tracker" = "feature") => createSharedLedgerIssue(db, {
        project_id: fresh.project_id, title: `Guarded ${alias}`, kind, alias,
      });
      const staleSkip = target("guard2");
      const staleDefault = target("guard3");
      const tracker = target("guard4", "tracker");
      const injected = target("guard5");
      const lastFresh = target("guard6");
      queue = new AuthQueue({ db, now: () => 30_000, backgroundMaintenance: false });
      const skip = { on_stale: "skip" };
      const request = submitActionMerge(queue, {
        type: "merge", command: "mandible auth merge feature/stale --into main",
        title: "Independent guarded closures", cwd: repoRoot, repo: path.basename(repoRoot),
        actions: [
          { kind: "issue_close", target_issue_ref: fresh.short_id, payload: skip },
          { kind: "issue_close", target_issue_ref: staleSkip.short_id, payload: skip },
          { kind: "issue_close", target_issue_ref: staleDefault.short_id, payload: {} },
          { kind: "issue_close", target_issue_ref: tracker.short_id, payload: skip },
          { kind: "issue_close", target_issue_ref: injected.short_id, payload: skip },
          { kind: "issue_close", target_issue_ref: lastFresh.short_id, payload: skip },
        ],
      });
      const apply = (queue as any).applyDeferredLedgerAction.bind(queue);
      (queue as any).applyDeferredLedgerAction = (request: unknown, action: { ordinal: number }) => {
        if (action.ordinal === 5) throw new Error("Injected target execution failure");
        return apply(request, action);
      };
      for (const issue of [staleSkip, staleDefault]) {
        store.addComment(issue.id, { body: "Changed since review", source: "mandible", ...SYSTEM_ACTOR });
      }
      await approvePausedFixtureRequest(queue, request.id);
      await completeFixturePublication(queue, request.id);

      const actions = queue.listActions(request.id);
      expect(actions.map((action) => action.state))
        .toEqual(["applied", "skipped_stale", "applied", "failed", "failed", "applied"]);
      expect(actions[1]).toMatchObject({ applied_at: null, outcome_detail: expect.stringContaining("digest moved") });
      expect(actions[2].outcome_detail).toContain("digest moved");
      const statuses = () => [fresh, staleSkip, staleDefault, tracker, injected, lastFresh]
        .map((issue) => store.getIssue(issue.id).status);
      expect(statuses()).toEqual(["closed", "open", "closed", "open", "open", "closed"]);
      expect(store.getIssue(fresh.id).resolution).toBe("delivered");

      const current = queue.getRequest(request.id)!;
      (queue as any).applyLedgerCompletionForRequest(current);
      (queue as any).releaseWithheldClosures(current);
      expect(queue.listActions(request.id)).toEqual(actions);
      expect(statuses()).toEqual(["closed", "open", "closed", "open", "open", "closed"]);
    } finally { queue?.dispose(); db.close(); }
  });

  it("creates resolves operational links for staged issue_close actions", () => {
    const db = createMigratedDb();
    try {
      const { repoRoot, issue } = createLedgerIssue(db, "link123");
      const queue = new AuthQueue({ db, now: () => 50_000 });
      const request = queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
        command: "echo link",
        title: "Link staged close",
        cwd: repoRoot,
        repo: path.basename(repoRoot),
        actions: [{ kind: "issue_close", target_issue_ref: issue.short_id, payload: {} }],
      });

      expect(
        db.prepare(
          `SELECT link_type, metadata_json
           FROM ledger_auth_issue_links
           WHERE auth_request_id = ? AND issue_id = ?`,
        ).get(request.id, issue.id),
      ).toMatchObject({
        link_type: "resolves",
      });
      const metadata = db.prepare(
        "SELECT metadata_json FROM ledger_auth_issue_links WHERE auth_request_id = ? AND issue_id = ?",
      ).get(request.id, issue.id) as { metadata_json: string };
      expect(JSON.parse(metadata.metadata_json).source_fields).toContain("auth_request_actions");
    } finally {
      db.close();
    }
  });
});

describe("auth request action queue persistence", () => {
  it("submits actions with target digests and edits one row without touching siblings", () => {
    const db = createMigratedDb();
    try {
      const { repoRoot, issue } = createLedgerIssue(db);
      const digest = getLedgerIssueHead(db, issue.id).digest;
      let now = 1000;
      const queue = new AuthQueue({ db, now: () => now });

      const request = queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
        command: "echo staged",
        title: "Staged actions",
        cwd: repoRoot,
        repo: path.basename(repoRoot),
        actions: [
          { kind: "comment_add", target_issue_ref: issue.short_id, payload: { body: "First" } },
          { kind: "label_add", target_issue_ref: issue.short_id, payload: { label: "ready" } },
          { kind: "checkpoint_add", target_issue_ref: issue.short_id, payload: { kind: "handoff", payload: { ok: true } } },
        ],
      });

      const before = queue.listActions(request.id);
      expect(before).toHaveLength(3);
      expect(before.map((action) => action.ordinal)).toEqual([1, 2, 3]);
      expect(before.map((action) => action.target_digest)).toEqual([digest, digest, digest]);

      now = 2000;
      queue.updateAction(request.id, before[1].id, {
        kind: "label_rm",
        target_issue_ref: issue.short_id,
        payload: { label: "ready" },
      });

      const after = queue.listActions(request.id);
      expect(after[0]).toMatchObject({
        id: before[0].id,
        payload: before[0].payload,
        updated_at: before[0].updated_at,
      });
      expect(after[1]).toMatchObject({
        id: before[1].id,
        kind: "label_rm",
        payload: { label: "ready" },
        updated_at: 2000,
      });
      expect(after[2]).toMatchObject({
        id: before[2].id,
        payload: before[2].payload,
        updated_at: before[2].updated_at,
      });
    } finally {
      db.close();
    }
  });

  it("denies CRUD after a request succeeds", () => {
    const db = createMigratedDb();
    try {
      const queue = new AuthQueue({ db });
      const request = queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
        command: "echo done",
        title: "Done",
        actions: [{ kind: "issue_close", target_issue_ref: "abc123", payload: {} }],
      });
      seedHistoricalAuthCompletion(queue, request.id, "ok");

      expect(() => queue.addAction(request.id, {
        kind: "label_add",
        target_issue_ref: "abc123",
        payload: { label: "late" },
      })).toThrow(AuthQueueError);
    } finally {
      db.close();
    }
  });
});

describe("auth request action routes", () => {
  function seedBriefingPromotion(db: Db) {
    const baseId = "briefing-base-000000000000000000000000";
    const otherBaseId = "briefing-other-0000000000000000000";
    const proposalId = "briefing-proposal-00000000000000000000";
    const groupId = "briefing-group-00000000000000000000000";
    const insertBundle = db.prepare(
      "INSERT INTO briefing_bundles (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
    );
    insertBundle.run(baseId, "Base");
    insertBundle.run(otherBaseId, "Other base");
    insertBundle.run(proposalId, "Proposal");
    db.prepare(`INSERT INTO briefing_groups
      (id, key, name, current_bundle_id, created_at, updated_at)
      VALUES (?, 'policy', 'Policy', ?, 1, 1)`)
      .run(groupId, baseId);
    db.prepare(`INSERT INTO briefing_group_updates
      (group_id, bundle_id, position, created_at) VALUES (?, ?, 0, 1)`)
      .run(groupId, proposalId);
    return { baseId, otherBaseId, proposalId, groupId };
  }

  it("atomically creates a request with an exact validated Briefing promotion", async () => {
    const db = createMigratedDb();
    try {
      const refs = seedBriefingPromotion(db);
      const router = new Router();
      const queue = new AuthQueue({ db });
      registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
      addBinding(db, "auth-action-agent", {
        binding_type: "provider_session_env",
        value: "auth-action-promotion-session",
      });
      const response = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: { ...AUTH_MERGE_REVIEW,
          command: "echo merge",
          title: "Promote reviewed policy",
          type: "merge",
          session_id: "auth-action-promotion-session",
          actions: [{
            kind: "briefing_group_promote",
            target_issue_ref: "policy123",
            payload: {
              group_ref: "briefing-group-0",
              expected_base_bundle_ref: "briefing-base-0",
              proposal_bundle_ref: "briefing-proposal-0",
            },
          }],
        },
      });
      expect(response.status).toBe(201);
      const requestId = (response.body as { request_id: string }).request_id;
      const readback = await router.invoke({
        method: "GET",
        url: `/api/auth/request/${requestId}/actions`,
      });
      expect(readback.status).toBe(200);
      expect(readback.body).toMatchObject({ actions: [{
        kind: "briefing_group_promote",
        target_issue_ref: "policy123",
        state: "staged",
        payload: {
          group_ref: refs.groupId,
          expected_base_bundle_ref: refs.baseId,
          proposal_bundle_ref: refs.proposalId,
        },
      }] });
    } finally {
      db.close();
    }
  });

  it("rolls back the whole request when the expected Briefing Base has drifted", async () => {
    const db = createMigratedDb();
    try {
      const refs = seedBriefingPromotion(db);
      const router = new Router();
      const queue = new AuthQueue({ db });
      registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
      addBinding(db, "auth-action-agent", {
        binding_type: "provider_session_env",
        value: "auth-action-promotion-drift-session",
      });
      const response = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: { ...AUTH_MERGE_REVIEW,
          command: "echo merge",
          title: "Stale policy promotion",
          type: "merge",
          session_id: "auth-action-promotion-drift-session",
          actions: [{
            kind: "briefing_group_promote",
            target_issue_ref: "policy123",
            payload: {
              group_ref: refs.groupId,
              expected_base_bundle_ref: refs.otherBaseId,
              proposal_bundle_ref: refs.proposalId,
            },
          }],
        },
      });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: "Briefing group Base does not match expected_base_bundle_ref",
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_requests").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_request_actions").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("supports per-action CRUD on pending requests", async () => {
    const db = createMigratedDb();
    try {
      const router = new Router();
      const queue = new AuthQueue({ db });
      registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
      addBinding(db, "auth-action-agent", {
        binding_type: "provider_session_env",
        value: "auth-action-route-session",
      });

      const submit = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: { ...AUTH_MERGE_REVIEW,
          command: "echo route",
          title: "Route staged actions",
          session_id: "auth-action-route-session",
          actions: [{ kind: "comment_add", target_issue_ref: "abc123", payload: { body: "One" } }],
        },
      });
      expect(submit.status).toBe(201);
      const requestId = (submit.body as { request_id: string }).request_id;

      const add = await router.invoke({
        method: "POST",
        url: `/api/auth/request/${requestId}/actions`,
        body: { kind: "label_add", target_issue_ref: "abc123", payload: { label: "ready" } },
      });
      expect(add.status).toBe(201);
      const actionId = (add.body as { action: { id: string } }).action.id;

      const edit = await router.invoke({
        method: "PUT",
        url: `/api/auth/request/${requestId}/actions/${actionId}`,
        body: { kind: "label_rm", target_issue_ref: "abc123", payload: { label: "ready" } },
      });
      expect(edit.status).toBe(200);
      expect((edit.body as { action: { kind: string } }).action.kind).toBe("label_rm");

      const list = await router.invoke({
        method: "GET",
        url: `/api/auth/request/${requestId}/actions`,
      });
      expect(list.status).toBe(200);
      expect((list.body as { actions: unknown[] }).actions).toHaveLength(2);

      const rm = await router.invoke({
        method: "DELETE",
        url: `/api/auth/request/${requestId}/actions/${actionId}`,
        body: {},
      });
      expect(rm.status).toBe(200);
    } finally {
      db.close();
    }
  });

  it("allows pending user veto toggles and denies them after completion", async () => {
    const db = createMigratedDb();
    try {
      const router = new Router();
      const queue = new AuthQueue({ db });
      registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
      const request = queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
        command: "echo route",
        title: "Route veto",
        actions: [{ kind: "comment_add", target_issue_ref: "abc123", payload: { body: "One" } }],
      });
      const action = queue.listActions(request.id)[0];

      const veto = await router.invoke({
        method: "POST",
        url: `/api/auth/request/${request.id}/actions/${action.id}/veto`,
        body: { vetoed: true },
      });
      expect(veto.status).toBe(200);
      expect((veto.body as { action: { state: string } }).action.state).toBe("vetoed");

      const restore = await router.invoke({
        method: "POST",
        url: `/api/auth/request/${request.id}/actions/${action.id}/veto`,
        body: { vetoed: false },
      });
      expect(restore.status).toBe(200);
      expect((restore.body as { action: { state: string } }).action.state).toBe("staged");

      seedHistoricalAuthCompletion(queue, request.id, "ok");
      const denied = await router.invoke({
        method: "POST",
        url: `/api/auth/request/${request.id}/actions/${action.id}/veto`,
        body: { vetoed: true },
      });
      expect(denied.status).toBe(409);
      expect(denied.body).toMatchObject({ status: "completed" });
    } finally {
      db.close();
    }
  });

  it("rejects invalid action payloads with a clear client error", async () => {
    const db = createMigratedDb();
    try {
      const router = new Router();
      const queue = new AuthQueue({ db });
      registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
      addBinding(db, "auth-action-agent", {
        binding_type: "provider_session_env",
        value: "auth-action-invalid-session",
      });

      const response = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: { ...AUTH_MERGE_REVIEW,
          command: "echo bad",
          title: "Bad staged action",
          session_id: "auth-action-invalid-session",
          actions: [{ kind: "label_add", target_issue_ref: "abc123", payload: {} }],
        },
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: "label is required" });
    } finally {
      db.close();
    }
  });
});
