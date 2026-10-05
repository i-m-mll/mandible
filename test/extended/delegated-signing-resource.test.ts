import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../../src/sqlite.ts";
import { describe, expect, it } from "vitest";

import type { AuthAutoApproveManager, AuthApprovalContext } from "../../src/auth-auto-approve.js";
import {
  DelegatedSigningResource,
  type DelegatedSignerInspector,
  type SignerProcessIdentity,
  type SignerSocketIdentity,
} from "../../src/delegated-signing-resource.js";
import { buildMetadataBackupSql } from "../../src/ledger/backup.js";
import { addCredential, addDelegatedSigningLease, createUser, getOperator } from "../../src/users/store.js";
import { createLedgerIssue, createLedgerProject, createMigratedDb } from "../helpers/ledger-fixtures.js";

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
    process: (pid) => processes.get(pid) ?? null,
    socket: (socketPath) => {
      const socket = sockets.get(socketPath);
      if (!socket) throw new Error("socket unavailable");
      return socket;
    },
    ownsSocket: (process, socket) =>
      (process.pid === 300 && socket.path.includes("agent-a"))
      || (process.pid === 301 && socket.path.includes("agent-b")),
    keyFingerprint: () => fingerprint,
    challenge: () => { challenges += 1; },
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
    db, resource, addClearance, processes, sockets, stopped, inspector,
    setFingerprint: (value: string) => { fingerprint = value; },
    challenges: () => challenges,
    removed: () => removed,
    setNow: (value: number) => { now = value; },
  };
}

describe("delegated signer reconnect lifecycle", () => {
  it.runIf(process.platform === "darwin")("proves a real throwaway ssh-agent key with the production inspector", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-reconnect-smoke-"));
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
    let socketPath: string | null = null;
    const signer = {
      getDelegatedSigningStatus: () => ({ configured: true }),
      setupDelegatedSigning: async () => ({ configured: true }),
      freshPresenceChallenge: async (ttlSeconds: number): Promise<AuthApprovalContext> => {
        const output = execFileSync("ssh-agent", ["-s"], { encoding: "utf8" });
        agentPid = output.match(/SSH_AGENT_PID=([^;]+);/)![1];
        socketPath = output.match(/SSH_AUTH_SOCK=([^;]+);/)![1];
        execFileSync("ssh-add", ["-t", String(ttlSeconds), keyPath], {
          env: { ...process.env, SSH_AUTH_SOCK: socketPath }, stdio: "ignore",
        });
        addDelegatedSigningLease(db, {
          id: "real-lease", credential_id: credential.id, owner_user_id: operator.id,
          minted_at: Date.now(), expires_at: Date.now() + ttlSeconds * 1000, mint_method: "fresh_presence",
        });
        return {
          source: "clearance", leaseId: "real-lease", approverUserId: operator.id,
          env: { SSH_AUTH_SOCK: socketPath! },
          runtime: { sshAgentPid: agentPid!, sshAuthSock: socketPath!, publicKeyPath: `${keyPath}.pub` },
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
      const borrow = resource.borrow(context.leaseId);
      await borrow.settle();
      await resource.drain(context.leaseId, "smoke_complete");
      expect(agentPid).toBeNull();
    } finally {
      if (agentPid) {
        try { execFileSync("kill", [agentPid]); } catch { /* already stopped */ }
      }
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reattaches only after exact identity proof and rejects a concurrent live owner", async () => {
    const f = fixture();
    try {
      const first = f.resource("runtime-a", 100);
      const context = await first.issueFresh(60);
      f.addClearance(context.leaseId);
      expect(f.challenges()).toBe(1);

      f.processes.delete(100); // routine daemon exit; ssh-agent survives
      const second = f.resource("runtime-b", 200);
      expect(second.attachAvailable()).toEqual({ attached: 1, refused: 0 });
      const borrow = second.borrow(context.leaseId);
      expect(borrow.approval.env.SSH_AUTH_SOCK).toBe("/private/tmp/agent-a/socket");
      await borrow.settle();
      expect(f.challenges()).toBe(3); // startup attachment plus pre-borrow nonce

      const contender = f.resource("runtime-c", 201);
      expect(contender.attachAvailable()).toEqual({ attached: 0, refused: 1 });
      expect(() => contender.borrow(context.leaseId)).toThrow(/another live Mandible runtime/);
      expect(f.db.prepare(
        "SELECT owner_runtime_epoch, state FROM delegated_signing_runtime_bindings WHERE lease_id = ?",
      ).get(context.leaseId)).toEqual({ owner_runtime_epoch: "runtime-b", state: "available" });

      const inspectProcess = f.inspector.process;
      f.inspector.process = (pid) => {
        if (pid === 200) throw new Error("process inspection unsupported");
        return inspectProcess(pid);
      };
      expect(f.resource("runtime-d", 202).attachAvailable()).toEqual({ attached: 0, refused: 1 });
      expect(f.db.prepare(
        "SELECT owner_runtime_epoch, state FROM delegated_signing_runtime_bindings WHERE lease_id = ?",
      ).get(context.leaseId)).toEqual({ owner_runtime_epoch: "runtime-b", state: "available" });
      f.inspector.process = inspectProcess;

      f.setFingerprint(`SHA256:${"X".repeat(43)}`);
      expect(() => second.borrow(context.leaseId)).toThrow(/expected key/);
      f.setFingerprint(`SHA256:${"R".repeat(43)}`);
      f.sockets.get("/private/tmp/agent-a/socket")!.ino = "replacement";
      expect(() => second.borrow(context.leaseId)).toThrow(/socket identity changed/);
      f.sockets.get("/private/tmp/agent-a/socket")!.ino = "10";
      f.processes.delete(300);
      expect(() => second.borrow(context.leaseId)).toThrow(/ssh-agent process is not alive/);
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
      const borrow = resource.borrow(context.leaseId);
      const draining = resource.drain(context.leaseId, "clearance_exhausted");
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
      expect(preview.attachAvailable()).toEqual({ attached: 0, refused: 0 });
      expect(() => preview.borrow(context.leaseId)).toThrow(/disabled outside/);
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
