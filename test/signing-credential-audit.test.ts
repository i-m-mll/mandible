import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditOperatorSigningCredential,
  discoverConfiguredPublicSigningKey,
  resolveSigningKeyFingerprint,
} from "../src/signing-credential-audit.js";
import type { Db } from "../src/db.js";
import { addCredential, getOperator } from "../src/users/store.js";
import { createMigratedDb as createSharedMigratedDb } from "./helpers/ledger-fixtures.js";

// Issue 2205073 — an unregistered protected-merge signing key stays invisible
// until the first sibling-merge drift refuses an approval. The startup audit
// makes it visible immediately, with the command that fixes it.

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createRepoWithSigningKey(configure: boolean): {
  repo: string;
  keyPath: string;
  fingerprint: string;
  publicMaterial: string;
} {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-signing-audit-")));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  const keyPath = path.join(repo, "signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const publicMaterial = fs
    .readFileSync(`${keyPath}.pub`, "utf8")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`, "-E", "sha256"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)[1]!;
  if (configure) {
    execFileSync("git", ["config", "user.signingkey", keyPath], { cwd: repo });
  }
  return { repo, keyPath, fingerprint, publicMaterial };
}

/**
 * `global: false` still falls through to the developer's real ~/.gitconfig,
 * which on a signing-enabled machine would mask the "unconfigured" case. Pin
 * the probes to repo-local config only.
 */
function withIsolatedGitConfig<T>(fn: () => T): T {
  const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
  const priorSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    return fn();
  } finally {
    if (priorGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = priorGlobal;
    if (priorSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = priorSystem;
  }
}

function createDb(): Db {
  return createSharedMigratedDb({
    operator: { slug: "audit-operator", display_name: "Audit Operator" },
    now: 1,
  });
}

describe("resolveSigningKeyFingerprint", () => {
  it("resolves a private key path via its .pub sibling", () => {
    const { keyPath, fingerprint, publicMaterial } = createRepoWithSigningKey(false);
    const resolved = resolveSigningKeyFingerprint(keyPath);
    expect(resolved).toEqual({ ok: true, value: { material: publicMaterial, fingerprint } });
  });

  it("resolves an inline key and a key:: literal", () => {
    const { fingerprint, publicMaterial } = createRepoWithSigningKey(false);
    expect(resolveSigningKeyFingerprint(publicMaterial)).toEqual({
      ok: true,
      value: { material: publicMaterial, fingerprint },
    });
    expect(resolveSigningKeyFingerprint(`key::${publicMaterial}`)).toEqual({
      ok: true,
      value: { material: publicMaterial, fingerprint },
    });
  });

  it("reports an unreadable path instead of guessing", () => {
    const resolved = resolveSigningKeyFingerprint("/nonexistent/mandible-signing-key");
    expect(resolved).toEqual({ ok: false, reason: "signing_key_path_unreadable" });
  });
});

describe("discoverConfiguredPublicSigningKey", () => {
  it("reads a .pub sidecar without opening the configured private-key path", () => {
    const { repo, keyPath, fingerprint, publicMaterial } = createRepoWithSigningKey(false);
    execFileSync("git", ["config", "user.signingkey", keyPath], { cwd: repo });
    fs.rmSync(keyPath);
    const discovered = withIsolatedGitConfig(() => discoverConfiguredPublicSigningKey({ cwd: repo, global: false }));
    expect(discovered).toMatchObject({
      value: { material: publicMaterial, fingerprint },
      reason: null,
    });
  });

  it("does not derive public material from a private key when no .pub sidecar exists", () => {
    const { repo, keyPath } = createRepoWithSigningKey(false);
    fs.rmSync(`${keyPath}.pub`);
    execFileSync("git", ["config", "user.signingkey", keyPath], { cwd: repo });
    const discovered = withIsolatedGitConfig(() => discoverConfiguredPublicSigningKey({ cwd: repo, global: false }));
    expect(discovered.value).toBeNull();
    expect(discovered.reason).toBe("public_key_not_available_without_private_key_access");
  });
});

describe("auditOperatorSigningCredential", () => {
  it("warns with the fix command when the configured key is unregistered", () => {
    const { repo, fingerprint } = createRepoWithSigningKey(true);
    const db = createDb();
    try {
      const audit = withIsolatedGitConfig(() =>
        auditOperatorSigningCredential(db, { cwd: repo, global: false }));
      expect(audit.status).toBe("missing_credential");
      expect(audit.fingerprint).toBe(fingerprint);
      expect(audit.operator_slug).toBe("audit-operator");
      expect(audit.hint).toBe("mandible user credential add audit-operator --from-git-signingkey");
    } finally {
      db.close();
    }
  });

  it("is satisfied once an active credential carries that fingerprint", () => {
    const { repo, fingerprint, publicMaterial } = createRepoWithSigningKey(true);
    const db = createDb();
    try {
      addCredential(db, getOperator(db)!.id, {
        type: "ssh_key",
        fingerprint,
        public_material: publicMaterial,
      });
      const audit = withIsolatedGitConfig(() =>
        auditOperatorSigningCredential(db, { cwd: repo, global: false }));
      expect(audit.status).toBe("ok");
      expect(audit.hint).toBeNull();
    } finally {
      db.close();
    }
  });

  it("does not accept a revoked credential as coverage", () => {
    const { repo, fingerprint, publicMaterial } = createRepoWithSigningKey(true);
    const db = createDb();
    try {
      const credential = addCredential(db, getOperator(db)!.id, {
        type: "ssh_key",
        fingerprint,
        public_material: publicMaterial,
      });
      db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(credential.id);
      expect(
        withIsolatedGitConfig(() =>
          auditOperatorSigningCredential(db, { cwd: repo, global: false })).status,
      ).toBe("missing_credential");
    } finally {
      db.close();
    }
  });

  it("stays silent when no signing key is configured", () => {
    const { repo } = createRepoWithSigningKey(false);
    const db = createDb();
    try {
      const audit = withIsolatedGitConfig(() =>
        auditOperatorSigningCredential(db, { cwd: repo, global: false }));
      expect(audit.status).toBe("unconfigured");
      expect(audit.hint).toBeNull();
    } finally {
      db.close();
    }
  });

  it("reports a configured-but-unresolvable key distinctly", () => {
    const { repo } = createRepoWithSigningKey(false);
    execFileSync("git", ["config", "user.signingkey", "/nonexistent/key"], { cwd: repo });
    const db = createDb();
    try {
      const audit = withIsolatedGitConfig(() =>
        auditOperatorSigningCredential(db, { cwd: repo, global: false }));
      expect(audit.status).toBe("unresolvable");
      expect(audit.reason).toBe("signing_key_path_unreadable");
    } finally {
      db.close();
    }
  });
});
