import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  auditOperatorSigningCredential,
  discoverConfiguredPublicSigningKey,
  resolveSigningKeyFingerprint,
} from "../src/signing-credential-audit.js";
import type { Db } from "../src/db.js";
import { addCredential, getOperator } from "../src/users/store.js";
import { createMigratedDb as createSharedMigratedDb } from "./helpers/ledger-fixtures.js";
import { longestEventLoopBlockMs, useSlowCommand, SYNCHRONOUS_WAIT_MS } from "./helpers/event-loop-blocking.js";

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
async function withIsolatedGitConfig<T>(fn: () => Promise<T>): Promise<T> {
  const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
  const priorSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    return await fn();
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
  it("resolves a key path via its .pub sibling, inline and key:: material, and refuses to guess", async () => {
    const { keyPath, fingerprint, publicMaterial } = createRepoWithSigningKey(false);
    const resolved = { ok: true, value: { material: publicMaterial, fingerprint } };
    expect(await resolveSigningKeyFingerprint(keyPath)).toEqual(resolved);
    expect(await resolveSigningKeyFingerprint(publicMaterial)).toEqual(resolved);
    expect(await resolveSigningKeyFingerprint(`key::${publicMaterial}`)).toEqual(resolved);
    expect(await resolveSigningKeyFingerprint("/nonexistent/mandible-signing-key"))
      .toEqual({ ok: false, reason: "signing_key_path_unreadable" });
  });
});

describe("discoverConfiguredPublicSigningKey", () => {
  it("reads only the .pub sidecar, never the configured private key", async () => {
    const { repo, keyPath, fingerprint, publicMaterial } = createRepoWithSigningKey(false);
    execFileSync("git", ["config", "user.signingkey", keyPath], { cwd: repo });
    const discover = () => withIsolatedGitConfig(() => discoverConfiguredPublicSigningKey({ cwd: repo, global: false }));

    // The private key may be absent: the sidecar alone answers.
    const privateBytes = fs.readFileSync(keyPath);
    fs.rmSync(keyPath);
    expect(await discover()).toMatchObject({ value: { material: publicMaterial, fingerprint }, reason: null });

    // Without a sidecar, public material is never derived from the private key.
    fs.writeFileSync(keyPath, privateBytes, { mode: 0o600 });
    fs.rmSync(`${keyPath}.pub`);
    expect(await discover()).toMatchObject({ value: null, reason: "public_key_not_available_without_private_key_access" });
  });
});

describe("auditOperatorSigningCredential", () => {
  it("is covered only by an active credential carrying the configured fingerprint", async () => {
    const { repo, fingerprint, publicMaterial } = createRepoWithSigningKey(true);
    const db = createDb();
    try {
      const audit = () => withIsolatedGitConfig(() => auditOperatorSigningCredential(db, { cwd: repo, global: false }));
      expect(await audit()).toMatchObject({
        status: "missing_credential",
        fingerprint,
        operator_slug: "audit-operator",
        hint: "mandible user credential add audit-operator --from-git-signingkey",
      });

      const credential = addCredential(db, getOperator(db)!.id, { type: "ssh_key", fingerprint, public_material: publicMaterial });
      expect(await audit()).toMatchObject({ status: "ok", hint: null });

      db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(credential.id);
      expect((await audit()).status).toBe("missing_credential");
    } finally {
      db.close();
    }
  });

  it("stays silent when no signing key is configured", async () => {
    const { repo } = createRepoWithSigningKey(false);
    const db = createDb();
    try {
      const audit = await withIsolatedGitConfig(() =>
        auditOperatorSigningCredential(db, { cwd: repo, global: false }));
      expect(audit.status).toBe("unconfigured");
      expect(audit.hint).toBeNull();
    } finally {
      db.close();
    }
  });

  it("probes Git and ssh-keygen off the event loop", async () => {
    const { repo, fingerprint } = createRepoWithSigningKey(true);
    const db = createDb();
    useSlowCommand("git");
    useSlowCommand("ssh-keygen");
    try {
      let audit: Awaited<ReturnType<typeof auditOperatorSigningCredential>> | undefined;
      const blockedMs = await longestEventLoopBlockMs(async () => {
        audit = await withIsolatedGitConfig(() => auditOperatorSigningCredential(db, { cwd: repo, global: false }));
      });

      expect(blockedMs).toBeLessThan(SYNCHRONOUS_WAIT_MS);
      expect(audit).toMatchObject({ status: "missing_credential", fingerprint });
    } finally {
      vi.unstubAllEnvs();
      db.close();
    }
  });

  it("reports a configured-but-unresolvable key distinctly", async () => {
    const { repo } = createRepoWithSigningKey(false);
    execFileSync("git", ["config", "user.signingkey", "/nonexistent/key"], { cwd: repo });
    const db = createDb();
    try {
      const audit = await withIsolatedGitConfig(() =>
        auditOperatorSigningCredential(db, { cwd: repo, global: false }));
      expect(audit.status).toBe("unresolvable");
      expect(audit.reason).toBe("signing_key_path_unreadable");
    } finally {
      db.close();
    }
  });
});
