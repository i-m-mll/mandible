import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import {
  addBinding,
  addCredential,
  createUser,
  getOperatorId,
  getSystemUser,
  listBindings,
  listCredentials,
  listUsers,
  removeBinding,
  revokeCredential,
  setupOperator,
  SYSTEM_USER_ID,
  updateUser,
  UserRegistryError,
} from "../src/users/store.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-users-store-"));
  db = openDb(path.join(tempDir, "mandible.db"));
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

  it("updates operator fields on re-run without creating a duplicate", () => {
    const first = setupOperator(db, { slug: "op", display_name: "Old Name", email: "old@x.io" });
    const updated = setupOperator(db, { slug: "op", display_name: "New Name", email: "new@x.io" });
    expect(updated.id).toBe(first.id);
    expect(updated.display_name).toBe("New Name");
    expect(updated.email).toBe("new@x.io");
    expect(listUsers(db, { kind: "human" })).toHaveLength(1);
  });

  it("derives a slug from the email local part when none is given", () => {
    const user = setupOperator(db, { display_name: "Grace", email: "grace@navy.mil" });
    expect(user.slug).toBe("grace");
  });
});

describe("credential immutability and fingerprint uniqueness", () => {
  function operator() {
    return setupOperator(db, { slug: "op", display_name: "Operator", email: "op@x.io" });
  }

  it("allows one active credential per fingerprint and blocks a second", () => {
    const op = operator();
    addCredential(db, op.id, { type: "ssh_key", fingerprint: "SHA256:aaa" });
    expect(() =>
      addCredential(db, op.id, { type: "ssh_key", fingerprint: "SHA256:aaa" }),
    ).toThrow(UserRegistryError);
  });

  it("permits revoke-then-re-add of the same fingerprint", () => {
    const op = operator();
    const cred = addCredential(db, op.id, { type: "yubikey_recipient", fingerprint: "age1xyz" });
    revokeCredential(db, cred.id);

    const readded = addCredential(db, op.id, {
      type: "yubikey_recipient",
      fingerprint: "age1xyz",
    });
    expect(readded.status).toBe("active");
    expect(readded.id).not.toBe(cred.id);

    // The revoked credential is retained as historical provenance.
    const all = listCredentials(db, op.id, { includeRevoked: true });
    expect(all.map((c) => c.status).sort()).toEqual(["active", "revoked"]);
    expect(listCredentials(db, op.id)).toHaveLength(1); // active only
  });

  it("rejects an unknown credential type", () => {
    const op = operator();
    expect(() =>
      addCredential(db, op.id, { type: "totp", fingerprint: "x" }),
    ).toThrow(UserRegistryError);
  });
});

describe("no private material is ever accepted", () => {
  const PRIVATE_KEY_SAMPLE =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE==\n-----END OPENSSH PRIVATE KEY-----";

  it("rejects private key material in public_material", () => {
    const op = setupOperator(db, { slug: "op", display_name: "Op" });
    expect(() =>
      addCredential(db, op.id, {
        type: "ssh_key",
        fingerprint: "SHA256:bbb",
        public_material: PRIVATE_KEY_SAMPLE,
      }),
    ).toThrow(/private key/i);
  });

  it("rejects private key material smuggled into the fingerprint", () => {
    const op = setupOperator(db, { slug: "op", display_name: "Op" });
    expect(() =>
      addCredential(db, op.id, { type: "ssh_key", fingerprint: PRIVATE_KEY_SAMPLE }),
    ).toThrow(/private key/i);
  });
});

describe("bindings and users", () => {
  it("adds, lists, and removes claimed bindings", () => {
    const op = setupOperator(db, { slug: "op", display_name: "Op" });
    const b = addBinding(db, op.id, { binding_type: "git_author_email", value: "op@x.io" });
    expect(listBindings(db, op.id)).toHaveLength(1);
    removeBinding(db, b.id);
    expect(listBindings(db, op.id)).toHaveLength(0);
  });

  it("rejects an unknown binding type", () => {
    const op = setupOperator(db, { slug: "op", display_name: "Op" });
    expect(() =>
      // @ts-expect-error deliberately invalid binding type
      addBinding(db, op.id, { binding_type: "nope", value: "x" }),
    ).toThrow(UserRegistryError);
  });

  it("enforces slug uniqueness and supports update", () => {
    createUser(db, { slug: "agent-a", kind: "agent", display_name: "Agent A" });
    expect(() =>
      createUser(db, { slug: "agent-a", kind: "agent", display_name: "Dup" }),
    ).toThrow(UserRegistryError);

    const updated = updateUser(db, "agent-a", { status: "retired", display_name: "Agent A2" });
    expect(updated.status).toBe("retired");
    expect(updated.display_name).toBe("Agent A2");
  });
});
