/**
 * The protected-branch signing rule (umbrella 0cda998): which of the
 * operator's credentials count, and checking commits against them. This is the
 * only implementation; the Git reference-transaction hook's signer projection
 * (src/protected-branch-guard.ts, issue 5886596) and the base-history audit
 * (src/protected-base-audit.ts, issue 117ba80) both read it.
 *
 * Only the configured operator's active `ssh_key` credentials ever count;
 * agent users and other people's keys never do.
 */

import { observeChild } from "./child-observation.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activeSigningCredentials,
  allowedSignerLine,
  trustedSshKeygenPath,
  verificationEnv,
  type SigningCredentialRow,
} from "./auth-signature-verification.js";
import type { Db } from "./db.js";
import { getOperatorId } from "./users/store.js";

/** The operator's active signing credentials, oldest first. */
export function operatorSigningCredentials(db: Db): SigningCredentialRow[] {
  const operatorId = getOperatorId(db);
  if (!operatorId) return [];
  return activeSigningCredentials(db).filter((credential) => credential.user_id === operatorId);
}

/**
 * `allowed_signers` lines for the operator's signing credentials. The
 * principal is the credential id, so a verified signature names the exact
 * credential.
 */
export function operatorAllowedSignerLines(db: Db): string[] {
  return signerLines(operatorSigningCredentials(db));
}

function signerLines(credentials: readonly SigningCredentialRow[]): string[] {
  return credentials.flatMap((credential) => {
    const line = allowedSignerLine(credential);
    return line ? [line] : [];
  });
}

export type CommitSignatureStatus =
  /** Signed with an operator credential that counts for the check. */
  | "operator"
  | "unsigned"
  /** A valid signature by a key that does not count for the check. */
  | "other_signer"
  /** A bad, expired, revoked or uncheckable signature. */
  | "invalid";

export interface CommitSignature {
  sha: string;
  subject: string;
  status: CommitSignatureStatus;
  /** SSH fingerprint of the signing key, when Git reports one. */
  fingerprint: string | null;
  /** The operator credential that signed, when status is `operator`. */
  credential_id: string | null;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/**
 * Classify each commit's signature against the operator credentials, with one `git log` call. Throws when Git cannot read the
 * commits or no trusted ssh-keygen is available; callers decide how to
 * surface that.
 */
export async function readCommitSignatures(
  db: Db,
  cwd: string,
  shas: readonly string[],
): Promise<CommitSignature[]> {
  if (shas.length === 0) return [];
  const sshKeygen = trustedSshKeygenPath();
  if (!sshKeygen) throw new Error("trusted_ssh_keygen_unavailable");
  const keys = operatorSigningCredentials(db);
  const lines = signerLines(keys);
  const dir = mkdtempSync(join(tmpdir(), "mandible-operator-signers-"));
  const allowedSigners = join(dir, "allowed_signers");
  try {
    writeFileSync(allowedSigners, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    const result = (await observeChild("git", [
      "-c", "gpg.format=ssh",
      "-c", `gpg.ssh.allowedSignersFile=${allowedSigners}`,
      "-c", `gpg.ssh.program=${sshKeygen}`,
      "-c", "gpg.ssh.revocationFile=/dev/null",
      "-c", "gpg.minTrustLevel=fully",
      "log", "--no-walk=unsorted", `--format=%H${FIELD}%G?${FIELD}%GS${FIELD}%GF${FIELD}%s${RECORD}`,
      ...shas,
    ], { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: verificationEnv() }));
    if (result.status !== 0) {
      throw new Error(`git log failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
    }
    const currentKeys = operatorSigningCredentials(db);
    return result.stdout.split(RECORD).map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
      const [sha = "", code = "", principal = "", fingerprint = "", subject = ""] = record.split(FIELD);
      const credential = currentKeys.find((key) => key.credential_id === principal && signerLines([key])[0] === lines.find(line => line.startsWith(`${principal} `))) ?? null;
      const status: CommitSignatureStatus = code === "N"
        ? "unsigned"
        : code === "G" && credential && credential.fingerprint === fingerprint
          ? "operator"
          : code === "G" || code === "U"
            ? "other_signer"
            : "invalid";
      return {
        sha,
        subject,
        status,
        fingerprint: fingerprint || null,
        credential_id: status === "operator" ? credential!.credential_id : null,
      };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
