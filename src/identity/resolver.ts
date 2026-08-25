// Fail-closed attribution resolver (umbrella 8e2e8b2 / issue 92813cc, wave 2).
//
// Ledger-native writes must carry a resolved user principal. This module turns
// the ambient context of a write (a daemon-internal action, the local HTTP/CLI
// operator, an authenticated session, or a git-bug import author) into an
// `AttributionContext` that the ledger store records in parallel `*_user_id`
// columns. The resolver never produces an anonymous actor: every path resolves
// to a concrete user or fails closed, so no new write can produce an
// unattributed (NULL) row.
//
// The parallel `*_user_id` columns are the real identity. The legacy
// `actor_id`/`actor_type`/`author_display` tuple is FROZEN provenance at every
// pre-existing call site (it is hashed into stable event/issue/comment ids), so
// this lane never rewrites it. `projectActorType` is the documented, pure
// projection of `users.kind` for future NEW write paths and read surfaces; it is
// never an authorization input and is not applied to legacy call sites here.

import type { Db } from "../db.js";
import {
  inManagedSessionContext,
  providerSessionEnvBindingValues,
  resolveAmbientProviderIdentity,
} from "../ambient-provider-identity.js";
import {
  SYSTEM_USER_ID,
  getOperator,
  getUserById,
} from "../users/store.js";
import {
  EVIDENCE_METHODS,
  assertEvidenceMethod,
  isEvidenceMethod,
  type EvidenceMethod,
  type UserKind,
} from "../users/types.js";
import type { LedgerActorInput, LedgerActorType } from "../ledger/types.js";

export { EVIDENCE_METHODS, assertEvidenceMethod, isEvidenceMethod, type EvidenceMethod };

/**
 * Locked evidence-method vocabulary (issue 92813cc). `evidence_method` records
 * the CLASS of evidence that established the identity, never a free-form or
 * per-binding detail string. Site-specific detail (e.g. which binding type
 * matched) belongs in a separate context/evidence-details field, not here.
 */
// Runtime guards and vocabulary are defined with the durable user/evidence
// types and re-exported here for existing attribution-resolver consumers.

/**
 * A resolved write principal. `user_id` names the acting user; `evidence_method`
 * is one of the locked vocabulary values; `evidence_id` optionally points at an
 * `attribution_evidence` row; `authorizer_user_id` names a distinct user who
 * authorized the action (e.g. the approver of an auth-queue merge).
 */
export interface AttributionContext {
  user_id: string;
  evidence_method: EvidenceMethod;
  evidence_id?: string | null;
  authorizer_user_id?: string | null;
}

export const OPERATOR_SETUP_HINT =
  "Run `mandible user setup` to create the local operator first.";

/**
 * The local HTTP/CLI principal has not been configured yet.
 *
 * This is a recoverable configuration state, not an attribution fallback: the
 * caller must run the explicit setup command before an interactive write can
 * be attributed. HTTP boundaries use this type to return a non-retryable 409
 * instead of obscuring the recovery action behind a generic 500.
 */
export class OperatorNotConfiguredError extends Error {
  readonly code = "operator_not_configured";
  readonly hint = OPERATOR_SETUP_HINT;
  readonly retryable = false;

  constructor() {
    super(`Local operator attribution is unavailable. ${OPERATOR_SETUP_HINT}`);
    this.name = "OperatorNotConfiguredError";
  }
}

/**
 * Centralized lossy projection of `users.kind` to the legacy `actor_type`
 * vocabulary. Documented as provenance only — never an authorization input, and
 * not applied to the frozen legacy tuple at pre-existing call sites.
 */
export function projectActorType(kind: UserKind): LedgerActorType {
  switch (kind) {
    case "human":
      return "mandible_user";
    case "agent":
      return "agent";
    case "system":
      return "system";
    case "external":
      return "external_adapter";
    default: {
      // Exhaustiveness guard: an unknown kind fails closed to external_adapter.
      const _never: never = kind;
      void _never;
      return "external_adapter";
    }
  }
}

/**
 * Attribution for a daemon-internal write with no external principal. Pure: it
 * needs no database because the `system` user carries a fixed sentinel id.
 * Callers use this only after classifying the write as genuinely internal.
 */
export function systemAction(): AttributionContext {
  return { user_id: SYSTEM_USER_ID, evidence_method: "system_internal" };
}

/**
 * Attribution resolved to the configured local operator. As of issue a64d2de
 * this is NO LONGER the fallback for tokenless HTTP ledger writes — those flow
 * through `attributionForRequest`, which resolves an ambient session binding or
 * stores NULL rather than assuming the operator. It remains the deliberate
 * principal for trusted in-process callers and operator-run local CLI
 * maintenance tools that write to the ledger directly (not over the network).
 * Missing operator configuration fails closed: a local operator action is not a
 * daemon-internal system action and must not be silently reclassified as one.
 */
export function localDefaultAttribution(db: Db): AttributionContext {
  const operator = getOperator(db);
  if (!operator) {
    throw new OperatorNotConfiguredError();
  }
  return {
    user_id: operator.id,
    evidence_method: "local_default",
  };
}

/**
 * Attribution for a local, process-resident write lane — a CLI maintenance tool
 * or a trusted in-process daemon submission — that carries no explicit principal
 * (issue a64d2de). It applies the same fail-closed order as the HTTP write path
 * and NEVER assumes the operator inside a managed-agent context:
 *
 *   - a genuinely non-managed local invocation (the human at a clean shell, no
 *     managed-session env markers) records the local operator (`local_default`);
 *   - a managed-agent context resolves the ambient provider to its owning agent
 *     (`session_claim`, agent-only) when a signal is present;
 *   - otherwise the write is left unattributed (`null` -> NULL columns).
 *
 * This closes the gap where a CLI tool or in-process lane run from an agent
 * session would otherwise silently stamp the operator, exactly the HTTP-path
 * defect. The operator-missing case still fails closed via `localDefaultAttribution`.
 */
export function localProcessDefaultAttribution(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): AttributionContext | null {
  if (!inManagedSessionContext(env)) {
    return localDefaultAttribution(db);
  }
  const ambient = resolveAmbientProviderIdentity(env);
  if (ambient) {
    const resolution = resolveProviderSessionAttributionResult(db, ambient.provider);
    if (resolution.status === "resolved") return resolution.attribution;
  }
  return null;
}

/** Ambient signals a session write can present for binding-based resolution. */
export interface SessionAttributionSignals {
  app_name?: string | null;
  provider_session_env?: string | null;
  process_pattern?: string | null;
  git_author_email?: string | null;
  binding_scope?: string | null;
}

export type SessionAttributionResolution =
  | { status: "resolved"; attribution: AttributionContext }
  | { status: "no_match" }
  | { status: "conflict" };

const SESSION_BINDING_ORDER: ReadonlyArray<{
  key: keyof SessionAttributionSignals;
  binding_type: string;
}> = [
  { key: "provider_session_env", binding_type: "provider_session_env" },
  { key: "app_name", binding_type: "app_name" },
  { key: "git_author_email", binding_type: "git_author_email" },
  { key: "process_pattern", binding_type: "process_pattern" },
];

/**
 * Resolve a session write to a user via active `user_bindings`. Fails closed:
 * returns null when no binding matches, and also when more than one active user
 * somehow shares a binding (structurally prevented by the unique index, but
 * never guessed here). A null return leaves classification to the caller: it
 * must either establish another explicit principal or reject the write, and
 * may use system attribution only for a genuinely daemon-internal action.
 */
export function resolveSessionAttribution(
  db: Db,
  signals: SessionAttributionSignals,
): AttributionContext | null {
  const result = resolveSessionAttributionResult(db, signals);
  return result.status === "resolved" ? result.attribution : null;
}

/** Resolve session signals while preserving no-match vs conflict semantics. */
export function resolveSessionAttributionResult(
  db: Db,
  signals: SessionAttributionSignals,
): SessionAttributionResolution {
  const matchedUserIds = new Set<string>();
  for (const { key, binding_type } of SESSION_BINDING_ORDER) {
    const value = signals[key];
    if (!value) continue;
    const scope = signals.binding_scope ?? null;
    const rows = db
      .prepare(
        `SELECT DISTINCT b.user_id
         FROM user_bindings b
         JOIN users u ON u.id = b.user_id
         WHERE b.binding_type = ? AND b.value = ?
           AND b.status = 'active' AND u.status = 'active'
           AND ((? IS NULL AND b.scope IS NULL)
             OR (? IS NOT NULL AND (b.scope IS NULL OR b.scope = ?)))
         LIMIT 2`,
      )
      .all(binding_type, normalizeBindingValue(value), scope, scope, scope) as Array<{ user_id: string }>;
    if (rows.length > 1) return { status: "conflict" };
    if (rows.length === 1) matchedUserIds.add(rows[0].user_id);
  }
  if (matchedUserIds.size === 0) return { status: "no_match" };
  if (matchedUserIds.size > 1) return { status: "conflict" };
  const userId = [...matchedUserIds][0];
  // session_claim is deliberately UNVERIFIED evidence derived from a forgeable
  // ambient signal (issue a64d2de). Constrain it to agent principals: a binding
  // that resolves to a human, system, or external user must never mint a
  // session_claim, so a forged or misconfigured claim cannot impersonate the
  // operator. Non-agent matches fail closed to no_match, leaving the write
  // unattributed rather than misattributed.
  const user = getUserById(db, userId);
  if (!user || user.kind !== "agent") return { status: "no_match" };
  return {
    status: "resolved",
    attribution: { user_id: userId, evidence_method: "session_claim" },
  };
}

/** Resolve an allowlisted provider to the agent owning its session env keys. */
export function resolveProviderSessionAttributionResult(
  db: Db,
  provider: string,
): SessionAttributionResolution {
  const matchedUserIds = new Set<string>();
  for (const providerSessionEnv of providerSessionEnvBindingValues(provider)) {
    const result = resolveSessionAttributionResult(db, {
      provider_session_env: providerSessionEnv,
    });
    if (result.status === "conflict") return result;
    if (result.status === "resolved") matchedUserIds.add(result.attribution.user_id);
  }
  if (matchedUserIds.size === 0) return { status: "no_match" };
  if (matchedUserIds.size > 1) return { status: "conflict" };
  return {
    status: "resolved",
    attribution: { user_id: [...matchedUserIds][0], evidence_method: "session_claim" },
  };
}

/**
 * Resolve an auth/inbox session reference using the same fail-closed binding
 * rules as live session writes. The session id itself is a
 * `provider_session_env` signal; when the Mandible session row exists, its app
 * is an additional claim that must resolve to the same user.
 */
export function resolveSessionIdAttribution(
  db: Db,
  sessionId: string,
): AttributionContext | null {
  const result = resolveSessionIdAttributionResult(db, sessionId);
  return result.status === "resolved" ? result.attribution : null;
}

/** Resolve a session id without collapsing conflicting claims into no match. */
export function resolveSessionIdAttributionResult(
  db: Db,
  sessionId: string,
): SessionAttributionResolution {
  const normalized = normalizeBindingValue(sessionId);
  if (!normalized) return { status: "no_match" };
  const row = db
    .prepare("SELECT app FROM sessions WHERE id = ?")
    .get(normalized) as { app: string } | undefined;
  return resolveSessionAttributionResult(db, {
    provider_session_env: normalized,
    app_name: row?.app ?? null,
  });
}

// --- LedgerActorInput adapters (used at write call sites) ---

/**
 * A daemon-internal system actor. Callers must pass this explicitly; the store
 * never substitutes system attribution for an omitted principal.
 */
export function systemActor(authorizerUserId?: string | null): LedgerActorInput {
  const attribution = systemAction();
  if (authorizerUserId) attribution.authorizer_user_id = authorizerUserId;
  return { attribution };
}

/**
 * Binding lookup/storage key normalization. Applied identically wherever a
 * binding value is stored or looked up, so whitespace variants of the same
 * value resolve to one binding.
 */
export function normalizeBindingValue(value: string): string {
  return value.trim();
}

// Re-exported so call sites need only import from the resolver module.
export { SYSTEM_USER_ID };
