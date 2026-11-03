import { exactAgentRef, normalizeAmbientProviderIdentity, type AmbientProviderIdentity } from "./ambient-provider-identity.js";

export interface ConversationAgentRow {
  source: string;
  session_id: string;
  agent_id?: string | null;
}

/** Codex agent_id is a display nickname; its session_id is the exact thread. */
export function conversationExecutionIdentity(row: ConversationAgentRow): AmbientProviderIdentity | null {
  const provider = row.source === "claude_code" ? "claude" : row.source;
  return normalizeAmbientProviderIdentity({ provider,
    agent_id: provider === "claude" ? row.agent_id ?? row.session_id : row.session_id,
    session_id: provider === "codex" ? null : row.session_id });
}

export function conversationAgentRef(row: ConversationAgentRow): string | null {
  return exactAgentRef(conversationExecutionIdentity(row));
}
