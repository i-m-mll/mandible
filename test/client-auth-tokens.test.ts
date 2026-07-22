import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { createUser, revokeCredential, updateUser } from "../src/users/store.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import {
  API_TOKEN_PREFIX,
  fingerprintForToken,
  generateRawToken,
  normalizeBearer,
  verifyApiToken,
} from "../src/client-auth/tokens.js";
import { loadOrCreatePepper } from "../src/client-auth/secret-store.js";
import {
  DEFAULT_CLIENT_AUTH_MODE,
  getClientAuthMode,
  setClientAuthMode,
} from "../src/client-auth/mode.js";
import { ClientAuthTelemetry } from "../src/client-auth/telemetry.js";

let tempDir = "";
let secretsDir = "";
let db: Db;
let pepper = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-auth-"));
  secretsDir = path.join(tempDir, "client-auth");
  db = openDb(path.join(tempDir, "mandible.db"));
  pepper = loadOrCreatePepper(db, secretsDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeAgent() {
  return createUser(db, { slug: "agent-x", kind: "agent", display_name: "Agent X" });
}

function authenticator() {
  return new ClientAuthenticator(db, { secretsDir });
}

describe("api token minting and verification", () => {
  it("mints a token whose raw value is never stored and round-trips to its user", () => {
    const user = makeAgent();
    const { token, credential } = authenticator().mintApiToken(user.slug, { label: "ci" });

    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(credential.type).toBe("api_token");
    expect(credential.status).toBe("active");
    // The stored fingerprint is a peppered hash, not the raw token.
    expect(credential.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(credential.fingerprint).not.toContain(token);

    const verified = verifyApiToken(db, pepper, token);
    expect(verified?.user.id).toBe(user.id);
    expect(verified?.credentialId).toBe(credential.id);
  });

  it("stores no row anywhere containing the raw token", () => {
    const user = makeAgent();
    const { token } = authenticator().mintApiToken(user.slug);
    const rows = db
      .prepare("SELECT fingerprint, public_material, label, metadata_json FROM user_credentials")
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") expect(value).not.toContain(token);
      }
    }
  });

  it("keeps the pepper on disk, never in the settings table", () => {
    makeAgent();
    const pepperFile = path.join(secretsDir, "pepper");
    expect(fs.existsSync(pepperFile)).toBe(true);
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'client_auth.token_pepper'")
      .get();
    expect(row).toBeUndefined();
  });

  it("migrates a legacy pepper row into the file and deletes the row", () => {
    // Simulate a database written by the pre-review build.
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('client_auth.token_pepper', 'legacy-pepper', 0)",
    ).run();
    const freshSecrets = path.join(tempDir, "migrated");
    const loaded = loadOrCreatePepper(db, freshSecrets);
    expect(loaded).toBe("legacy-pepper");
    expect(fs.readFileSync(path.join(freshSecrets, "pepper"), "utf8").trim()).toBe("legacy-pepper");
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'client_auth.token_pepper'").get(),
    ).toBeUndefined();
  });

  it("rejects a revoked token", () => {
    const user = makeAgent();
    const { token, credential } = authenticator().mintApiToken(user.slug);
    expect(verifyApiToken(db, pepper, token)).not.toBeNull();

    revokeCredential(db, credential.id);
    expect(verifyApiToken(db, pepper, token)).toBeNull();
  });

  it("rejects an unknown or malformed token without side effects", () => {
    makeAgent();
    expect(verifyApiToken(db, pepper, null)).toBeNull();
    expect(verifyApiToken(db, pepper, "")).toBeNull();
    expect(verifyApiToken(db, pepper, "not-a-mandible-token")).toBeNull();
    expect(verifyApiToken(db, pepper, generateRawToken())).toBeNull();
  });

  it("rejects a valid token whose user has been retired", () => {
    const user = makeAgent();
    const { token } = authenticator().mintApiToken(user.slug);
    updateUser(db, user.id, { status: "retired" });
    expect(verifyApiToken(db, pepper, token)).toBeNull();
  });

  it("hashes deterministically with a stable pepper", () => {
    const token = generateRawToken();
    expect(fingerprintForToken(pepper, token)).toBe(fingerprintForToken(pepper, token));
  });

  it("normalizes bearer scheme prefixes", () => {
    expect(normalizeBearer("Bearer abc123")).toBe("abc123");
    expect(normalizeBearer("bearer abc123")).toBe("abc123");
    expect(normalizeBearer("abc123")).toBe("abc123");
    expect(normalizeBearer("  ")).toBeNull();
    expect(normalizeBearer(undefined)).toBeNull();
  });
});

describe("client auth mode", () => {
  it("defaults to compat and toggles to strict", () => {
    expect(getClientAuthMode(db)).toBe(DEFAULT_CLIENT_AUTH_MODE);
    expect(getClientAuthMode(db)).toBe("compat");
    setClientAuthMode(db, "strict");
    expect(getClientAuthMode(db)).toBe("strict");
    setClientAuthMode(db, "compat");
    expect(getClientAuthMode(db)).toBe("compat");
  });

  it("rejects an invalid mode", () => {
    expect(() => setClientAuthMode(db, "loose")).toThrow();
  });
});

describe("unattributed-write telemetry", () => {
  it("counts by transport and category", () => {
    const telemetry = new ClientAuthTelemetry();
    telemetry.recordUnattributedWrite({ method: "POST", pathname: "/api/issues", transport: "http", category: "issues" });
    telemetry.recordUnattributedWrite({ method: "PATCH", pathname: "/api/sessions/1", transport: "file-rpc", category: "sessions" });
    telemetry.recordUnattributedWrite({ method: "POST", pathname: "/api/issues", transport: "http", category: "issues" });

    const snapshot = telemetry.snapshot();
    expect(snapshot.unattributed_writes_total).toBe(3);
    expect(snapshot.by_transport).toEqual({ http: 2, "file-rpc": 1 });
    expect(snapshot.by_category).toEqual({ issues: 2, sessions: 1 });
    expect(snapshot.last_unattributed_write?.pathname).toBe("/api/issues");
  });
});
