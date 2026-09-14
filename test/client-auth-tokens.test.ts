// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { loadOrCreatePepper } from "../src/client-auth/secret-store.js";
import { API_TOKEN_PREFIX, fingerprintForToken, generateRawToken, normalizeBearer, verifyApiToken } from "../src/client-auth/tokens.js";
import { DEFAULT_CLIENT_AUTH_MODE, getClientAuthMode, setClientAuthMode } from "../src/client-auth/mode.js";
import { openDb, type Db } from "../src/db.js";
import { createUser, revokeCredential, updateUser } from "../src/users/store.js";

let root = ""; let secrets = ""; let db: Db; let pepper = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-auth-"));
  secrets = path.join(root, "client-auth");
  db = openDb(path.join(root, "mandible.db"));
  pepper = loadOrCreatePepper(db, secrets);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function agent() { return createUser(db, { slug: "agent-x", kind: "agent", display_name: "Agent X" }); }

describe("durable API credentials", () => {
  it("stores only a peppered fingerprint and round-trips the user", () => {
    const user = agent();
    const issued = new ClientAuthenticator(db, { secretsDir: secrets }).mintApiToken(user.slug, { label: "ci" });
    expect(issued.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(issued.credential.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(issued.credential.fingerprint).not.toContain(issued.token);
    expect(verifyApiToken(db, pepper, issued.token)?.user.id).toBe(user.id);
  });

  it("rejects unknown, revoked, and retired-user credentials", () => {
    const user = agent();
    const issued = new ClientAuthenticator(db, { secretsDir: secrets }).mintApiToken(user.slug);
    expect(verifyApiToken(db, pepper, generateRawToken())).toBeNull();
    revokeCredential(db, issued.credential.id);
    expect(verifyApiToken(db, pepper, issued.token)).toBeNull();
    const second = new ClientAuthenticator(db, { secretsDir: secrets }).mintApiToken(user.slug);
    updateUser(db, user.id, { status: "retired" });
    expect(verifyApiToken(db, pepper, second.token)).toBeNull();
  });

  it("keeps the pepper outside SQLite with protected permissions", () => {
    const file = path.join(secrets, "pepper");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'client_auth.token_pepper'").get()).toBeUndefined();
    expect(fingerprintForToken(pepper, "same")).toBe(fingerprintForToken(pepper, "same"));
  });

  it("normalizes bearer syntax", () => {
    expect(normalizeBearer("Bearer abc")).toBe("abc");
    expect(normalizeBearer("bearer abc")).toBe("abc");
    expect(normalizeBearer("  ")).toBeNull();
  });
});

describe("client auth mode", () => {
  it("defaults fail-closed and refuses obsolete compatibility mode", () => {
    expect(DEFAULT_CLIENT_AUTH_MODE).toBe("strict");
    expect(getClientAuthMode(db)).toBe("strict");
    setClientAuthMode(db, "strict");
    expect(() => setClientAuthMode(db, "compat")).toThrow();
  });
});
