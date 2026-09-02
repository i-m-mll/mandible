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
// Preview instances also hold one process-bound browser-enrollment proof under
// their isolated preview root. It is accepted only by the handshake and is
// never created by the main daemon.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { ensureMandibleConfigEntry } from "../platform-paths.js";

const PEPPER_FILE = "pepper";
const BOOTSTRAP_TOKEN_FILE = "bootstrap-token";
const DASHBOARD_SESSION_FILE = "dashboard-session.json";
export const PREVIEW_BROWSER_ENROLLMENT_FILE = "preview-browser-enrollment.json";
export const MAX_DASHBOARD_SESSIONS = 8;
/** Legacy location: the pepper used to live in the settings KV table. */
const LEGACY_PEPPER_SETTING_KEY = "client_auth.token_pepper";

/**
 * Copies the directory forward from the pre-durable-root config location on
 * first use (issue 24f0316). The pepper in particular cannot be regenerated
 * without consequence: every stored API token's fingerprint is an HMAC under
 * it, so a fresh pepper silently invalidates all of them.
 */
export function defaultClientAuthDir(): string {
  return ensureMandibleConfigEntry("client-auth");
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

export interface PreviewBrowserEnrollmentProof {
  version: 1;
  pid: number;
  startup_epoch: string;
  token: string;
}

export function writePreviewBrowserEnrollmentProof(
  proof: PreviewBrowserEnrollmentProof | null,
  previewRoot: string,
): string {
  const filePath = path.join(previewRoot, PREVIEW_BROWSER_ENROLLMENT_FILE);
  if (proof) {
    writeSecretFile(filePath, JSON.stringify(proof));
  } else {
    fs.rmSync(filePath, { force: true });
  }
  return filePath;
}

export interface StoredDashboardSession {
  token_fingerprint: string;
  user_id: string;
  slug: string;
  created_at: number;
  expires_at: number;
  renew_until: number;
}

export interface StoredDashboardSessions {
  version: 2;
  sessions: StoredDashboardSession[];
}

function parseDashboardSession(value: unknown): StoredDashboardSession {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid client-auth dashboard session file.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.token_fingerprint !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(record.token_fingerprint)
    || typeof record.user_id !== "string"
    || record.user_id.length === 0
    || typeof record.slug !== "string"
    || record.slug.length === 0
    || typeof record.created_at !== "number"
    || !Number.isSafeInteger(record.created_at)
    || record.created_at < 0
    || typeof record.expires_at !== "number"
    || !Number.isSafeInteger(record.expires_at)
    || record.expires_at < 0
    || (record.renew_until !== undefined
      && (typeof record.renew_until !== "number"
        || !Number.isSafeInteger(record.renew_until)
        || record.renew_until < 0))
  ) {
    throw new Error("Invalid client-auth dashboard session file.");
  }
  const renewUntil = typeof record.renew_until === "number"
    ? record.renew_until
    : record.expires_at;
  if (record.created_at > record.expires_at || renewUntil < record.expires_at) {
    throw new Error("Invalid client-auth dashboard session file.");
  }
  return {
    token_fingerprint: record.token_fingerprint,
    user_id: record.user_id,
    slug: record.slug,
    created_at: record.created_at,
    expires_at: record.expires_at,
    renew_until: renewUntil,
  };
}

export function readDashboardSessions(
  dir: string = defaultClientAuthDir(),
): { sessions: StoredDashboardSession[]; legacy: boolean } | null {
  const filePath = path.join(dir, DASHBOARD_SESSION_FILE);
  const raw = readProtectedSecretFile(filePath);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid client-auth dashboard session file.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid client-auth dashboard session file.");
  }
  const value = parsed as Record<string, unknown>;
  if (value.version === 2) {
    if (!Array.isArray(value.sessions) || value.sessions.length > MAX_DASHBOARD_SESSIONS) {
      throw new Error("Invalid client-auth dashboard session file.");
    }
    const sessions = value.sessions.map(parseDashboardSession);
    if (new Set(sessions.map((session) => session.token_fingerprint)).size !== sessions.length) {
      throw new Error("Invalid client-auth dashboard session file.");
    }
    return { sessions, legacy: false };
  }
  return { sessions: [parseDashboardSession(value)], legacy: true };
}

export function writeDashboardSessions(
  sessions: StoredDashboardSession[],
  dir: string = defaultClientAuthDir(),
): void {
  const filePath = path.join(dir, DASHBOARD_SESSION_FILE);
  if (sessions.length > 0) {
    const state: StoredDashboardSessions = { version: 2, sessions };
    writeSecretFile(filePath, JSON.stringify(state));
    return;
  }
  fs.rmSync(filePath, { force: true });
}

/** Compatibility helpers for callers that still operate on one session. */
export function readDashboardSession(
  dir: string = defaultClientAuthDir(),
): StoredDashboardSession | null {
  return readDashboardSessions(dir)?.sessions[0] ?? null;
}

export function writeDashboardSession(
  session: StoredDashboardSession | null,
  dir: string = defaultClientAuthDir(),
): void {
  writeDashboardSessions(session ? [session] : [], dir);
}
