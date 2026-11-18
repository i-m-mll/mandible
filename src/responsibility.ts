import { exactAgentRef, parseExactAgentRef } from "./ambient-provider-identity.js";
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "./db.js";
import { resolveSessionAlias, sessionAliasIds } from "./session-liveness.js";
import type { RequestLike } from "./server.js";
import { requireIdentity, ClientAuthzError, hasAgentMarker, isUserRequest } from "./client-auth/authz.js";
import { resolveProviderSessionAttributionResult } from "./identity/resolver.js";
import { requestOriginJson } from "./request-origin.js";

/** Who holds an item: an agent session, or the user (no session). */
export interface ResponsibilityHolder { user_id: string; session_id: string | null }

/**
 * The caller of a custody-governed action. Custody coordinates agents, so an
 * agent acts through its exact session; the user is never a custodian by
 * acting and is never refused for custody.
 */
export type ResponsibilityActor =
  | { kind: "agent"; user_id: string; session_id: string }
  | { kind: "user"; user_id: string };

export function responsibilityActor(req: RequestLike): ResponsibilityActor {
  const identity = requireIdentity(req);
  const db = getDb();
  if (isUserRequest(db, req)) return { kind: "user", user_id: identity.user_id };
  const agentPrincipal = (db.prepare("SELECT kind FROM users WHERE id = ?").get(identity.user_id) as { kind: string } | undefined)?.kind === "agent";
  const session = req.ambient_identity ? exactAgentRef(req.ambient_identity)
    : hasAgentMarker(req) || agentPrincipal ? null : identity.session_id ?? null;
  if (!session) throw new ClientAuthzError(409, "agent_identity_required", "Exact executing agent identity is required for custody.");
  return { kind: "agent", user_id: identity.user_id, session_id: session };
}

/** The holder an actor becomes when it takes custody. */
export function actorHolder(actor: ResponsibilityActor): ResponsibilityHolder {
  return { user_id: actor.user_id, session_id: actor.kind === "agent" ? actor.session_id : null };
}

export interface CustodyOwner { owner_user_id: string | null; responsibility_session_id: string | null }

/**
 * `allowed` with the holder the user passed over, or `refused` with the holder
 * an agent is not. Unheld items refuse agents; callers that let an agent claim
 * an unheld item decide that before asking.
 */
export type CustodyDecision =
  | { allowed: true; passed_over: ResponsibilityHolder | null }
  | { allowed: false; holder: ResponsibilityHolder | null };

export function custodyGate(db: Db, owner: CustodyOwner, actor: ResponsibilityActor): CustodyDecision {
  const holder = owner.owner_user_id ? { user_id: owner.owner_user_id, session_id: owner.responsibility_session_id } : null;
  if (actor.kind === "user") {
    const own = holder !== null && holder.user_id === actor.user_id && holder.session_id === null;
    return { allowed: true, passed_over: own ? null : holder };
  }
  return holder && holdsResponsibility(db, owner, actorHolder(actor))
    ? { allowed: true, passed_over: null }
    : { allowed: false, holder };
}

export function sameResponsibilitySession(db: Db, left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return left === right;
  if (left === right) return true;
  const leftExact = parseExactAgentRef(left);
  const rightExact = parseExactAgentRef(right);
  if (leftExact || rightExact) {
    // Historical Codex thread ids already identify one exact agent.
    const exact = leftExact ?? rightExact!;
    const bare = leftExact ? right : left;
    if (exact.provider !== "codex") return false;
    if (exact.agent_id === bare) return true;
    const alias = resolveSessionAlias(db, bare);
    return alias?.provider === "codex" && alias.provider_session_id === exact.agent_id;
  }
  const resolution = resolveSessionAlias(db, left);
  return Boolean(resolution && sessionAliasIds(resolution).includes(right));
}
/** Whether `holder` is the item's holder. Authorization goes through {@link custodyGate}. */
export function holdsResponsibility(db: Db, owner: CustodyOwner, holder: ResponsibilityHolder): boolean {
  return owner.owner_user_id === holder.user_id && sameResponsibilitySession(db, owner.responsibility_session_id, holder.session_id);
}
export function recordResponsibilityTransfer(db: Db, input: {
  kind: "work_unit" | "auth_request"; id: string; prior: ResponsibilityHolder | null;
  next: ResponsibilityHolder | null; generation: number; reason: string;
}): void {
  db.prepare(`INSERT INTO responsibility_events (id, entity_kind, entity_id, prior_user_id, prior_session_id,
    new_user_id, new_session_id, generation, reason, occurred_at, request_origin_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.kind, input.id, input.prior?.user_id ?? null, input.prior?.session_id ?? null,
      input.next?.user_id ?? null, input.next?.session_id ?? null, input.generation, input.reason, Date.now(), requestOriginJson());
}

export function sessionResponsibilityActor(db: Db, sessionId: string): Extract<ResponsibilityActor, { kind: "agent" }> | null {
  const resolution = resolveSessionAlias(db, sessionId);
  if (!resolution) return null;
  const row = (resolution.mandible_session_id ? db.prepare("SELECT owner_user_id FROM sessions WHERE id = ?").get(resolution.mandible_session_id) : null)
    ?? (resolution.console_session_id ? db.prepare("SELECT owner_user_id FROM console_sessions WHERE id = ?").get(resolution.console_session_id) : null);
  const explicit = (row as { owner_user_id?: string | null } | undefined)?.owner_user_id;
  const inferred = resolution.provider ? resolveProviderSessionAttributionResult(db, resolution.provider) : null;
  const userId = explicit ?? (inferred?.status === "resolved" ? inferred.attribution.user_id : null);
  const ref = parseExactAgentRef(sessionId) ? sessionId : resolution.agent_ref;
  return userId && ref ? { kind: "agent", user_id: userId, session_id: ref } : null;
}
