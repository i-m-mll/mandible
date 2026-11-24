/**
 * Shared JSON-line normalizers for Codex stream output.
 * Bug: 8d3328c — Extracted from PTYBackend for reuse by SpawnBackend.
 *
 * Each normalizer takes a raw JSON line (string) and returns a ConsoleStreamEvent
 * or null if the line is not recognized. They are pure functions (no side effects).
 */
import type { ConsoleStreamEvent } from "../types.js";

/**
 * Mutable state passed through successive calls to normalizeCodexStreamLine
 * for a single Codex session. The caller owns this state object.
 */
export interface CodexNormalizerState {
  threadId: string | null;
  turnCount: number;
  model: string | null;
}

export function normalizeCodexStreamLine(
  line: string,
  state: CodexNormalizerState,
): ConsoleStreamEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "thread.started") {
    state.threadId = typeof parsed.thread_id === "string" ? parsed.thread_id : state.threadId;
    return {
      type: "system",
      subtype: "init",
      session_id: state.threadId ?? "",
      ...(state.model ? { model: state.model } : {}),
    };
  }
  if (type === "item.completed") {
    const item = (parsed.item && typeof parsed.item === "object") ? parsed.item as Record<string, unknown> : null;
    if (!item) return null;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "agent_message") {
      return {
        type: "assistant",
        session_id: state.threadId ?? "",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          ...(state.model ? { model: state.model } : {}),
          content: [{ type: "text", text: typeof item.text === "string" ? item.text : "" }],
        },
      };
    }
    return null;
  }
  if (type === "turn.completed") {
    state.turnCount += 1;
    const usage = (parsed.usage && typeof parsed.usage === "object") ? parsed.usage as Record<string, unknown> : {};
    return {
      type: "result",
      subtype: "success",
      session_id: state.threadId ?? "",
      duration_ms: 0,
      num_turns: state.turnCount,
      total_cost_usd: 0,
      is_error: false,
      usage,
    };
  }
  if (type === "error" || type === "turn.failed") {
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null;
    const message =
      typeof parsed.message === "string" ? parsed.message
        : typeof error?.message === "string" ? error.message
          : "Codex request failed";
    return {
      type: "result",
      subtype: "error_during_execution",
      session_id: state.threadId ?? "",
      duration_ms: 0,
      num_turns: state.turnCount,
      total_cost_usd: 0,
      is_error: true,
      errors: [message],
    };
  }
  return null;
}
