import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { createUser, revokeCredential, updateUser } from "../src/users/store.js";
import {
  API_TOKEN_PREFIX,
  fingerprintForToken,
  generateRawToken,
  mintApiToken,
  normalizeBearer,
  verifyApiToken,
} from "../src/client-auth/tokens.js";
import {
  DEFAULT_CLIENT_AUTH_MODE,
  getClientAuthMode,
  setClientAuthMode,
} from "../src/client-auth/mode.js";
import { ClientAuthTelemetry } from "../src/client-auth/telemetry.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-auth-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeAgent() {
  return createUser(db, { slug: "agent-x", kind: "agent", display_name: "Agent X" });
}

describe("api token minting and verification", () => {
  it("mints a token whose raw value is never stored and round-trips to its user", () => {
    const user = makeAgent();
    const { token, credential } = mintApiToken(db, user.slug, { label: "ci" });

    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(credential.type).toBe("api_token");
    expect(credential.status).toBe("active");
    // The stored fingerprint is a peppered hash, not the raw token.
    expect(credential.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(credential.fingerprint).not.toContain(token);

    const verified = verifyApiToken(db, token);
    expect(verified?.user.id).toBe(user.id);
    expect(verified?.credentialId).toBe(credential.id);
  });

  it("stores no row anywhere containing the raw token", () => {
    const user = makeAgent();
    const { token } = mintApiToken(db, user.slug);
    const rows = db
      .prepare("SELECT fingerprint, public_material, label, metadata_json FROM user_credentials")
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") expect(value).not.toContain(token);
      }
    }
  });

  it("rejects a revoked token", () => {
    const user = makeAgent();
    const { token, credential } = mintApiToken(db, user.slug);
    expect(verifyApiToken(db, token)).not.toBeNull();

    revokeCredential(db, credential.id);
    expect(verifyApiToken(db, token)).toBeNull();
  });

  it("rejects an unknown or malformed token", () => {
    makeAgent();
    expect(verifyApiToken(db, null)).toBeNull();
    expect(verifyApiToken(db, "")).toBeNull();
    expect(verifyApiToken(db, "not-a-mandible-token")).toBeNull();
    expect(verifyApiToken(db, generateRawToken())).toBeNull();
  });

  it("rejects a valid token whose user has been retired", () => {
    const user = makeAgent();
    const { token } = mintApiToken(db, user.slug);
    updateUser(db, user.id, { status: "retired" });
    expect(verifyApiToken(db, token)).toBeNull();
  });

  it("hashes deterministically with a stable per-install pepper", () => {
    const token = generateRawToken();
    const first = fingerprintForToken(db, token);
    const second = fingerprintForToken(db, token);
    expect(first).toBe(second);
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
