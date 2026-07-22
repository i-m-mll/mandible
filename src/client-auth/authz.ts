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

import type { Db } from "../db.js";
import { getOperatorId } from "../users/store.js";
import type { RequestLike, ResolvedClientIdentity } from "../server.js";

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
