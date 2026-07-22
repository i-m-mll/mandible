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
  "yubikey_recipient",
  "delegated_ssh_key",
  "api_token",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export type CredentialStatus = "active" | "revoked";

export const BINDING_TYPES = [
  "app_name",
  "provider_session_env",
  "process_pattern",
  "git_author_email",
  "external_author",
] as const;
export type BindingType = (typeof BINDING_TYPES)[number];
export type BindingStatus = "active" | "inactive";

export type MintMethod = "fresh_presence" | "reused_lease";

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
  evidence_method: string;
  credential_id: string | null;
  lease_id: string | null;
  verified_at: number;
  details: Record<string, unknown>;
}

export interface DelegatedSigningLease {
  id: string;
  credential_id: string;
  owner_user_id: string;
  minted_at: number;
  expires_at: number;
  mint_method: MintMethod;
}

export interface AddAttributionEvidenceInput {
  evidence_method: string;
  credential_id?: string | null;
  lease_id?: string | null;
  details?: Record<string, unknown>;
}

export interface AddDelegatedSigningLeaseInput {
  id: string;
  credential_id: string;
  owner_user_id: string;
  minted_at: number;
  expires_at: number;
  mint_method: MintMethod;
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
