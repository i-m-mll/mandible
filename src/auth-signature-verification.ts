import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Db } from "./db.js";

interface SigningCredentialRow {
  credential_id: string;
  user_id: string;
  fingerprint: string;
  public_material: string;
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

/** Extract the actual post-merge commit recorded by the successful merge script. */
export function extractSuccessfulMergeCommitSha(output: string): string | null {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    const markerIndex = line.indexOf(MERGE_RESULT_PREFIX);
    if (markerIndex < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(markerIndex + MERGE_RESULT_PREFIX.length)) as {
        merge_sha?: unknown;
      };
      if (typeof parsed.merge_sha === "string" && COMMIT_SHA_PATTERN.test(parsed.merge_sha)) {
        return parsed.merge_sha;
      }
    } catch {
      // A malformed marker is verification evidence, not a merge failure.
    }
  }
  return null;
}

function activeSigningCredentials(db: Db): SigningCredentialRow[] {
  return db.prepare(
    `SELECT
       credential.id AS credential_id,
       credential.user_id,
       credential.fingerprint,
       credential.public_material
     FROM user_credentials AS credential
     JOIN users AS owner ON owner.id = credential.user_id
     WHERE credential.status = 'active'
       AND owner.status = 'active'
       AND credential.type IN ('ssh_key', 'delegated_ssh_key')
       AND credential.public_material IS NOT NULL
     ORDER BY credential.created_at ASC, credential.id ASC`,
  ).all() as SigningCredentialRow[];
}

function allowedSignerLine(credential: SigningCredentialRow): string | null {
  const fields = credential.public_material.trim().split(/\s+/);
  if (fields.length < 2) return null;
  return `${credential.credential_id} ${fields[0]} ${fields[1]}`;
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

function verificationEnv(): NodeJS.ProcessEnv {
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

function trustedSshKeygenPath(): string | null {
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
  const verificationDir = mkdtempSync(join(tmpdir(), "mandible-allowed-signers-"));
  const allowedSignersPath = join(verificationDir, "allowed_signers");
  try {
    writeFileSync(allowedSignersPath, `${allowed.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
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
    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
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
  } finally {
    rmSync(verificationDir, { recursive: true, force: true });
  }
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
