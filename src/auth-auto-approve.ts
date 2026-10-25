import { childOutput } from "./child-observation.js";
import { DOMAIN_EVENTS } from "./contracts.js";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type SqliteDatabase from "./sqlite.js";

import { getDb } from "./db.js";
import { ensureMandibleConfigEntry } from "./platform-paths.js";
import { broadcast as defaultBroadcast } from "./sse.js";
import type { SseEvent } from "./types.js";
import {
  addCredential,
  addDelegatedSigningLease,
  findActiveCredentialByFingerprint,
  getOperator,
} from "./users/store.js";
import type { UserCredential } from "./users/types.js";

const execFileAsync = promisify(execFile);

export const AUTO_APPROVE_DURATION_SETTING = "auth_auto_approve_duration_minutes";
const DEFAULT_DURATION_MINUTES = 60;
const DEFAULT_PRESENCE_COMMAND_TIMEOUT_MS = 15_000;
const PROVIDER = "yubikey-age";

export interface AuthApprovalContext {
  source: "auto_lease" | "presence_challenge" | "clearance";
  leaseId: string;
  approverUserId: string;
  env: NodeJS.ProcessEnv;
  /** Opaque process facts consumed only by DelegatedSigningResource. */
  runtime?: {
    sshAgentPid: string;
    sshAuthSock: string;
    publicKeyPath: string;
  };
}

export interface AuthAutoApprover {
  getActiveApprovalContext(): AuthApprovalContext | null;
  getDelegatedSigningStatus?(): DelegatedSigningStatus;
  presenceChallenge?(ttlSeconds?: number, signal?: AbortSignal): Promise<AuthApprovalContext>;
}

export interface DelegatedSigningStatus {
  provider: string;
  configured: boolean;
  public_key: string | null;
  public_key_path: string;
  encrypted_passphrase_path: string;
  recipient_path: string;
  missing_tools: string[];
}

export interface AuthAutoApproveStatus {
  enabled: boolean;
  lease_id: string | null;
  enabled_until: number | null;
  remaining_ms: number;
  duration_minutes: number;
  signing: DelegatedSigningStatus;
}

export interface SetupDelegatedSigningOptions {
  name?: string;
  email?: string;
  ageRecipient?: string;
  overwrite?: boolean;
}

export interface AuthAutoApproveOptions {
  db?: InstanceType<typeof SqliteDatabase>;
  now?: () => number;
  broadcast?: (event: SseEvent) => void;
  configDir?: string;
  seedDefaultDurationSetting?: boolean;
  presenceCommandTimeoutMs?: number;
}

interface ActiveLease {
  id: string;
  credentialId: string;
  ownerUserId: string;
  enabledUntil: number;
  sshAgentPid: string;
  sshAuthSock: string;
  timer: ReturnType<typeof setTimeout> | null;
  publicKeyPath: string;
  terminationPending?: boolean;
}

export class AuthAutoApproveManager implements AuthAutoApprover {
  private readonly db: InstanceType<typeof SqliteDatabase>;
  private readonly now: () => number;
  private readonly broadcast: (event: SseEvent) => void;
  private readonly configDir: string;
  private readonly presenceCommandTimeoutMs: number;
  private activeLease: ActiveLease | null = null;

  constructor(options: AuthAutoApproveOptions = {}) {
    this.db = options.db ?? getDb();
    this.now = options.now ?? (() => Date.now());
    this.broadcast = options.broadcast ?? defaultBroadcast;
    // Copied forward from the pre-durable-root config location on first use
    // (issue 24f0316); the delegated signing key material cannot be regenerated.
    this.configDir = options.configDir ?? ensureMandibleConfigEntry("delegated-signing");
    this.presenceCommandTimeoutMs = Math.max(
      1,
      options.presenceCommandTimeoutMs ?? DEFAULT_PRESENCE_COMMAND_TIMEOUT_MS,
    );
    if (options.seedDefaultDurationSetting !== false) {
      this.seedDefaultDurationSetting();
    }
  }

  getStatus(): AuthAutoApproveStatus {
    this.expireIfNeeded();
    const lease = this.activeLease?.terminationPending ? null : this.activeLease;
    const enabledUntil = lease?.enabledUntil ?? null;
    const remainingMs = enabledUntil == null ? 0 : Math.max(0, enabledUntil - this.now());
    return {
      enabled: lease != null,
      lease_id: lease?.id ?? null,
      enabled_until: enabledUntil,
      remaining_ms: remainingMs,
      duration_minutes: this.getDurationMinutes(),
      signing: this.getDelegatedSigningStatus(),
    };
  }

  getActiveApprovalContext(): AuthApprovalContext | null {
    this.expireIfNeeded();
    if (!this.activeLease || this.activeLease.terminationPending) return null;
    return {
      source: "auto_lease",
      leaseId: this.activeLease.id,
      approverUserId: this.activeLease.ownerUserId,
      env: {
        SSH_AUTH_SOCK: this.activeLease.sshAuthSock,
        MANDIBLE_AUTH_DELEGATED_SIGNING: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.signingkey",
        GIT_CONFIG_VALUE_0: this.activeLease.publicKeyPath,
      },
    };
  }

  async setupDelegatedSigning(
    options: SetupDelegatedSigningOptions = {},
  ): Promise<DelegatedSigningStatus> {
    const missing = this.getMissingTools();
    if (missing.length > 0) {
      throw new Error(`Missing required tools: ${missing.join(", ")}`);
    }

    const paths = this.paths();
    if (!options.overwrite && (fs.existsSync(paths.privateKey) || fs.existsSync(paths.encryptedPassphrase))) {
      throw new Error("Delegated signing key already exists. Pass overwrite=true to replace it.");
    }

    const ageRecipient = options.ageRecipient?.trim() || await this.resolveSingleAgeRecipient();
    if (!ageRecipient) {
      throw new Error(
        "No age-plugin-yubikey recipient found. Run age-plugin-yubikey --generate, then retry setup.",
      );
    }

    fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.configDir, 0o700);

    const passphrase = randomBytes(48).toString("base64url");
    const name = options.name?.trim() || "Mandible delegated signing";
    const email = options.email?.trim();
    const comment = email ? `${name} <${email}>` : name;

    for (const file of [paths.privateKey, paths.publicKey, paths.encryptedPassphrase, paths.recipient]) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }

    try {
      await runWithInput(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-C", comment, "-f", paths.privateKey],
        `${passphrase}\n${passphrase}\n`,
      );
      fs.chmodSync(paths.privateKey, 0o600);
      fs.chmodSync(paths.publicKey, 0o644);

      await runWithInput("age", ["-r", ageRecipient, "-o", paths.encryptedPassphrase], passphrase);
      fs.chmodSync(paths.encryptedPassphrase, 0o600);
      fs.writeFileSync(paths.recipient, `${ageRecipient}\n`, { mode: 0o600 });
      await this.ensureDelegatedSigningCredentials(ageRecipient);
    } catch (error) {
      for (const file of [paths.privateKey, paths.publicKey, paths.encryptedPassphrase, paths.recipient]) {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      }
      throw error;
    }

    return this.getDelegatedSigningStatus();
  }

  async enable(durationMinutes?: number): Promise<AuthAutoApproveStatus> {
    const minutes = this.normalizeDurationMinutes(durationMinutes ?? this.getDurationMinutes());
    const durationSeconds = Math.max(60, Math.round(minutes * 60));
    this.disable("replaced");

    const lease = await this.createDelegatedSigningLease(durationSeconds);
    lease.timer = setTimeout(() => this.disable("expired"), durationSeconds * 1000);
    lease.timer.unref();
    this.activeLease = lease;
    this.broadcastStatus("enabled");
    return this.getStatus();
  }

  async presenceChallenge(ttlSeconds = 60, signal?: AbortSignal): Promise<AuthApprovalContext> {
    signal?.throwIfAborted();
    this.expireIfNeeded();
    const active = this.getActiveApprovalContext();
    if (active) return active;

    const durationSeconds = Math.min(300, Math.max(30, Math.round(ttlSeconds)));
    const lease = await this.createDelegatedSigningLease(durationSeconds, signal);
    if (signal?.aborted) {
      this.db.prepare("UPDATE delegated_signing_leases SET expires_at = MIN(expires_at, MAX(minted_at + 1, ?)) WHERE id = ?").run(this.now(), lease.id);
      await stopSshAgent(lease.sshAgentPid);
      signal.throwIfAborted();
    }
    const timer = setTimeout(() => {
      void stopSshAgent(lease.sshAgentPid).catch(() => undefined);
    }, durationSeconds * 1000);
    timer.unref();

    return {
      source: "presence_challenge",
      leaseId: lease.id,
      approverUserId: lease.ownerUserId,
      env: {
        SSH_AUTH_SOCK: lease.sshAuthSock,
        MANDIBLE_AUTH_DELEGATED_SIGNING: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.signingkey",
        GIT_CONFIG_VALUE_0: lease.publicKeyPath,
      },
    };
  }

  /**
   * Mint a new hardware-presence-backed signer even when another signer is
   * active. Scoped clearance issuance must always consume a fresh YubiKey
   * touch; it must never inherit the historical global auto-approve lease.
   */
  async freshPresenceChallenge(ttlSeconds = 60): Promise<AuthApprovalContext> {
    const durationSeconds = Math.min(24 * 60 * 60, Math.max(30, Math.round(ttlSeconds)));
    const lease = await this.createDelegatedSigningLease(durationSeconds);
    return {
      source: "clearance",
      leaseId: lease.id,
      approverUserId: lease.ownerUserId,
      env: {
        SSH_AUTH_SOCK: lease.sshAuthSock,
        MANDIBLE_AUTH_DELEGATED_SIGNING: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.signingkey",
        GIT_CONFIG_VALUE_0: lease.publicKeyPath,
      },
      runtime: {
        sshAgentPid: lease.sshAgentPid,
        sshAuthSock: lease.sshAuthSock,
        publicKeyPath: lease.publicKeyPath,
      },
    };
  }

  async stopApprovalRuntime(context: AuthApprovalContext): Promise<void> {
    if (!context.runtime) return;
    await stopSshAgent(context.runtime.sshAgentPid);
  }

  private async createDelegatedSigningLease(durationSeconds: number, signal?: AbortSignal): Promise<ActiveLease> {
    signal?.throwIfAborted();
    const status = this.getDelegatedSigningStatus();
    if (!status.configured) {
      throw new Error("Delegated signing is not configured.");
    }
    if (status.missing_tools.length > 0) {
      throw new Error(`Missing required tools: ${status.missing_tools.join(", ")}`);
    }

    const paths = this.paths();
    const ageRecipient = fs.readFileSync(paths.recipient, "utf8").trim();
    const credential = await this.ensureDelegatedSigningCredentials(ageRecipient, signal);
    signal?.throwIfAborted();
    const operator = getOperator(this.db);
    if (!operator) {
      throw new Error("Delegated signing requires a configured local operator.");
    }
    const identity = await execFileText("age-plugin-yubikey", ["--identity"], {
      timeoutMs: this.presenceCommandTimeoutMs, signal,
    });
    if (!identity.trim()) {
      throw new Error("No age-plugin-yubikey identity available from the inserted YubiKey.");
    }
    const passphrase = await runWithInput(
      "age",
      ["--decrypt", "--identity", "-", paths.encryptedPassphrase],
      identity,
      { timeoutMs: this.presenceCommandTimeoutMs, signal },
    );
    signal?.throwIfAborted();
    const agent = await startSshAgent();

    try {
      signal?.throwIfAborted();
      await runWithInput(
        "ssh-add",
        ["-t", String(durationSeconds), paths.privateKey],
        `${passphrase.trimEnd()}\n`,
        { env: { SSH_AUTH_SOCK: agent.sshAuthSock }, signal, timeoutMs: signal ? this.presenceCommandTimeoutMs : undefined },
      );
    } catch (error) {
      await stopSshAgent(agent.sshAgentPid);
      throw error;
    }

    const mintedAt = this.now();
    const enabledUntil = mintedAt + durationSeconds * 1000;
    const id = randomUUID();
    try {
      signal?.throwIfAborted();
      addDelegatedSigningLease(this.db, {
        id,
        credential_id: credential.id,
        owner_user_id: operator.id,
        minted_at: mintedAt,
        expires_at: enabledUntil,
        mint_method: "fresh_presence",
      });
    } catch (error) {
      await stopSshAgent(agent.sshAgentPid);
      throw error;
    }
    return {
      id,
      credentialId: credential.id,
      ownerUserId: operator.id,
      enabledUntil,
      sshAgentPid: agent.sshAgentPid,
      sshAuthSock: agent.sshAuthSock,
      timer: null,
      publicKeyPath: paths.publicKey,
    };
  }

  private async ensureDelegatedSigningCredentials(ageRecipient: string, signal?: AbortSignal): Promise<UserCredential> {
    signal?.throwIfAborted();
    const operator = getOperator(this.db);
    if (!operator) {
      throw new Error("Delegated signing setup requires a configured local operator.");
    }
    const paths = this.paths();
    const publicKey = fs.readFileSync(paths.publicKey, "utf8").trim();
    const fingerprintOutput = await execFileText(
      "ssh-keygen",
      ["-lf", paths.publicKey, "-E", "sha256"],
      { signal, timeoutMs: signal ? this.presenceCommandTimeoutMs : undefined },
    );
    signal?.throwIfAborted();
    const fingerprint = fingerprintOutput.match(/SHA256:[A-Za-z0-9+/=]{40,50}/)?.[0] ?? null;
    if (!fingerprint) {
      throw new Error("Could not derive the delegated SSH public-key fingerprint.");
    }
    const delegated = this.ensureCredential({
      ownerUserId: operator.id,
      type: "delegated_ssh_key",
      fingerprint,
      publicMaterial: publicKey,
      label: "Mandible delegated signing",
    });
    this.ensureCredential({
      ownerUserId: operator.id,
      type: "yubikey_recipient",
      fingerprint: ageRecipient,
      publicMaterial: ageRecipient,
      label: "Mandible delegated signing YubiKey recipient",
    });
    return delegated;
  }

  private ensureCredential(input: {
    ownerUserId: string;
    type: "delegated_ssh_key" | "yubikey_recipient";
    fingerprint: string;
    publicMaterial: string;
    label: string;
  }): UserCredential {
    const existing = findActiveCredentialByFingerprint(this.db, input.fingerprint);
    if (existing) {
      if (
        existing.user_id !== input.ownerUserId ||
        existing.type !== input.type ||
        existing.public_material !== input.publicMaterial
      ) {
        throw new Error(
          `Credential fingerprint ${input.fingerprint} is already bound to incompatible identity material.`,
        );
      }
      return existing;
    }
    return addCredential(this.db, input.ownerUserId, {
      type: input.type,
      fingerprint: input.fingerprint,
      public_material: input.publicMaterial,
      label: input.label,
      metadata: { provider: PROVIDER, managed_by: "delegated_signing_setup" },
    }, this.now());
  }

  disable(reason = "disabled"): AuthAutoApproveStatus {
    this.clearActiveLease(reason, true);
    return this.getStatus();
  }

  async removeDelegatedSigning(): Promise<AuthAutoApproveStatus> {
    const lease = this.activeLease;
    if (lease) {
      this.db.prepare(
        `UPDATE delegated_signing_leases
         SET expires_at = MIN(expires_at, MAX(minted_at + 1, ?))
         WHERE id = ?`,
      ).run(this.now(), lease.id);
      if (lease.timer) clearTimeout(lease.timer);
      lease.timer = null;
      lease.terminationPending = true;
      await stopSshAgent(lease.sshAgentPid);
      if (this.activeLease !== lease) {
        throw new Error("Delegated signing lease changed during removal; retry removal.");
      }
      this.activeLease = null;
    }
    const paths = this.paths();
    for (const file of [paths.privateKey, paths.publicKey, paths.encryptedPassphrase, paths.recipient]) {
      fs.rmSync(file, { force: true });
    }
    try {
      fs.rmdirSync(this.configDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
    this.broadcastStatus("signing_removed");
    return this.getStatus();
  }

  private clearActiveLease(reason: string, broadcast: boolean): void {
    const lease = this.activeLease;
    this.activeLease = null;
    if (lease?.timer) clearTimeout(lease.timer);
    if (lease) {
      void stopSshAgent(lease.sshAgentPid).catch(() => undefined);
      if (broadcast) this.broadcastStatus(reason);
    }
  }

  getDurationMinutes(): number {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(AUTO_APPROVE_DURATION_SETTING) as { value: string } | undefined;
    return this.normalizeDurationMinutes(row?.value ?? DEFAULT_DURATION_MINUTES);
  }

  private normalizeDurationMinutes(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_DURATION_MINUTES;
    return Math.min(480, Math.max(1, Math.round(parsed)));
  }

  getDelegatedSigningStatus(): DelegatedSigningStatus {
    const paths = this.paths();
    const publicKey = fs.existsSync(paths.publicKey)
      ? fs.readFileSync(paths.publicKey, "utf8").trim()
      : null;
    return {
      provider: PROVIDER,
      configured: Boolean(
        publicKey &&
        fs.existsSync(paths.privateKey) &&
        fs.existsSync(paths.encryptedPassphrase) &&
        fs.existsSync(paths.recipient)
      ),
      public_key: publicKey,
      public_key_path: paths.publicKey,
      encrypted_passphrase_path: paths.encryptedPassphrase,
      recipient_path: paths.recipient,
      missing_tools: this.getMissingTools(),
    };
  }

  private paths(): {
    privateKey: string;
    publicKey: string;
    encryptedPassphrase: string;
    recipient: string;
  } {
    const base = path.join(this.configDir, "id_ed25519_mandible_delegated");
    return {
      privateKey: base,
      publicKey: `${base}.pub`,
      encryptedPassphrase: path.join(this.configDir, "id_ed25519_mandible_delegated.passphrase.age"),
      recipient: path.join(this.configDir, "age-recipient.txt"),
    };
  }

  private getMissingTools(): string[] {
    return ["age", "age-plugin-yubikey", "ssh-keygen", "ssh-agent", "ssh-add", "lsof"].filter(
      (tool) => !hasCommand(tool),
    );
  }

  private seedDefaultDurationSetting(): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES (?, ?, CAST(strftime('%s','now') * 1000 AS INTEGER))`,
    ).run(AUTO_APPROVE_DURATION_SETTING, String(DEFAULT_DURATION_MINUTES));
  }

  private async resolveSingleAgeRecipient(): Promise<string | null> {
    const list = await execFileText("age-plugin-yubikey", ["--list"]);
    const recipients = list
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("age1yubikey"));
    return recipients.length === 1 ? recipients[0] : null;
  }

  private expireIfNeeded(): void {
    if (
      this.activeLease &&
      !this.activeLease.terminationPending &&
      this.activeLease.enabledUntil <= this.now()
    ) {
      this.disable("expired");
    }
  }

  private broadcastStatus(reason: string): void {
    this.broadcast({
      event: DOMAIN_EVENTS.AUTH_AUTO_APPROVE,
      data: { reason, status: this.getStatus() },
    });
  }
}

/** Whether `command` is an executable file on PATH, found the way a shell would find it, without starting one. */
function hasCommand(command: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((directory) => {
    if (!directory) return false;
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return fs.statSync(path.join(directory, command)).isFile();
    } catch {
      return false;
    }
  });
}

async function execFileText(
  command: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  try {
    return await childOutput(command, args, {
      env: { ...process.env, LC_ALL: "C", ...options.env }, input: options.input,
      maxBuffer: 1024 * 1024, encoding: "utf8", timeout: options.timeoutMs ?? 0,
      killSignal: "SIGKILL", signal: options.signal,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (options.timeoutMs != null && (failure.killed || failure.signal === "SIGKILL")) throw new Error(`${command} timed out after ${options.timeoutMs}ms`);
    throw error;
  }
}

function runWithInput(
  command: string,
  args: string[],
  input: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  return execFileText(command, args, { ...options, input });
}

async function startSshAgent(): Promise<{ sshAgentPid: string; sshAuthSock: string }> {
  const output = await execFileText("ssh-agent", ["-s"]);
  const sock = output.match(/SSH_AUTH_SOCK=([^;]+);/)?.[1];
  const pid = output.match(/SSH_AGENT_PID=([^;]+);/)?.[1];
  if (!sock || !pid) {
    throw new Error("Failed to parse ssh-agent output.");
  }
  return { sshAgentPid: pid, sshAuthSock: sock };
}

async function stopSshAgent(pid: string): Promise<void> {
  try {
    await execFileAsync("kill", [pid]);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = String(failure.stderr ?? "");
    if (failure.code === "ESRCH" || /no such process/i.test(stderr)) return;
    throw error;
  }
}
