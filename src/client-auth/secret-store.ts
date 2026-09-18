// Filesystem-anchored client-auth secrets.
//
// The trust model for these secrets is same-user filesystem access.
// The client-auth directory holds:
//   - `pepper`: the HMAC pepper for token fingerprints. Kept out of the DB so a
//     database read (GET /api/settings) or write (PUT /api/settings) cannot
//     exfiltrate or overwrite it (finding 4). Read once at startup and cached.
//   - `authority-id`: an installation identity for local CSRF binding.
//
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { ensureMandibleClientAuthDir } from "../platform-paths.js";

const PEPPER_FILE = "pepper";
const AUTHORITY_ID_FILE = "authority-id";
/** Legacy location: the pepper used to live in the settings KV table. */
const LEGACY_PEPPER_SETTING_KEY = "client_auth.token_pepper";

/**
 * Copies the directory forward from the pre-durable-root config location on
 * first use (issue 24f0316). The pepper in particular cannot be regenerated
 * without consequence: every stored API token's fingerprint is an HMAC under
 * it, so a fresh pepper silently invalidates all of them.
 */
export function defaultClientAuthDir(): string {
  return ensureMandibleClientAuthDir();
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writeSecretFile(filePath: string, contents: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readProtectedSecretFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  ensureDir(path.dirname(filePath));
  fs.chmodSync(filePath, 0o600);
  const contents = fs.readFileSync(filePath, "utf8").trim();
  return contents || null;
}

/**
 * Load the HMAC pepper from disk, creating it on first run. If a legacy pepper
 * exists in the settings table it is migrated to the file and the row deleted,
 * so the pepper is never again readable/overwritable through the settings API.
 * Called once at startup; the result is cached by the caller.
 */
export function loadOrCreatePepper(db: Db, dir: string = defaultClientAuthDir()): string {
  const pepperPath = path.join(dir, PEPPER_FILE);
  const existing = readProtectedSecretFile(pepperPath);
  if (existing) {
    migrateLegacyPepperRow(db);
    return existing;
  }

  const legacy = readLegacyPepperRow(db);
  if (legacy) {
    writePepperExclusively(pepperPath, legacy);
    deleteLegacyPepperRow(db);
    return readRequiredSecretFile(pepperPath);
  }

  const pepper = randomBytes(32).toString("base64url");
  writePepperExclusively(pepperPath, pepper);
  return readRequiredSecretFile(pepperPath);
}

/**
 * Stable public identity for one client-auth authority. Production and every
 * isolated preview have different protected config directories, so this value
 * lets a browser recognize that a different daemon temporarily appeared at
 * the same origin without presenting or discarding its credential.
 */
export function loadOrCreateClientAuthAuthorityId(
  dir: string = defaultClientAuthDir(),
): string {
  const authorityPath = path.join(dir, AUTHORITY_ID_FILE);
  const existing = readProtectedSecretFile(authorityPath);
  if (existing) return existing;
  const authorityId = `authority_${randomBytes(18).toString("base64url")}`;
  writeSecretFile(authorityPath, authorityId);
  return readRequiredSecretFile(authorityPath);
}

function writePepperExclusively(pepperPath: string, pepper: string): void {
  ensureDir(path.dirname(pepperPath));
  try {
    fs.writeFileSync(pepperPath, pepper, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  fs.chmodSync(pepperPath, 0o600);
}

function readRequiredSecretFile(filePath: string): string {
  const value = readProtectedSecretFile(filePath);
  if (!value) throw new Error(`Client-auth secret is empty: ${filePath}`);
  return value;
}

function readLegacyPepperRow(db: Db): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(LEGACY_PEPPER_SETTING_KEY) as { value: string } | undefined;
  const value = row?.value?.trim();
  return value ? value : null;
}

function deleteLegacyPepperRow(db: Db): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_PEPPER_SETTING_KEY);
  if (readLegacyPepperRow(db) !== null) {
    throw new Error("Failed to remove the legacy client-auth pepper from settings.");
  }
}

function migrateLegacyPepperRow(db: Db): void {
  if (readLegacyPepperRow(db)) {
    deleteLegacyPepperRow(db);
  }
}
