import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type Database from "better-sqlite3";

import { getDb } from "./db.js";
import { getMandibleConfigPath } from "./platform-paths.js";
import { broadcast as defaultBroadcast } from "./sse.js";
import type { SseEvent } from "./types.js";

const execFileAsync = promisify(execFile);

export const AUTO_APPROVE_DURATION_SETTING = "auth_auto_approve_duration_minutes";
const DEFAULT_DURATION_MINUTES = 60;
const PROVIDER = "yubikey-age";

export interface AuthApprovalContext {
  source: "auto_lease";
  leaseId: string;
  env: NodeJS.ProcessEnv;
}

export interface AuthAutoApprover {
  getActiveApprovalContext(): AuthApprovalContext | null;
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
  db?: InstanceType<typeof Database>;
  now?: () => number;
  broadcast?: (event: SseEvent) => void;
  configDir?: string;
}

interface ActiveLease {
  id: string;
  enabledUntil: number;
  sshAgentPid: string;
  sshAuthSock: string;
  timer: ReturnType<typeof setTimeout> | null;
  publicKeyPath: string;
}

export class AuthAutoApproveManager implements AuthAutoApprover {
  private readonly db: InstanceType<typeof Database>;
  private readonly now: () => number;
  private readonly broadcast: (event: SseEvent) => void;
  private readonly configDir: string;
  private activeLease: ActiveLease | null = null;

  constructor(options: AuthAutoApproveOptions = {}) {
    this.db = options.db ?? getDb();
    this.now = options.now ?? (() => Date.now());
    this.broadcast = options.broadcast ?? defaultBroadcast;
    this.configDir = options.configDir ?? getMandibleConfigPath("delegated-signing");
    this.seedDefaultDurationSetting();
  }

  getStatus(): AuthAutoApproveStatus {
    this.expireIfNeeded();
    const lease = this.activeLease;
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
    if (!this.activeLease) return null;
    return {
      source: "auto_lease",
      leaseId: this.activeLease.id,
      env: {
        SSH_AUTH_SOCK: this.activeLease.sshAuthSock,
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
    } catch (error) {
      for (const file of [paths.privateKey, paths.publicKey, paths.encryptedPassphrase, paths.recipient]) {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      }
      throw error;
    }

    return this.getDelegatedSigningStatus();
  }

  async enable(durationMinutes?: number): Promise<AuthAutoApproveStatus> {
    const status = this.getDelegatedSigningStatus();
    if (!status.configured) {
      throw new Error("Delegated signing is not configured.");
    }
    if (status.missing_tools.length > 0) {
      throw new Error(`Missing required tools: ${status.missing_tools.join(", ")}`);
    }

    this.disable("replaced");

    const paths = this.paths();
    const identity = await execFileText("age-plugin-yubikey", ["--identity"]);
    if (!identity.trim()) {
      throw new Error("No age-plugin-yubikey identity available from the inserted YubiKey.");
    }
    const passphrase = await runWithInput(
      "age",
      ["--decrypt", "--identity", "-", paths.encryptedPassphrase],
      identity,
    );
    const agent = await startSshAgent();
    const minutes = this.normalizeDurationMinutes(durationMinutes ?? this.getDurationMinutes());
    const durationSeconds = Math.max(60, Math.round(minutes * 60));

    try {
      await runWithInput(
        "ssh-add",
        ["-t", String(durationSeconds), paths.privateKey],
        `${passphrase.trimEnd()}\n`,
        { SSH_AUTH_SOCK: agent.sshAuthSock },
      );
    } catch (error) {
      await stopSshAgent(agent.sshAgentPid);
      throw error;
    }

    const enabledUntil = this.now() + durationSeconds * 1000;
    const lease: ActiveLease = {
      id: randomUUID(),
      enabledUntil,
      sshAgentPid: agent.sshAgentPid,
      sshAuthSock: agent.sshAuthSock,
      timer: null,
      publicKeyPath: paths.publicKey,
    };
    lease.timer = setTimeout(() => this.disable("expired"), durationSeconds * 1000);
    lease.timer.unref();
    this.activeLease = lease;
    this.broadcastStatus("enabled");
    return this.getStatus();
  }

  disable(reason = "disabled"): AuthAutoApproveStatus {
    const lease = this.activeLease;
    this.activeLease = null;
    if (lease?.timer) clearTimeout(lease.timer);
    if (lease) {
      void stopSshAgent(lease.sshAgentPid).catch(() => undefined);
      this.broadcastStatus(reason);
    }
    return this.getStatus();
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

  private getDelegatedSigningStatus(): DelegatedSigningStatus {
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
    return ["age", "age-plugin-yubikey", "ssh-keygen", "ssh-agent", "ssh-add"].filter(
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
    if (this.activeLease && this.activeLease.enabledUntil <= this.now()) {
      this.disable("expired");
    }
  }

  private broadcastStatus(reason: string): void {
    this.broadcast({
      event: "auth:auto-approve",
      data: { reason, status: this.getStatus() },
    });
  }
}

function hasCommand(command: string): boolean {
  try {
    execFileSync("command", ["-v", command], { shell: "/bin/sh", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function execFileText(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function runWithInput(
  command: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} failed with exit ${code}: ${stderr.trim()}`));
      }
    });
    child.stdin.end(input);
  });
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
  } catch {
    // Best effort. The agent also enforces key lifetime.
  }
}
