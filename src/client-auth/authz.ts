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
  localDefaultAttribution,
  type AttributionContext,
} from "../identity/resolver.js";
import { getOperatorId } from "../users/store.js";
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
 * Resolve the durable write principal attached by the client-auth boundary.
 * Every authenticated credential is token evidence, including bounded
 * dashboard and file-RPC capabilities. Compat callers without a credential
 * retain the existing local-operator attribution path.
 */
export function attributionForRequest(db: Db, req: unknown): AttributionContext {
  const identity = req && typeof req === "object"
    ? (req as { client_identity?: ResolvedClientIdentity | null }).client_identity
    : null;
  if (!identity) return localDefaultAttribution(db);
  return {
    user_id: identity.user_id,
    evidence_method: "api_token",
  };
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
