import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { RequestLike, ResolvedClientIdentity } from "../server.js";
import type { Operation } from "../security/operation-policy.js";
import { signOperatorChallenge } from "../auth-operator-proof.js";
import { authorizedOperatorSignerLines } from "../auth-signature-verification.js";
import { discoverConfiguredPublicSigningKey } from "../signing-credential-audit.js";
import { addAttributionEvidence, getOperator } from "../users/store.js";
import { ClientAuthzError } from "./authz.js";

const proofs = new WeakMap<RequestLike, { identity: ResolvedClientIdentity; expiresAt: number; digest: string }>();
const mutates = (request: RequestLike) => !["GET", "HEAD", "OPTIONS"].includes(request.method);
const digest = (request: RequestLike) => createHash("sha256")
  .update(JSON.stringify({ method: request.method, url: request.url, params: request.params, body: request.body }))
  .digest("hex");

export function operatorPresenceIdentity(request: RequestLike): ResolvedClientIdentity | null {
  const proof = proofs.get(request);
  return proof && Date.now() < proof.expiresAt && proof.digest === digest(request) ? proof.identity : null;
}

/** Proof is minted and consumed inside one dispatch; no reusable bearer or proof endpoint exists. */
export async function authorizeProtectedMutation(
  db: Db, request: RequestLike, operation: Operation, installationId: string, instanceId: string,
): Promise<void> {
  if (!mutates(request) || !(operation.operatorPresence || operation.effects.includes("auth:credentials"))) return;
  const operator = getOperator(db);
  if (!operator) {
    // Initial setup creates identity only, never approval or credential authority.
    if (operation.id === "post:/api/users/setup") return;
    throw new ClientAuthzError(403, "operator_presence_required", "Configure the local operator before performing this action.");
  }
  let signers = authorizedOperatorSignerLines(db, operator.id);
  const bootstrappingKey = operation.id === "post:/api/users/operator/signing-key" && signers.length === 0;
  if (bootstrappingKey) {
    const configured = await discoverConfiguredPublicSigningKey();
    if (configured.value) signers = [`bootstrap ${configured.value.material}`];
  }
  const actionDigest = digest(request);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 60_000;
  const challenge = JSON.stringify({ namespace: "mandible-protected-action", installation_id: installationId,
    instance_id: instanceId, operation: operation.id, caller_user_id: request.client_identity?.user_id ?? null,
    session_id: request.client_identity?.session_id ?? null, digest: actionDigest,
    nonce: randomUUID(), issued_at: issuedAt, expires_at: expiresAt });
  const proof = await signOperatorChallenge(null, challenge, signers, request.signal);
  if (!proof.ok) throw new ClientAuthzError(403, "operator_presence_required", `Operator presence ${proof.reason}: ${proof.detail}`);
  const current = getOperator(db);
  const registered = bootstrappingKey ? authorizedOperatorSignerLines(db, operator.id).length === 0
    : authorizedOperatorSignerLines(db, operator.id).some(line => line.startsWith(`${proof.credentialId} `));
  if (request.signal?.aborted || Date.now() >= expiresAt || digest(request) !== actionDigest
      || current?.id !== operator.id || !registered) {
    throw new ClientAuthzError(409, "operator_presence_stale", "The action or operator credentials changed during signing; review the current action again.");
  }
  addAttributionEvidence(db, { evidence_method: "credential_signature",
    credential_id: bootstrappingKey ? null : proof.credentialId,
    details: { verified: true, signer_user_id: operator.id, authorizer_user_id: operator.id,
      challenge, signature: proof.signature, action_digest: actionDigest, operation: operation.id } });
  proofs.set(request, { identity: { user_id: operator.id, slug: operator.slug, method: "local_os_user",
    credential_id: bootstrappingKey ? null : proof.credentialId, source: "local_os_user",
    effect_ceiling: request.client_identity?.effect_ceiling ?? [] }, expiresAt, digest: actionDigest });
}
