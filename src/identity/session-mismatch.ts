// Issue 499c148 — surface client-token / session-binding user disagreements at
// session registration instead of only at the auth-request gate.
//
// An agent session carries two independent identities: the user its bearer
// token authenticates as (`req.client_identity`, resolved by the client-auth
// gate) and the user its session bindings resolve to (`app_name` /
// `provider_session_env`, resolved by the fail-closed attribution resolver).
// `POST /api/auth/request` already refuses a submission when the two disagree
// (`resolveAuthRequester`, `requester_identity_mismatch`), but nothing before
// that gate looked, so a session launched with the wrong token could run for
// hours writing ledger rows under the wrong user and only discover it at
// end-of-day auth submission.
//
// This module compares the two identities wherever a session row is registered
// or linked by an authenticated client and records the disagreement on the
// session row. It is a surfacing lane only: no caller consults the flag for
// authorization, and the requester gate's semantics are unchanged.

import type { Db } from "../db.js";
import type { ResolvedClientIdentity } from "../server.js";
import { getUserById } from "../users/store.js";
import type { UserKind } from "../users/types.js";
import { resolveSessionIdAttributionResult } from "./resolver.js";

/** One side of the comparison, resolved to a registry user where possible. */
export interface SessionIdentityPrincipal {
  user_id: string;
  slug: string | null;
  kind: UserKind | null;
  display_name: string | null;
}

/** Structured detail persisted on `sessions.identity_mismatch_json`. */
export interface SessionIdentityMismatch {
  detected_at: number;
  /** How the client bearer was resolved: a durable api_token or a daemon-minted ephemeral. */
  client_method: ResolvedClientIdentity["method"];
  client: SessionIdentityPrincipal;
  binding: SessionIdentityPrincipal;
  message: string;
}

export type SessionIdentityCheck =
  | { status: "mismatch"; mismatch: SessionIdentityMismatch }
  | { status: "consistent" }
  | {
      status: "indeterminate";
      /** Only one side resolved (or the bindings conflict): not a mismatch. */
      reason: "no_client_identity" | "no_session_binding" | "session_binding_conflict";
    };

/** Warning payload returned to the connecting agent in registration responses. */
export interface SessionIdentityWarning extends SessionIdentityMismatch {
  code: "client_session_identity_mismatch";
}

function principal(db: Db, userId: string): SessionIdentityPrincipal {
  const user = getUserById(db, userId);
  return {
    user_id: userId,
    slug: user?.slug ?? null,
    kind: user?.kind ?? null,
    display_name: user?.display_name ?? null,
  };
}

function describe(who: SessionIdentityPrincipal): string {
  return who.slug ? `${who.slug} (${who.kind ?? "unknown kind"})` : who.user_id;
}

function mismatchMessage(
  client: SessionIdentityPrincipal,
  binding: SessionIdentityPrincipal,
): string {
  return `This session's client token authenticates as ${describe(client)}, but its session`
    + ` bindings resolve to ${describe(binding)}. Ledger writes are being attributed to`
    + ` ${describe(client)} and auth-request submission will be refused until the two agree.`
    + " Run `mandible user whoami` to inspect the effective client identity.";
}

/**
 * Compare the authenticated client user against the session's binding
 * resolution. Both sides must resolve for a comparison to be meaningful: an
 * unauthenticated request or an unbound session is a different (already
 * tracked) failure mode, not a mismatch, and must never clear or set the flag.
 */
export function evaluateSessionIdentity(
  db: Db,
  sessionId: string,
  identity: ResolvedClientIdentity | null | undefined,
  now: number = Date.now(),
): SessionIdentityCheck {
  if (!identity) return { status: "indeterminate", reason: "no_client_identity" };
  const resolution = resolveSessionIdAttributionResult(db, sessionId);
  if (resolution.status === "conflict") {
    return { status: "indeterminate", reason: "session_binding_conflict" };
  }
  if (resolution.status === "no_match") {
    return { status: "indeterminate", reason: "no_session_binding" };
  }
  const bindingUserId = resolution.attribution.user_id;
  if (bindingUserId === identity.user_id) return { status: "consistent" };
  const client = principal(db, identity.user_id);
  const binding = principal(db, bindingUserId);
  return {
    status: "mismatch",
    mismatch: {
      detected_at: now,
      client_method: identity.method,
      client,
      binding,
      message: mismatchMessage(client, binding),
    },
  };
}

/** Parse the stored flag columns back into structured detail. */
export function parseSessionIdentityMismatch(
  mismatchAt: number | null | undefined,
  mismatchJson: string | null | undefined,
): SessionIdentityMismatch | null {
  if (!mismatchAt || !mismatchJson) return null;
  try {
    const parsed = JSON.parse(mismatchJson) as SessionIdentityMismatch;
    return { ...parsed, detected_at: mismatchAt };
  } catch {
    return null;
  }
}

/** Read the currently recorded mismatch for a session, if any. */
export function readSessionIdentityMismatch(
  db: Db,
  sessionId: string,
): SessionIdentityMismatch | null {
  const row = db
    .prepare("SELECT identity_mismatch_at, identity_mismatch_json FROM sessions WHERE id = ?")
    .get(sessionId) as
    | { identity_mismatch_at: number | null; identity_mismatch_json: string | null }
    | undefined;
  if (!row) return null;
  return parseSessionIdentityMismatch(row.identity_mismatch_at, row.identity_mismatch_json);
}

/**
 * Persist the outcome of a check and return the flag state afterwards. A
 * consistent registration clears an earlier flag; an indeterminate one leaves
 * whatever was already recorded alone, because a missing side is not evidence
 * that the earlier disagreement was resolved.
 */
export function recordSessionIdentityCheck(
  db: Db,
  sessionId: string,
  check: SessionIdentityCheck,
): SessionIdentityMismatch | null {
  if (check.status === "mismatch") {
    db.prepare(
      `UPDATE sessions
          SET identity_mismatch_at = ?, identity_mismatch_json = ?
        WHERE id = ?`,
    ).run(check.mismatch.detected_at, JSON.stringify(check.mismatch), sessionId);
    return check.mismatch;
  }
  if (check.status === "consistent") {
    db.prepare(
      `UPDATE sessions
          SET identity_mismatch_at = NULL, identity_mismatch_json = NULL
        WHERE id = ?`,
    ).run(sessionId);
    return null;
  }
  return readSessionIdentityMismatch(db, sessionId);
}

/**
 * Evaluate, persist, and render the registration-time warning for a session
 * touched by an authenticated client. Returns null when the two identities
 * agree or the comparison is not possible. Failures here never break
 * registration: surfacing a warning must not be able to reject a session.
 */
export function checkSessionIdentity(
  db: Db,
  sessionId: string,
  identity: ResolvedClientIdentity | null | undefined,
): SessionIdentityWarning | null {
  let mismatch: SessionIdentityMismatch | null = null;
  try {
    mismatch = recordSessionIdentityCheck(
      db,
      sessionId,
      evaluateSessionIdentity(db, sessionId, identity),
    );
  } catch {
    return null;
  }
  return mismatch ? { code: "client_session_identity_mismatch", ...mismatch } : null;
}
