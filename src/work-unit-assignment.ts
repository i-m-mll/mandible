import type { Db } from "./db.js";
import type { AmbientProviderIdentity } from "./ambient-provider-identity.js";
import type { ConversationSource, WorkUnitAssignmentTarget } from "./contracts.js";
import { readSessionAliasSources } from "./session-liveness.js";

export function assignmentProvider(provider: unknown): ConversationSource | null {
  if (provider === "claude" || provider === "claude_code") return "claude_code";
  return provider === "codex" || provider === "gemini" ? provider : null;
}

export function parseAssignmentTarget(value: unknown): WorkUnitAssignmentTarget | null {
  if (value == null) return null;
  const target = typeof value === "string" ? JSON.parse(value) : value;
  if (!target || typeof target !== "object" || typeof target.session_id !== "string" || !target.session_id.trim())
    throw new Error("Invalid work-unit assignment target");
  if (target.kind === "alias") return { kind: "alias", session_id: target.session_id };
  if (target.kind === "native" && assignmentProvider(target.provider) === target.provider)
    return { kind: "native", provider: target.provider, session_id: target.session_id };
  throw new Error("Invalid work-unit assignment target");
}

export function resolveAssignmentTarget(db: Db, target: WorkUnitAssignmentTarget | null): { provider: ConversationSource; session_id: string } | null {
  if (!target) return null;
  if (target.kind === "native") return { provider: target.provider, session_id: target.session_id };
  const sources = readSessionAliasSources(db, [target.session_id]);
  const identities = new Map<string, { provider: ConversationSource; session_id: string }>();
  const add = (source: unknown, sessionId: string | null | undefined) => {
    const provider = assignmentProvider(source);
    if (provider && sessionId?.trim()) {
      const identity = { provider, session_id: sessionId.trim() };
      identities.set(JSON.stringify(identity), identity);
    }
  };
  const sessions = [sources.sessionsById.get(target.session_id), ...(sources.sessionsByConversation.get(target.session_id) ?? [])];
  for (const row of sources.consoleByAlias.get(target.session_id) ?? []) {
    add(row.command, row.provider_session_id);
    if (row.mandible_session_id) sessions.push(sources.sessionsById.get(row.mandible_session_id));
  }
  for (const row of sessions) if (row) add(row.app, row.conversation_id);
  if (sources.ingestions instanceof Error) return null;
  const ingestion = sources.ingestions?.get(target.session_id);
  if (ingestion?.status === "ambiguous" || ingestion?.status === "unsupported") return null;
  if (ingestion?.status === "ingested") add(ingestion.provider, ingestion.provider_session_id);
  return identities.size === 1 ? identities.values().next().value! : null;
}

/** Called only by ownership boundaries, never by ordinary mutation reconciliation. */
export function assignmentTargetForSession(db: Db, explicitAlias: string | null, ambient?: AmbientProviderIdentity | null): WorkUnitAssignmentTarget | null {
  if (explicitAlias) {
    if (ambient && explicitAlias === ambient.provider_session_id) {
      const provider = assignmentProvider(ambient.provider);
      if (provider) return { kind: "native", provider, session_id: explicitAlias };
    }
    const target: WorkUnitAssignmentTarget = { kind: "alias", session_id: explicitAlias };
    const native = resolveAssignmentTarget(db, target);
    return native ? { kind: "native", ...native } : target;
  }
  const provider = assignmentProvider(ambient?.provider);
  return provider && ambient ? { kind: "native", provider, session_id: ambient.provider_session_id } : null;
}

export function serializeAssignmentTarget(target: WorkUnitAssignmentTarget | null): string | null {
  return target ? JSON.stringify(target) : null;
}
