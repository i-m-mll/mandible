import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { describe, expect, it, vi } from "vitest";

import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { AuthClearanceManager } from "../src/auth-clearance.js";
import { AuthQueue } from "../src/auth-queue.js";
import { resetDb, setDb, type Db } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import type { RequestLike, ResponseLike, RouteHandler, RouteOptions, RouteRegistrar } from "../src/server.js";
import type { AuthApprovalContext } from "../src/delegated-signing-resource.js";
import { buildMetadataBackupSql } from "../src/ledger/backup.js";
import {
  addCredential,
  addDelegatedSigningLease,
  createUser,
  getOperator,
  setupOperator,
} from "../src/users/store.js";
import {
  createLedgerIssue,
  createLedgerProject,
  createMigratedDb,
  migratedMemoryDb,
} from "./helpers/ledger-fixtures.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

function fixture() {
  const db = createMigratedDb({
    operator: { slug: "clearance-operator", display_name: "Clearance Operator" },
    now: 1,
  });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-clearance-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Clearance Test"]);
  git(repo, ["config", "user.email", "clearance@test.invalid"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["checkout", "-b", "feature/scoped"]);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feature"]);
  git(repo, ["checkout", "main"]);
  const root = fs.realpathSync(repo);
  db.prepare(
    `INSERT INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
     VALUES ('clearance-repo', ?, 'clearance-repo', 'main', 1, 0)`,
  ).run(root);
  const project = createLedgerProject(db, root, { defaultBranch: "main", remoteUrl: "" });
  const issue = createLedgerIssue(db, {
    project_id: project.project.id,
    title: "Scoped clearance test",
    aliases: [{ alias_kind: "git_bug_short", alias: "abc1234", source: "mandible", is_primary: true }],
  });
  const agent = createUser(db, {
    slug: "clearance-agent",
    kind: "agent",
    display_name: "Clearance Agent",
  }, 2);
  const agentCredential = addCredential(db, agent.id, {
    type: "api_token",
    fingerprint: "clearance-agent-token-fingerprint",
  }, 3);
  const operator = getOperator(db)!;
  const delegated = addCredential(db, operator.id, {
    type: "delegated_ssh_key",
    fingerprint: `SHA256:${"C".repeat(43)}`,
    public_material: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"C".repeat(20)} clearance-test`,
  }, 4);
  let clock = 10_000;
  const released: string[] = [];
  const contexts = new Map<string, AuthApprovalContext>();
  const borrowCounts = new Map<string, number>();
  const draining = new Map<string, Array<() => void>>();
  const finishDrain = (leaseId: string) => {
    if ((borrowCounts.get(leaseId) ?? 0) > 0) return;
    contexts.delete(leaseId);
    released.push(leaseId);
    db.prepare(
      "UPDATE delegated_signing_runtime_bindings SET state = 'retired', retired_at = ?, retired_reason = 'test' WHERE lease_id = ?",
    ).run(clock, leaseId);
    for (const resolve of draining.get(leaseId) ?? []) resolve();
    draining.delete(leaseId);
  };
  const signer = {
    status: () => ({ configured: true }),
    setup: async () => ({ configured: true }),
    remove: async () => ({ configured: false }),
    issueFresh: async (ttlSeconds: number): Promise<AuthApprovalContext> => {
      const leaseId = `lease-${clock}-${Math.random()}`;
      addDelegatedSigningLease(db, {
        id: leaseId,
        credential_id: delegated.id,
        owner_user_id: operator.id,
        minted_at: clock,
        expires_at: clock + ttlSeconds * 1000,
        mint_method: "fresh_presence",
      });
      const context: AuthApprovalContext = {
        source: "clearance",
        leaseId,
        approverUserId: operator.id,
        env: { SSH_AUTH_SOCK: `/tmp/${leaseId}.sock` },
      };
      contexts.set(leaseId, context);
      db.prepare(
        `INSERT INTO delegated_signing_runtime_bindings (
          lease_id, agent_pid, agent_uid, agent_process_start, agent_executable,
          socket_path, socket_dev, socket_ino, socket_uid, socket_mode,
          credential_fingerprint, public_key_path, issued_runtime_epoch,
          owner_runtime_epoch, owner_pid, owner_uid, owner_process_start, owner_executable, attached_at,
          last_validated_at, state
        ) VALUES (?, 101, 1, 'agent-start', '/usr/bin/ssh-agent', ?, '1', '2', 1, 384,
          ?, '/tmp/key.pub', 'runtime-a', 'runtime-a', 100, 1, 'daemon-start', '/usr/bin/node', ?, ?, 'available')`,
      ).run(leaseId, context.env.SSH_AUTH_SOCK, delegated.fingerprint, clock, clock);
      return context;
    },
    borrow: (leaseId: string) => {
      const context = contexts.get(leaseId);
      if (!context) throw new Error("signer unavailable");
      borrowCounts.set(leaseId, (borrowCounts.get(leaseId) ?? 0) + 1);
      return {
        approval: context,
        settle: async () => {
          borrowCounts.set(leaseId, (borrowCounts.get(leaseId) ?? 1) - 1);
          if (draining.has(leaseId)) finishDrain(leaseId);
        },
      };
    },
    drain: async (leaseId: string) => {
      if ((borrowCounts.get(leaseId) ?? 0) === 0) {
        finishDrain(leaseId);
        return;
      }
      await new Promise<void>((resolve) => {
        const waiters = draining.get(leaseId) ?? [];
        waiters.push(resolve);
        draining.set(leaseId, waiters);
      });
    },
    release: async (context: AuthApprovalContext) => { await signer.drain(context.leaseId); },
  };
  const manager = new AuthClearanceManager(db, signer as never, "runtime-a", { now: () => clock });
  const executions: Array<{ request_id: string; env?: NodeJS.ProcessEnv; released_at_start: number }> = [];
  const queue = new AuthQueue({
    db,
    clearanceManager: manager,
    backgroundMaintenance: false,
    executor: async (options) => {
      executions.push({ request_id: options.request_id, env: options.env, released_at_start: released.length });
      return {
        exit_code: 0, signal: null, stdout: "merged\n", stderr: "", output: "merged\n",
        started_at: clock, finished_at: clock + 1,
      };
    },
  });
  const submit = async (suffix = "", overrides: Record<string, unknown> = {}) => (await queue.submit({ ...AUTH_MERGE_REVIEW,
    type: "merge",
    command: "mandible auth merge feature/scoped --into main",
    title: `Scoped merge ${suffix}`,
    cwd: root,
    target_repo_root: root,
    repo: "clearance-repo",
    base_branch: "main",
    head_branch: "feature/scoped",
    merge_head_sha: git(repo, ["rev-parse", "feature/scoped"]),
    issue_references: [issue.id],
    execution_mode: "daemon",
    requester_evidence_method: "api_token",
    requester_credential_id: agentCredential.id,
    ...overrides,
  }, agent.id));
  return {
    db, repo, project, issue, agent, agentCredential, operator, manager, signer,
    released, submit, queue, executions,
    setClock: (value: number) => { clock = value; },
  };
}

describe("scoped protected-merge clearance", () => {
  it("refuses a clearance whose head differs from its selected request", async () => {
    const f = fixture();
    try {
      const request = (await f.submit());
      await expect(f.manager.issue({
        requestId: request.id,
        grantee: f.agent.id,
        issueRef: f.issue.id,
        headBranch: "feature/other",
      }, f.operator.id)).rejects.toMatchObject({ code: "scope_mismatch" });
    } finally {
      (await f.queue.dispose());
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("does not consume clearance until the dependency is durably finalized", async () => {
    const f = fixture();
    try {
      const dependency = (await f.submit("dependency"));
      const request = (await f.submit("dependent", { depends_on_id: dependency.id }));
      const clearance = await f.manager.issue({
        requestId: request.id, grantee: f.agent.id, issueRef: f.issue.id, headBranch: "feature/scoped",
      }, f.operator.id);

      await expect((async () => (await f.queue.approveWithClearance(request.id))())).rejects.toThrow(/Dependency .* is pending/);
      expect(f.manager.uses(clearance.id)).toEqual([]);

      f.db.prepare(
        "UPDATE auth_requests SET status = 'completed', exit_code = 0, merge_finalized_at = ? WHERE id = ?",
      ).run(10_001, dependency.id);
      expect((await f.queue.approveWithClearance(request.id)).status).toBe("executing");
      expect(f.manager.uses(clearance.id)).toHaveLength(1);
    } finally {
      (await f.queue.dispose());
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("executes the exact matching protected merge through a short-id clearance queue path", async () => {
    const f = fixture();
    try {
      const request = (await f.submit("queue"));
      const clearance = await f.manager.issue({
        requestId: request.id, grantee: f.agent.id, issueRef: f.issue.id, headBranch: "feature/scoped",
      }, f.operator.id);
      const executing = (await f.queue.approveWithClearance(request.id.slice(0, 8)));
      expect(executing).toMatchObject({ status: "executing", approval_source: "clearance" });
      // The fixture executor publishes no signed merge, so evidence verification
      // fails the execution; this covers the clearance path through execution.
      await waitUntil(async () => (await f.queue.getRequest(request.id))?.status === "failed", "the cleared merge execution to finish");
      expect(f.executions).toHaveLength(1);
      expect(f.executions[0]).toMatchObject({ request_id: request.id });
      expect(f.executions[0].released_at_start).toBe(0);
      expect(f.executions[0].env?.SSH_AUTH_SOCK).toContain("/tmp/lease-");
      expect(f.released).toEqual([clearance.signing_lease_id]);
      expect(f.manager.uses(clearance.id)).toEqual([
        expect.objectContaining({ auth_request_id: request.id, use_ordinal: 1 }),
      ]);
    } finally {
      (await f.queue.dispose());
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("issues one fresh bounded grant and atomically freezes and consumes the exact request", async () => {
    const f = fixture();
    try {
      const request = (await f.submit());
      const clearance = await f.manager.issue({
        requestId: request.id,
        grantee: f.agent.id,
        issueRef: f.issue.id,
        headBranch: "feature/scoped",
      }, f.operator.id);
      expect(clearance.max_uses).toBe(1);
      expect(clearance.expires_at - clearance.issued_at).toBe(60 * 60_000);
      let transitioned = false;
      let contender!: ReturnType<AuthClearanceManager['consume']>;
      const consumed = (await f.manager.consume(request.id, ({ use }) => {
        transitioned = true;
        contender = f.manager.consume(request.id, () => undefined);
        f.db.prepare(
          "UPDATE auth_requests SET status = 'executing', clearance_use_id = ?, execution_evidence_id = ? WHERE id = ?",
        ).run(use.id, use.evidence_id, request.id);
      }));
      await expect(contender).rejects.toThrow(/No active/);
      expect(transitioned).toBe(true);
      expect(consumed.use.request_snapshot_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(f.manager.show(clearance.id).consumed_uses).toBe(1);
      expect(() => f.db.prepare("UPDATE auth_requests SET head_branch = 'other' WHERE id = ?").run(request.id))
        .toThrow(/frozen/);
      const evidence = f.db.prepare("SELECT * FROM attribution_evidence WHERE id = ?")
        .get(consumed.use.evidence_id) as { evidence_method: string; details_json: string };
      expect(evidence.evidence_method).toBe("delegated_lease");
      expect(JSON.parse(evidence.details_json)).toMatchObject({
        clearance_id: clearance.id,
        clearance_use_id: consumed.use.id,
        requester_credential_id: f.agentCredential.id,
        runtime_epoch: "runtime-a",
      });
      expect(f.db.prepare("SELECT credential_id FROM attribution_evidence WHERE id = ?").get(consumed.use.evidence_id))
        .not.toEqual({ credential_id: f.agentCredential.id });
      expect(() => f.db.prepare("DELETE FROM auth_requests WHERE id = ?").run(request.id))
        .toThrow(/FOREIGN KEY constraint failed/);
      expect(f.manager.uses(clearance.id)).toEqual([
        expect.objectContaining({ auth_request_id: request.id, request_snapshot_digest: consumed.use.request_snapshot_digest }),
      ]);
      const restored = new SqliteDatabase(":memory:");
      try {
        restored.exec(buildMetadataBackupSql(f.db));
        expect(restored.prepare(
          "SELECT auth_request_id, request_snapshot_digest FROM auth_clearance_uses WHERE id = ?",
        ).get(consumed.use.id)).toEqual({
          auth_request_id: request.id,
          request_snapshot_digest: consumed.use.request_snapshot_digest,
        });
        expect(restored.pragma("foreign_key_check")).toEqual([]);
      } finally {
        restored.close();
      }
      expect(() => f.db.prepare("DELETE FROM auth_clearance_uses WHERE id = ?").run(consumed.use.id))
        .toThrow(/append-only/);
      expect(() => f.db.prepare("DELETE FROM auth_clearances WHERE id = ?").run(clearance.id))
        .toThrow(/append-only/);
    } finally {
      (await f.queue.dispose());
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("issues prospectively from explicit exact scope without an existing request", async () => {
    const f = fixture();
    try {
      const clearance = await f.manager.issue({
        grantee: f.agent.id,
        project: f.project.project.project_key,
        baseBranch: "main",
        issueRef: f.issue.id,
        headBranch: "feature/scoped",
        action: "merge",
      }, f.operator.id);
      expect(clearance.created_from_request_id).toBeNull();
      const request = (await f.submit("later"));
      expect((await f.manager.consume(request.id, () => undefined)).clearance.id).toBe(clearance.id);
    } finally {
      (await f.queue.dispose());
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it.each([
    ["action type", { type: "data-delete", command: "echo destructive", canonical_message: false, verification: null }, /protected merge/],
    ["remote execution", { execution_mode: "remote" }, /protected merge/],
    ["session claim", { requester_evidence_method: "session_claim", requester_credential_id: null }, /provenance/],
  ])("refuses unsupported %s", async (_label, overrides, message) => {
    const f = fixture();
    try {
      const request = (await f.submit(String(_label), overrides));
      await expect(f.manager.issue({
        requestId: request.id,
        grantee: f.agent.id,
        headBranch: "feature/scoped",
      }, f.operator.id)).rejects.toThrow(message);
    } finally {
      (await f.queue.dispose());
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("fails closed for expiry, revocation, exhaustion, ambiguity, restart, and deferred effects", async () => {
    const f = fixture();
    try {
      const first = (await f.submit("first"));
      const clearance = await f.manager.issue({
        requestId: first.id, grantee: f.agent.id, issueRef: f.issue.id, durationMinutes: 1,
      }, f.operator.id);
      f.db.prepare(
        `INSERT INTO auth_request_actions
          (id, auth_request_id, ordinal, kind, target_issue_ref, payload, state, staged_at, updated_at)
         VALUES ('effect', ?, 0, 'comment_add', ?, '{}', 'staged', 1, 1)`,
      ).run(first.id, f.issue.id);
      await expect((async () => (await f.manager.consume(first.id, () => undefined))())).rejects.toThrow(/No active/);
      f.db.prepare("DELETE FROM auth_request_actions WHERE id = 'effect'").run();
      await f.manager.revoke(clearance.id, f.operator.id);
      await expect(f.manager.revoke(clearance.id, f.operator.id)).resolves.toMatchObject({ id: clearance.id });
      expect(() => f.db.prepare("UPDATE auth_clearances SET revoked_at = revoked_at + 1 WHERE id = ?").run(clearance.id))
        .toThrow(/revocation is immutable/);
      await expect((async () => (await f.manager.consume(first.id, () => undefined))())).rejects.toThrow(/No active/);

      const second = (await f.submit("second"));
      const oneUse = await f.manager.issue({ requestId: second.id, grantee: f.agent.id, issueRef: f.issue.id }, f.operator.id);
      (await f.manager.consume(second.id, () => undefined));
      await expect((async () => (await f.manager.consume(second.id, () => undefined))())).rejects.toThrow(/No active/);
      expect(f.manager.show(oneUse.id).consumed_uses).toBe(1); // execution failure would not refund this use

      const third = (await f.submit("third"));
      const ambiguousIssue = await f.manager.issue(
        { requestId: third.id, grantee: f.agent.id, issueRef: f.issue.id }, f.operator.id,
      );
      const ambiguousHead = await f.manager.issue(
        { requestId: third.id, grantee: f.agent.id, headBranch: "feature/scoped" }, f.operator.id,
      );
      await expect((async () => (await f.manager.consume(third.id, () => undefined))())).rejects.toThrow(/Multiple active/);

      const restarted = new AuthClearanceManager(f.db, f.signer as never, "runtime-b", { now: () => 10_000 });
      await expect((async () => (await restarted.consume(third.id, () => undefined))())).rejects.toThrow(/Multiple active/);
      await f.manager.revoke(ambiguousIssue.id, f.operator.id);
      await f.manager.revoke(ambiguousHead.id, f.operator.id);

      const expiring = (await f.submit("expiring"));
      await f.manager.issue({ requestId: expiring.id, grantee: f.agent.id, issueRef: f.issue.id, durationMinutes: 1 }, f.operator.id);
      f.setClock(70_001);
      await expect((async () => (await f.manager.consume(expiring.id, () => undefined))())).rejects.toThrow(/No active/);
    } finally {
      (await f.queue.dispose());
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("cleans up the fresh signer when durable issuance fails", async () => {
    const f = fixture();
    try {
      const request = (await f.submit());
      f.db.exec("CREATE TRIGGER refuse_clearance BEFORE INSERT ON auth_clearances BEGIN SELECT RAISE(ABORT, 'refused'); END");
      await expect(f.manager.issue({ requestId: request.id, grantee: f.agent.id, issueRef: f.issue.id }, f.operator.id))
        .rejects.toThrow(/refused/);
      expect(f.released).toHaveLength(1);
      expect(f.db.prepare("SELECT COUNT(*) AS count FROM auth_clearances").get()).toEqual({ count: 0 });
    } finally {
      (await f.queue.dispose());
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });
});

describe("auth clearance API", () => {
  class CapturingRoutes implements RouteRegistrar {
    readonly handlers = new Map<string, RouteHandler>();
    get(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`GET ${path}`, handler); }
    post(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`POST ${path}`, handler); }
    put(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`PUT ${path}`, handler); }
    patch(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`PATCH ${path}`, handler); }
    delete(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`DELETE ${path}`, handler); }
  }

  function response() {
    const state = { status: 200, body: undefined as unknown };
    const res: ResponseLike = {
      status(code) { state.status = code; return res; },
      json(body) { state.body = body; },
      send(body) { state.body = body; },
      setHeader() {},
    };
    return { state, res };
  }

  it("keeps prospective create operator-only and forwards the exact scope", async () => {
    const db = migratedMemoryDb();
    const operator = setupOperator(db, { slug: "clearance-api-operator", display_name: "Clearance API Operator" });
    setDb(db);
    const issue = vi.fn(async (input: unknown, issuer: string) => ({ id: "clearance-1", input, issuer }));
    const manager = {
      issue,
      list: () => [], show: () => ({}), uses: () => [], revoke: async () => ({}),
      signingStatus: () => ({}), setupSigning: async () => ({}), removeSigning: async () => ({}),
    };
    const routes = new CapturingRoutes();
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    try {
      registerAuthRoutes(routes, queue, new AuthAutoApproveManager({ db }), manager as never, inlineLedgerReader(() => queue.db));
      const handler = routes.handlers.get("POST /api/auth/clearances")!;

      const anonymous = response();
      await handler({ body: {}, params: {}, query: {}, client_identity: null } as RequestLike, anonymous.res);
      expect(anonymous.state.status).toBe(401);
      expect(issue).not.toHaveBeenCalled();

      const result = response();
      await handler({
        body: {
          grantee: "agent-a", project: "mandible", base: "develop", issue: "de690d2",
          head: "feature/exact", action: "merge", duration_minutes: 30, max_uses: 2,
        },
        params: {}, query: {},
        client_identity: {
          user_id: operator.id, slug: operator.slug, method: "api_token",
          credential_id: "operator-token", source: "http_bearer",
        },
      } as RequestLike, result.res);
      expect(result.state.status).toBe(201);
      expect(issue).toHaveBeenCalledWith(expect.objectContaining({
        requestId: null, grantee: "agent-a", project: "mandible", baseBranch: "develop",
        issueRef: "de690d2", headBranch: "feature/exact", durationMinutes: 30, maxUses: 2,
      }), operator.id);
    } finally {
      (await queue.dispose());
      db.close();
      resetDb({ reason: "auth clearance API test ended" });
    }
  });
});
