import { exactAgentRef, parseExactAgentRef } from "./ambient-provider-identity.js";
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "./db.js";
import { resolveSessionAlias, sessionAliasIds } from "./session-liveness.js";
import type { RequestLike } from "./server.js";
import { requireIdentity, ClientAuthzError } from "./client-auth/authz.js";
import { resolveProviderSessionAttributionResult } from "./identity/resolver.js";
import { requestOriginJson } from "./request-origin.js";

export interface ResponsibilityActor { user_id: string; session_id: string | null }
export function responsibilityActor(req: RequestLike): ResponsibilityActor {
  const identity = requireIdentity(req);
  const ref = req.ambient_identity ? exactAgentRef(req.ambient_identity) : null;
  const agentPrincipal = (getDb().prepare("SELECT kind FROM users WHERE id = ?").get(identity.user_id) as { kind: string } | undefined)?.kind === "agent";
  const managed = Boolean(agentPrincipal || req.ambient_identity || (req as RequestLike & { managed_client?: boolean }).managed_client
    || (req as RequestLike & { local_managed_identity?: unknown }).local_managed_identity);
  if (managed && !ref) throw new ClientAuthzError(409, "agent_identity_required", "Exact executing agent identity is required for custody.");
  return { user_id: identity.user_id, session_id: ref ?? identity.session_id ?? null };
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
export function holdsResponsibility(db: Db, owner: { owner_user_id: string | null; responsibility_session_id: string | null }, actor: ResponsibilityActor): boolean {
  return owner.owner_user_id === actor.user_id && sameResponsibilitySession(db, owner.responsibility_session_id, actor.session_id);
}
export function recordResponsibilityTransfer(db: Db, input: {
  kind: "work_unit" | "auth_request"; id: string; prior: ResponsibilityActor | null;
  next: ResponsibilityActor | null; generation: number; reason: string;
}): void {
  db.prepare(`INSERT INTO responsibility_events (id, entity_kind, entity_id, prior_user_id, prior_session_id,
    new_user_id, new_session_id, generation, reason, occurred_at, request_origin_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.kind, input.id, input.prior?.user_id ?? null, input.prior?.session_id ?? null,
      input.next?.user_id ?? null, input.next?.session_id ?? null, input.generation, input.reason, Date.now(), requestOriginJson());
}

export function sessionResponsibilityActor(db: Db, sessionId: string): ResponsibilityActor | null {
  const resolution = resolveSessionAlias(db, sessionId);
  if (!resolution) return null;
  const row = (resolution.mandible_session_id ? db.prepare("SELECT owner_user_id FROM sessions WHERE id = ?").get(resolution.mandible_session_id) : null)
    ?? (resolution.console_session_id ? db.prepare("SELECT owner_user_id FROM console_sessions WHERE id = ?").get(resolution.console_session_id) : null);
  const explicit = (row as { owner_user_id?: string | null } | undefined)?.owner_user_id;
  const inferred = resolution.provider ? resolveProviderSessionAttributionResult(db, resolution.provider) : null;
  const userId = explicit ?? (inferred?.status === "resolved" ? inferred.attribution.user_id : null);
  const ref = parseExactAgentRef(sessionId) ? sessionId : resolution.agent_ref;
  return userId && ref ? { user_id: userId, session_id: ref } : null;
}
