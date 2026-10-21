import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Db } from "./db.js";
import { gitObjectAnswer, rememberedObjectFact } from "./git-object-facts.js";

export interface SigningCredentialRow {
  credential_id: string;
  user_id: string;
  fingerprint: string;
  public_material: string;
  type: string;
}

export interface MergeSignatureVerification {
  verified: boolean;
  commit_sha: string | null;
  fingerprint: string | null;
  credential_id: string | null;
  user_id: string | null;
  reason: string | null;
}

const MERGE_RESULT_PREFIX = "MANDIBLE_MERGE_RESULT ";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const SSH_FINGERPRINT_PATTERN = /SHA256:[A-Za-z0-9+/=]+/;
const TRUSTED_SSH_KEYGEN_PATHS = ["/usr/bin/ssh-keygen", "/bin/ssh-keygen"];

/**
 * Extract the actual post-merge commit recorded by the successful merge script.
 *
 * Issue 08a5f04 (review F1) — hardened marker parse: every
 * `MANDIBLE_MERGE_RESULT` line in the output must parse to a valid commit SHA
 * and all occurrences must agree on it, otherwise the whole record is void
 * (null). One successful execution emits the marker once; the only legitimate
 * duplicate is the atomic-recovery path re-emitting the same merge SHA with
 * refreshed issue metadata. A marker appended with a different SHA — or any
 * malformed marker — is tamper evidence, never something to skip past.
 */
export function extractSuccessfulMergeCommitSha(output: string): string | null {
  const markerLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(MERGE_RESULT_PREFIX));
  if (markerLines.length === 0) return null;
  let mergeSha: string | null = null;
  for (const line of markerLines) {
    let parsedSha: string;
    try {
      const parsed = JSON.parse(line.slice(line.indexOf(MERGE_RESULT_PREFIX) + MERGE_RESULT_PREFIX.length)) as {
        merge_sha?: unknown;
      };
      if (typeof parsed.merge_sha !== "string" || !COMMIT_SHA_PATTERN.test(parsed.merge_sha)) {
        return null;
      }
      parsedSha = parsed.merge_sha;
    } catch {
      // A malformed marker is verification evidence, not a merge failure.
      return null;
    }
    if (mergeSha !== null && mergeSha !== parsedSha) return null;
    mergeSha = parsedSha;
  }
  return mergeSha;
}

/** Shared with the provenance matcher so evidence details validate identically. */
export function isValidCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA_PATTERN.test(value);
}

export function activeSigningCredentials(db: Db): SigningCredentialRow[] {
  return db.prepare(
    `SELECT
       credential.id AS credential_id,
       credential.user_id,
       credential.fingerprint,
       credential.public_material,
       credential.type
     FROM user_credentials AS credential
     JOIN users AS owner ON owner.id = credential.user_id
     WHERE credential.status = 'active'
       AND owner.status = 'active'
       AND credential.type IN ('ssh_key', 'delegated_ssh_key')
       AND credential.public_material IS NOT NULL
     ORDER BY credential.created_at ASC, credential.id ASC`,
  ).all() as SigningCredentialRow[];
}

export function allowedSignerLine(credential: SigningCredentialRow): string | null {
  const fields = credential.public_material.trim().split(/\s+/);
  if (fields.length < 2) return null;
  return `${credential.credential_id} ${fields[0]} ${fields[1]}`;
}

export function authorizedMergeSignerLines(
  db: Db,
  userId: string,
  credentialId?: string | null,
): string[] {
  return activeSigningCredentials(db)
    .filter((credential) => credential.user_id === userId)
    .filter((credential) => !credentialId || credential.credential_id === credentialId)
    .flatMap((credential) => {
      const line = allowedSignerLine(credential);
      return line ? [line] : [];
    });
}

export function authorizedOperatorSignerLines(db: Db, userId: string): string[] {
  return activeSigningCredentials(db)
    .filter((credential) => credential.user_id === userId && credential.type === "ssh_key")
    .flatMap((credential) => { const line = allowedSignerLine(credential); return line ? [line] : []; });
}

function unverified(
  commitSha: string | null,
  reason: string,
  fingerprint: string | null = null,
): MergeSignatureVerification {
  return {
    verified: false,
    commit_sha: commitSha,
    fingerprint,
    credential_id: null,
    user_id: null,
    reason,
  };
}

/** Git environment for signature checks: no user, system or injected config. */
export function verificationEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return env;
}

export function trustedSshKeygenPath(): string | null {
  return TRUSTED_SSH_KEYGEN_PATHS.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Verify one successful merge commit against an ephemeral allowed-signers file
 * derived exclusively from active registry credentials.
 */
export function verifyMergeCommitSignature(
  db: Db,
  cwd: string | null,
  commitSha: string | null,
): MergeSignatureVerification {
  if (!cwd) return unverified(commitSha, "missing_repository_path");
  if (!commitSha) return unverified(null, "missing_merge_commit_sha");
  const sshKeygenPath = trustedSshKeygenPath();
  if (!sshKeygenPath) return unverified(commitSha, "trusted_ssh_keygen_unavailable");

  const credentials = activeSigningCredentials(db);
  const allowed = credentials.flatMap((credential) => {
    const line = allowedSignerLine(credential);
    return line ? [line] : [];
  });
  try {
    const signers = `${allowed.join("\n")}\n`;
    const key = ["verify-commit", cwd, commitSha, sshKeygenPath, createHash("sha256").update(signers).digest("hex")].join("\0");
    const result = rememberedObjectFact(key, () => verifyCommitAgainst(cwd, commitSha, sshKeygenPath, signers));
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    const fingerprint = diagnostic.match(SSH_FINGERPRINT_PATTERN)?.[0] ?? null;
    if (result.status !== 0) {
      return unverified(
        commitSha,
        allowed.length === 0
          ? "no_active_registered_signing_credentials"
          : "signature_not_trusted",
        fingerprint,
      );
    }

    const principal = diagnostic.match(/Good "git" signature for ([^\s]+) with /)?.[1] ?? null;
    const credential = credentials.find((candidate) => candidate.credential_id === principal) ?? null;
    if (!credential) {
      return unverified(commitSha, "verified_principal_not_registered", fingerprint);
    }
    if (!fingerprint || credential.fingerprint !== fingerprint) {
      return unverified(commitSha, "registered_fingerprint_mismatch", fingerprint);
    }
    return {
      verified: true,
      commit_sha: commitSha,
      fingerprint,
      credential_id: credential.credential_id,
      user_id: credential.user_id,
      reason: null,
    };
  } catch {
    return unverified(commitSha, "verification_error");
  }
}

/**
 * One `git verify-commit` of `commitSha` against exactly `signers`. Its verdict
 * is definitive when Git ran to completion and the commit exists here: exit 1
 * also covers a commit missing from this repository, which may arrive later.
 */
function verifyCommitAgainst(cwd: string, commitSha: string, sshKeygenPath: string, signers: string) {
  const verificationDir = mkdtempSync(join(tmpdir(), "mandible-allowed-signers-"));
  const allowedSignersPath = join(verificationDir, "allowed_signers");
  try {
    writeFileSync(allowedSignersPath, signers, { encoding: "utf8", mode: 0o600 });
    const result = spawnSync(
      "git",
      [
        "-c",
        "gpg.format=ssh",
        "-c",
        `gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
        "-c",
        `gpg.ssh.program=${sshKeygenPath}`,
        "-c",
        "gpg.ssh.revocationFile=/dev/null",
        "-c",
        "gpg.minTrustLevel=fully",
        "verify-commit",
        commitSha,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: verificationEnv(),
      },
    );
    const completed = !result.error && result.signal === null && (result.status === 0 || result.status === 1);
    return {
      value: { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" },
      definitive: completed && (result.status === 0 || commitExists(cwd, commitSha)),
    };
  } finally {
    rmSync(verificationDir, { recursive: true, force: true });
  }
}

function commitExists(cwd: string, commitSha: string): boolean {
  try {
    return gitObjectAnswer(cwd, ["cat-file", "-t", commitSha], { env: verificationEnv(), timeout: 10_000 }) === "commit";
  } catch {
    return false;
  }
}

export function verifyAuthorizedMergeCommitSignature(
  db: Db,
  cwd: string | null,
  commitSha: string | null,
  approverUserId: string,
  credentialId?: string | null,
): MergeSignatureVerification {
  const verification = verifyMergeCommitSignature(db, cwd, commitSha);
  if (!verification.verified) return verification;
  if (verification.user_id !== approverUserId) {
    return unverified(commitSha, "signer_is_not_approving_user", verification.fingerprint);
  }
  if (credentialId && verification.credential_id !== credentialId) {
    return unverified(commitSha, "signer_is_not_delegated_credential", verification.fingerprint);
  }
  return verification;
}

/** Bind the recorded merge result to the target branch head before trusting its signature. */
export function verifySuccessfulMergeCommitSignature(
  db: Db,
  cwd: string | null,
  commitSha: string | null,
  targetHeadSha: string | null,
): MergeSignatureVerification {
  if (commitSha && !targetHeadSha) {
    return unverified(commitSha, "target_head_unavailable");
  }
  if (commitSha && targetHeadSha && commitSha !== targetHeadSha) {
    return unverified(commitSha, "merge_commit_not_target_head");
  }
  return verifyMergeCommitSignature(db, cwd, commitSha);
}

type AtomicMarker = {
  merge_sha: string;
  base_sha?: string;
  head_sha?: string;
  tree_sha?: string;
};

export function extractAtomicMergeState(output: string): {
  prepared: Required<AtomicMarker> | null;
  applied: AtomicMarker | null;
  invalid: boolean;
} {
  let prepared: Required<AtomicMarker> | null = null;
  let applied: AtomicMarker | null = null;
  let invalid = false;
  for (const line of output.split(/\r?\n/)) {
    for (const [prefix, kind] of [
      ["MANDIBLE_MERGE_PREPARED ", "prepared"],
      ["MANDIBLE_MERGE_APPLIED ", "applied"],
    ] as const) {
      const index = line.indexOf(prefix);
      if (index < 0) continue;
      try {
        const value = JSON.parse(line.slice(index + prefix.length)) as AtomicMarker;
        if (!COMMIT_SHA_PATTERN.test(value.merge_sha ?? "") || !COMMIT_SHA_PATTERN.test(value.base_sha ?? "")) { invalid = true; continue; }
        if (kind === "prepared") {
          if (!COMMIT_SHA_PATTERN.test(value.head_sha ?? "") || !COMMIT_SHA_PATTERN.test(value.tree_sha ?? "")) { invalid = true; continue; }
          if (prepared && (prepared.merge_sha !== value.merge_sha || prepared.base_sha !== value.base_sha || prepared.head_sha !== value.head_sha || prepared.tree_sha !== value.tree_sha)) invalid = true;
          prepared = value as Required<AtomicMarker>;
        } else {
          if (applied && (applied.merge_sha !== value.merge_sha || applied.base_sha !== value.base_sha)) invalid = true;
          applied = value;
        }
      } catch { invalid = true; }
    }
  }
  if (applied && prepared && (applied.merge_sha !== prepared.merge_sha || applied.base_sha !== prepared.base_sha)) invalid = true;
  return { prepared, applied, invalid };
}
