import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { createNoopHookManager } from "./helpers/auth-queue-fixtures.js";
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
import { DelegatedSigningResource, type AuthApprovalContext } from "../src/delegated-signing-resource.js";
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

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: ConstructorParameters<typeof AuthQueue>[0] = {}) {
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
  let nextLease = 0;
  let stopRuntime: (context: AuthApprovalContext) => Promise<void> = async context => { released.push(context.leaseId); };
  const autoSigner = {
    getDelegatedSigningStatus: () => ({ configured: true }),
    setupDelegatedSigning: async () => ({ configured: true }),
    removeDelegatedSigning: async () => undefined,
    freshPresenceChallenge: async (ttlSeconds: number): Promise<AuthApprovalContext> => {
      const leaseId = `lease-${++nextLease}`;
      addDelegatedSigningLease(db, {
        id: leaseId, credential_id: delegated.id, owner_user_id: operator.id,
        minted_at: clock, expires_at: clock + ttlSeconds * 1000, mint_method: "fresh_presence",
      });
      return {
        source: "clearance", leaseId, approverUserId: operator.id,
        env: { SSH_AUTH_SOCK: `/tmp/${leaseId}.sock` },
        runtime: { sshAgentPid: "101", sshAuthSock: `/tmp/${leaseId}.sock`, publicKeyPath: "/tmp/key.pub" },
      };
    },
    stopApprovalRuntime: (context: AuthApprovalContext) => stopRuntime(context),
  } as unknown as AuthAutoApproveManager;
  const signer = new DelegatedSigningResource(autoSigner, {
    db, runtimeEpoch: "runtime-a", pid: 100, now: () => clock,
    inspector: {
      process: async pid => ({ pid, uid: 1, start: `${pid}-start`, executable: pid === 101 ? "/usr/bin/ssh-agent" : "/usr/bin/bun" }),
      socket: socketPath => ({ path: socketPath, dev: "1", ino: "2", uid: 1, mode: 0o600 }),
      ownsSocket: async () => true,
      keyFingerprint: async () => delegated.fingerprint,
      challenge: async () => undefined,
    },
  });
  const manager = new AuthClearanceManager(db, signer as never, "runtime-a", { now: () => clock });
  const executions: Array<{ request_id: string; env?: NodeJS.ProcessEnv; released_at_start: number }> = [];
  let execute: NonNullable<ConstructorParameters<typeof AuthQueue>[0]>["executor"] = async () => ({
    exit_code: 0, signal: null, stdout: "merged\n", stderr: "", output: "merged\n", started_at: clock, finished_at: clock + 1,
  });
  let broadcast: (event: { event: string }) => void = () => undefined;
  const queue = new AuthQueue({
    ...options,
    db,
    clearanceManager: manager,
    backgroundMaintenance: false,
    broadcast: event => broadcast(event),
    executor: async (options) => {
      executions.push({ request_id: options.request_id, env: options.env, released_at_start: released.length });
      return execute!(options);
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
    setExecutor: (value: typeof execute) => { execute = value; },
    setStop: (value: typeof stopRuntime) => { stopRuntime = value; },
    setBroadcast: (value: typeof broadcast) => { broadcast = value; },
  };
}

describe("scoped protected-merge clearance", () => {
  it("keeps a failed restart draining and retries the same authority barrier after cleanup recovers", async () => {
    const restart = vi.fn();
    const hooks = createNoopHookManager();
    hooks.getRun = (() => ({ state: "pending", exit_code: 75 })) as typeof hooks.getRun;
    hooks.admittedDrainIdentity = async () => "authority-restart-admission";
    hooks.grantRetry = () => undefined;
    hooks.runPending = async () => [];
    const f = fixture({ hookManager: hooks, restartFn: restart });
    vi.spyOn(f.queue as never, "successfulMergeEvidenceFailure").mockResolvedValue(null);
    try {
      const request = await f.submit();
      f.db.prepare("UPDATE auth_requests SET repo = 'mandible' WHERE id = ?").run(request.id);
      await f.manager.issue({ requestId: request.id, grantee: f.agent.id }, f.operator.id);
      const consumed = await f.manager.consume(request.id, () => undefined);
      f.setStop(async () => { throw new Error("restart signer stop refused"); });
      await expect(consumed.settle()).rejects.toThrow("restart signer stop refused");
      f.db.prepare("UPDATE auth_requests SET status = 'completed', exit_code = 0, resolved_at = ? WHERE id = ?").run(10_001, request.id);
      await f.queue.retryHookConvergence(request.id);
      await waitUntil(() => f.queue.rebuildFailure?.message.includes("restart remains draining"), "failed authority restart barrier");
      expect(f.queue.isRebuilding).toBe(true);
      expect(restart).not.toHaveBeenCalled();
      await expect(f.manager.issue({ requestId: request.id, grantee: f.agent.id }, f.operator.id)).rejects.toThrow(/closing/);
      expect(f.released).toEqual([]);
      f.setStop(async context => { f.released.push(context.leaseId); });
      await f.queue.retryHookConvergence(request.id);
      await waitUntil(() => restart.mock.calls.length === 1, "retried authority restart");
      expect(f.queue.rebuildFailure).toBeNull();
      expect(f.released).toHaveLength(1);
    } finally {
      f.setStop(async context => { f.released.push(context.leaseId); });
      await f.queue.dispose();
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("keeps signer and database owned through a late executor and held retirement during close", async () => {
    const f = fixture();
    const execution = gate();
    const retiring = gate();
    const stopped = gate();
    let closed = false;
    f.setExecutor(async () => {
      await execution.promise;
      expect(f.db.prepare("SELECT COUNT(*) AS count FROM auth_clearance_uses").get()).toEqual({ count: 1 });
      expect(f.released).toEqual([]);
      return { exit_code: 1, signal: null, stdout: "", stderr: "refused", output: "refused", started_at: 1, finished_at: 2 };
    });
    f.setStop(async context => {
      retiring.resolve();
      await stopped.promise;
      f.released.push(context.leaseId);
    });
    try {
      const request = await f.submit();
      const clearance = await f.manager.issue({ requestId: request.id, grantee: f.agent.id }, f.operator.id);
      await f.queue.approveWithClearance(request.id);
      await waitUntil(() => f.executions.length === 1, "held executor admission");
      const closing = f.queue.dispose().then(() => { closed = true; });
      await expect(f.manager.issue({ requestId: request.id, grantee: f.agent.id }, f.operator.id)).rejects.toThrow(/closing/);
      expect(closed).toBe(false);
      expect(f.released).toEqual([]);
      execution.resolve();
      await retiring.promise;
      expect(closed).toBe(false);
      expect(f.db.prepare("SELECT state FROM delegated_signing_runtime_bindings WHERE lease_id = ?").get(clearance.signing_lease_id))
        .toEqual({ state: "draining" });
      stopped.resolve();
      await closing;
      expect(f.released).toEqual([clearance.signing_lease_id]);
      expect(f.db.prepare("SELECT state FROM delegated_signing_runtime_bindings WHERE lease_id = ?").get(clearance.signing_lease_id))
        .toEqual({ state: "retired" });
    } finally {
      execution.resolve(); stopped.resolve();
      await f.queue.dispose();
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("settles consumed authority when publication throws before executor admission", async () => {
    const f = fixture();
    try {
      const request = await f.submit();
      const clearance = await f.manager.issue({ requestId: request.id, grantee: f.agent.id }, f.operator.id);
      f.setBroadcast(() => { throw new Error("publication failed"); });
      await expect(f.queue.approveWithClearance(request.id)).rejects.toThrow("publication failed");
      expect(f.executions).toEqual([]);
      expect(f.manager.uses(clearance.id)).toHaveLength(1);
      expect(f.released).toEqual([clearance.signing_lease_id]);
    } finally {
      await f.queue.dispose(); f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("settles consumption when shutdown cancels admission before the executor starts", async () => {
    const f = fixture();
    try {
      const request = await f.submit();
      const clearance = await f.manager.issue({ requestId: request.id, grantee: f.agent.id }, f.operator.id);
      let closing: Promise<void> | undefined;
      f.setBroadcast(() => { closing ??= f.queue.dispose(); });
      await f.queue.approveWithClearance(request.id);
      await closing;
      expect(f.executions).toEqual([]);
      expect(f.released).toEqual([clearance.signing_lease_id]);
      expect(f.db.prepare("SELECT COUNT(*) AS count FROM auth_clearance_uses").get()).toEqual({ count: 1 });
    } finally {
      await f.queue.dispose(); f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("retains a failed signer stop as draining and retries it before closing", async () => {
    const f = fixture();
    try {
      const request = await f.submit();
      const clearance = await f.manager.issue({ requestId: request.id, grantee: f.agent.id }, f.operator.id);
      const consumed = await f.manager.consume(request.id, () => undefined);
      f.setStop(async () => { throw new Error("stop refused"); });
      await expect(consumed.settle()).rejects.toThrow("stop refused");
      await expect(f.queue.dispose()).rejects.toThrow(/failed to close/);
      expect(f.released).toEqual([]);
      expect(f.db.prepare("SELECT state, retired_at FROM delegated_signing_runtime_bindings WHERE lease_id = ?").get(clearance.signing_lease_id))
        .toEqual({ state: "draining", retired_at: null });
      f.setStop(async context => { f.released.push(context.leaseId); });
      await f.queue.dispose();
      expect(f.released).toEqual([clearance.signing_lease_id]);
    } finally {
      await f.queue.dispose(); f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

  it("keeps unproven execution nonterminal and fences the next same-repository command", async () => {
    const f = fixture();
    const consume = f.manager.consume.bind(f.manager);
    const consumed: Awaited<ReturnType<typeof consume>>[] = [];
    vi.spyOn(f.manager, "consume").mockImplementation(async (...args) => {
      const result = await consume(...args);
      consumed.push(result);
      return result;
    });
    f.setExecutor(async () => { throw Object.assign(new Error("process group still alive"), { processGroupSettled: false }); });
    try {
      const request = await f.submit();
      const follower = await f.submit("follower");
      const clearance = await f.manager.issue({ requestId: request.id, grantee: f.agent.id, maxUses: 2 }, f.operator.id);
      await f.queue.approveWithClearance(request.id);
      await waitUntil(async () => (await f.queue.getRequest(request.id))?.error?.includes("termination is unproven") === true, "executor cleanup uncertainty");
      expect(await f.queue.getRequest(request.id)).toMatchObject({ status: "executing", exit_code: null, resolved_at: null });
      await expect(f.queue.approveWithClearance(follower.id)).rejects.toThrow(/termination .*unproven|remains fenced/);
      expect(f.executions.map(value => value.request_id)).toEqual([request.id]);
      expect(await f.queue.getRequest(follower.id)).toMatchObject({ status: "pending", clearance_use_id: null, last_executed_at: null });
      expect(f.manager.uses(clearance.id)).toHaveLength(1);
      await expect(f.queue.dispose()).rejects.toThrow(/authority remains owned/);
      expect(f.released).toEqual([]);
      expect(f.db.prepare("SELECT state, retired_at FROM delegated_signing_runtime_bindings WHERE lease_id = ?").get(clearance.signing_lease_id))
        .toEqual({ state: "available", retired_at: null });
      await expect(f.queue.dispose()).rejects.toThrow(/authority remains owned/);
    } finally {
      // The fixture now proves its fake executor terminal before releasing the retained borrow.
      await Promise.all(consumed.map(value => value.settle()));
      await f.manager.close();
      f.db.close();
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });

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

  it("refuses a prerequisite edit during signer observation without consuming approval", async () => {
    const f = fixture();
    try {
      const first = await f.submit("first");
      const second = await f.submit("second");
      for (const dependency of [first, second]) {
        f.db.prepare("UPDATE auth_requests SET status = 'completed', exit_code = 0, merge_finalized_at = 10001 WHERE id = ?").run(dependency.id);
      }
      const request = await f.submit("dependent", { depends_on_ids: [first.id] });
      const clearance = await f.manager.issue({ requestId: request.id, grantee: f.agent.id,
        issueRef: f.issue.id, headBranch: "feature/scoped" }, f.operator.id);
      const borrow = f.signer.borrow;
      vi.spyOn(f.signer, "borrow").mockImplementation(leaseId => {
        f.db.prepare("UPDATE auth_requests SET depends_on_ids = ? WHERE id = ?").run(JSON.stringify([second.id]), request.id);
        return borrow(leaseId);
      });
      await expect(f.queue.approveWithClearance(request.id)).rejects.toThrow(/changed during clearance observation/);
      expect(f.manager.uses(clearance.id)).toEqual([]);
      expect(f.executions).toEqual([]);
      expect((await f.queue.getRequest(request.id))?.status).toBe("pending");
    } finally { await f.queue.dispose(); f.db.close(); fs.rmSync(f.repo, { recursive: true, force: true }); }
  });

  it("does not consume clearance until the dependency is durably finalized", async () => {
    const f = fixture();
    try {
      const dependency = (await f.submit("dependency"));
      const request = (await f.submit("dependent", { depends_on_ids: [dependency.id] }));
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
      await consumed.settle();
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
      const consumption = await f.manager.consume(request.id, () => undefined);
      expect(consumption.clearance.id).toBe(clearance.id);
      await consumption.settle();
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
      const consumption = await f.manager.consume(second.id, () => undefined);
      await consumption.settle();
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
      close: async () => undefined,
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
