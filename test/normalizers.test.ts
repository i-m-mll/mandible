/**
 * Provider stream lines normalize to the shared event stream (bug 8d3328c).
 */
import { expect, it } from "vitest";
import {
  normalizeCodexStreamLine,
  type CodexNormalizerState,
} from "../src/backends/normalizers.js";

const line = (record: unknown) => JSON.stringify(record);

it("normalizes every recognized Codex event, carrying thread state across lines", () => {
  const state: CodexNormalizerState = { threadId: null, turnCount: 0, model: "gpt-5" };
  const codex: Array<[unknown, Record<string, unknown>]> = [
    [{ type: "thread.started", thread_id: "t1" }, { type: "system", subtype: "init", session_id: "t1", model: "gpt-5" }],
    [{ type: "item.completed", item: { type: "agent_message", text: "done" } },
      { type: "assistant", session_id: "t1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }],
    [{ type: "turn.completed", usage: { input_tokens: 100 } }, { type: "result", subtype: "success", is_error: false }],
    [{ type: "error", message: "rate limited" }, { type: "result", is_error: true, errors: ["rate limited"] }],
    [{ type: "turn.failed", error: { message: "timeout" } }, { type: "result", is_error: true, errors: ["timeout"] }],
  ];
  for (const [input, expected] of codex) {
    expect(normalizeCodexStreamLine(line(input), state), line(input)).toMatchObject(expected);
  }
  expect(state).toMatchObject({ threadId: "t1", turnCount: 1 });
});

it("drops invalid and unrecognized lines instead of inventing events", () => {
  const fresh = (): CodexNormalizerState => ({ threadId: null, turnCount: 0, model: null });
  for (const input of ["bad", line({ type: "unknown" }), line({ type: "item.completed", item: { type: "tool_call" } })]) {
    expect(normalizeCodexStreamLine(input, fresh()), input).toBeNull();
  }
});
