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
//
// Flag transitions
// ----------------
// `mismatch` records (overwriting any earlier record) and `consistent` clears.
// The interesting case is `indeterminate` — one side no longer resolves — where
// a previously recorded flag is normally preserved, because a side that stops
// resolving is not evidence that the operator fixed the token. That default is
// wrong in exactly one situation: the session was re-registered under a
// different app, so the binding the record names is no longer one of this
// session's resolution inputs.
//
// `resolveSessionIdAttributionResult` derives a session's binding from exactly
// two signals: `provider_session_env` (the session id, immutable — it is the row
// key) and `app_name` (`sessions.app`, replaced on every re-registration). So
// `sessions.app` is the only mutable input, and comparing it against the value
// captured at detection time is a complete test for "the binding side of this
// record can no longer be current":
//
//   * app unchanged, binding stopped resolving (agent binding revoked, user
//     retired, bindings now conflict) → preserve. The misconfiguration this flag
//     exists for is untouched, and silence here would be the real regression.
//   * app changed → clear. The record names a binding this session no longer
//     has; asserting it would be asserting something we cannot check.
//
// The rule cannot erase a live disagreement, because it is only reachable from
// the `indeterminate` branch. If the new app still resolves to a user other than
// the client, `evaluateSessionIdentity` returns `mismatch` and the record is
// rewritten rather than cleared.

import type { Db } from "../db.js";
import type { ResolvedClientIdentity } from "../server.js";
import { getUserById } from "../users/store.js";
import type { UserKind } from "../users/types.js";
import { normalizeBindingValue, resolveSessionIdAttributionResult } from "./resolver.js";

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
  /**
   * `sessions.app` at detection time — the only mutable input to this session's
   * binding resolution, captured so a later re-registration under a different
   * app can retire the record (see the transition notes above). Optional on the
   * wire: a record written without it is treated as unknown, which preserves.
   */
  binding_app?: string | null;
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

// The enforcement clause is deliberately precise. `resolveAuthRequester` refuses
// with `requester_identity_mismatch` only when both sides resolve and disagree;
// if the session binding stops resolving the submission is allowed through and
// attributed to the client. Promising an unconditional refusal would send an
// operator hunting for a block that will not happen.
function mismatchMessage(
  client: SessionIdentityPrincipal,
  binding: SessionIdentityPrincipal,
): string {
  return `This session's client token authenticates as ${describe(client)}, but its session`
    + ` bindings resolve to ${describe(binding)}. Ledger writes are being attributed to`
    + ` ${describe(client)}, and auth-request submission is refused while both identities`
    + ` resolve and disagree. Run \`mandible user whoami\` to inspect the effective client`
    + " identity.";
}

/** The session's current `app`, the mutable half of its binding resolution. */
function readSessionApp(db: Db, sessionId: string): string | null {
  const row = db.prepare("SELECT app FROM sessions WHERE id = ?").get(sessionId) as
    | { app: string | null }
    | undefined;
  return row?.app ?? null;
}

/** Compare two `sessions.app` values the way binding resolution would. */
function sameBindingApp(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = typeof a === "string" ? normalizeBindingValue(a) : null;
  const right = typeof b === "string" ? normalizeBindingValue(b) : null;
  return left === right;
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
      binding_app: readSessionApp(db, sessionId),
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
 * Read recorded mismatches for many sessions at once, keyed by session id.
 * Listing routes project this flag onto every row they return; doing that with
 * the single-row helper is one statement per session. Ids that have no row, or
 * no recorded mismatch, are simply absent from the map.
 */
export function readSessionIdentityMismatchBatch(
  db: Db,
  sessionIds: readonly string[],
): Map<string, SessionIdentityMismatch> {
  const found = new Map<string, SessionIdentityMismatch>();
  const unique = [...new Set(sessionIds.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return found;
  // Chunked so a large listing cannot exceed SQLite's bound-parameter ceiling.
  const CHUNK = 400;
  for (let offset = 0; offset < unique.length; offset += CHUNK) {
    const chunk = unique.slice(offset, offset + CHUNK);
    const rows = db
      .prepare(
        `SELECT id, identity_mismatch_at, identity_mismatch_json
           FROM sessions
          WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as Array<{
        id: string;
        identity_mismatch_at: number | null;
        identity_mismatch_json: string | null;
      }>;
    for (const row of rows) {
      const mismatch = parseSessionIdentityMismatch(
        row.identity_mismatch_at,
        row.identity_mismatch_json,
      );
      if (mismatch) found.set(row.id, mismatch);
    }
  }
  return found;
}

function clearSessionIdentityMismatch(db: Db, sessionId: string): void {
  db.prepare(
    `UPDATE sessions
        SET identity_mismatch_at = NULL, identity_mismatch_json = NULL
      WHERE id = ?`,
  ).run(sessionId);
}

/**
 * Persist the outcome of a check and return the flag state afterwards.
 *
 * A consistent check clears an earlier flag. An indeterminate one normally
 * preserves it, because a side that stopped resolving is not evidence that the
 * operator fixed the token — but it retires a record whose `binding_app` no
 * longer matches the session's current app, since that record describes a
 * binding this session no longer has. See the transition notes at the top of
 * this module for why that cannot discard a live disagreement.
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
    clearSessionIdentityMismatch(db, sessionId);
    return null;
  }
  const stored = readSessionIdentityMismatch(db, sessionId);
  if (!stored) return null;
  // Absent `binding_app` means the record predates this capture and its binding
  // input is unknown, so it is preserved rather than guessed at.
  if (stored.binding_app === undefined) return stored;
  if (sameBindingApp(stored.binding_app, readSessionApp(db, sessionId))) return stored;
  clearSessionIdentityMismatch(db, sessionId);
  return null;
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
