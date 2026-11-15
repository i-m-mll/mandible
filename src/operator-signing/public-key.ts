/** Public-key parsing for operator signing credentials. Never reads private key material. */

import { execFile } from "node:child_process";
import os from "node:os";

/** Run one probe; its trimmed stdout, or null when it fails in any way. */
function probe(command: string, args: string[], options: { cwd: string; input?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: options.cwd, encoding: "utf-8", timeout: 5000 },
      (error, stdout) => resolve(error ? null : stdout.trim()));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

export interface ResolvedSigningKey {
  material: string;
  fingerprint: string;
}

export type SigningKeyResolution = { ok: true; value: ResolvedSigningKey } | { ok: false; reason: string };

/** Parse one OpenSSH public-key line and calculate its SHA256 fingerprint. */
export async function resolveOpenSshPublicKey(input: string): Promise<SigningKeyResolution> {
  if (input.length > 16_384) {
    return { ok: false, reason: "public_key_input_too_large" };
  }
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    return { ok: false, reason: "expected_one_openssh_public_key_line" };
  }
  const fields = lines[0].split(/\s+/);
  if (fields.length < 2 || !isPublicKeyLine(`${fields[0]} ${fields[1]}`)) {
    return { ok: false, reason: "signing_key_not_openssh_public_key" };
  }
  const material = `${fields[0]} ${fields[1]}`;
  const fingerprint = await fingerprintOf(material);
  if (!fingerprint) {
    return { ok: false, reason: "signing_key_fingerprint_failed" };
  }
  return { ok: true, value: { material, fingerprint } };
}

function isPublicKeyLine(value: string): boolean {
  return /^(ssh-|ecdsa-|sk-)\S+\s+\S+/.test(value.trim());
}

async function fingerprintOf(material: string): Promise<string | null> {
  const output = await probe("/usr/bin/ssh-keygen", ["-lf", "-", "-E", "sha256"], { cwd: os.homedir(), input: `${material}\n` });
  const fingerprint = output?.split(/\s+/)[1] ?? null;
  return fingerprint && fingerprint.startsWith("SHA256:") ? fingerprint : null;
}
