import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractSuccessfulMergeCommitSha,
  verifyMergeCommitSignature,
  verifySuccessfulMergeCommitSignature,
} from "../src/auth-signature-verification.js";
import { openDb, type Db } from "../src/db.js";
import {
  addCredential,
  revokeCredential,
  setupOperator,
} from "../src/users/store.js";

function git(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env,
  }).trim();
}

let tempDir = "";
let repo = "";
let keyPath = "";
let db: Db;
let mergeSha = "";
let publicMaterial = "";
let fingerprint = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-signature-verify-"));
  repo = path.join(tempDir, "repo");
  keyPath = path.join(tempDir, "signing_key");
  fs.mkdirSync(repo);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  publicMaterial = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  fingerprint = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`, "-E", "sha256"], {
    encoding: "utf8",
  }).trim().split(/\s+/)[1]!;

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Mandible Signature Test"]);
  git(repo, ["config", "user.email", "signature-test@example.invalid"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  git(repo, ["checkout", "-b", "feature/signed"]);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "feature"]);
  git(repo, ["checkout", "main"]);
  git(repo, ["config", "gpg.format", "ssh"]);
  git(repo, ["config", "user.signingkey", keyPath]);
  git(repo, ["merge", "--no-ff", "--no-edit", "-S", "feature/signed"]);
  mergeSha = git(repo, ["rev-parse", "HEAD"]);

  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("merge signature verification", () => {
  it("verifies a signed merge and resolves its active credential and user", () => {
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    const credential = addCredential(db, operator.id, {
      type: "ssh_key",
      fingerprint,
      public_material: publicMaterial,
    });

    expect(verifyMergeCommitSignature(db, repo, mergeSha)).toEqual({
      verified: true,
      commit_sha: mergeSha,
      fingerprint,
      credential_id: credential.id,
      user_id: operator.id,
      reason: null,
    });
  });

  it("reports an unregistered signing key without failing the merge result", () => {
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    const otherKeyPath = path.join(tempDir, "other_signing_key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", otherKeyPath]);
    const otherPublicMaterial = fs.readFileSync(`${otherKeyPath}.pub`, "utf8").trim();
    const otherFingerprint = execFileSync(
      "ssh-keygen",
      ["-lf", `${otherKeyPath}.pub`, "-E", "sha256"],
      { encoding: "utf8" },
    ).trim().split(/\s+/)[1]!;
    addCredential(db, operator.id, {
      type: "ssh_key",
      fingerprint: otherFingerprint,
      public_material: otherPublicMaterial,
    });

    expect(verifyMergeCommitSignature(db, repo, mergeSha)).toMatchObject({
      verified: false,
      commit_sha: mergeSha,
      fingerprint,
      credential_id: null,
      user_id: null,
      reason: "signature_not_trusted",
    });
  });

  it("excludes revoked credentials from generated allowed-signers material", () => {
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    const credential = addCredential(db, operator.id, {
      type: "ssh_key",
      fingerprint,
      public_material: publicMaterial,
    });
    revokeCredential(db, credential.id);

    expect(verifyMergeCommitSignature(db, repo, mergeSha)).toMatchObject({
      verified: false,
      reason: "no_active_registered_signing_credentials",
    });
  });

  it("rejects a signed commit marker that is not the target branch head", () => {
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    addCredential(db, operator.id, {
      type: "ssh_key",
      fingerprint,
      public_material: publicMaterial,
    });
    const targetHead = git(repo, ["rev-parse", `${mergeSha}^1`]);

    expect(verifySuccessfulMergeCommitSignature(db, repo, mergeSha, targetHead)).toMatchObject({
      verified: false,
      commit_sha: mergeSha,
      reason: "merge_commit_not_target_head",
    });
  });

  it("ignores a repository-configured SSH verifier that forges success", () => {
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    const otherKeyPath = path.join(tempDir, "trusted_other_key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", otherKeyPath]);
    const otherPublicMaterial = fs.readFileSync(`${otherKeyPath}.pub`, "utf8").trim();
    const otherFingerprint = execFileSync(
      "ssh-keygen",
      ["-lf", `${otherKeyPath}.pub`, "-E", "sha256"],
      { encoding: "utf8" },
    ).trim().split(/\s+/)[1]!;
    const credential = addCredential(db, operator.id, {
      type: "ssh_key",
      fingerprint: otherFingerprint,
      public_material: otherPublicMaterial,
    });
    const forgedVerifier = path.join(tempDir, "forged-ssh-keygen");
    fs.writeFileSync(
      forgedVerifier,
      `#!/bin/sh\nprintf '%s\\n' 'Good "git" signature for ${credential.id} with ED25519 key ${otherFingerprint}' >&2\nexit 0\n`,
      { mode: 0o755 },
    );
    git(repo, ["config", "gpg.ssh.program", forgedVerifier]);

    expect(verifyMergeCommitSignature(db, repo, mergeSha)).toMatchObject({
      verified: false,
      fingerprint,
      reason: "signature_not_trusted",
    });
  });
});

describe("successful merge result parsing", () => {
  it("extracts only a full commit id from the merge script result marker", () => {
    const output = `noise\nMANDIBLE_MERGE_RESULT {"merge_sha":"${mergeSha}"}\n`;
    expect(extractSuccessfulMergeCommitSha(output)).toBe(mergeSha);
    expect(extractSuccessfulMergeCommitSha("MANDIBLE_MERGE_RESULT {\"merge_sha\":\"abc123\"}"))
      .toBeNull();
  });
});
