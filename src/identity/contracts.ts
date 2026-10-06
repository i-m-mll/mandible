import type { UserKind } from "../users/types.js";

export interface ReadUserIdentity {
  id: string;
  display_name: string;
  kind: UserKind;
}

export interface ReadCredentialIdentity {
  id: string;
  type: string;
  label: string | null;
}

export interface AttributionReadProjection {
  user: ReadUserIdentity | null;
  evidence_method: string | null;
  evidence_id: string | null;
  credential: ReadCredentialIdentity | null;
}

/**
 * What the merge-signature evidence actually says, as three mutually exclusive
 * states rather than one boolean.
 *
 * `verified_signature: boolean` could not express the middle case. A merge
 * whose signature verification *failed* still records
 * `evidence_method: "credential_signature"` (auth-queue.ts writes that method
 * unconditionally, including from its `catch`, and puts the result in the
 * evidence `details` bag), so deriving the badge from the method name reported
 * "Verified signature" for a signature that had not verified. The state the
 * approver most needs to see was the one the type could not represent.
 */
export type MergeSignatureClaim =
  /** No credential-signature evidence attached — nothing is being claimed. */
  | { state: "none" }
  /** Evidence attached and `details.verified === true`. */
  | { state: "verified"; fingerprint: string | null }
  /** Evidence attached and verification did not succeed. `reason` is the recorded cause. */
  | { state: "unverified"; reason: string | null };

export interface AuthAttributionReadFields {
  requester: ReadUserIdentity | null;
  approver: ReadUserIdentity | null;
  execution_evidence: AttributionReadProjection | null;
  merge_signature: MergeSignatureClaim;
}

