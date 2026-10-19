/**
 * The protected-branch signing rule (umbrella 0cda998).
 *
 * A protected branch may move only to a commit signed with one of the
 * operator's keys: the operator's active `ssh_key` credentials in Mandible's
 * user registry. Delegated agent keys (`delegated_ssh_key`) and other users'
 * keys never satisfy it.
 *
 * The Git reference-transaction hook (issue 5886596) and the base-history
 * audit (issue 117ba80) both apply this rule, from this one source of operator
 * keys.
 */

import { spawnSync } from "node:child_process";
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

/** The operator's active `ssh_key` credentials, oldest first. */
export function operatorSigningKeys(db: Db): SigningCredentialRow[] {
  const operatorId = getOperatorId(db);
  if (!operatorId) return [];
  return activeSigningCredentials(db)
    .filter((credential) => credential.user_id === operatorId && credential.type === "ssh_key");
}

/**
 * `allowed_signers` lines for the operator's keys. The principal is the
 * credential id, so a verified signature names the exact credential.
 */
export function operatorAllowedSignerLines(db: Db): string[] {
  return operatorSigningKeys(db).flatMap((credential) => {
    const line = allowedSignerLine(credential);
    return line ? [line] : [];
  });
}

export type CommitSignatureStatus =
  /** Signed with one of the operator's keys. */
  | "operator"
  | "unsigned"
  /** A valid signature by a key that is not one of the operator's keys. */
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
 * Classify each commit's signature against the operator's keys with one
 * `git log` call. Throws when Git cannot read the commits or no trusted
 * ssh-keygen is available; callers decide how to surface that.
 */
export function readCommitSignatures(db: Db, cwd: string, shas: readonly string[]): CommitSignature[] {
  if (shas.length === 0) return [];
  const sshKeygen = trustedSshKeygenPath();
  if (!sshKeygen) throw new Error("trusted_ssh_keygen_unavailable");
  const keys = operatorSigningKeys(db);
  const lines = operatorAllowedSignerLines(db);
  const dir = mkdtempSync(join(tmpdir(), "mandible-operator-signers-"));
  const allowedSigners = join(dir, "allowed_signers");
  try {
    writeFileSync(allowedSigners, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    const result = spawnSync("git", [
      "-c", "gpg.format=ssh",
      "-c", `gpg.ssh.allowedSignersFile=${allowedSigners}`,
      "-c", `gpg.ssh.program=${sshKeygen}`,
      "-c", "gpg.ssh.revocationFile=/dev/null",
      "-c", "gpg.minTrustLevel=fully",
      "log", "--no-walk=unsorted", `--format=%H${FIELD}%G?${FIELD}%GS${FIELD}%GF${FIELD}%s${RECORD}`,
      ...shas,
    ], { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: verificationEnv() });
    if (result.status !== 0) {
      throw new Error(`git log failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
    }
    return result.stdout.split(RECORD).map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
      const [sha = "", code = "", principal = "", fingerprint = "", subject = ""] = record.split(FIELD);
      const credential = keys.find((key) => key.credential_id === principal) ?? null;
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
