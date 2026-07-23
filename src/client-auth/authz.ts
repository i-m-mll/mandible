// Authorization checks for client-auth management routes (finding 2).
//
// Token mint/list/revoke and mode flips are self-administration surfaces: an
// unauthenticated caller must never mint tokens for arbitrary users, revoke
// others' credentials, or flip the mode. These helpers enforce, independent of
// compat/strict mode (the mode gate governs ordinary mutations; these routes are
// always guarded because they administer authentication itself).
//
// Bootstrappability: the filesystem bootstrap token gives same-user CLI calls
// an authenticated identity and can enroll the dashboard through a fragment
// that is stripped before API traffic. The handshake never authenticates an
// anonymous caller.
//
// This is deliberately narrow — authentication-material administration only, not
// general project authorization, which is the permissions umbrella child.

import { getDb, type Db } from "../db.js";
import {
  resolveProviderSessionAttributionResult,
  type AttributionContext,
} from "../identity/resolver.js";
import { getOperatorId } from "../users/store.js";
import type { AmbientProviderIdentity } from "../ambient-provider-identity.js";
import type {
  ClientAuthGate,
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
      "This endpoint requires an authenticated client token.",
    );
  }
  return identity;
}

export function isOperator(db: Db, identity: ResolvedClientIdentity): boolean {
  const operatorId = getOperatorId(db);
  return operatorId !== null && identity.user_id === operatorId;
}

/**
 * Resolve the durable write principal for a ledger mutation (issue a64d2de).
 * The attribution order is deliberate and fail-closed — it never falls back to
 * the local operator:
 *
 *   (a) A verified bearer credential resolved by the client-auth gate is token
 *       evidence (`api_token`), including bounded dashboard and file-RPC
 *       capabilities.
 *   (b) Otherwise, if the request carries an ambient provider signal (the
 *       `X-Mandible-Ambient-Provider*` headers the CLI and MCP channel send on
 *       mutating calls), resolve that provider to the agent user that owns its
 *       session env keys via the same fail-closed binding machinery the
 *       auth-request lane uses. A single owning agent yields `session_claim`
 *       evidence; a no-match or conflicting binding yields no attribution.
 *   (c) Otherwise return `null` — an unattributed write. The store records NULL
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
  if (identity) {
    return {
      user_id: identity.user_id,
      evidence_method: "api_token",
    };
  }
  const ambient: AmbientProviderIdentity | null = record?.ambient_identity ?? null;
  if (ambient?.provider) {
    const resolution = resolveProviderSessionAttributionResult(db, ambient.provider);
    if (resolution.status === "resolved") {
      return resolution.attribution;
    }
  }
  return null;
}

const WEBSOCKET_AUTH_PROTOCOL_PREFIX = "mandible-auth.";

/** Read a bearer from a WebSocket subprotocol header without putting it in the URL. */
export function credentialFromWebSocketProtocols(
  header: string | string[] | undefined,
): string | null {
  const values = (Array.isArray(header) ? header.join(",") : header ?? "")
    .split(",")
    .map((value) => value.trim());
  const protocol = values.find((value) => value.startsWith(WEBSOCKET_AUTH_PROTOCOL_PREFIX));
  return protocol?.slice(WEBSOCKET_AUTH_PROTOCOL_PREFIX.length) || null;
}

/** Authenticate an operator-terminal upgrade using its header-only credential. */
export function authorizeOperatorWebSocket(
  db: Db,
  gate: ClientAuthGate,
  protocolHeader: string | string[] | undefined,
  pathname: string,
): boolean {
  const identity = gate.authenticate(
    credentialFromWebSocketProtocols(protocolHeader),
    "http_bearer",
    { method: "GET", pathname },
  );
  return identity !== null && isOperator(db, identity);
}

/** Require an operator bearer for any terminal that can activate a client credential. */
export function authorizeManagedSessionWebSocket(
  db: Db,
  gate: ClientAuthGate,
  protocolHeader: string | string[] | undefined,
  pathname: string,
  credentialBearing: boolean,
): boolean {
  return !credentialBearing || authorizeOperatorWebSocket(
    db,
    gate,
    protocolHeader,
    pathname,
  );
}

/** Require an authenticated OPERATOR (401 if anonymous, 403 if non-operator). */
export function requireOperator(db: Db, req: RequestLike): ResolvedClientIdentity {
  const identity = requireIdentity(req);
  if (!isOperator(db, identity)) {
    throw new ClientAuthzError(
      403,
      "operator_required",
      "Only the local operator may perform this action.",
    );
  }
  return identity;
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
  if (identity.user_id === targetUserId) return identity;
  if (isOperator(db, identity)) return identity;
  throw new ClientAuthzError(
    403,
    "forbidden",
    "You may only manage your own tokens; managing another user's tokens requires the operator.",
  );
}
