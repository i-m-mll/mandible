import { withRequestOrigin } from "../src/request-origin.js";
import { withLedgerMutationActor } from "../src/ledger/mutation-history.js";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { describe, expect, it, vi } from "vitest";

import type { AuthAutoApproveManager, AuthApprovalContext } from "../src/auth-auto-approve.js";
import {
  DelegatedSigningResource,
  type DelegatedSignerInspector,
  type SignerProcessIdentity,
  type SignerSocketIdentity,
} from "../src/delegated-signing-resource.js";
import { buildMetadataBackupSql } from "../src/ledger/backup.js";
import { addCredential, addDelegatedSigningLease, shortenDelegatedSigningLease, SYSTEM_USER_ID, createUser, getOperator } from "../src/users/store.js";
import { createLedgerIssue, createLedgerProject, createMigratedDb } from "./helpers/ledger-fixtures.js";
import { longestEventLoopBlockMs, useSlowCommand, SYNCHRONOUS_WAIT_MS } from "./helpers/event-loop-blocking.js";

function fixture() {
  const db = createMigratedDb({
    operator: { slug: "reconnect-operator", display_name: "Reconnect Operator" },
    now: 1,
  });
  const operator = getOperator(db)!;
  const delegated = addCredential(db, operator.id, {
    type: "delegated_ssh_key",
    fingerprint: `SHA256:${"R".repeat(43)}`,
    public_material: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"R".repeat(20)} reconnect`,
  }, 2);
  const agent = createUser(db, { slug: "reconnect-agent", kind: "agent", display_name: "Reconnect Agent" }, 3);
  const token = addCredential(db, agent.id, { type: "api_token", fingerprint: "reconnect-token" }, 4);
  const project = createLedgerProject(db, "/tmp/mandible-reconnect-project", { defaultBranch: "main" });
  const issue = createLedgerIssue(db, { project_id: project.project.id, title: "Reconnect" });
  let now = 10_000;
  let nextLease = 0;
  const stopped: string[] = [];
  let removed = 0;
  const processes = new Map<number, SignerProcessIdentity>([
    [100, { pid: 100, uid: 501, start: "daemon-a", executable: "/usr/local/bin/node" }],
    [200, { pid: 200, uid: 501, start: "daemon-b", executable: "/usr/local/bin/node" }],
    [201, { pid: 201, uid: 501, start: "daemon-c", executable: "/usr/local/bin/node" }],
    [202, { pid: 202, uid: 501, start: "daemon-d", executable: "/usr/local/bin/node" }],
    [300, { pid: 300, uid: 501, start: "agent-a", executable: "/usr/bin/ssh-agent" }],
    [301, { pid: 301, uid: 501, start: "agent-b", executable: "/usr/bin/ssh-agent" }],
  ]);
  const sockets = new Map<string, SignerSocketIdentity>([
    ["/private/tmp/agent-a/socket", { path: "/private/tmp/agent-a/socket", dev: "1", ino: "10", uid: 501, mode: 0o600 }],
    ["/private/tmp/agent-b/socket", { path: "/private/tmp/agent-b/socket", dev: "1", ino: "11", uid: 501, mode: 0o600 }],
  ]);
  let fingerprint = delegated.fingerprint;
  let challenges = 0;
  const inspector: DelegatedSignerInspector = {
    process: async (pid) => processes.get(pid) ?? null,
    socket: (socketPath) => {
      const socket = sockets.get(socketPath);
      if (!socket) throw new Error("socket unavailable");
      return socket;
    },
    ownsSocket: async (process, socket) =>
      (process.pid === 300 && socket.path.includes("agent-a"))
      || (process.pid === 301 && socket.path.includes("agent-b")),
    keyFingerprint: async () => fingerprint,
    challenge: async () => { challenges += 1; },
  };
  const signer = {
    getDelegatedSigningStatus: () => ({ configured: true }),
    setupDelegatedSigning: async () => ({ configured: true }),
    freshPresenceChallenge: async (ttlSeconds: number): Promise<AuthApprovalContext> => {
      nextLease += 1;
      const leaseId = `lease-${nextLease}`;
      const pid = 299 + nextLease;
      const socket = `/private/tmp/agent-${nextLease === 1 ? "a" : "b"}/socket`;
      addDelegatedSigningLease(db, {
        id: leaseId,
        credential_id: delegated.id,
        owner_user_id: operator.id,
        minted_at: now,
        expires_at: now + ttlSeconds * 1000,
        mint_method: "fresh_presence",
      });
      return {
        source: "clearance",
        leaseId,
        approverUserId: operator.id,
        env: { SSH_AUTH_SOCK: socket },
        runtime: { sshAgentPid: String(pid), sshAuthSock: socket, publicKeyPath: "/tmp/reconnect.pub" },
      };
    },
    stopApprovalRuntime: async (context: AuthApprovalContext) => { stopped.push(context.leaseId); },
    removeDelegatedSigning: async () => { removed += 1; },
  } as unknown as AuthAutoApproveManager;
  const resource = (epoch: string, pid: number, allowRuntimeAuthority = true) =>
    new DelegatedSigningResource(signer, {
      db,
      runtimeEpoch: epoch,
      pid,
      allowRuntimeAuthority,
      now: () => now,
      inspector,
    });
  const addClearance = (leaseId: string, runtimeEpoch = "runtime-a") => {
    db.prepare(
      `INSERT INTO auth_clearances (
        id, issuer_user_id, grantee_user_id, grantee_credential_id, project_id,
        base_branch, issue_id, head_branch, action, issued_at, expires_at,
        max_uses, runtime_epoch, signing_lease_id, created_from_request_id
      ) VALUES (?, ?, ?, ?, ?, 'main', ?, 'feature/reconnect', 'merge', ?, ?, 1, ?, ?, NULL)`,
    ).run(`clearance-${leaseId}`, operator.id, agent.id, token.id, project.project.id, issue.id,
      now, now + 60_000, runtimeEpoch, leaseId);
  };
  return {
    db, resource, signer, addClearance, processes, sockets, stopped, inspector,
    setFingerprint: (value: string) => { fingerprint = value; },
    challenges: () => challenges,
    removed: () => removed,
    setNow: (value: number) => { now = value; },
  };
}

/** A real throwaway ssh-agent holding one key, issued as a fresh lease through the production inspector. */
async function withRealAgent(body: (agent: {
  db: ReturnType<typeof createMigratedDb>;
  signer: AuthAutoApproveManager;
  resource: DelegatedSigningResource;
  context: AuthApprovalContext;
  agentRunning: () => boolean;
}) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync("/tmp/mandible-sign-");
  fs.chmodSync(dir, 0o700);
  const keyPath = path.join(dir, "id_ed25519");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const publicMaterial = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`, "-E", "sha256"], {
    encoding: "utf8",
  }).match(/SHA256:[A-Za-z0-9+/=]{40,50}/)![0];
  const db = createMigratedDb({ operator: { slug: "real-agent-operator", display_name: "Real Agent" } });
  const operator = getOperator(db)!;
  const credential = addCredential(db, operator.id, {
    type: "delegated_ssh_key", fingerprint, public_material: publicMaterial,
  });
  let agentPid: string | null = null;
  const signer = {
    getDelegatedSigningStatus: () => ({ configured: true }),
    setupDelegatedSigning: async () => ({ configured: true }),
    freshPresenceChallenge: async (ttlSeconds: number): Promise<AuthApprovalContext> => {
      const output = execFileSync("ssh-agent", ["-a", path.join(dir, "agent.sock"), "-s"], { encoding: "utf8" });
      agentPid = output.match(/SSH_AGENT_PID=([^;]+);/)![1];
      const socketPath = output.match(/SSH_AUTH_SOCK=([^;]+);/)![1];
      execFileSync("ssh-add", ["-t", String(ttlSeconds), keyPath], {
        env: { ...process.env, SSH_AUTH_SOCK: socketPath }, stdio: "ignore",
      });
      addDelegatedSigningLease(db, {
        id: "real-lease", credential_id: credential.id, owner_user_id: operator.id,
        minted_at: Date.now(), expires_at: Date.now() + ttlSeconds * 1000, mint_method: "fresh_presence",
      });
      return {
        source: "clearance", leaseId: "real-lease", approverUserId: operator.id,
        env: { SSH_AUTH_SOCK: socketPath },
        runtime: { sshAgentPid: agentPid, sshAuthSock: socketPath, publicKeyPath: `${keyPath}.pub` },
      };
    },
    stopApprovalRuntime: async () => {
      if (agentPid) execFileSync("kill", [agentPid]);
      agentPid = null;
    },
    removeDelegatedSigning: async () => undefined,
  } as unknown as AuthAutoApproveManager;
  try {
    const resource = new DelegatedSigningResource(signer, {
      db, runtimeEpoch: "real-runtime", allowRuntimeAuthority: true,
    });
    const context = await resource.issueFresh(60);
    await body({ db, signer, resource, context, agentRunning: () => agentPid !== null });
  } finally {
    if (agentPid) {
      try { execFileSync("kill", [agentPid]); } catch { /* already stopped */ }
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("delegated signer reconnect lifecycle", () => {
  it("does not signal a reused PID when failed acquisition cleanup is retried", async () => {
    const f = fixture();
    try {
      const resource = f.resource("runtime-a", 100);
      f.db.exec(`CREATE TRIGGER refuse_binding BEFORE INSERT ON delegated_signing_runtime_bindings
        BEGIN SELECT RAISE(ABORT, 'binding write refused'); END`);
      const stop = vi.spyOn(f.signer, "stopApprovalRuntime").mockRejectedValueOnce(new Error("first stop refused"));
      await expect(resource.issueFresh(60)).rejects.toThrow(/acquisition and cleanup failed/);
      expect(stop).toHaveBeenCalledTimes(1);
      f.processes.set(300, { pid: 300, uid: 501, start: "replacement", executable: "/usr/bin/ssh-agent" });
      await resource.close();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(f.stopped).toEqual([]);
      expect(f.processes.get(300)?.start).toBe("replacement");
    } finally { f.db.close(); }
  });

  it("keeps failed acquisition cleanup owned when its original process identity is unavailable", async () => {
    const f = fixture();
    try {
      const resource = f.resource("runtime-a", 100);
      const inspect = f.inspector.process;
      f.inspector.process = async pid => {
        if (pid === 300) throw new Error("identity inspection refused");
        return inspect(pid);
      };
      const stop = vi.spyOn(f.signer, "stopApprovalRuntime");
      await expect(resource.issueFresh(60)).rejects.toThrow(/acquisition and cleanup failed/);
      await expect(resource.close()).rejects.toThrow(/identity inspection refused/);
      f.inspector.process = inspect;
      await expect(resource.close()).rejects.toThrow(/identity is unavailable/);
      expect(stop).not.toHaveBeenCalled();
      f.processes.delete(300);
      await resource.close();
      expect(stop).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("joins acquisition and startup attachment before closing, preserving an available signer", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const challenge = f.inspector.challenge;
    f.inspector.challenge = async (...args) => { entered(); await held; await challenge(...args); };
    try {
      const first = f.resource("runtime-a", 100);
      const issuing = first.issueFresh(60);
      await started;
      let closed = false;
      const closing = first.close().then(() => { closed = true; });
      expect(closed).toBe(false);
      await expect(first.issueFresh(60)).rejects.toThrow(/closing/);
      release();
      const context = await issuing;
      f.addClearance(context.leaseId);
      await closing;
      expect(f.stopped).toEqual([]);
      f.processes.delete(100);

      let releaseAttach!: () => void;
      let enteredAttach!: () => void;
      const heldAttach = new Promise<void>(resolve => { releaseAttach = resolve; });
      const startedAttach = new Promise<void>(resolve => { enteredAttach = resolve; });
      f.inspector.challenge = async (...args) => { enteredAttach(); await heldAttach; await challenge(...args); };
      const second = f.resource("runtime-b", 200);
      const attaching = second.attachAvailable();
      await startedAttach;
      const closingSecond = second.close();
      await expect(second.borrow(context.leaseId)).rejects.toThrow(/closing/);
      releaseAttach();
      expect(await attaching).toEqual({ attached: 1, refused: 0 });
      await closingSecond;
      expect(f.stopped).toEqual([]);
      f.processes.delete(200);
      f.inspector.challenge = challenge;
      const third = f.resource("runtime-c", 201);
      expect(await third.attachAvailable()).toEqual({ attached: 1, refused: 0 });
      const borrow = await third.borrow(context.leaseId);
      await borrow.settle();
      await third.close();
    } finally {
      release();
      f.db.close();
    }
  });

  it("retains retirement ownership when process inspection fails and retries after proof returns", async () => {
    const f = fixture();
    try {
      const resource = f.resource("runtime-a", 100);
      const context = await resource.issueFresh(60);
      const inspect = f.inspector.process;
      f.inspector.process = async pid => {
        if (pid === 300) throw new Error("inspection refused");
        return inspect(pid);
      };
      await expect(resource.drain(context.leaseId, "clearance_revoked")).rejects.toThrow("inspection refused");
      await expect(resource.close()).rejects.toThrow(/failed to close/);
      expect(f.stopped).toEqual([]);
      expect(f.db.prepare("SELECT state, retired_at FROM delegated_signing_runtime_bindings WHERE lease_id = ?").get(context.leaseId))
        .toEqual({ state: "draining", retired_at: null });
      f.inspector.process = inspect;
      await resource.close();
      expect(f.stopped).toEqual([context.leaseId]);
    } finally { f.db.close(); }
  });

  it("retains a pending drain when its database transition fails before process cleanup", async () => {
    const f = fixture();
    try {
      const resource = f.resource("runtime-a", 100);
      const context = await resource.issueFresh(60);
      f.db.exec(`CREATE TRIGGER refuse_drain BEFORE UPDATE ON delegated_signing_runtime_bindings
        WHEN NEW.state = 'draining' BEGIN SELECT RAISE(ABORT, 'drain write refused'); END`);
      await expect(resource.drain(context.leaseId, "clearance_revoked")).rejects.toThrow("drain write refused");
      await expect(resource.close()).rejects.toThrow(/failed to close/);
      expect(f.stopped).toEqual([]);
      expect(f.db.prepare("SELECT state FROM delegated_signing_runtime_bindings WHERE lease_id = ?").get(context.leaseId))
        .toEqual({ state: "available" });
      f.db.exec("DROP TRIGGER refuse_drain");
      await resource.close();
      expect(f.stopped).toEqual([context.leaseId]);
      expect(f.db.prepare("SELECT state FROM delegated_signing_runtime_bindings WHERE lease_id = ?").get(context.leaseId))
        .toEqual({ state: "retired" });
    } finally { f.db.close(); }
  });

  it.runIf(process.platform === "darwin")("proves a real throwaway ssh-agent key with the production inspector", async () => {
    await withRealAgent(async ({ resource, context, agentRunning }) => {
      const borrow = await resource.borrow(context.leaseId);
      await borrow.settle();
      await resource.drain(context.leaseId, "smoke_complete");
      expect(agentRunning()).toBe(false);
    });
  });

  it.runIf(process.platform === "darwin")("proves, borrows, claims and drains a real signer without blocking the event loop", async () => {
    await withRealAgent(async ({ db, signer, resource, context, agentRunning }) => {
      const exited = spawn("true");
      await new Promise((resolve) => exited.once("exit", resolve));
      for (const command of ["ps", "lsof", "ssh-add", "ssh-keygen"]) useSlowCommand(command);
      try {
        const blockedMs = await longestEventLoopBlockMs(async () => {
          const borrow = await resource.borrow(context.leaseId);
          await borrow.settle();
          // The owning runtime is gone; its successor claims the binding and drains it.
          db.prepare("UPDATE delegated_signing_runtime_bindings SET owner_runtime_epoch = 'gone', owner_pid = ? WHERE lease_id = ?")
            .run(exited.pid, context.leaseId);
          const successor = new DelegatedSigningResource(signer, { db, runtimeEpoch: "successor", allowRuntimeAuthority: true });
          await successor.drain(context.leaseId, "clearance_revoked");
        });

        expect(blockedMs).toBeLessThan(SYNCHRONOUS_WAIT_MS);
        expect(agentRunning()).toBe(false);
        expect(db.prepare("SELECT owner_runtime_epoch, state FROM delegated_signing_runtime_bindings WHERE lease_id = ?")
          .get(context.leaseId)).toEqual({ owner_runtime_epoch: "successor", state: "retired" });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("reattaches only after exact identity proof and rejects a concurrent live owner", async () => {
    const f = fixture();
    try {
      const first = f.resource("runtime-a", 100);
      const context = await first.issueFresh(60);
      f.addClearance(context.leaseId);
      expect(f.challenges()).toBe(1);

      await first.close();
      expect(f.stopped).toEqual([]);
      await expect(first.borrow(context.leaseId)).rejects.toThrow(/closing/);
      f.processes.delete(100); // routine daemon exit; ssh-agent survives
      const second = f.resource("runtime-b", 200);
      expect(await second.attachAvailable()).toEqual({ attached: 1, refused: 0 });
      const borrow = await second.borrow(context.leaseId);
      expect(borrow.approval.env.SSH_AUTH_SOCK).toBe("/private/tmp/agent-a/socket");
      await borrow.settle();
      expect(f.challenges()).toBe(3); // startup attachment plus pre-borrow nonce

      const contender = f.resource("runtime-c", 201);
      expect(await contender.attachAvailable()).toEqual({ attached: 0, refused: 1 });
      await expect(contender.borrow(context.leaseId)).rejects.toThrow(/another live Mandible runtime/);
      expect(f.db.prepare(
        "SELECT owner_runtime_epoch, state FROM delegated_signing_runtime_bindings WHERE lease_id = ?",
      ).get(context.leaseId)).toEqual({ owner_runtime_epoch: "runtime-b", state: "available" });

      const inspectProcess = f.inspector.process;
      f.inspector.process = async (pid) => {
        if (pid === 200) throw new Error("process inspection unsupported");
        return inspectProcess(pid);
      };
      expect(await f.resource("runtime-d", 202).attachAvailable()).toEqual({ attached: 0, refused: 1 });
      expect(f.db.prepare(
        "SELECT owner_runtime_epoch, state FROM delegated_signing_runtime_bindings WHERE lease_id = ?",
      ).get(context.leaseId)).toEqual({ owner_runtime_epoch: "runtime-b", state: "available" });
      f.inspector.process = inspectProcess;

      f.setFingerprint(`SHA256:${"X".repeat(43)}`);
      await expect(second.borrow(context.leaseId)).rejects.toThrow(/expected key/);
      f.setFingerprint(`SHA256:${"R".repeat(43)}`);
      f.sockets.get("/private/tmp/agent-a/socket")!.ino = "replacement";
      await expect(second.borrow(context.leaseId)).rejects.toThrow(/socket identity changed/);
      f.sockets.get("/private/tmp/agent-a/socket")!.ino = "10";
      f.processes.delete(300);
      await expect(second.borrow(context.leaseId)).rejects.toThrow(/ssh-agent process is not alive/);
    } finally {
      f.db.close();
    }
  });

  it("holds a final-use borrow until settlement, then retires and stops the exact agent once", async () => {
    const f = fixture();
    try {
      const resource = f.resource("runtime-a", 100);
      const context = await resource.issueFresh(60);
      f.addClearance(context.leaseId);
      const borrow = await resource.borrow(context.leaseId);
      const caller = { attribution: { user_id: getOperator(f.db)!.id, evidence_method: "api_token" as const } };
      const origin = { provider: "codex", provider_session_id: "native-lease-owner" };
      withRequestOrigin(origin, () => withLedgerMutationActor(caller, () =>
        shortenDelegatedSigningLease(f.db, context.leaseId, 30_000)));
      const draining = withRequestOrigin(origin, () => withLedgerMutationActor(caller, () =>
        resource.drain(context.leaseId, "clearance_exhausted")));
      await Promise.resolve();
      expect(f.stopped).toEqual([]);
      await borrow.settle();
      await draining;
      expect(f.stopped).toEqual([context.leaseId]);
      expect(f.db.prepare(
        "SELECT state, retired_reason FROM delegated_signing_runtime_bindings WHERE lease_id = ?",
      ).get(context.leaseId)).toEqual({ state: "retired", retired_reason: "clearance_exhausted" });
      expect(f.db.prepare("SELECT expires_at FROM delegated_signing_leases WHERE id = ?").get(context.leaseId))
        .toEqual({ expires_at: 10_001 });
      const updates = () => f.db.prepare("SELECT actor_user_id,actor_type,evidence_method,payload_json FROM ledger_events WHERE entity_type='signing_lease' AND event_type='signing_lease.updated' AND entity_id=? ORDER BY rowid").all(context.leaseId);
      expect(updates().map(event => ({ actor: event.actor_user_id, evidence: event.evidence_method, payload: JSON.parse(event.payload_json) })))
        .toEqual([
          { actor: getOperator(f.db)!.id, evidence: "api_token", payload: expect.objectContaining({ request_origin: origin, changed_fields: ["expires_at"] }) },
          { actor: SYSTEM_USER_ID, evidence: "system_internal", payload: expect.objectContaining({ request_origin: origin, changed_fields: ["expires_at"] }) },
        ]);
      expect(updates()[1].actor_type).toBe("system");
      shortenDelegatedSigningLease(f.db, context.leaseId, 40_000);
      expect(updates()).toHaveLength(2);
    } finally {
      f.db.close();
    }
  });

  it("drains scoped leases before delegated-signing removal and disables copied previews", async () => {
    const f = fixture();
    try {
      const resource = f.resource("runtime-a", 100);
      const context = await resource.issueFresh(60);
      f.addClearance(context.leaseId);
      await resource.remove();
      expect(f.stopped).toEqual([context.leaseId]);
      expect(f.removed()).toBe(1);

      const preview = f.resource("preview", 201, false);
      expect(await preview.attachAvailable()).toEqual({ attached: 0, refused: 0 });
      await expect(preview.borrow(context.leaseId)).rejects.toThrow(/disabled outside/);
    } finally {
      f.db.close();
    }
  });

  it("keeps runtime bindings out of metadata backups", async () => {
    const f = fixture();
    try {
      const context = await f.resource("runtime-a", 100).issueFresh(60);
      f.addClearance(context.leaseId);
      const dump = buildMetadataBackupSql(f.db);
      expect(dump).not.toContain("delegated_signing_runtime_bindings");
      const restored = new SqliteDatabase(":memory:");
      try {
        restored.exec(dump);
        expect(restored.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegated_signing_runtime_bindings'",
        ).get()).toBeUndefined();
      } finally {
        restored.close();
      }
    } finally {
      f.db.close();
    }
  });
});
