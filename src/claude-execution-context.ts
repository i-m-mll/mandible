import { exactAgentRef, normalizeAmbientProviderIdentity, type AmbientProviderIdentity } from "./ambient-provider-identity.js";

export const EXECUTION_CONTEXT_ARGUMENT = "__mandible_execution_context";

/** Hook session_id scopes both main-agent and native-child identities. */
export function claudeHookExecutionContext(event: Record<string, unknown>): AmbientProviderIdentity | null {
  return normalizeAmbientProviderIdentity({ provider: "claude", session_id: event.session_id, agent_id: event.agent_id ?? event.session_id });
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

export function claudePreToolUseProjection(event: Record<string, unknown>): Record<string, unknown> {
  const context = claudeHookExecutionContext(event);
  const input = event.tool_input;
  if (!context || !input || typeof input !== "object" || Array.isArray(input)) return {};
  const original = input as Record<string, unknown>;
  let updatedInput: Record<string, unknown>;
  if (event.tool_name === "Bash" && typeof original.command === "string") {
    const command = `unset MANDIBLE_REQUEST_ORIGIN CODEX_THREAD_ID CODEX_SESSION_ID GEMINI_SESSION_ID CLAUDE_SESSION_ID;\nexport CLAUDE_CODE_SESSION_ID=${shellQuote(context.session_id!)} CLAUDE_AGENT_ID=${shellQuote(context.agent_id!)} MANDIBLE_EXECUTION_CONTEXT=${shellQuote(JSON.stringify(context))} MANDIBLE_AGENT_REF=${shellQuote(exactAgentRef(context)!)};\n${original.command}`;
    updatedInput = { ...original, command };
  } else if (typeof event.tool_name === "string" && event.tool_name.startsWith("mcp__mandible__")) {
    updatedInput = { ...original, [EXECUTION_CONTEXT_ARGUMENT]: context };
  } else return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } };
}
