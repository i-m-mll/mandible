import type { Db } from "../db.js";

import type {
  ReadUserIdentity,
  ReadCredentialIdentity,
  AttributionReadProjection,
  MergeSignatureClaim,
  AuthAttributionReadFields,
} from "./contracts.js";
export type {
  ReadUserIdentity,
  ReadCredentialIdentity,
  AttributionReadProjection,
  MergeSignatureClaim,
  AuthAttributionReadFields,
} from "./contracts.js";

interface EvidenceRow {
  id: string;
  evidence_method: string;
  credential_id: string | null;
  details_json: string;
}

interface CredentialRow {
  id: string;
  type: string;
  label: string | null;
}

/** Resolve user/evidence display facts without changing the stored legacy actor fields. */
export class AttributionReadResolver {
  private readonly users = new Map<string, ReadUserIdentity | null>();
  private readonly evidence = new Map<string, EvidenceRow | null>();
  private readonly credentials = new Map<string, ReadCredentialIdentity | null>();

  constructor(private readonly db: Db) {}

  user(userId: string | null | undefined): ReadUserIdentity | null {
    if (!userId) return null;
    if (this.users.has(userId)) return this.users.get(userId) ?? null;
    const row = this.db.prepare(
      "SELECT id, display_name, kind FROM users WHERE id = ?",
    ).get(userId) as ReadUserIdentity | undefined;
    const user = row ?? null;
    this.users.set(userId, user);
    return user;
  }

  attribution(input: {
    user_id?: string | null;
    evidence_method?: string | null;
    evidence_id?: string | null;
  }): AttributionReadProjection | null {
    const user = this.user(input.user_id);
    const evidence = this.evidenceRow(input.evidence_id);
    const evidenceMethod = evidence?.evidence_method ?? input.evidence_method ?? null;
    const evidenceId = evidence?.id ?? input.evidence_id ?? null;
    const credential = this.credential(evidence?.credential_id);
    if (!user && !evidenceMethod && !evidenceId && !credential) return null;
    return {
      user,
      evidence_method: evidenceMethod,
      evidence_id: evidenceId,
      credential,
    };
  }

  private evidenceRow(evidenceId: string | null | undefined): EvidenceRow | null {
    if (!evidenceId) return null;
    if (this.evidence.has(evidenceId)) return this.evidence.get(evidenceId) ?? null;
    const row = this.db.prepare(
      "SELECT id, evidence_method, credential_id, details_json FROM attribution_evidence WHERE id = ?",
    ).get(evidenceId) as EvidenceRow | undefined;
    const evidence = row ?? null;
    this.evidence.set(evidenceId, evidence);
    return evidence;
  }

  /**
   * The signature claim carried by one evidence row. Fails closed: evidence
   * whose `details.verified` is anything other than exactly `true` — including
   * a details bag that will not parse — is `unverified`, never `verified`.
   */
  mergeSignatureClaim(evidenceId: string | null | undefined): MergeSignatureClaim {
    const evidence = this.evidenceRow(evidenceId);
    if (!evidence || evidence.evidence_method !== "credential_signature") {
      return { state: "none" };
    }
    let details: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(evidence.details_json);
      details = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // An unreadable details bag is not proof of verification. Say so, and say
      // why, rather than silently degrading to the "none" state — evidence is
      // attached, so "nothing is claimed" would also be untrue.
      return { state: "unverified", reason: "evidence_details_unreadable" };
    }
    if (details.verified === true) {
      return {
        state: "verified",
        fingerprint: typeof details.fingerprint === "string" ? details.fingerprint : null,
      };
    }
    return {
      state: "unverified",
      reason: typeof details.reason === "string" ? details.reason : null,
    };
  }

  private credential(credentialId: string | null | undefined): ReadCredentialIdentity | null {
    if (!credentialId) return null;
    if (this.credentials.has(credentialId)) return this.credentials.get(credentialId) ?? null;
    const row = this.db.prepare(
      "SELECT id, type, label FROM user_credentials WHERE id = ?",
    ).get(credentialId) as CredentialRow | undefined;
    const credential = row ?? null;
    this.credentials.set(credentialId, credential);
    return credential;
  }
}

export function resolvedActorDisplay(
  legacyDisplay: string,
  fallback: string,
  attribution: AttributionReadProjection | null,
): string {
  return (attribution?.user?.display_name ?? legacyDisplay) || fallback;
}

export function authAttributionReadFields(
  resolver: AttributionReadResolver,
  request: {
    requested_by_user_id?: string | null;
    approved_by_user_id?: string | null;
    execution_evidence_id?: string | null;
  },
): AuthAttributionReadFields {
  const executionEvidence = resolver.attribution({ evidence_id: request.execution_evidence_id });
  return {
    requester: resolver.user(request.requested_by_user_id),
    approver: resolver.user(request.approved_by_user_id),
    execution_evidence: executionEvidence,
    // Derived from the recorded verification RESULT, not from the evidence
    // method name. Those disagree whenever verification failed.
    merge_signature: resolver.mergeSignatureClaim(request.execution_evidence_id),
  };
}
