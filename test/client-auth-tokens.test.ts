import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { createUser, revokeCredential, setupOperator, updateUser } from "../src/users/store.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import {
  API_TOKEN_PREFIX,
  fingerprintForToken,
  generateRawToken,
  normalizeBearer,
  verifyApiToken,
} from "../src/client-auth/tokens.js";
import {
  loadOrCreatePepper,
  MAX_DASHBOARD_SESSIONS,
  readDashboardSessions,
} from "../src/client-auth/secret-store.js";
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

  it("repairs permissions on an existing pepper file before using it", () => {
    const pepperFile = path.join(secretsDir, "pepper");
    fs.chmodSync(secretsDir, 0o755);
    fs.chmodSync(pepperFile, 0o644);
    expect(loadOrCreatePepper(db, secretsDir)).toBe(pepper);
    expect(fs.statSync(secretsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(pepperFile).mode & 0o777).toBe(0o600);
  });

  it("fails closed when a migrated legacy pepper cannot be deleted", () => {
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('client_auth.token_pepper', 'legacy-pepper', 0)",
    ).run();
    const failingDb = {
      prepare(sql: string) {
        if (sql.startsWith("DELETE FROM settings")) {
          throw new Error("simulated read-only database");
        }
        return db.prepare(sql);
      },
    } as unknown as Db;
    const freshSecrets = path.join(tempDir, "failed-migration");
    expect(() => loadOrCreatePepper(failingDb, freshSecrets)).toThrow(
      "simulated read-only database",
    );
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'client_auth.token_pepper'").get(),
    ).toBeDefined();
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

describe("bounded dashboard sessions", () => {
  function operatorAuth(options: ConstructorParameters<typeof ClientAuthenticator>[1] = {}) {
    const operator = setupOperator(db, { display_name: "Operator", email: "op@example.com" });
    const auth = new ClientAuthenticator(db, { secretsDir, ...options });
    const durable = auth.mintApiToken(operator.id).token;
    const identity = auth.authenticate(durable)!;
    return { auth, operator, durable, identity };
  }

  it("keeps the presented session valid while concurrent renewal succeeds", () => {
    const { auth, identity } = operatorAuth();
    const browser = auth.issueDashboardToken(identity);
    const desktop = auth.issueDashboardToken(identity);
    expect(auth.authenticate(browser.token)).not.toBeNull();
    expect(auth.authenticate(desktop.token)).not.toBeNull();

    const browserIdentity = auth.authenticate(browser.token, "http_bearer", {
      method: "POST",
      pathname: "/api/client-auth/handshake",
    })!;
    const renewed = auth.issueDashboardToken(browserIdentity);
    expect(auth.authenticate(browser.token)).not.toBeNull();
    expect(auth.authenticate(desktop.token)).not.toBeNull();
    expect(auth.authenticate(renewed.token)).not.toBeNull();
  });

  it("adds a durable-token enrollment without revoking existing surfaces", () => {
    const { auth, durable, identity } = operatorAuth();
    const first = auth.issueDashboardToken(identity);
    const secondIdentity = auth.authenticate(durable)!;
    const second = auth.issueDashboardToken(secondIdentity);
    expect(auth.authenticate(first.token)).not.toBeNull();
    expect(auth.authenticate(second.token)).not.toBeNull();
  });

  it("purges expired sessions before evicting the oldest at capacity", () => {
    let now = 1_000;
    const { auth, identity } = operatorAuth({
      dashboardSessionTtlMs: 10,
      dashboardSessionRenewalGraceMs: 10,
      now: () => now,
    });
    const expired = auth.issueDashboardToken(identity);
    now = 1_021;
    const live: string[] = [];
    for (let index = 0; index < MAX_DASHBOARD_SESSIONS; index += 1) {
      now += 1;
      live.push(auth.issueDashboardToken(identity).token);
    }
    expect(auth.authenticate(expired.token)).toBeNull();
    expect(readDashboardSessions(secretsDir)?.sessions).toHaveLength(MAX_DASHBOARD_SESSIONS);
    expect(live.every((token) => auth.authenticate(token) !== null)).toBe(true);

    now += 1;
    const newest = auth.issueDashboardToken(identity);
    expect(auth.authenticate(live[0])).toBeNull();
    expect(auth.authenticate(live.at(-1)!)).not.toBeNull();
    expect(auth.authenticate(newest.token)).not.toBeNull();
  });

  it("restores all persisted sessions after restart", () => {
    const { auth, operator, identity } = operatorAuth();
    const first = auth.issueDashboardToken(identity);
    const second = auth.issueDashboardToken(identity);
    const restarted = new ClientAuthenticator(db, { secretsDir });
    expect(restarted.authenticate(first.token)).toMatchObject({ user_id: operator.id });
    expect(restarted.authenticate(second.token)).toMatchObject({ user_id: operator.id });
  });

  it("isolates production and preview audiences even when they share a copied database", () => {
    const operator = setupOperator(db, { display_name: "Operator", email: "op@example.com" });
    const production = new ClientAuthenticator(db, {
      secretsDir: path.join(tempDir, "production-auth"),
    });
    const preview = new ClientAuthenticator(db, {
      secretsDir: path.join(tempDir, "preview-auth"),
    });
    const identity = { user_id: operator.id, slug: operator.slug };
    const productionSession = production.issueDashboardToken(identity);
    const previewSession = preview.issueDashboardToken(identity);

    expect(production.authorityId()).not.toBe(preview.authorityId());
    expect(preview.authenticate(productionSession.token)).toBeNull();
    expect(production.authenticate(previewSession.token)).toBeNull();
  });

  it("migrates the legacy single-record file transparently", () => {
    const { auth, operator, identity } = operatorAuth();
    const token = auth.issueDashboardToken(identity).token;
    const state = readDashboardSessions(secretsDir)!;
    fs.writeFileSync(
      path.join(secretsDir, "dashboard-session.json"),
      JSON.stringify(state.sessions[0]),
      { mode: 0o600 },
    );

    const restarted = new ClientAuthenticator(db, { secretsDir });
    expect(restarted.authenticate(token)).toMatchObject({ user_id: operator.id });
    expect(JSON.parse(fs.readFileSync(
      path.join(secretsDir, "dashboard-session.json"),
      "utf8",
    ))).toMatchObject({ version: 2, sessions: [state.sessions[0]] });
  });

  it("fails closed on malformed persisted state", () => {
    const operator = setupOperator(db, { display_name: "Operator", email: "op@example.com" });
    fs.writeFileSync(
      path.join(secretsDir, "dashboard-session.json"),
      JSON.stringify({ version: 2, sessions: [{ token_fingerprint: "raw-secret" }] }),
      { mode: 0o600 },
    );
    expect(operator.id).toBeTruthy();
    expect(() => new ClientAuthenticator(db, { secretsDir })).toThrow(
      "Invalid client-auth dashboard session file.",
    );
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
