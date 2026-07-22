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
  SYSTEM_USER_ID,
  createUser,
  getOperator,
  getUserById,
  addBinding,
  getUserBySlug,
} from "../users/store.js";
import type { User, UserKind } from "../users/types.js";
import type { LedgerActorInput, LedgerActorType } from "../ledger/types.js";

/**
 * Locked evidence-method vocabulary (issue 92813cc). `evidence_method` records
 * the CLASS of evidence that established the identity, never a free-form or
 * per-binding detail string. Site-specific detail (e.g. which binding type
 * matched) belongs in a separate context/evidence-details field, not here.
 */
export const EVIDENCE_METHODS = [
  "local_default",
  "session_claim",
  "external_import",
  "credential_signature",
  "hardware_presence",
  "delegated_lease",
  "system_internal",
  "api_token",
] as const;
export type EvidenceMethod = (typeof EVIDENCE_METHODS)[number];

const EVIDENCE_METHOD_SET: ReadonlySet<string> = new Set(EVIDENCE_METHODS);

export function isEvidenceMethod(value: string): value is EvidenceMethod {
  return EVIDENCE_METHOD_SET.has(value);
}

/**
 * Runtime guard applied at the ledger store boundary: reject any attribution
 * carrying an evidence_method outside the locked vocabulary.
 */
export function assertEvidenceMethod(value: string): asserts value is EvidenceMethod {
  if (!isEvidenceMethod(value)) {
    throw new Error(
      `Invalid evidence_method '${value}'. Allowed: ${EVIDENCE_METHODS.join(", ")}.`,
    );
  }
}

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
 * Attribution for a local HTTP/CLI write, resolved to the configured operator.
 * Missing operator configuration fails closed: an HTTP/CLI action is not a
 * daemon-internal system action and must not be silently reclassified as one.
 */
export function localDefaultAttribution(db: Db): AttributionContext {
  const operator = getOperator(db);
  if (!operator) {
    throw new Error("Local operator attribution is unavailable");
  }
  return {
    user_id: operator.id,
    evidence_method: "local_default",
  };
}

/** Ambient signals a session write can present for binding-based resolution. */
export interface SessionAttributionSignals {
  app_name?: string | null;
  provider_session_env?: string | null;
  process_pattern?: string | null;
  git_author_email?: string | null;
  binding_scope?: string | null;
}

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
    if (rows.length > 1) return null;
    if (rows.length === 1) matchedUserIds.add(rows[0].user_id);
  }
  if (matchedUserIds.size !== 1) return null;
  return { user_id: [...matchedUserIds][0], evidence_method: "session_claim" };
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

/** The local operator actor for HTTP/CLI writes. */
export function localDefaultActor(db: Db): LedgerActorInput {
  return { attribution: localDefaultAttribution(db) };
}

// --- Shadow users for external git-bug import authors ---

const SHADOW_BINDING_TYPE = "external_author";

/**
 * Binding lookup/storage key normalization. Applied identically at mint and
 * lookup so that whitespace variants of the same author name resolve to one
 * shadow user. The RAW author string is preserved as the display name.
 */
export function normalizeBindingValue(value: string): string {
  return value.trim();
}

function shadowScope(adapter: string, projectId: string): string {
  return `${adapter}::${projectId}`;
}

function slugifyShadow(adapter: string, authorName: string): string {
  const base = `${adapter}-${authorName}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = base.length > 0 ? base : "author";
  return `ext-${trimmed}`.slice(0, 96);
}

function isUniqueConstraint(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}

export interface ShadowUserRequest {
  adapter: string;
  project_id: string;
  author_name: string;
}

function findShadowUser(db: Db, value: string, scope: string): User | null {
  const row = db
    .prepare(
      `SELECT user_id FROM user_bindings
       WHERE binding_type = ? AND value = ? AND scope = ? AND status = 'active'
       LIMIT 1`,
    )
    .get(SHADOW_BINDING_TYPE, value, scope) as { user_id: string } | undefined;
  if (!row) return null;
  const user = getUserById(db, row.user_id);
  if (!user || user.kind !== "external" || user.status !== "active") {
    throw new Error(`External-author binding '${scope}:${value}' has an ineligible owner`);
  }
  return user;
}

/**
 * Idempotently get-or-create an external-kind shadow user for a git-bug import
 * author. Keyed by adapter + project + normalized author name via an
 * `external_author` binding, so equal names across different adapters are never
 * merged and whitespace variants converge. The raw display name is preserved
 * verbatim. External users never receive credentials, authenticator bindings,
 * or permissions — the `external_author` binding is a lookup key only. Minting
 * is race-idempotent: a unique-constraint loss re-looks-up and returns the
 * winner.
 */
export function mintShadowUser(db: Db, request: ShadowUserRequest): User {
  const scope = shadowScope(request.adapter, request.project_id);
  const value = normalizeBindingValue(request.author_name);

  const existing = findShadowUser(db, value, scope);
  if (existing) return existing;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let slug = slugifyShadow(request.adapter, value);
    if (getUserBySlug(db, slug)) {
      let suffix = 2;
      while (getUserBySlug(db, `${slug}-${suffix}`)) suffix += 1;
      slug = `${slug}-${suffix}`;
    }
    try {
      return db.transaction(() => {
        const user = createUser(db, {
          slug,
          kind: "external",
          display_name: request.author_name,
          metadata: { adapter: request.adapter, project_id: request.project_id, shadow: true },
        });
        addBinding(db, user.id, {
          binding_type: SHADOW_BINDING_TYPE,
          value,
          scope,
        });
        return user;
      })();
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const winner = findShadowUser(db, value, scope);
        if (winner) return winner;
        continue; // slug collision without a binding winner: retry with a new slug.
      }
      throw error;
    }
  }
  const finalWinner = findShadowUser(db, value, scope);
  if (finalWinner) return finalWinner;
  throw new Error(`Failed to mint shadow user for ${request.adapter}:${request.author_name}`);
}

/** Attribution for a new git-bug import authored by an external shadow user. */
export function shadowImportActor(db: Db, request: ShadowUserRequest): LedgerActorInput {
  const user = mintShadowUser(db, request);
  return {
    attribution: { user_id: user.id, evidence_method: "external_import" },
    author_display: request.author_name,
  };
}

// Re-exported so call sites need only import from the resolver module.
export { SYSTEM_USER_ID };
