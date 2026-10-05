import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type SqliteDatabase from "./sqlite.js";

import {
  AuthAutoApproveManager,
  type AuthApprovalContext,
  type DelegatedSigningStatus,
  type SetupDelegatedSigningOptions,
} from "./auth-auto-approve.js";
import { getDb } from "./db.js";

type Db = InstanceType<typeof SqliteDatabase>;

export interface SignerProcessIdentity {
  pid: number;
  uid: number;
  start: string;
  executable: string;
}

export interface SignerSocketIdentity {
  path: string;
  dev: string;
  ino: string;
  uid: number;
  mode: number;
}

export interface DelegatedSignerInspector {
  process(pid: number): SignerProcessIdentity | null;
  socket(socketPath: string): SignerSocketIdentity;
  ownsSocket(process: SignerProcessIdentity, socket: SignerSocketIdentity): boolean;
  keyFingerprint(socketPath: string): string;
  challenge(socketPath: string, publicKeyPath: string, publicMaterial: string): void;
}

interface RuntimeBindingRow {
  lease_id: string;
  agent_pid: number;
  agent_uid: number;
  agent_process_start: string;
  agent_executable: string;
  socket_path: string;
  socket_dev: string;
  socket_ino: string;
  socket_uid: number;
  socket_mode: number;
  credential_fingerprint: string;
  public_key_path: string;
  owner_runtime_epoch: string;
  owner_pid: number;
  owner_uid: number;
  owner_process_start: string;
  owner_executable: string;
  state: "available" | "draining" | "retired" | "lost";
  retired_at: number | null;
  retired_reason: string | null;
}

interface LiveLease {
  context: AuthApprovalContext;
  binding: RuntimeBindingRow;
  borrows: number;
  draining: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  settled: Array<() => void>;
}

export interface DelegatedSignerBorrow {
  approval: AuthApprovalContext;
  settle(): Promise<void>;
}

export interface DelegatedSigningResourceOptions {
  db?: Db;
  runtimeEpoch?: string;
  allowRuntimeAuthority?: boolean;
  now?: () => number;
  pid?: number;
  inspector?: DelegatedSignerInspector;
}

/**
 * Sole live-resource owner for scoped delegated signers. Durable rows record
 * identity and an exclusive daemon claim, but never key material or a signing
 * operation. The ssh-agent remains the only live capability.
 */
export class DelegatedSigningResource {
  private readonly db: Db;
  private readonly runtimeEpoch: string;
  private readonly allowRuntimeAuthority: boolean;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly inspector: DelegatedSignerInspector;
  private readonly leases = new Map<string, LiveLease>();

  constructor(
    private readonly signer: AuthAutoApproveManager,
    options: DelegatedSigningResourceOptions = {},
  ) {
    this.db = options.db ?? getDb();
    this.runtimeEpoch = options.runtimeEpoch ?? `legacy-${process.pid}`;
    this.allowRuntimeAuthority = options.allowRuntimeAuthority ?? true;
    this.now = options.now ?? (() => Date.now());
    this.pid = options.pid ?? process.pid;
    this.inspector = options.inspector ?? systemSignerInspector;
  }

  status(): DelegatedSigningStatus {
    return this.signer.getDelegatedSigningStatus();
  }

  async setup(options: SetupDelegatedSigningOptions = {}): Promise<DelegatedSigningStatus> {
    if (options.overwrite) await this.drainAll("signing_replaced");
    return this.signer.setupDelegatedSigning(options);
  }

  async issueFresh(ttlSeconds: number): Promise<AuthApprovalContext> {
    this.assertAuthorityAllowed();
    const context = await this.signer.freshPresenceChallenge(ttlSeconds);
    let binding: RuntimeBindingRow | null = null;
    try {
      binding = this.captureBinding(context);
      this.insertBinding(binding);
      this.validate(binding, true);
      this.installLiveLease(context, binding);
      return context;
    } catch (error) {
      if (binding) this.retireBinding(binding, "lost", "initial_validation_failed");
      await this.signer.stopApprovalRuntime(context).catch(() => undefined);
      throw error;
    }
  }

  /** Reattach all eligible bindings during production daemon startup. */
  attachAvailable(): { attached: number; refused: number } {
    if (!this.allowRuntimeAuthority) return { attached: 0, refused: 0 };
    const rows = this.db.prepare(
      `SELECT binding.*,
          (binding.state = 'available' AND lease.expires_at > ? AND EXISTS(
            SELECT 1 FROM auth_clearances clearance
             WHERE clearance.signing_lease_id = binding.lease_id
               AND clearance.expires_at > ? AND clearance.revoked_at IS NULL
               AND (SELECT COUNT(*) FROM auth_clearance_uses used WHERE used.clearance_id = clearance.id)
                   < clearance.max_uses
          )) AS eligible
         FROM delegated_signing_runtime_bindings binding
         JOIN delegated_signing_leases lease ON lease.id = binding.lease_id
        WHERE binding.state IN ('available','draining') AND binding.retired_at IS NULL
        ORDER BY binding.lease_id`,
    ).all(this.now(), this.now()) as Array<RuntimeBindingRow & { eligible: number }>;
    let attached = 0;
    let refused = 0;
    for (const row of rows) {
      try {
        if (row.eligible) {
          this.attach(row);
          attached += 1;
        } else {
          void this.drain(row.lease_id, "clearance_inactive").catch(() => undefined);
        }
      } catch {
        refused += 1;
      }
    }
    return { attached, refused };
  }

  borrow(leaseId: string): DelegatedSignerBorrow {
    this.assertAuthorityAllowed();
    let live = this.leases.get(leaseId);
    if (!live) {
      const row = this.readBinding(leaseId);
      if (!row) throw new Error("Clearance signer has no reconnectable runtime binding.");
      live = this.attach(row);
    }
    if (live.draining || live.binding.state !== "available") {
      throw new Error("Clearance signer is draining or retired.");
    }
    this.assertCurrentOwner(live.binding);
    this.validate(live.binding, true);
    live.borrows += 1;
    let settled = false;
    return {
      approval: { ...live.context, source: "clearance" },
      settle: async () => {
        if (settled) return;
        settled = true;
        live!.borrows -= 1;
        if (live!.borrows === 0) {
          for (const resolve of live!.settled.splice(0)) resolve();
          if (live!.draining) await this.finishDrain(live!);
        }
      },
    };
  }

  async release(context: AuthApprovalContext): Promise<void> {
    await this.drain(context.leaseId, "released");
  }

  async drain(leaseId: string, reason: string): Promise<void> {
    let live = this.leases.get(leaseId);
    if (!live) {
      const binding = this.readBinding(leaseId);
      if (!binding || binding.state === "retired" || binding.state === "lost") return;
      // Cleanup proves only exact process/socket identity. It deliberately does
      // not require a still-active credential/lease or signing challenge: those
      // are commonly the reason cleanup is running, and cannot authorize a
      // signature once the binding is marked draining.
      this.claim(binding, true);
      live = this.installLiveLease(this.contextFromBinding(binding), binding);
    }
    if (!live.draining) {
      live.draining = true;
      live.binding.state = "draining";
      live.binding.retired_reason = reason;
      this.db.prepare(
        `UPDATE delegated_signing_leases
            SET expires_at = MIN(expires_at, MAX(minted_at + 1, ?))
          WHERE id = ?`,
      ).run(this.now(), leaseId);
      this.db.prepare(
        "UPDATE delegated_signing_runtime_bindings SET state = 'draining', retired_reason = ? WHERE lease_id = ? AND state = 'available'",
      ).run(reason, leaseId);
    }
    if (live.borrows > 0) {
      await new Promise<void>((resolve) => live!.settled.push(resolve));
    }
    await this.finishDrain(live);
  }

  async remove(): Promise<DelegatedSigningStatus> {
    await this.drainAll("signing_removed");
    await this.signer.removeDelegatedSigning();
    return this.status();
  }

  private async drainAll(reason: string): Promise<void> {
    const leaseIds = (this.db.prepare(
      "SELECT lease_id FROM delegated_signing_runtime_bindings WHERE state IN ('available','draining')",
    ).all() as Array<{ lease_id: string }>).map((row) => row.lease_id);
    await Promise.all(leaseIds.map((leaseId) => this.drain(leaseId, reason)));
  }

  private attach(binding: RuntimeBindingRow): LiveLease {
    this.assertAuthorityAllowed();
    this.claim(binding);
    const context = this.contextFromBinding(binding);
    try {
      this.validate(binding, true);
    } catch (error) {
      this.retireBinding(binding, "lost", "revalidation_failed");
      throw error;
    }
    return this.installLiveLease(context, binding);
  }

  private claim(binding: RuntimeBindingRow, allowDraining = false): void {
    const daemon = this.requireProcess(this.pid, "daemon");
    const claim = this.db.transaction(() => {
      const current = this.readBinding(binding.lease_id);
      if (!current || (!allowDraining && current.state !== "available")
          || (allowDraining && current.state !== "available" && current.state !== "draining")
          || current.retired_at !== null) {
        throw new Error("Clearance signer binding is not available.");
      }
      if (current.owner_runtime_epoch !== this.runtimeEpoch) {
        const owner = this.inspector.process(current.owner_pid);
        if (owner && owner.start === current.owner_process_start
            && owner.uid === current.owner_uid && owner.executable === current.owner_executable) {
          throw new Error("Clearance signer is owned by another live Mandible runtime.");
        }
        const updated = this.db.prepare(
          `UPDATE delegated_signing_runtime_bindings
              SET owner_runtime_epoch = ?, owner_pid = ?, owner_uid = ?, owner_process_start = ?, owner_executable = ?,
                  attached_at = ?, last_validated_at = ?
            WHERE lease_id = ? AND owner_runtime_epoch = ? AND owner_pid = ?
              AND owner_process_start = ? AND state IN ('available','draining')`,
        ).run(
          this.runtimeEpoch, daemon.pid, daemon.uid, daemon.start, daemon.executable, this.now(), this.now(),
          current.lease_id, current.owner_runtime_epoch, current.owner_pid, current.owner_process_start,
        );
        if (updated.changes !== 1) throw new Error("Concurrent clearance signer ownership claim was refused.");
      }
    });
    claim.immediate();
    Object.assign(binding, this.readBinding(binding.lease_id));
  }

  private captureBinding(context: AuthApprovalContext): RuntimeBindingRow {
    if (!context.runtime) throw new Error("Fresh signer did not return process identity.");
    const agent = this.requireProcess(Number(context.runtime.sshAgentPid), "ssh-agent");
    const daemon = this.requireProcess(this.pid, "daemon");
    const socket = this.inspector.socket(context.runtime.sshAuthSock);
    if (!this.inspector.ownsSocket(agent, socket)) throw new Error("ssh-agent does not own the recorded socket.");
    const lease = this.db.prepare(
      `SELECT credential.fingerprint
         FROM delegated_signing_leases lease
         JOIN user_credentials credential ON credential.id = lease.credential_id
        WHERE lease.id = ?`,
    ).get(context.leaseId) as { fingerprint: string } | undefined;
    if (!lease) throw new Error("Delegated signing lease is unavailable.");
    return {
      lease_id: context.leaseId,
      agent_pid: agent.pid,
      agent_uid: agent.uid,
      agent_process_start: agent.start,
      agent_executable: agent.executable,
      socket_path: socket.path,
      socket_dev: socket.dev,
      socket_ino: socket.ino,
      socket_uid: socket.uid,
      socket_mode: socket.mode,
      credential_fingerprint: lease.fingerprint,
      public_key_path: context.runtime.publicKeyPath,
      owner_runtime_epoch: this.runtimeEpoch,
      owner_pid: daemon.pid,
      owner_uid: daemon.uid,
      owner_process_start: daemon.start,
      owner_executable: daemon.executable,
      state: "available",
      retired_at: null,
      retired_reason: null,
    };
  }

  private insertBinding(binding: RuntimeBindingRow): void {
    this.db.prepare(
      `INSERT INTO delegated_signing_runtime_bindings (
        lease_id, agent_pid, agent_uid, agent_process_start, agent_executable,
        socket_path, socket_dev, socket_ino, socket_uid, socket_mode,
        credential_fingerprint, public_key_path, issued_runtime_epoch,
        owner_runtime_epoch, owner_pid, owner_uid, owner_process_start, owner_executable, attached_at,
        last_validated_at, state, retired_at, retired_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', NULL, NULL)`,
    ).run(
      binding.lease_id, binding.agent_pid, binding.agent_uid, binding.agent_process_start,
      binding.agent_executable, binding.socket_path, binding.socket_dev, binding.socket_ino,
      binding.socket_uid, binding.socket_mode, binding.credential_fingerprint,
      binding.public_key_path, this.runtimeEpoch, binding.owner_runtime_epoch,
      binding.owner_pid, binding.owner_uid, binding.owner_process_start, binding.owner_executable,
      this.now(), this.now(),
    );
  }

  private installLiveLease(context: AuthApprovalContext, binding: RuntimeBindingRow): LiveLease {
    const existing = this.leases.get(binding.lease_id);
    if (existing) return existing;
    const expiresAt = Number((this.db.prepare(
      "SELECT expires_at FROM delegated_signing_leases WHERE id = ?",
    ).get(binding.lease_id) as { expires_at: number } | undefined)?.expires_at ?? this.now());
    const live: LiveLease = { context, binding, borrows: 0, draining: false, timer: null, settled: [] };
    live.timer = setTimeout(() => { void this.drain(binding.lease_id, "expired"); }, Math.max(1, expiresAt - this.now()));
    live.timer.unref();
    this.leases.set(binding.lease_id, live);
    return live;
  }

  private validate(binding: RuntimeBindingRow, challenge: boolean): void {
    this.assertCurrentOwner(binding);
    const agent = this.requireProcess(binding.agent_pid, "ssh-agent");
    if (agent.uid !== binding.agent_uid || agent.start !== binding.agent_process_start
        || agent.executable !== binding.agent_executable || path.basename(agent.executable) !== "ssh-agent") {
      throw new Error("ssh-agent process identity changed.");
    }
    const socket = this.inspector.socket(binding.socket_path);
    if (socket.dev !== binding.socket_dev || socket.ino !== binding.socket_ino
        || socket.uid !== binding.socket_uid || socket.mode !== binding.socket_mode
        || !this.inspector.ownsSocket(agent, socket)) {
      throw new Error("ssh-agent socket identity changed.");
    }
    const credential = this.db.prepare(
      `SELECT credential.public_material, credential.fingerprint
         FROM delegated_signing_leases lease
         JOIN user_credentials credential ON credential.id = lease.credential_id
         JOIN users owner ON owner.id = lease.owner_user_id
        WHERE lease.id = ? AND lease.expires_at > ? AND credential.status = 'active'
          AND credential.type = 'delegated_ssh_key' AND owner.status = 'active' AND owner.kind = 'human'`,
    ).get(binding.lease_id, this.now()) as { public_material: string; fingerprint: string } | undefined;
    if (!credential || credential.fingerprint !== binding.credential_fingerprint) {
      throw new Error("Delegated signing lease or credential is no longer valid.");
    }
    if (this.inspector.keyFingerprint(binding.socket_path) !== binding.credential_fingerprint) {
      throw new Error("ssh-agent does not contain exactly the expected key.");
    }
    if (challenge) this.inspector.challenge(binding.socket_path, binding.public_key_path, credential.public_material);
    this.db.prepare(
      "UPDATE delegated_signing_runtime_bindings SET last_validated_at = ? WHERE lease_id = ? AND owner_runtime_epoch = ?",
    ).run(this.now(), binding.lease_id, this.runtimeEpoch);
  }

  private assertCurrentOwner(binding: RuntimeBindingRow): void {
    const current = this.readBinding(binding.lease_id);
    if (!current || current.owner_runtime_epoch !== this.runtimeEpoch || current.owner_pid !== this.pid
        || current.state !== "available" || current.retired_at !== null) {
      throw new Error("This Mandible runtime does not exclusively own the clearance signer.");
    }
    const daemon = this.requireProcess(this.pid, "daemon");
    if (daemon.uid !== current.owner_uid || daemon.start !== current.owner_process_start
        || daemon.executable !== current.owner_executable) {
      throw new Error("Mandible runtime process identity changed.");
    }
    Object.assign(binding, current);
  }

  private async finishDrain(live: LiveLease): Promise<void> {
    if (!this.leases.has(live.binding.lease_id)) return;
    if (live.timer) clearTimeout(live.timer);
    const canStop = this.provesExactAgent(live.binding);
    this.retireBinding(live.binding, "retired", live.binding.retired_reason ?? "drained");
    this.leases.delete(live.binding.lease_id);
    // Re-prove after the durable retirement write, immediately before the
    // signal. This closes the ordinary PID-reuse window around cleanup; if the
    // process or socket changed during retirement, leave it untouched.
    if (canStop && this.provesExactAgent(live.binding)) {
      await this.signer.stopApprovalRuntime(live.context);
    }
  }

  private provesExactAgent(binding: RuntimeBindingRow): boolean {
    try {
      const agent = this.requireProcess(binding.agent_pid, "ssh-agent");
      if (agent.uid !== binding.agent_uid || agent.start !== binding.agent_process_start
          || agent.executable !== binding.agent_executable) return false;
      const socket = this.inspector.socket(binding.socket_path);
      return socket.dev === binding.socket_dev && socket.ino === binding.socket_ino
        && socket.uid === binding.socket_uid && socket.mode === binding.socket_mode
        && this.inspector.ownsSocket(agent, socket);
    } catch {
      return false;
    }
  }

  private retireBinding(binding: RuntimeBindingRow, state: "retired" | "lost", reason: string): void {
    binding.state = state;
    binding.retired_at = this.now();
    binding.retired_reason = reason;
    this.db.prepare(
      `UPDATE delegated_signing_runtime_bindings
          SET state = ?, retired_at = COALESCE(retired_at, ?), retired_reason = COALESCE(retired_reason, ?)
        WHERE lease_id = ? AND state IN ('available','draining')`,
    ).run(state, binding.retired_at, reason, binding.lease_id);
  }

  private contextFromBinding(binding: RuntimeBindingRow): AuthApprovalContext {
    const lease = this.db.prepare(
      "SELECT owner_user_id FROM delegated_signing_leases WHERE id = ?",
    ).get(binding.lease_id) as { owner_user_id: string } | undefined;
    if (!lease) throw new Error("Delegated signing lease is unavailable.");
    return {
      source: "clearance",
      leaseId: binding.lease_id,
      approverUserId: lease.owner_user_id,
      env: {
        SSH_AUTH_SOCK: binding.socket_path,
        MANDIBLE_AUTH_DELEGATED_SIGNING: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.signingkey",
        GIT_CONFIG_VALUE_0: binding.public_key_path,
      },
      runtime: {
        sshAgentPid: String(binding.agent_pid),
        sshAuthSock: binding.socket_path,
        publicKeyPath: binding.public_key_path,
      },
    };
  }

  private readBinding(leaseId: string): RuntimeBindingRow | null {
    return (this.db.prepare(
      "SELECT * FROM delegated_signing_runtime_bindings WHERE lease_id = ?",
    ).get(leaseId) as RuntimeBindingRow | undefined) ?? null;
  }

  private requireProcess(pid: number, label: string): SignerProcessIdentity {
    const identity = this.inspector.process(pid);
    if (!identity) throw new Error(`${label} process is not alive.`);
    return identity;
  }

  private assertAuthorityAllowed(): void {
    if (!this.allowRuntimeAuthority) {
      throw new Error("Scoped signer authority is disabled outside the main mutation-enabled instance.");
    }
  }
}

const systemSignerInspector: DelegatedSignerInspector = {
  process(pid) {
    try {
      globalThis.process.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return null;
      throw new Error(`Cannot prove process ${pid} liveness: ${String(error)}`);
    }
    const uid = Number(execFileSync("ps", ["-o", "uid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    const start = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const executable = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!Number.isInteger(uid) || !start || !executable) {
      throw new Error(`Cannot prove process ${pid} identity.`);
    }
    return { pid, uid, start, executable };
  },
  socket(socketPath) {
    if (!path.isAbsolute(socketPath)) throw new Error("ssh-agent socket path is not absolute.");
    const stat = fs.lstatSync(socketPath, { bigint: true });
    const parent = fs.statSync(path.dirname(socketPath));
    const uid = process.getuid?.() ?? Number(stat.uid);
    if (!stat.isSocket() || Number(stat.uid) !== uid || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
      throw new Error("ssh-agent socket is not private to the daemon user.");
    }
    return {
      path: socketPath,
      dev: String(stat.dev),
      ino: String(stat.ino),
      uid: Number(stat.uid),
      mode: Number(stat.mode & 0o777n),
    };
  },
  ownsSocket(processIdentity, socket) {
    try {
      const output = execFileSync("lsof", ["-a", "-p", String(processIdentity.pid), "-U", "-Fn"], {
        encoding: "utf8", timeout: 5_000,
      });
      return output.split(/\r?\n/).includes(`n${socket.path}`);
    } catch {
      return false;
    }
  },
  keyFingerprint(socketPath) {
    const output = execFileSync("ssh-add", ["-l", "-E", "sha256"], {
      encoding: "utf8", timeout: 5_000, env: { ...process.env, SSH_AUTH_SOCK: socketPath },
    }).trim().split(/\r?\n/).filter(Boolean);
    if (output.length !== 1) throw new Error("ssh-agent must contain exactly one key.");
    const fingerprint = output[0].match(/SHA256:[A-Za-z0-9+/=]{40,50}/)?.[0];
    if (!fingerprint) throw new Error("ssh-agent key fingerprint is unreadable.");
    return fingerprint;
  },
  challenge(socketPath, publicKeyPath, publicMaterial) {
    if (fs.readFileSync(publicKeyPath, "utf8").trim() !== publicMaterial.trim()) {
      throw new Error("Delegated public-key file no longer matches the durable credential.");
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-signer-challenge-"));
    try {
      const noncePath = path.join(dir, "nonce");
      const allowedPath = path.join(dir, "allowed_signers");
      const nonce = randomBytes(32);
      fs.writeFileSync(noncePath, nonce, { mode: 0o600 });
      fs.writeFileSync(allowedPath, `mandible-clearance ${publicMaterial.trim()}\n`, { mode: 0o600 });
      execFileSync("ssh-keygen", ["-Y", "sign", "-f", publicKeyPath, "-n", "mandible-clearance", noncePath], {
        stdio: "ignore", timeout: 5_000, env: { ...process.env, SSH_AUTH_SOCK: socketPath },
      });
      execFileSync(
        "ssh-keygen",
        ["-Y", "verify", "-I", "mandible-clearance", "-f", allowedPath, "-n", "mandible-clearance", "-s", `${noncePath}.sig`],
        { input: nonce, stdio: ["pipe", "ignore", "ignore"], timeout: 5_000 },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

export type { AuthApprovalContext, DelegatedSigningStatus, SetupDelegatedSigningOptions };
