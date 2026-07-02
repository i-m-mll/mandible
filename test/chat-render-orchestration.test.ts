import { describe, expect, it } from "vitest";
import {
  buildStreamState,
  computeLiveTail,
  conversationBlocksToStreamEvents,
  deriveStreamingState,
  flushPendingSSE,
} from "../ui/src/chat";
import type { StreamEvent } from "../ui/src/components/stream-renderer/types";

function normalize(events: StreamEvent[]): Array<Record<string, unknown>> {
  return buildStreamState(events).nodes.map((node) => {
    if (node.kind === "user_message") {
      return { kind: node.kind, entity: node.entity, text: node.text };
    }
    if (node.kind === "assistant_turn") {
      return {
        kind: node.kind,
        entity: node.entity,
        content: node.turn.assistantEvent.message.content.map((block) => {
          if (block.type === "tool_use") {
            return { type: block.type, id: block.id, name: block.name };
          }
          return block;
        }),
        toolResults: Array.from(node.turn.toolResults.entries()).map(([id, block]) => ({
          id,
          content: block.content,
          is_error: block.is_error ?? false,
        })),
      };
    }
    return { kind: node.kind, entity: node.entity, analyzing: node.event.analyzing };
  });
}

describe("chat render orchestration", () => {
  it("builds the same render model for finished history and ended live events", () => {
    const historyEvents = conversationBlocksToStreamEvents("provider-1", [
      {
        id: "u1",
        conversation_id: "c1",
        type: "user_message",
        role: "user",
        content: "Fix the test",
        position: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        parent_id: null,
        metadata_json: "{}",
      },
      {
        id: "t1",
        conversation_id: "c1",
        type: "thinking",
        role: "assistant",
        content: "Need to inspect the failure",
        position: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        parent_id: null,
        metadata_json: "{}",
      },
      {
        id: "tu1",
        conversation_id: "c1",
        type: "tool_use",
        role: "assistant",
        content: "{}",
        position: 3,
        timestamp: "2026-01-01T00:00:02.000Z",
        parent_id: null,
        metadata_json: JSON.stringify({ tool_id: "tool-1", tool_name: "Read", tool_input: { file: "a.ts" } }),
      },
      {
        id: "tr1",
        conversation_id: "c1",
        type: "tool_result",
        role: "tool",
        content: "test output",
        position: 4,
        timestamp: "2026-01-01T00:00:03.000Z",
        parent_id: null,
        metadata_json: JSON.stringify({ tool_id: "tool-1" }),
      },
      {
        id: "a1",
        conversation_id: "c1",
        type: "assistant_message",
        role: "assistant",
        content: "Fixed.",
        position: 5,
        timestamp: "2026-01-01T00:00:04.000Z",
        parent_id: null,
        metadata_json: "{}",
      },
    ]);

    const liveEvents: StreamEvent[] = [
      {
        type: "user",
        uuid: "u1",
        session_id: "provider-1",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: "Fix the test" }] },
      },
      {
        type: "assistant",
        uuid: "t1",
        session_id: "provider-1",
        parent_tool_use_id: null,
        message: {
          id: "t1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need to inspect the failure" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file: "a.ts" } },
            { type: "text", text: "Fixed." },
          ],
          stop_reason: "end_turn",
        },
      },
      {
        type: "user",
        uuid: "tr1",
        session_id: "provider-1",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "test output" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "provider-1",
        duration_ms: 0,
        num_turns: 1,
        result: "",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        is_error: false,
      },
    ];

    expect(normalize(historyEvents)).toEqual(normalize(liveEvents));
  });

  it("keeps only the live tail after persisted history, including tool-result handoff", () => {
    const historyEvents: StreamEvent[] = [
      {
        type: "assistant",
        session_id: "s1",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
        },
      },
    ];
    const memEvents: StreamEvent[] = [
      { type: "system", subtype: "init", session_id: "s1" },
      historyEvents[0],
      {
        type: "user",
        session_id: "s1",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
        },
      },
      {
        type: "user",
        session_id: "s1",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: "next" }] },
      },
      {
        type: "assistant",
        session_id: "s1",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "tail" }] },
      },
    ];

    expect(computeLiveTail(historyEvents, memEvents)).toEqual(memEvents.slice(3));
  });

  it("deduplicates buffered SSE and derives stopped streaming state", () => {
    const resultEvent: StreamEvent = {
      type: "result",
      subtype: "success",
      session_id: "s1",
      duration_ms: 0,
      num_turns: 1,
      result: "",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      is_error: false,
    };
    const pending = { current: [resultEvent, resultEvent] };
    let events: StreamEvent[] = [resultEvent];
    let streaming = true;

    flushPendingSSE(
      pending,
      (fn) => {
        events = fn(events);
      },
      (value) => {
        streaming = value;
      },
    );

    expect(events).toEqual([resultEvent]);
    expect(streaming).toBe(false);
    expect(pending.current).toEqual([]);
    expect(deriveStreamingState(resultEvent ? [resultEvent] : [])).toBe(false);
  });
});
