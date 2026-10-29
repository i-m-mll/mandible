import type { Db } from "./db.js";
import type { AmbientProviderIdentity } from "./ambient-provider-identity.js";
import type { ConversationSource, WorkUnitAssignmentTarget } from "./contracts.js";
import { resolveSessionAlias } from "./session-liveness.js";

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
  const alias = resolveSessionAlias(db, target.session_id, { readCodexTaskLiveness: () => ({ status: "unavailable" }) });
  const provider = assignmentProvider(alias?.provider);
  return provider && alias?.provider_session_id ? { provider, session_id: alias.provider_session_id } : null;
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
