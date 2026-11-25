/**
 * How each provider's hooks hand Mandible's owed notices to the model: which
 * stdin fields name the session, the event and the agent, and how the text is
 * encoded for each event `mandible hook notices` is registered at. Read on the
 * hook path, so this file imports nothing but types.
 */

import type { RegisteredRoute } from "../notices/wake/types.js";

/**
 * How the owed text is printed. `block`, `block_subagent` and `continue` refuse the end of a turn.
 * `block_subagent` also asks the subagent to repeat its report, because its parent receives only
 * the subagent's last reply and the refusal makes that reply a new one.
 */
export type HookEncoding = "plain" | "additional_context" | "block" | "block_subagent" | "inject_steps" | "continue";

type Payload = Record<string, unknown>;

export interface HookAdapter {
  session_field: string;
  event_field: string;
  /** The stdin field naming a subagent within the session, where the provider has one. */
  agent_field: string | null;
  events: Readonly<Record<string, HookEncoding>>;
  /** Whether this end-of-turn event follows a refusal this hook already made in the same turn. */
  continuing(payload: Payload): boolean;
  /** The wake route the provider hands the hook's process, if it hands one. */
  route(env: NodeJS.ProcessEnv): RegisteredRoute | null;
}

const stopHookActive = (payload: Payload) => payload.stop_hook_active === true;

export const HOOK_ADAPTERS = {
  claude: {
    session_field: "session_id", event_field: "hook_event_name", agent_field: "agent_id",
    events: { UserPromptSubmit: "plain", PostToolUse: "additional_context", Stop: "block", SubagentStop: "block_subagent" },
    continuing: stopHookActive,
    route: (env) => env.CLAUDE_CODE_MESSAGING_SOCKET && env.CLAUDE_CODE_MESSAGING_TOKEN
      ? { provider: "claude", socket: env.CLAUDE_CODE_MESSAGING_SOCKET, token: env.CLAUDE_CODE_MESSAGING_TOKEN } : null,
  },
  codex: {
    session_field: "session_id", event_field: "hook_event_name", agent_field: "agent_id",
    events: { UserPromptSubmit: "plain", PostToolUse: "additional_context", Stop: "block", SubagentStop: "block_subagent" },
    continuing: stopHookActive,
    // A Codex desktop thread's route is its id, derived at wake time.
    route: () => null,
  },
  antigravity: {
    session_field: "conversationId", event_field: "hookEventName", agent_field: null,
    events: { PreInvocation: "inject_steps", Stop: "continue" },
    // The documentation defines continuationActive as executionNum > 0, but the
    // CLI (1.5.14) sends continuationActive false on every Stop of a continued turn.
    continuing: (payload) => payload.continuationActive === true || (typeof payload.executionNum === "number" && payload.executionNum > 0),
    // The CLI hands its address and token to commands the agent runs, not to hooks (agy 1.5.14).
    route: (env) => env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN
      ? { provider: "antigravity", address: env.ANTIGRAVITY_LS_ADDRESS, token: env.ANTIGRAVITY_CSRF_TOKEN } : null,
  },
} as const satisfies Record<string, HookAdapter>;

export type HookProvider = keyof typeof HOOK_ADAPTERS;

export const refusesStop = (encoding: HookEncoding): boolean =>
  encoding === "block" || encoding === "block_subagent" || encoding === "continue";

const REPEAT_REPORT = "Mandible: your parent reads your last reply as your whole report. Act on the above if it calls for action, then end with your complete report again, changed only where the above changes it.";

/** What separates the rows one hook call hands over. */
export const NOTICE_SEPARATOR = "\n\n";

/** The stdout that hands the owed rows' texts to the model at `event`, in order. */
export function encodeHookOutput(encoding: HookEncoding, event: string, texts: readonly string[]): string {
  const text = texts.join(NOTICE_SEPARATOR);
  switch (encoding) {
    case "plain": return `${text}\n`;
    case "additional_context": return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`;
    case "block": return `${JSON.stringify({ decision: "block", reason: text })}\n`;
    case "block_subagent": return `${JSON.stringify({ decision: "block", reason: `${text}\n\n${REPEAT_REPORT}` })}\n`;
    case "inject_steps": return `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] })}\n`;
    case "continue": return `${JSON.stringify({ decision: "continue", reason: text })}\n`;
  }
}
