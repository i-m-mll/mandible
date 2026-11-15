import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ApprovalCaller, AuthQueue } from "../../src/auth-queue.js";
import type { Db } from "../../src/db.js";
import { OperatorSigningAuthority } from "../../src/operator-signing/authority.js";
import type { CreateOutcome, KeyState, KeyStatus, OperatorSigner, SignOutcome, SignRequest } from "../../src/operator-signing/signer.js";
import { getOperator } from "../../src/users/store.js";

const run = promisify(execFile);

/** Signing is spawned, like the real helper, so tests can hold the touch at the child boundary. */
function spawned(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`)));
  });
}

/**
 * A software stand-in for the approval helper: the key file is an unencrypted
 * OpenSSH ECDSA P-256 private key, and every sign is one simulated touch.
 * `next` scripts the helper's next sign outcome; `states` overrides status.
 */
export class SoftwareOperatorSigner implements OperatorSigner {
  touches: SignRequest[] = [];
  next: SignOutcome[] = [];
  states = new Map<string, { state: KeyState; detail?: string }>();

  async create(key: string): Promise<CreateOutcome> {
    await run("ssh-keygen", ["-q", "-t", "ecdsa", "-b", "256", "-N", "", "-C", "", "-f", key]);
    const publicKey = readFileSync(`${key}.pub`, "utf8").trim();
    rmSync(`${key}.pub`, { force: true });
    return { result: "created", public_key: publicKey };
  }

  async status(keys: readonly string[]): Promise<KeyStatus[]> {
    return Promise.all(keys.map(async (key): Promise<KeyStatus> => {
      const override = this.states.get(key);
      if (override) return { key, state: override.state, public_key: null, detail: override.detail ?? null };
      if (!existsSync(key)) return { key, state: "key_missing", public_key: null, detail: null };
      const { stdout } = await run("ssh-keygen", ["-y", "-f", key]);
      return { key, state: "usable", public_key: stdout.trim(), detail: null };
    }));
  }

  async sign(request: SignRequest, signal?: AbortSignal): Promise<SignOutcome> {
    this.touches.push(request);
    const scripted = this.next.shift();
    if (scripted) return scripted;
    if (signal?.aborted) return { result: "cancelled" };
    if (!existsSync(request.key)) return { result: "key_missing" };
    const dir = mkdtempSync(path.join(os.tmpdir(), "mandible-soft-sign-"));
    try {
      const message = path.join(dir, "message");
      writeFileSync(message, request.message);
      await spawned("ssh-keygen", ["-q", "-Y", "sign", "-f", request.key, "-n", request.namespace, message]);
      return { result: "signed", signature: readFileSync(`${message}.sig`, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** One key directory per test process; key files are named by fingerprint, so databases never collide. */
export const FIXTURE_APPROVAL_KEY_DIR = mkdtempSync(path.join(os.tmpdir(), "mandible-approval-keys-"));

export function fixtureOperatorSigning(db: Db, signer: OperatorSigner = new SoftwareOperatorSigner()): OperatorSigningAuthority {
  return new OperatorSigningAuthority(db, signer, FIXTURE_APPROVAL_KEY_DIR);
}

/** Place an existing OpenSSH private key where the fixture authority looks for the enrolled key. */
export function installFixtureApprovalKey(db: Db, fingerprint: string, privateKeyPath: string): void {
  copyFileSync(privateKeyPath, fixtureOperatorSigning(db).keyPath(fingerprint));
}

/** A local interface caller, as client auth resolves it for the operator. */
export function operatorCaller(userId: string): ApprovalCaller {
  return { user_id: userId, evidence_method: "local_default", identity_method: "local_default", source: "local", credential_id: null };
}

/** Approve as the operator, giving a queue built without a signer the fixture's software signer. */
export function approveAsFixtureOperator(queue: AuthQueue, id: string, userId?: string): ReturnType<AuthQueue["approveAsOperator"]> {
  const internals = queue as unknown as { db: Db; operatorSigning: OperatorSigningAuthority | null };
  internals.operatorSigning ??= fixtureOperatorSigning(internals.db);
  return queue.approveAsOperator(id, operatorCaller(userId ?? getOperator(internals.db)!.id));
}
