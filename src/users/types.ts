// User registry core types (umbrella 8e2e8b2 / issue e89c2b0).
//
// These mirror the v107 schema. Downstream waves (attribution resolver, auth
// queue attribution, session/work-unit ownership, client tokens, groups) consume
// these tables but their wiring is out of scope here.

export type UserKind = "human" | "agent" | "system" | "external";
export type UserStatus = "active" | "retired";

/**
 * Credential type vocabulary is validated in application code, not by a DB
 * CHECK constraint, so adding a new credential type never requires a table
 * rebuild. Keep this list in sync with the issue spec.
 */
export const CREDENTIAL_TYPES = [
  "ssh_key",
  "api_token",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export type CredentialStatus = "active" | "revoked";

/** Whether Mandible can invoke an `ssh_key` here or only verify it; null for other types. */
export type CredentialCustody = "enclave" | "external";

export const BINDING_TYPES = [
  "app_name",
  "provider_session_env",
  "process_pattern",
  "git_author_email",
  "external_author",
] as const;
export type BindingType = (typeof BINDING_TYPES)[number];
export type BindingStatus = "active" | "inactive";

/** Locked classes of evidence that may be persisted for durable attribution. */
export const EVIDENCE_METHODS = [
  "local_default",
  "session_claim",
  "external_import",
  "credential_signature",
  "system_internal",
  "api_token",
] as const;
export type EvidenceMethod = (typeof EVIDENCE_METHODS)[number];

const EVIDENCE_METHOD_SET: ReadonlySet<string> = new Set(EVIDENCE_METHODS);

export function isEvidenceMethod(value: string): value is EvidenceMethod {
  return EVIDENCE_METHOD_SET.has(value);
}

export function assertEvidenceMethod(value: string): asserts value is EvidenceMethod {
  if (!isEvidenceMethod(value)) {
    throw new Error(
      `Invalid evidence_method '${value}'. Allowed: ${EVIDENCE_METHODS.join(", ")}.`,
    );
  }
}

export interface User {
  id: string;
  slug: string;
  kind: UserKind;
  display_name: string;
  email: string | null;
  status: UserStatus;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown>;
}

export interface UserCredential {
  id: string;
  user_id: string;
  type: string;
  fingerprint: string;
  public_material: string | null;
  label: string | null;
  status: CredentialStatus;
  created_at: number;
  revoked_at: number | null;
  metadata: Record<string, unknown>;
  custody: CredentialCustody | null;
}

export interface UserBinding {
  id: string;
  user_id: string;
  binding_type: BindingType;
  value: string;
  scope: string | null;
  status: BindingStatus;
  created_at: number;
  updated_at: number;
}

export interface AttributionEvidence {
  id: string;
  evidence_method: EvidenceMethod;
  credential_id: string | null;
  verified_at: number;
  details: Record<string, unknown>;
}

export interface AddAttributionEvidenceInput {
  evidence_method: EvidenceMethod;
  credential_id?: string | null;
  details?: Record<string, unknown>;
}

export interface CreateUserInput {
  slug: string;
  kind: UserKind;
  display_name: string;
  email?: string | null;
  status?: UserStatus;
  metadata?: Record<string, unknown>;
}

export interface UpdateUserInput {
  display_name?: string;
  email?: string | null;
  status?: UserStatus;
  metadata?: Record<string, unknown>;
}

export interface AddCredentialInput {
  type: string;
  fingerprint: string;
  public_material?: string | null;
  label?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AddBindingInput {
  binding_type: BindingType;
  value: string;
  scope?: string | null;
  status?: BindingStatus;
}

export interface SetupOperatorInput {
  slug?: string;
  display_name?: string;
  email?: string | null;
  metadata?: Record<string, unknown>;
}
