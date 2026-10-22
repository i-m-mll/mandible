/**
 * Provider stream lines normalize to the shared event stream (bug 8d3328c).
 */
import { expect, it } from "vitest";
import {
  normalizeCodexStreamLine,
  normalizeGeminiStreamLine,
  type CodexNormalizerState,
} from "../src/backends/normalizers.js";

const line = (record: unknown) => JSON.stringify(record);

it("normalizes every recognized provider event, carrying Codex thread state across lines", () => {
  const gemini: Array<[unknown, Record<string, unknown>]> = [
    [{ type: "init", session_id: "s1", model: "pro" }, { type: "system", subtype: "init", session_id: "s1", model: "pro" }],
    [{ type: "message", role: "assistant", session_id: "s1", content: "hello", model: "flash" },
      { type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }],
    [{ type: "message", role: "user", session_id: "s1", content: "hi" }, { type: "user", session_id: "s1" }],
    [{ type: "result", status: "success", session_id: "s1", stats: { duration_ms: 1234 } },
      { type: "result", subtype: "success", is_error: false, duration_ms: 1234 }],
    [{ type: "result", status: "failed", session_id: "s1", stats: {} }, { type: "result", is_error: true, errors: ["failed"] }],
  ];
  for (const [input, expected] of gemini) {
    expect(normalizeGeminiStreamLine(line(input)), line(input)).toMatchObject(expected);
  }

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
  for (const input of ["not json", line({ type: "unknown", session_id: "s1" })]) {
    expect(normalizeGeminiStreamLine(input), input).toBeNull();
  }
  for (const input of ["bad", line({ type: "unknown" }), line({ type: "item.completed", item: { type: "tool_call" } })]) {
    expect(normalizeCodexStreamLine(input, fresh()), input).toBeNull();
  }
});
