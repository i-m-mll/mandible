// Authorization checks for client-auth management routes (finding 2).
//
// Token mint/list/revoke surfaces are self-administration surfaces: an
// unauthenticated caller must never mint tokens for arbitrary users, revoke
// others' credentials, or alter authentication state. These routes are always
// guarded because they administer authentication itself.
//
// This is deliberately narrow — authentication-material administration only, not
// general project authorization, which is the permissions umbrella child.

import { getDb, type Db } from "../db.js";
import {
  resolveProviderSessionAttributionResult,
  type AttributionContext,
} from "../identity/resolver.js";
import { getOperatorId, getUserById } from "../users/store.js";
import type { AmbientProviderIdentity } from "../ambient-provider-identity.js";
import type {
  RequestLike,
  ResolvedClientIdentity,
  RouteHandler,
} from "../server.js";

export class ClientAuthzError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClientAuthzError";
  }
}

/** The authenticated identity or a 401. */
export function requireIdentity(req: RequestLike): ResolvedClientIdentity {
  const identity = req.client_identity;
  if (!identity) {
    throw new ClientAuthzError(
      401,
      "authentication_required",
      "This endpoint requires an authenticated client.",
    );
  }
  return identity;
}

export function isOperator(db: Db, identity: ResolvedClientIdentity): boolean {
  const operatorId = getOperatorId(db);
  return operatorId !== null && identity.user_id === operatorId;
}

export function isLocalHumanRequest(req: RequestLike): boolean {
  return req.client_identity?.method === "local_socket"
    && (req as RequestLike & { managed_client?: boolean }).managed_client !== true
    && !(req as RequestLike & { local_managed_identity?: unknown }).local_managed_identity
    && !req.ambient_identity;
}

export function requireDurableIdentity(req: RequestLike): ResolvedClientIdentity {
  const identity = requireIdentity(req);
  if (identity.method !== "api_token" || !identity.credential_id) {
    throw new ClientAuthzError(401, "durable_credential_required",
      "This action requires an authenticated durable client credential.");
  }
  return identity;
}

/**
 * Resolve the write principal for a ledger mutation (issue a64d2de).
 * The attribution order is deliberate and fail-closed — it never falls back to
 * the local operator:
 *
 *   (a) A verified bearer credential resolved by the client-auth gate is token
 *       evidence (`api_token`), including bounded dashboard and file-RPC
 *       capabilities.
 *   (b) A validated managed app/session alias on the local socket identifies
 *       the resolved agent with `session_claim` evidence. It has no protected
 *       credential authority.
 *   (c) Otherwise, if the request carries an ambient provider signal (the
 *       `X-Mandible-Ambient-Provider*` headers the CLI and MCP channel send on
 *       mutating calls), resolve that provider to the agent user that owns its
 *       session env keys via the same fail-closed binding machinery the
 *       auth-request lane uses. A single owning agent yields `session_claim`
 *       evidence; a no-match or conflicting binding yields no attribution.
 *   (d) An unmanaged socket invocation by the configured operator carries
 *       `local_default` evidence. Otherwise return `null` — an unattributed
 *       write. The store records NULL
 *       user-attribution columns, reproducing the pre-identity legacy behavior
 *       (generic 'Mandible' display via the legacy-column read fallback).
 *
 * The previous unconditional operator fallback misattributed every tokenless
 * compat-mode write to the local operator; that fallback is removed here.
 * Unattributed-write telemetry is unchanged and still counted at the server
 * gate.
 */
export function attributionForRequest(db: Db, req: unknown): AttributionContext | null {
  const record = req && typeof req === "object" ? (req as RequestLike) : null;
  const identity = record?.client_identity ?? null;
  const ambient: AmbientProviderIdentity | null = record?.ambient_identity ?? null;
  const managed = (record as RequestLike & { managed_client?: boolean } | null)?.managed_client === true;
  const managedIdentity = (record as RequestLike & {
    local_managed_identity?: { app_name: string; session_id: string } | null;
  } | null)?.local_managed_identity;
  if (identity && identity.method !== "local_socket") {
    return {
      user_id: identity.user_id,
      evidence_method: identity.source === "local_os_user" ? "local_default" : "api_token",
    };
  }
  if (identity?.method === "local_socket" && managedIdentity) {
    // The socket ingress has already validated this app/session pair and
    // resolved it to one agent. Keep its attribution tied to that principal.
    const user = getUserById(db, identity.user_id);
    return user?.status === "active" && user.kind === "agent"
      ? { user_id: user.id, evidence_method: "session_claim" }
      : null;
  }
  if (ambient?.provider && (!identity || identity.method === "local_socket")) {
    // resolveProviderSessionAttributionResult only resolves to an agent-kind
    // owner (enforced in the resolver), so a forged provider header cannot
    // impersonate a human. Native provenance is captured independently by the
    // request-origin context, including when bearer authority wins above.
    const resolution = resolveProviderSessionAttributionResult(db, ambient.provider);
    if (resolution.status === "resolved"
        && (!identity || resolution.attribution.user_id === identity.user_id)) {
      return resolution.attribution;
    }
  }
  if (identity?.method === "local_socket" && !managed && !ambient
      && identity.user_id === getOperatorId(db)) {
    return { user_id: identity.user_id, evidence_method: "local_default" };
  }
  return null;
}

/** One target-aware WebSocket authorization path; browser credentials never ride a subprotocol. */
export function authorizeManagedSessionWebSocket(
  db: Db,
  identity: ResolvedClientIdentity | null,
  ownerUserId: string | null,
  credentialBearing: boolean,
): boolean {
  if (!identity || !identity.effect_ceiling.includes("process:external")) return false;
  if (credentialBearing) return isOperator(db, identity);
  return ownerUserId === identity.user_id || isOperator(db, identity);
}

/** Require an authenticated OPERATOR (401 if anonymous, 403 if non-operator). */
export function requireOperator(db: Db, req: RequestLike): ResolvedClientIdentity {
  const identity = requireIdentity(req);
  if (!isOperator(db, identity) || (identity.method === "local_socket" && !isLocalHumanRequest(req))) {
    throw new ClientAuthzError(
      403,
      "operator_required",
      "Only the local operator may perform this action.",
    );
  }
  return identity;
}

export function requireDurableOperator(db: Db, req: RequestLike): ResolvedClientIdentity {
  const identity = requireDurableIdentity(req);
  if (!isOperator(db, identity)) {
    throw new ClientAuthzError(403, "operator_required", "Only the local operator may perform this action.");
  }
  return identity;
}

export function requireProtectedOperator(db: Db, req: RequestLike): ResolvedClientIdentity {
  return req.client_identity?.method === "local_socket"
    ? requireDurableOperator(db, req)
    : requireOperator(db, req);
}

export function authorizeOperatorSetup(db: Db, req: RequestLike): void {
  if (getOperatorId(db) !== null) {
    requireProtectedOperator(db, req);
    return;
  }
  if ((req as RequestLike & { managed_client?: boolean }).managed_client === true
      || (req as RequestLike & { local_managed_identity?: unknown }).local_managed_identity
      || req.ambient_identity) {
    throw new ClientAuthzError(403, "operator_setup_human_required",
      "Initial operator setup requires a local human invocation.");
  }
}

/**
 * Central HTTP boundary for routes that construct or fork managed agent
 * sessions. Those routes can activate an app-bound credential, so admission is
 * operator-only even while the general mutation gate remains in compat mode.
 */
export function operatorOnlyManagedSessionRoute(handler: RouteHandler): RouteHandler {
  return (req, res) => {
    try {
      requireOperator(getDb(), req);
    } catch (error) {
      if (error instanceof ClientAuthzError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
    return handler(req, res);
  };
}

/**
 * Require the authenticated caller to be the target user themselves, or the
 * operator acting on another user.
 */
export function requireSelfOrOperator(
  db: Db,
  req: RequestLike,
  targetUserId: string,
): ResolvedClientIdentity {
  const identity = requireIdentity(req);
  if (identity.method === "local_socket") return requireDurableOperator(db, req);
  if (identity.user_id === targetUserId) return identity;
  if (isOperator(db, identity)) return identity;
  throw new ClientAuthzError(
    403,
    "forbidden",
    "You may only manage your own tokens; managing another user's tokens requires the operator.",
  );
}
