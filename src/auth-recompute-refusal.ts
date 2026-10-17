/**
 * Issue 2205073 — honest approval errors for approve-time candidate recompute.
 *
 * Issue 08a5f04 gave approval a stale-candidate recompute path with a dozen
 * fail-closed guards. Every one of them declined by returning null, and the
 * caller threw a single generic sentence: "Reviewed merge inputs or retained
 * candidate changed; requeue and reapprove this request." The specific reason
 * went exclusively to daemon_log (or nowhere at all), so the approver saw a
 * misconfiguration — an unregistered protected-merge signing key — as an
 * unexplained refusal on the second of three queued requests.
 *
 * This module turns a structured refusal into the message the approver reads:
 * the original strict sentence (still first, so it stays greppable and
 * back-compatible), then the machine-readable reason, then the fix that
 * actually applies to that reason.
 */

export interface RecomputeRefusal {
  /** Machine-readable guard identity, e.g. "head_branch_moved". */
  reason: string;
  detail?: Record<string, unknown>;
}

export interface RecomputeRefusalContext {
  /** Registry ref for the operator, used in the credential-registration hint. */
  operatorRef?: string | null;
}

export const STRICT_RECOMPUTE_MESSAGE =
  "Reviewed merge inputs or retained candidate changed; requeue and reapprove this request.";

const REQUEUE = "Requeue and reapprove this request so a fresh candidate is reviewed.";

/** Signature failures that mean "this key is not a registered credential". */
const UNREGISTERED_KEY_REASONS = new Set([
  "signature_not_trusted",
  "no_active_registered_signing_credentials",
  "verified_principal_not_registered",
  "registered_fingerprint_mismatch",
]);

export function describeRecomputeRefusal(
  refusal: RecomputeRefusal | null | undefined,
  context: RecomputeRefusalContext = {},
): string {
  if (!refusal) return STRICT_RECOMPUTE_MESSAGE;
  const explanation = explain(refusal, context);
  return `${STRICT_RECOMPUTE_MESSAGE} Refusal: ${refusal.reason}. ${explanation}`;
}

function explain(refusal: RecomputeRefusal, context: RecomputeRefusalContext): string {
  const detail = refusal.detail ?? {};
  switch (refusal.reason) {
    case "strict_pin_requested":
      return `This request opted into strict pin behavior, so any reviewed-input change blocks approval. ${REQUEUE}`;
    case "not_recomputable_request": {
      const missing = stringList(detail.missing);
      const because = missing ? ` (missing or unsupported: ${missing})` : "";
      return (
        `Automatic recompute needs a local-mode merge request with complete reviewed merge inputs${because}. ` +
        REQUEUE
      );
    }
    case "retained_candidate_invalid":
      return (
        "The retained merge candidate no longer matches the reviewed candidate — its candidate ref or pin " +
        `commit was deleted, rewritten, or re-pointed. This is tamper evidence, not drift. ${REQUEUE}`
      );
    case "head_branch_moved":
      return (
        `Head branch '${text(detail.head_branch) ?? "?"}' now points at ${shortSha(detail.current_head)}, ` +
        `not the reviewed ${shortSha(detail.reviewed_head)}: the reviewed content itself changed. ` +
        REQUEUE
      );
    case "execution_chain_busy":
      return (
        "Another merge or revalidation for this repository is still in flight, so the candidate cannot be " +
        "recomputed safely right now. Wait for it to finish and approve again — no requeue needed."
      );
    case "base_head_unresolvable":
      return (
        `Could not resolve the current head of base branch '${text(detail.base_branch) ?? "?"}' in ` +
        `${text(detail.cwd) ?? "the target repo"}. Check that the repository is readable and the daemon is ` +
        "healthy, then approve again."
      );
    case "base_unchanged":
      return (
        "The base branch has not moved, so the retained candidate is stale for some other reason: the pin " +
        `or preflight record no longer matches the reviewed inputs. ${REQUEUE}`
      );
    case "base_transition_unaccounted":
      return explainBaseTransition(detail, context);
    case "recomputed_preflight_unavailable":
      return (
        `The recomputed merge preflight did not complete (status: ${text(detail.status) ?? "unknown"}` +
        `${text(detail.reason) ? `: ${text(detail.reason)}` : ""}), so the candidate could not be re-attested. ` +
        "Retry once that clears; if it keeps failing, check repo and daemon health."
      );
    case "base_moved_again":
      return (
        "The base branch moved again between provenance verification and the recomputed preflight. Approve " +
        "again once the base settles — no requeue needed."
      );
    case "repin_failed":
      return (
        `The refreshed merge candidate could not be pinned (${text(detail.repin_reason) ?? "unknown failure"}). ` +
        `The previous pin state is intact and still blocking. ${REQUEUE}`
      );
    default:
      return REQUEUE;
  }
}

function explainBaseTransition(
  detail: Record<string, unknown>,
  context: RecomputeRefusalContext,
): string {
  const reason = text(detail.transition_reason) ?? "unknown";
  const commit = shortSha(detail.commit);
  const range =
    `The protected base advanced from ${shortSha(detail.old_base)} to ${shortSha(detail.new_base)}, but that ` +
    "transition is not fully accounted for by recorded, signature-verified queue merges";
  switch (reason) {
    case "signature_not_authorized": {
      const signatureReason = text(detail.signature_reason) ?? "unknown";
      const fingerprint = text(detail.signature_fingerprint);
      const key = fingerprint ? `key ${fingerprint}` : "an unidentified key";
      if (UNREGISTERED_KEY_REASONS.has(signatureReason)) {
        return (
          `${range}: merge commit ${commit} on the base is signed by ${key}, which is not an active ` +
          `registered signing credential (${signatureReason}). Register the protected-merge signing key, ` +
          `then approve again: \`mandible user credential add ${operatorRef(context)} --from-git-signingkey\`.`
        );
      }
      if (signatureReason === "signer_is_not_approving_user") {
        return (
          `${range}: merge commit ${commit} is signed by ${key}, which belongs to a different user than the ` +
          "approver recorded for that merge. Verify who actually performed that merge before re-approving."
        );
      }
      return (
        `${range}: the signature on merge commit ${commit} (${key}) did not verify against the approving ` +
        `user's active credentials (${signatureReason}). If this is your protected-merge signing key, ` +
        `register it: \`mandible user credential add ${operatorRef(context)} --from-git-signingkey\`.`
      );
    }
    case "commit_not_a_recorded_queue_merge":
      return (
        `${range}: commit ${commit} on the base is not a completed queue merge recorded by Mandible. A merge ` +
        `performed outside the auth queue cannot be attested. ${REQUEUE}`
      );
    case "not_a_two_parent_merge":
      return (
        `${range}: commit ${commit} is not a two-parent merge (parents: ` +
        `${text(detail.parent_count) ?? "?"}) — a direct commit or octopus merge on the protected branch. ` +
        REQUEUE
      );
    case "merge_second_parent_not_reviewed_head":
      return (
        `${range}: merge commit ${commit} does not merge the head that its recorded request reviewed. ` +
        REQUEUE
      );
    case "merge_provenance_reused":
      return (
        `${range}: merge commit ${commit} is claimed by more than one completed request, which is reuse ` +
        `evidence. ${REQUEUE}`
      );
    case "recorded_merge_missing_reviewed_head":
    case "recorded_merge_missing_approver":
      return (
        `${range}: the completed request recorded for merge commit ${commit} is missing the provenance ` +
        `fields needed to attest it (${reason}). ${REQUEUE}`
      );
    case "first_parent_chain_mismatch":
    case "first_parent_chain_broken":
      return (
        `${range}: the first-parent chain from the new base does not lead back to the reviewed base ` +
        `(${reason}), which means the protected branch history was rewritten. ${REQUEUE}`
      );
    case "first_parent_chain_unresolvable":
    case "parents_unresolvable":
      return (
        `${range}: git could not resolve the base history (${reason}${commit === "(unknown)" ? "" : ` at ${commit}`}). ` +
        "Retry the approval; if it persists, check repo and daemon health."
      );
    case "transition_too_long":
      return (
        `${range}: the transition is ${text(detail.commits) ?? "too many"} commits long, beyond the cap for ` +
        `automatic attestation. ${REQUEUE}`
      );
    case "empty_transition":
      return `${range}: the new base is not a descendant of the reviewed base. ${REQUEUE}`;
    case "missing_repo_context":
      return (
        `${range}: the request has no repository path or base branch recorded, so provenance cannot be ` +
        `checked. ${REQUEUE}`
      );
    default:
      return `${range} (${reason}). ${REQUEUE}`;
  }
}

function operatorRef(context: RecomputeRefusalContext): string {
  const ref = context.operatorRef?.trim();
  return ref && ref.length > 0 ? ref : "operator";
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function shortSha(value: unknown): string {
  const sha = text(value);
  if (!sha) return "(unknown)";
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 12) : sha;
}

function stringList(value: unknown): string | null {
  if (!Array.isArray(value)) return text(value);
  const items = value.map((entry) => text(entry)).filter((entry): entry is string => Boolean(entry));
  return items.length > 0 ? items.join(", ") : null;
}
