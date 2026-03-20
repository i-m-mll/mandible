/**
 * Tests for shared normalizers and SpawnBackend.
 * Bug: 8d3328c
 */
import { describe, expect, it } from "vitest";
import {
  normalizeGeminiStreamLine,
  normalizeCodexStreamLine,
  type CodexNormalizerState,
} from "../src/backends/normalizers.js";

describe("normalizeGeminiStreamLine", () => {
  it("returns null for invalid JSON", () => {
    expect(normalizeGeminiStreamLine("not json")).toBeNull();
  });

  it("parses init event", () => {
    const line = JSON.stringify({ type: "init", session_id: "s1", model: "pro" });
    const event = normalizeGeminiStreamLine(line);
    expect(event).toEqual({
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "pro",
    });
  });

  it("parses assistant message", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      session_id: "s1",
      content: "hello",
      model: "flash",
    });
    const event = normalizeGeminiStreamLine(line);
    expect(event).toEqual({
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        model: "flash",
      },
    });
  });

  it("parses user message", () => {
    const line = JSON.stringify({
      type: "message",
      role: "user",
      session_id: "s1",
      content: "hi",
    });
    const event = normalizeGeminiStreamLine(line);
    expect(event?.type).toBe("user");
  });

  it("parses success result", () => {
    const line = JSON.stringify({
      type: "result",
      status: "success",
      session_id: "s1",
      stats: { duration_ms: 1234 },
    });
    const event = normalizeGeminiStreamLine(line);
    expect(event).toEqual({
      type: "result",
      subtype: "success",
      session_id: "s1",
      duration_ms: 1234,
      num_turns: 1,
      total_cost_usd: 0,
      is_error: false,
    });
  });

  it("parses error result", () => {
    const line = JSON.stringify({
      type: "result",
      status: "failed",
      session_id: "s1",
      stats: {},
    });
    const event = normalizeGeminiStreamLine(line);
    expect(event?.type).toBe("result");
    expect(event?.is_error).toBe(true);
    expect(event?.errors).toContain("failed");
  });

  it("returns null for unrecognized type", () => {
    const line = JSON.stringify({ type: "unknown", session_id: "s1" });
    expect(normalizeGeminiStreamLine(line)).toBeNull();
  });
});

describe("normalizeCodexStreamLine", () => {
  function freshState(): CodexNormalizerState {
    return { threadId: null, turnCount: 0, model: null };
  }

  it("returns null for invalid JSON", () => {
    expect(normalizeCodexStreamLine("bad", freshState())).toBeNull();
  });

  it("parses thread.started", () => {
    const state = freshState();
    const line = JSON.stringify({ type: "thread.started", thread_id: "t1" });
    const event = normalizeCodexStreamLine(line, state);
    expect(event).toEqual({
      type: "system",
      subtype: "init",
      session_id: "t1",
    });
    expect(state.threadId).toBe("t1");
  });

  it("parses thread.started with model", () => {
    const state: CodexNormalizerState = { threadId: null, turnCount: 0, model: "gpt-5" };
    const line = JSON.stringify({ type: "thread.started", thread_id: "t2" });
    const event = normalizeCodexStreamLine(line, state);
    expect(event?.model).toBe("gpt-5");
  });

  it("parses item.completed agent_message", () => {
    const state: CodexNormalizerState = { threadId: "t1", turnCount: 0, model: null };
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "done" },
    });
    const event = normalizeCodexStreamLine(line, state);
    expect(event).toEqual({
      type: "assistant",
      session_id: "t1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    });
  });

  it("returns null for item.completed with non-agent_message type", () => {
    const state = freshState();
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "tool_call" },
    });
    expect(normalizeCodexStreamLine(line, state)).toBeNull();
  });

  it("parses turn.completed", () => {
    const state: CodexNormalizerState = { threadId: "t1", turnCount: 0, model: null };
    const line = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100 },
    });
    const event = normalizeCodexStreamLine(line, state);
    expect(event?.type).toBe("result");
    expect(event?.subtype).toBe("success");
    expect(event?.is_error).toBe(false);
    expect(state.turnCount).toBe(1);
  });

  it("parses error event", () => {
    const state = freshState();
    const line = JSON.stringify({
      type: "error",
      message: "rate limited",
    });
    const event = normalizeCodexStreamLine(line, state);
    expect(event?.type).toBe("result");
    expect(event?.is_error).toBe(true);
    expect(event?.errors).toContain("rate limited");
  });

  it("parses turn.failed event", () => {
    const state = freshState();
    const line = JSON.stringify({
      type: "turn.failed",
      error: { message: "timeout" },
    });
    const event = normalizeCodexStreamLine(line, state);
    expect(event?.type).toBe("result");
    expect(event?.is_error).toBe(true);
    expect(event?.errors).toContain("timeout");
  });

  it("returns null for unrecognized type", () => {
    expect(normalizeCodexStreamLine(JSON.stringify({ type: "unknown" }), freshState())).toBeNull();
  });
});
