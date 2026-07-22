// Filesystem-anchored client-auth secrets.
//
// The trust model for these secrets is the same as file-RPC: same-user
// filesystem access. Two secrets live under <config-dir>/client-auth/ (0700):
//   - `pepper`: the HMAC pepper for token fingerprints. Kept out of the DB so a
//     database read (GET /api/settings) or write (PUT /api/settings) cannot
//     exfiltrate or overwrite it (finding 4). Read once at startup and cached.
//   - `bootstrap-token`: the operator's daemon-lifetime ephemeral token, written
//     0600 so a same-user CLI can authenticate without the token ever appearing
//     on the wire or in the served HTML (finding 1).
//
// No secret is ever embedded in an HTTP response.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { getMandibleConfigDir } from "../platform-paths.js";

const PEPPER_FILE = "pepper";
const BOOTSTRAP_TOKEN_FILE = "bootstrap-token";
/** Legacy location: the pepper used to live in the settings KV table. */
const LEGACY_PEPPER_SETTING_KEY = "client_auth.token_pepper";

export function defaultClientAuthDir(): string {
  return path.join(getMandibleConfigDir(), "client-auth");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some mounts do not support chmod; the creation mode still documents intent.
  }
}

function writeSecretFile(filePath: string, contents: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
}

/**
 * Load the HMAC pepper from disk, creating it on first run. If a legacy pepper
 * exists in the settings table it is migrated to the file and the row deleted,
 * so the pepper is never again readable/overwritable through the settings API.
 * Called once at startup; the result is cached by the caller.
 */
export function loadOrCreatePepper(db: Db, dir: string = defaultClientAuthDir()): string {
  const pepperPath = path.join(dir, PEPPER_FILE);
  if (fs.existsSync(pepperPath)) {
    const existing = fs.readFileSync(pepperPath, "utf8").trim();
    if (existing) {
      migrateLegacyPepperRow(db);
      return existing;
    }
  }

  const legacy = readLegacyPepperRow(db);
  if (legacy) {
    writeSecretFile(pepperPath, legacy);
    deleteLegacyPepperRow(db);
    return legacy;
  }

  const pepper = randomBytes(32).toString("base64url");
  writeSecretFile(pepperPath, pepper);
  return pepper;
}

function readLegacyPepperRow(db: Db): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(LEGACY_PEPPER_SETTING_KEY) as { value: string } | undefined;
    const value = row?.value?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

function deleteLegacyPepperRow(db: Db): void {
  try {
    db.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_PEPPER_SETTING_KEY);
  } catch {
    // best effort — a stale row is harmless once the file is authoritative.
  }
}

function migrateLegacyPepperRow(db: Db): void {
  if (readLegacyPepperRow(db)) {
    deleteLegacyPepperRow(db);
  }
}

/**
 * Write (or clear) the operator's daemon-lifetime bootstrap token file. Passing
 * null removes the file (no operator configured). The file is 0600 so only the
 * same user can read it.
 */
export function writeBootstrapTokenFile(token: string | null, dir: string = defaultClientAuthDir()): void {
  const tokenPath = path.join(dir, BOOTSTRAP_TOKEN_FILE);
  if (token) {
    writeSecretFile(tokenPath, token);
    return;
  }
  try {
    fs.rmSync(tokenPath, { force: true });
  } catch {
    // best effort
  }
}

export function bootstrapTokenFilePath(dir: string = defaultClientAuthDir()): string {
  return path.join(dir, BOOTSTRAP_TOKEN_FILE);
}
