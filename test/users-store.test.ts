import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Db } from "../src/db.js";
import {
  addCredential,
  getOperatorId,
  getSystemUser,
  listCredentials,
  listUsers,
  revokeCredential,
  setupOperator,
  SYSTEM_USER_ID,
  UserRegistryError,
} from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-users-store-"));
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("system user seeding", () => {
  it("seeds exactly one system user reachable by id and helper", () => {
    const system = getSystemUser(db);
    expect(system.id).toBe(SYSTEM_USER_ID);
    expect(system.slug).toBe("system");
    expect(system.kind).toBe("system");
    expect(listUsers(db, { kind: "system" })).toHaveLength(1);
  });
});

describe("operator setup idempotency", () => {
  it("creates the operator once and converges on re-run", () => {
    const first = setupOperator(db, { display_name: "Ada Lovelace", email: "ada@example.com" });
    expect(first.kind).toBe("human");
    expect(getOperatorId(db)).toBe(first.id);

    const second = setupOperator(db, { display_name: "Ada Lovelace", email: "ada@example.com" });
    expect(second.id).toBe(first.id);
    // Only the system user plus the single operator exist.
    expect(listUsers(db)).toHaveLength(2);
    expect(listUsers(db, { kind: "human" })).toHaveLength(1);
  });

});

// Valid public-shape samples for the credential allowlist.
const SSH_FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const AGE_RECIPIENT = `age1${"q".repeat(58)}`;

describe("credential immutability and fingerprint uniqueness", () => {
  function operator() {
    return setupOperator(db, { slug: "op", display_name: "Operator", email: "op@x.io" });
  }

  it("allows one active credential per fingerprint and blocks a second", () => {
    const op = operator();
    addCredential(db, op.id, { type: "ssh_key", fingerprint: SSH_FINGERPRINT });
    expect(() =>
      addCredential(db, op.id, { type: "ssh_key", fingerprint: SSH_FINGERPRINT }),
    ).toThrow(UserRegistryError);
  });

  it("permits revoke-then-re-add of the same fingerprint", () => {
    const op = operator();
    const cred = addCredential(db, op.id, {
      type: "yubikey_recipient",
      fingerprint: AGE_RECIPIENT,
    });
    revokeCredential(db, cred.id);

    const readded = addCredential(db, op.id, {
      type: "yubikey_recipient",
      fingerprint: AGE_RECIPIENT,
    });
    expect(readded.status).toBe("active");
    expect(readded.id).not.toBe(cred.id);

    // The revoked credential is retained as historical provenance.
    const all = listCredentials(db, op.id, { includeRevoked: true });
    expect(all.map((c) => c.status).sort()).toEqual(["active", "revoked"]);
    expect(listCredentials(db, op.id)).toHaveLength(1); // active only
  });

});

describe("no private material is ever accepted", () => {
  const PEM_PRIVATE_KEY =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE==\n-----END OPENSSH PRIVATE KEY-----";
  const PPK_DOCUMENT =
    "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\nAAAABBBBCCCC";
  // A raw base64/DER blob (no OpenSSH prefix): must fail the allowlist, not a denylist.
  const BASE64_DER_BLOB = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ";

  function op() {
    return setupOperator(db, { slug: "op", display_name: "Op" });
  }

  it.each([
    ["a PEM private key in public_material", { public_material: PEM_PRIVATE_KEY }, /private key/i],
    ["a PEM private key in the fingerprint", { fingerprint: PEM_PRIVATE_KEY }, /private key/i],
    ["a private key nested in a metadata value", { metadata: { note: "backup", stash: { key: PEM_PRIVATE_KEY } } }, /private key/i],
    ["a private key in the label", { label: PEM_PRIVATE_KEY }, /private key/i],
    ["a PuTTY PPK document in public_material", { public_material: PPK_DOCUMENT }, /private key/i],
    ["a base64/DER blob in public_material", { public_material: BASE64_DER_BLOB }, /single-line OpenSSH public key/i],
  ])("rejects %s", (_name, fields, message) => {
    expect(() =>
      addCredential(db, op().id, { type: "ssh_key", fingerprint: SSH_FINGERPRINT, ...fields }),
    ).toThrow(message);
  });

  it("enforces the metadata size cap", () => {
    expect(() =>
      addCredential(db, op().id, {
        type: "api_token",
        fingerprint: "tokfp-abc123",
        metadata: { blob: "z".repeat(5000) },
      }),
    ).toThrow(/exceeds/i);
  });
});
