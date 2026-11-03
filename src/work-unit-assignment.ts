import type { Db } from "./db.js";
import { exactAgentRef, parseExactAgentRef, type AmbientProviderIdentity } from "./ambient-provider-identity.js";
import type { ConversationSource, WorkUnitAssignmentTarget } from "./contracts.js";
import { readSessionAliasSources } from "./session-liveness.js";

export function assignmentProvider(provider: unknown): ConversationSource | null {
  if (provider === "claude" || provider === "claude_code") return "claude_code";
  return provider === "codex" || provider === "gemini" ? provider : null;
}

export function assignmentTargetId(target: WorkUnitAssignmentTarget | null): string | null {
  return target?.kind === "native" ? target.agent_ref : target?.session_id ?? null;
}

export function parseAssignmentTarget(value: unknown): WorkUnitAssignmentTarget | null {
  if (value == null) return null;
  const target = typeof value === "string" ? JSON.parse(value) : value;
  if (!target || typeof target !== "object") throw new Error("Invalid work-unit assignment target");
  if (target.kind === "native" && typeof target.agent_ref === "string" && parseExactAgentRef(target.agent_ref))
    return { kind: "native", agent_ref: target.agent_ref };
  if (typeof target.session_id === "string" && target.session_id.trim()) {
    if (target.kind === "alias") return { kind: "alias", session_id: target.session_id };
    if (target.kind === "native" && assignmentProvider(target.provider)) {
      const provider = target.provider === "claude_code" ? "claude" : target.provider;
      const ref = provider === "claude" ? null : exactAgentRef({ provider, agent_id: target.session_id, session_id: null });
      return ref ? { kind: "native", agent_ref: ref } : null;
    }
  }
  throw new Error("Invalid work-unit assignment target");
}

export interface ResolvedAssignment { provider: ConversationSource; session_id: string; agent_ref: string; execution_identity: AmbientProviderIdentity }
export function resolveAssignmentTarget(db: Db, target: WorkUnitAssignmentTarget | null): ResolvedAssignment | null {
  if (!target) return null;
  const identities = new Map<string, ResolvedAssignment>();
  const addIdentity = (identity: AmbientProviderIdentity) => {
    const ref = exactAgentRef(identity);
    const provider = assignmentProvider(identity.provider);
    if (ref && provider && identity.agent_id) identities.set(ref, { provider, session_id: identity.agent_id, agent_ref: ref, execution_identity: identity });
  };
  if (target.kind === "native") {
    const identity = parseExactAgentRef(target.agent_ref);
    if (identity) addIdentity(identity);
  } else {
    const exact = parseExactAgentRef(target.session_id);
    if (exact) addIdentity(exact);
    else {
      const sources = readSessionAliasSources(db, [target.session_id]);
      const sessions = [sources.sessionsById.get(target.session_id), ...(sources.sessionsByConversation.get(target.session_id) ?? [])];
      for (const row of sources.consoleByAlias.get(target.session_id) ?? []) {
        if (row.command && row.provider_session_id) addIdentity({ provider: row.command, agent_id: row.provider_session_id, session_id: row.command === "claude" ? row.provider_session_id : null });
        if (row.mandible_session_id) sessions.push(sources.sessionsById.get(row.mandible_session_id));
      }
      for (const row of sessions) if (row?.app && row.conversation_id) addIdentity({ provider: row.app, agent_id: row.conversation_id, session_id: row.app === "claude" ? row.conversation_id : null });
      if (sources.ingestions instanceof Error) return null;
      const ingestion = sources.ingestions?.get(target.session_id);
      if (ingestion?.status === "ambiguous" || ingestion?.status === "unsupported") return null;
      if (ingestion?.status === "ingested" && ingestion.agent_ref) {
        const identity = parseExactAgentRef(ingestion.agent_ref);
        if (identity) addIdentity(identity);
      }
    }
  }
  return identities.size === 1 ? identities.values().next().value! : null;
}

/** Explicit aliases never manufacture the caller's identity. */
export function assignmentTargetForSession(db: Db, explicitAlias: string | null, ambient?: AmbientProviderIdentity | null): WorkUnitAssignmentTarget | null {
  const ref = ambient ? exactAgentRef(ambient) : null;
  if (!explicitAlias) return ref ? { kind: "native", agent_ref: ref } : null;
  if (parseExactAgentRef(explicitAlias)) return { kind: "native", agent_ref: explicitAlias };
  if (ref && explicitAlias === ambient?.agent_id) return { kind: "native", agent_ref: ref };
  const target: WorkUnitAssignmentTarget = { kind: "alias", session_id: explicitAlias };
  const native = resolveAssignmentTarget(db, target);
  return native ? { kind: "native", agent_ref: native.agent_ref } : target;
}

export function serializeAssignmentTarget(target: WorkUnitAssignmentTarget | null): string | null {
  return target ? JSON.stringify(target) : null;
}
