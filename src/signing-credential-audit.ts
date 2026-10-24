/**
 * Issue 2205073 — startup audit for the protected-merge signing credential.
 *
 * Base-transition provenance verification (issue 08a5f04) will only attest a
 * sibling merge whose commit signature verifies against an *active registry
 * credential* of its approver. If the operator's protected-merge signing key
 * was never registered, nothing looks wrong until the second queued approval
 * of the operator's life, which then refuses with no visible cause.
 *
 * This audit makes the misconfiguration visible at startup: it derives the
 * fingerprint of the configured `git user.signingkey` and reports whether any
 * active signing credential on the operator matches it. It is read-only, runs
 * its probes off the event loop, and never blocks startup.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Db } from "./db.js";
import { getOperator } from "./users/store.js";

export type SigningCredentialAuditStatus =
  | "ok"
  | "no_operator"
  | "unconfigured"
  | "unresolvable"
  | "missing_credential";

export interface SigningCredentialAudit {
  status: SigningCredentialAuditStatus;
  /** Raw `git config user.signingkey` value, when set. */
  configured_key: string | null;
  fingerprint: string | null;
  operator_slug: string | null;
  /** Machine-readable cause for `unresolvable`. */
  reason: string | null;
  /** The command that fixes a `missing_credential` result. */
  hint: string | null;
}

export interface SigningCredentialAuditOptions {
  /** Working directory for the git/ssh-keygen probes. Defaults to $HOME. */
  cwd?: string;
  /**
   * Read `user.signingkey` from global config only (the daemon default: it is
   * not scoped to any one repository). Pass false to honour repo-local config.
   */
  global?: boolean;
}

const SIGNING_CREDENTIAL_TYPES = ["ssh_key", "delegated_ssh_key"];

/**
 * The daemon may run under the dotfiles agent-signing environment, whose
 * `GIT_CONFIG_*` overrides point `user.signingkey` at the *agent* key. The
 * audit is about the operator's protected-merge key, so those overrides are
 * stripped — same rule as `mandible user credential add --from-git-signingkey`.
 */
function gitProbeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return env;
}

/** Run one probe; its trimmed stdout, or null when it fails in any way. */
function probe(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd: options.cwd, env: options.env, encoding: "utf-8", timeout: 5000,
    }, (error, stdout) => resolve(error ? null : stdout.trim()));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

/** Exit 1 simply means unset; any other failure is equally "nothing to audit". */
export async function readConfiguredSigningKey(options: SigningCredentialAuditOptions = {}): Promise<string | null> {
  const args = options.global === false
    ? ["config", "--get", "user.signingkey"]
    : ["config", "--global", "--get", "user.signingkey"];
  return (await probe("git", args, { cwd: options.cwd ?? os.homedir(), env: gitProbeEnv() })) || null;
}

export interface ResolvedSigningKey {
  material: string;
  fingerprint: string;
}

export type SigningKeyResolution = { ok: true; value: ResolvedSigningKey } | { ok: false; reason: string };

/** Parse one pasted OpenSSH public-key line and calculate its SHA256 fingerprint. */
export async function resolveOpenSshPublicKey(
  input: string,
  options: SigningCredentialAuditOptions = {},
): Promise<SigningKeyResolution> {
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
  const fingerprint = await fingerprintOf(material, options.cwd ?? os.homedir());
  if (!fingerprint) {
    return { ok: false, reason: "signing_key_fingerprint_failed" };
  }
  return { ok: true, value: { material, fingerprint } };
}

/** Discover only public material for Settings; never open or derive from a private key. */
export async function discoverConfiguredPublicSigningKey(
  options: SigningCredentialAuditOptions = {},
): Promise<{ configured_key: string | null; value: ResolvedSigningKey | null; reason: string | null }> {
  const configuredKey = await readConfiguredSigningKey(options);
  if (!configuredKey) return { configured_key: null, value: null, reason: null };

  const inline = configuredKey.startsWith("key::")
    ? configuredKey.slice("key::".length)
    : configuredKey;
  if (isPublicKeyLine(inline)) {
    const result = await resolveOpenSshPublicKey(inline, options);
    return result.ok
      ? { configured_key: configuredKey, value: result.value, reason: null }
      : { configured_key: configuredKey, value: null, reason: result.reason };
  }

  let configuredPath = configuredKey;
  if (configuredPath.startsWith("~/")) configuredPath = path.join(os.homedir(), configuredPath.slice(2));
  if (!path.isAbsolute(configuredPath)) configuredPath = path.resolve(options.cwd ?? os.homedir(), configuredPath);
  const publicPath = configuredPath.endsWith(".pub") ? configuredPath : `${configuredPath}.pub`;
  const publicMaterial = readFirstLine(publicPath);
  if (!publicMaterial || !isPublicKeyLine(publicMaterial)) {
    return { configured_key: configuredKey, value: null, reason: "public_key_not_available_without_private_key_access" };
  }
  const result = await resolveOpenSshPublicKey(publicMaterial, options);
  return result.ok
    ? { configured_key: configuredKey, value: result.value, reason: null }
    : { configured_key: configuredKey, value: null, reason: result.reason };
}

/**
 * Resolve a `user.signingkey` value to its OpenSSH public material and SHA256
 * fingerprint. Accepts the three shapes git supports: a literal `key::` value,
 * an inline public key, or a path to a public or private key file.
 */
export async function resolveSigningKeyFingerprint(
  configuredKey: string,
  options: SigningCredentialAuditOptions = {},
): Promise<SigningKeyResolution> {
  const cwd = options.cwd ?? os.homedir();
  let keyLine: string | null = null;

  if (configuredKey.startsWith("key::")) {
    keyLine = configuredKey.slice("key::".length);
  } else if (isPublicKeyLine(configuredKey)) {
    keyLine = configuredKey;
  } else {
    let keyPath = configuredKey;
    if (keyPath.startsWith("~/")) keyPath = path.join(os.homedir(), keyPath.slice(2));
    if (!path.isAbsolute(keyPath)) keyPath = path.resolve(cwd, keyPath);
    if (!existsSync(keyPath)) {
      return { ok: false, reason: "signing_key_path_unreadable" };
    }
    const firstLine = readFirstLine(keyPath);
    if (firstLine && isPublicKeyLine(firstLine)) {
      keyLine = firstLine;
    } else if (existsSync(`${keyPath}.pub`)) {
      keyLine = readFirstLine(`${keyPath}.pub`);
    } else {
      keyLine = await probe("ssh-keygen", ["-y", "-f", keyPath], { cwd });
    }
  }

  const material = keyLine
    ?.trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  if (!material || !isPublicKeyLine(material)) {
    return { ok: false, reason: "signing_key_not_openssh_public_key" };
  }
  const fingerprint = await fingerprintOf(material, cwd);
  if (!fingerprint) {
    return { ok: false, reason: "signing_key_fingerprint_failed" };
  }
  return { ok: true, value: { material, fingerprint } };
}

export async function auditOperatorSigningCredential(
  db: Db,
  options: SigningCredentialAuditOptions = {},
): Promise<SigningCredentialAudit> {
  const configuredKey = await readConfiguredSigningKey(options);
  const operator = readOperator(db);
  if (!configuredKey) {
    return {
      status: "unconfigured",
      configured_key: null,
      fingerprint: null,
      operator_slug: operator?.slug ?? null,
      reason: null,
      hint: null,
    };
  }
  if (!operator) {
    return {
      status: "no_operator",
      configured_key: configuredKey,
      fingerprint: null,
      operator_slug: null,
      reason: null,
      hint: "Run `mandible user setup` to create the local operator.",
    };
  }
  const resolved = await resolveSigningKeyFingerprint(configuredKey, options);
  if (!resolved.ok) {
    return {
      status: "unresolvable",
      configured_key: configuredKey,
      fingerprint: null,
      operator_slug: operator.slug,
      reason: resolved.reason,
      hint: null,
    };
  }
  const fingerprint = resolved.value.fingerprint;
  const matches = activeSigningFingerprints(db, operator.id).includes(fingerprint);
  if (matches) {
    return {
      status: "ok",
      configured_key: configuredKey,
      fingerprint,
      operator_slug: operator.slug,
      reason: null,
      hint: null,
    };
  }
  return {
    status: "missing_credential",
    configured_key: configuredKey,
    fingerprint,
    operator_slug: operator.slug,
    reason: null,
    hint: `mandible user credential add ${operator.slug} --from-git-signingkey`,
  };
}

function readOperator(db: Db): { id: string; slug: string } | null {
  try {
    const operator = getOperator(db);
    return operator ? { id: operator.id, slug: operator.slug } : null;
  } catch {
    return null;
  }
}

function activeSigningFingerprints(db: Db, userId: string): string[] {
  try {
    const placeholders = SIGNING_CREDENTIAL_TYPES.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT fingerprint FROM user_credentials
          WHERE user_id = ? AND status = 'active' AND type IN (${placeholders})`,
      )
      .all(userId, ...SIGNING_CREDENTIAL_TYPES) as Array<{ fingerprint: string }>;
    return rows.map((row) => row.fingerprint);
  } catch {
    return [];
  }
}

function isPublicKeyLine(value: string): boolean {
  return /^(ssh-|ecdsa-|sk-)\S+\s+\S+/.test(value.trim());
}

function readFirstLine(file: string): string | null {
  try {
    return readFileSync(file, "utf-8").split(/\r?\n/, 1)[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function fingerprintOf(material: string, cwd: string): Promise<string | null> {
  const output = await probe("ssh-keygen", ["-lf", "-", "-E", "sha256"], { cwd, input: `${material}\n` });
  const fingerprint = output?.split(/\s+/)[1] ?? null;
  return fingerprint && fingerprint.startsWith("SHA256:") ? fingerprint : null;
}
