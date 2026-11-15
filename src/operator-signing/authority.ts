import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { observeChild } from "../child-observation.js";
import { trustedSshKeygenPath } from "../auth-signature-verification.js";
import type { Db } from "../db.js";
import type { MergeCommitSigner } from "../merge-commit.js";
import { resolveOpenSshPublicKey } from "./public-key.js";
import { ulid } from "../users/ids.js";
import {
  addAttributionEvidence,
  addEnclaveApprovalKey,
  getOperator,
  listCredentials,
  retireEnclaveCustody,
} from "../users/store.js";
import type { AttributionEvidence, UserCredential } from "../users/types.js";
import type { OPERATOR_TRUST_CHANGE_KINDS } from "./schema.js";
import type { KeyState, OperatorSigner, SignOutcome } from "./signer.js";

/** Namespace of every typed operator statement; merge commits use `git`. */
export const OPERATOR_STATEMENT_NAMESPACE = "mandible-operator";

export type TrustChangeKind = (typeof OPERATOR_TRUST_CHANGE_KINDS)[number];

export type SigningRefusalCode =
  | "operator_required"
  | "approval_key_required"
  | "approval_key_unavailable"
  | "bootstrap_confirmation_required"
  | "cancelled"
  | "signing_failed"
  | "untrusted_signature"
  | "stale";

export interface SigningRefusal {
  code: SigningRefusalCode;
  detail: string;
}

export type Signed<T> = { ok: true; value: T } | { ok: false; error: SigningRefusal };

export interface VerifiedSignature {
  credential_id: string;
  fingerprint: string;
  signature: string;
}

export interface ApprovalKeyStatus {
  credential: UserCredential;
  state: KeyState;
  detail: string | null;
}

export interface TrustChange {
  id: string;
  operator_user_id: string;
  kind: TrustChangeKind;
  authorization: "signed" | "bootstrap";
  statement: string;
  signatures: Array<{ credential_id: string; role: "approval_key" | "new_key"; signature: string }>;
  created_at: number;
}

export interface OperatorStatement {
  kind: "trust_change" | "clearance_grant";
  content: Record<string, unknown>;
}

const refuse = (code: SigningRefusalCode, detail: string): { ok: false; error: SigningRefusal } => ({ ok: false, error: { code, detail } });

/** Exact bytes of a typed statement; the order of keys is fixed by construction. */
export function statementBytes(operatorId: string, statement: OperatorStatement, issuedAt: number, nonce: string): string {
  return JSON.stringify({
    statement: "mandible-operator-statement@1",
    kind: statement.kind,
    operator_user_id: operatorId,
    issued_at: issuedAt,
    nonce,
    content: statement.content,
  });
}

function signOutcomeRefusal(outcome: Exclude<SignOutcome, { result: "signed" }>): { ok: false; error: SigningRefusal } {
  switch (outcome.result) {
    case "cancelled": return refuse("cancelled", "Signing was cancelled.");
    case "failed": return refuse("signing_failed", outcome.detail);
    default: return refuse("approval_key_unavailable", `The approval key cannot sign: ${outcome.result}.`);
  }
}

/** Verify an armored SSH signature with stock OpenSSH against one public key. */
export async function verifySshSignature(publicMaterial: string, namespace: string, message: Buffer | string, signature: string): Promise<boolean> {
  const sshKeygen = trustedSshKeygenPath();
  const fields = publicMaterial.trim().split(/\s+/);
  if (!sshKeygen || fields.length < 2) return false;
  const dir = mkdtempSync(path.join(tmpdir(), "mandible-operator-verify-"));
  try {
    const signers = path.join(dir, "allowed_signers");
    const signaturePath = path.join(dir, "signature");
    writeFileSync(signers, `operator ${fields[0]} ${fields[1]}\n`, { mode: 0o600 });
    writeFileSync(signaturePath, signature, { mode: 0o600 });
    const verified = await observeChild(sshKeygen, ["-Y", "verify", "-n", namespace, "-f", signers, "-I", "operator", "-s", signaturePath], {
      input: message, timeout: 5_000,
    });
    return verified.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Signed operator actions. Every signature comes from the operator's enrolled
 * approval key through the operator signer and is verified here against the
 * registered public key; nothing a caller submits stands in for it.
 *
 * The approval key's wrapped-key file lives at a path derived from its
 * fingerprint under `keyDirectory`, so no stored row can name another file.
 */
export class OperatorSigningAuthority {
  constructor(
    private readonly db: Db,
    private readonly signer: OperatorSigner,
    private readonly keyDirectory: string,
    private readonly now: () => number = Date.now,
  ) {}

  keyPath(fingerprint: string): string {
    return path.join(this.keyDirectory, `${createHash("sha256").update(fingerprint).digest("hex")}.key`);
  }

  private enclaveKeys(operatorId: string): UserCredential[] {
    return listCredentials(this.db, operatorId).filter((credential) => credential.custody === "enclave");
  }

  private operatorId(): Signed<string> {
    const operator = getOperator(this.db);
    return operator && operator.status === "active" && operator.kind === "human"
      ? { ok: true, value: operator.id }
      : refuse("operator_required", "Configure the local operator first.");
  }

  async approvalKeyStatus(): Promise<ApprovalKeyStatus[]> {
    const operatorId = this.operatorId();
    if (!operatorId.ok) return [];
    const keys = this.enclaveKeys(operatorId.value);
    if (keys.length === 0) return [];
    const statuses = await this.signer.status(keys.map((key) => this.keyPath(key.fingerprint)));
    return keys.map((credential) => {
      if (!Array.isArray(statuses)) return { credential, state: "failed", detail: statuses.detail };
      const status = statuses.find((entry) => entry.key === this.keyPath(credential.fingerprint));
      return status
        ? { credential, state: status.state, detail: status.detail }
        : { credential, state: "failed", detail: "The approval helper did not report this key." };
    });
  }

  /** One touch: the enrolled approval key signs `message` in `namespace`, verified before it is returned. */
  async signWithApprovalKey(namespace: string, message: Buffer | string, reason: string, signal?: AbortSignal): Promise<Signed<VerifiedSignature>> {
    const operatorId = this.operatorId();
    if (!operatorId.ok) return operatorId;
    const [key, ...others] = this.enclaveKeys(operatorId.value);
    if (!key) return refuse("approval_key_required", "Enroll an approval key in Settings before performing this action.");
    if (others.length > 0) return refuse("signing_failed", "More than one approval key is enrolled.");
    return this.signWith(key, namespace, message, reason, signal);
  }

  /** The approval key as a merge-commit signer; `reason` is shown on the sheet. */
  commitSigner(reason: string): MergeCommitSigner {
    return { sign: (message, namespace, signal) => this.signWithApprovalKey(namespace, message, reason, signal) };
  }

  private async signWith(key: UserCredential, namespace: string, message: Buffer | string, reason: string, signal?: AbortSignal): Promise<Signed<VerifiedSignature>> {
    const outcome = await this.signer.sign({ key: this.keyPath(key.fingerprint), namespace, message: Buffer.from(message), reason }, signal);
    if (signal?.aborted) return refuse("cancelled", "Signing was cancelled.");
    if (outcome.result !== "signed") return signOutcomeRefusal(outcome);
    if (!key.public_material || !(await verifySshSignature(key.public_material, namespace, message, outcome.signature))) {
      return refuse("untrusted_signature", "The signature does not verify against the enrolled approval key.");
    }
    return { ok: true, value: { credential_id: key.id, fingerprint: key.fingerprint, signature: outcome.signature } };
  }

  private stillEnrolled(operatorId: string, credentialIds: readonly string[]): boolean {
    const current = this.enclaveKeys(operatorId).map((key) => key.id).sort();
    return getOperator(this.db)?.id === operatorId && JSON.stringify(current) === JSON.stringify([...credentialIds].sort());
  }

  /**
   * A typed statement signed by the approval key and recorded as evidence.
   * `commit` runs in the same transaction, after the key set is re-checked.
   */
  async signStatement<T>(statement: OperatorStatement, reason: string, signal: AbortSignal | undefined,
    commit: (evidence: AttributionEvidence, signed: VerifiedSignature) => T): Promise<Signed<T>> {
    const operatorId = this.operatorId();
    if (!operatorId.ok) return operatorId;
    const keyIds = this.enclaveKeys(operatorId.value).map((key) => key.id);
    const bytes = statementBytes(operatorId.value, statement, this.now(), randomUUID());
    const signed = await this.signWithApprovalKey(OPERATOR_STATEMENT_NAMESPACE, bytes, reason, signal);
    if (!signed.ok) return signed;
    return this.db.transaction((): Signed<T> => {
      if (!this.stillEnrolled(operatorId.value, keyIds)) return refuse("stale", "The approval key changed during signing; try again.");
      const evidence = addAttributionEvidence(this.db, {
        evidence_method: "credential_signature",
        credential_id: signed.value.credential_id,
        details: { verified: true, signer_user_id: operatorId.value, authorizer_user_id: operatorId.value,
          namespace: OPERATOR_STATEMENT_NAMESPACE, statement: bytes, signature: signed.value.signature },
      }, this.now());
      return { ok: true, value: commit(evidence, signed.value) };
    })();
  }

  /** A change to whom the gate trusts or what it covers: signed by the approval key and recorded. */
  async authorizeTrustChange<T>(kind: Exclude<TrustChangeKind, "approval_key_enrollment">, content: Record<string, unknown>,
    reason: string, signal: AbortSignal | undefined, apply: () => T): Promise<Signed<{ value: T; change: TrustChange }>> {
    return this.signStatement({ kind: "trust_change", content: { change: kind, ...content } }, reason, signal, (evidence, signed) => {
      const value = apply();
      const change = this.recordTrustChange(kind, "signed", String(evidence.details.statement),
        [{ credential_id: signed.credential_id, role: "approval_key", signature: signed.signature }]);
      return { value, change };
    });
  }

  /**
   * Enroll a new approval key. The helper creates it; the new key signs the
   * enrollment statement, and so does the current approval key while one is
   * usable. With none usable the enrollment is a recorded bootstrap: at once
   * when no key is enrolled or every enrolled key is missing or invalidated,
   * and with the operator's confirmation when a key fails for a reason the
   * helper cannot classify. A key that cannot sign only for now (cancelled,
   * biometry unavailable or locked out, no session) refuses enrollment. A
   * replaced key stays as a verify-only signer.
   */
  async enroll(signal?: AbortSignal, options: { confirmBootstrap?: boolean } = {}): Promise<Signed<{ credential: UserCredential; change: TrustChange }>> {
    const operatorId = this.operatorId();
    if (!operatorId.ok) return operatorId;
    const statuses = await this.approvalKeyStatus();
    const usable = statuses.find((status) => status.state === "usable");
    if (!usable) {
      const transient = statuses.find((status) => !["key_missing", "key_invalidated", "failed"].includes(status.state));
      if (transient) return refuse("approval_key_unavailable", `The enrolled approval key cannot sign now: ${transient.state}. Try again.`);
      const unclassified = statuses.find((status) => status.state === "failed");
      if (unclassified && !options.confirmBootstrap) {
        return refuse("bootstrap_confirmation_required", `The enrolled approval key failed: ${unclassified.detail ?? "no detail"}. Confirm to replace it without its signature.`);
      }
    }
    const authorization = usable ? "signed" : "bootstrap";
    mkdirSync(this.keyDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.keyDirectory, 0o700);
    const pending = path.join(this.keyDirectory, `pending-${randomUUID()}.key`);
    const created = await this.signer.create(pending);
    if (created.result !== "created") {
      rmSync(pending, { force: true });
      return created.result === "failed" ? refuse("signing_failed", created.detail) : refuse("approval_key_unavailable", `Cannot create an approval key: ${created.result}.`);
    }
    const resolved = await resolveOpenSshPublicKey(created.public_key);
    if (!resolved.ok || !resolved.value.material.startsWith("ecdsa-sha2-nistp256 ")) {
      rmSync(pending, { force: true });
      return refuse("signing_failed", "The approval helper returned an unexpected public key.");
    }
    const { material, fingerprint } = resolved.value;
    const keyPath = this.keyPath(fingerprint);
    if (existsSync(keyPath)) {
      rmSync(pending, { force: true });
      return refuse("signing_failed", "A key file for this fingerprint already exists.");
    }
    renameSync(pending, keyPath);
    const discard = () => rmSync(keyPath, { force: true });
    const replaced = statuses.map((status) => status.credential);
    const bytes = statementBytes(operatorId.value, {
      kind: "trust_change",
      content: {
        change: "approval_key_enrollment", authorization, fingerprint, public_key: material,
        replaces: replaced.map((credential) => ({ credential_id: credential.id, fingerprint: credential.fingerprint })),
      },
    }, this.now(), randomUUID());
    const newSignature = await this.signer.sign({ key: keyPath, namespace: OPERATOR_STATEMENT_NAMESPACE, message: Buffer.from(bytes),
      reason: "enroll a new Mandible approval key" }, signal);
    if (newSignature.result !== "signed") { discard(); return signOutcomeRefusal(newSignature); }
    if (signal?.aborted) { discard(); return refuse("cancelled", "Signing was cancelled."); }
    if (!(await verifySshSignature(material, OPERATOR_STATEMENT_NAMESPACE, bytes, newSignature.signature))) {
      discard();
      return refuse("untrusted_signature", "The new key's signature does not verify against its public key.");
    }
    const signatures: TrustChange["signatures"] = [{ credential_id: "", role: "new_key", signature: newSignature.signature }];
    if (usable) {
      const current = await this.signWith(usable.credential, OPERATOR_STATEMENT_NAMESPACE, bytes,
        "authorize replacing your Mandible approval key", signal);
      if (!current.ok) { discard(); return current; }
      signatures.push({ credential_id: current.value.credential_id, role: "approval_key", signature: current.value.signature });
    }
    try {
      return this.db.transaction((): Signed<{ credential: UserCredential; change: TrustChange }> => {
        if (!this.stillEnrolled(operatorId.value, replaced.map((credential) => credential.id))) {
          throw new StaleEnrollment();
        }
        for (const credential of replaced) retireEnclaveCustody(this.db, credential.id);
        const credential = addEnclaveApprovalKey(this.db, operatorId.value, { fingerprint, public_material: material, label: "Approval key" }, this.now());
        signatures[0]!.credential_id = credential.id;
        const change = this.recordTrustChange("approval_key_enrollment", authorization, bytes, signatures);
        return { ok: true, value: { credential, change } };
      })();
    } catch (error) {
      discard();
      if (error instanceof StaleEnrollment) return refuse("stale", "The approval key changed during enrollment; try again.");
      throw error;
    }
  }

  private recordTrustChange(kind: TrustChangeKind, authorization: TrustChange["authorization"], statement: string,
    signatures: TrustChange["signatures"]): TrustChange {
    const operatorId = getOperator(this.db)!.id;
    const change: TrustChange = { id: ulid(this.now()), operator_user_id: operatorId, kind, authorization, statement, signatures, created_at: this.now() };
    this.db.prepare(`INSERT INTO operator_trust_changes (id, operator_user_id, kind, authorization, statement, signatures_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(change.id, operatorId, kind, authorization, statement, JSON.stringify(signatures), change.created_at);
    return change;
  }
}

class StaleEnrollment extends Error {}

export function listTrustChanges(db: Db, limit = 100): TrustChange[] {
  const rows = db.prepare("SELECT * FROM operator_trust_changes ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as Array<{
    id: string; operator_user_id: string; kind: TrustChangeKind; authorization: TrustChange["authorization"];
    statement: string; signatures_json: string; created_at: number;
  }>;
  return rows.map(({ signatures_json, ...row }) => ({ ...row, signatures: JSON.parse(signatures_json) as TrustChange["signatures"] }));
}
