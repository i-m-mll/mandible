import { describe, expect, it } from "vitest";
import {
  buildStreamState,
  computeLiveTail,
  conversationBlocksToStreamEvents,
  deriveStreamingState,
  flushPendingSSE,
  reconcileProviderProjection,
} from "../../ui/src/chat";
import type { StreamEvent } from "../../ui/src/components/stream-renderer/types";

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
          const { source: _source, ...content } = block;
          return content;
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
  it("reconciles provisional provider deltas without duplicate or stale content", () => {
    const history = [{
      type: "assistant",
      uuid: "durable-1",
      session_id: "s1",
      parent_tool_use_id: null,
      message: { id: "durable-1", role: "assistant", content: [{ type: "text", text: "durable" }] },
    }] as StreamEvent[];
    const live = (sequence: number, identity: string, text: string) => ({
      kind: "provisional-content" as const,
      conversation_id: "conversation-1",
      provider_session_id: "s1",
      generation: 1,
      sequence,
      observed_at: sequence,
      identity,
      event: {
        type: "assistant",
        uuid: identity.slice("message:".length),
        session_id: "s1",
        message: { id: identity.slice("message:".length), role: "assistant", content: [{ type: "text", text }] },
      },
    });
    const projection = {
      conversation_id: "conversation-1",
      revision: 4,
      events: [
        live(3, "message:live-1", "latest"),
        live(1, "message:live-1", "stale"),
        live(4, "message:durable-1", "must disappear"),
        {
          ...live(5, "message:client-intent-1", "provisional discrepancy"),
          correlation: {
            intent_id: "client-intent-1",
            delivery_id: "delivery-1",
            turn_id: "turn-1",
            provider_message_id: "durable-1",
          },
        },
      ],
    };

    const reconciled = reconcileProviderProjection(history, projection);
    expect(reconciled).toHaveLength(2);
    expect((reconciled[1] as { message: { content: Array<{ text: string }> } }).message.content[0].text).toBe("latest");
  });

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
        uuid: "assistant-1",
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
        uuid: "assistant-tail-anchor",
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

    expect(computeLiveTail(historyEvents, memEvents)).toEqual(memEvents.slice(2));
  });

  it.each(["codex", "claude", "agy/gemini"])(
    "preserves persisted semantic events, errors, unmatched results, and timestamps for %s",
    (provider) => {
      const events = conversationBlocksToStreamEvents(provider, [
        { id: "s1", type: "system", content: "Project instructions", timestamp: "2026-01-01T00:00:00Z", metadata_json: "{}" },
        { id: "u1", type: "user_message", content: "Run it", timestamp: "2026-01-01T00:00:01Z", metadata_json: "{}" },
        { id: "tu1", type: "tool_use", content: "{}", timestamp: "2026-01-01T00:00:02Z", metadata_json: JSON.stringify({ tool_id: "tool-1", tool_name: "Bash", tool_input: { command: "false" } }) },
        { id: "tr1", type: "tool_result", content: "exit 1", timestamp: "2026-01-01T00:00:03Z", metadata_json: JSON.stringify({ tool_id: "tool-1", is_error: true }) },
        { id: "e1", type: "event", content: "provider stopped", timestamp: "2026-01-01T00:00:04Z", metadata_json: JSON.stringify({ event_type: "stop", level: "error" }) },
        { id: "tr2", type: "tool_result", content: "orphan output", timestamp: "2026-01-01T00:00:05Z", metadata_json: JSON.stringify({ tool_id: "missing", tool_kind: "function_call_output", source_record_ordinal: 41 }) },
      ]);
      const state = buildStreamState(events);
      const system = state.nodes.find((node) => node.kind === "semantic_event" && node.event.semantic_kind === "system");
      const errorEvent = state.nodes.find((node) => node.kind === "semantic_event" && node.event.semantic_kind === "event");
      const turn = state.nodes.find((node) => node.kind === "assistant_turn");
      const unmatched = state.nodes.find((node) => node.kind === "unmatched_tool_result");

      expect(system?.event.source).toMatchObject({ blockId: "s1", timestamp: "2026-01-01T00:00:00Z" });
      expect(errorEvent?.event).toMatchObject({ content: "provider stopped", label: "stop", is_error: true });
      expect(turn?.turn.toolResults.get("tool-1")).toMatchObject({ content: "exit 1", is_error: true });
      expect(unmatched?.result).toMatchObject({
        tool_use_id: "missing",
        content: "orphan output",
        source: { blockId: "tr2", timestamp: "2026-01-01T00:00:05Z" },
      });
    },
  );

  it("excludes exact provider bookkeeping while keeping semantic and unknown events visible", () => {
    const events = conversationBlocksToStreamEvents("codex", [
      { id: "tc1", type: "event", content: "token_count", timestamp: "2026-01-01T00:00:00Z", metadata_json: JSON.stringify({ source_event_type: "token_count", visibility: "default_hidden", context_usage: { source: "mirror_exact", percent: 20 } }) },
      { id: "dev1", type: "system", content: "developer instructions", timestamp: "2026-01-01T00:00:01Z", metadata_json: JSON.stringify({ source_event_type: "developer", visibility: "default_hidden" }) },
      { id: "meta1", type: "system", content: "Claude meta context", timestamp: "2026-01-01T00:00:01Z", metadata_json: JSON.stringify({ source_event_type: "user_meta", visibility: "default_hidden" }) },
      { id: "known1", type: "event", content: "provider stopped", timestamp: "2026-01-01T00:00:02Z", metadata_json: JSON.stringify({ source_event_type: "stop", visibility: "default_visible", level: "error" }) },
      { id: "unknown1", type: "event", content: "new provider event", timestamp: "2026-01-01T00:00:03Z", metadata_json: JSON.stringify({ source_event_type: "future_kind", visibility: "default_hidden" }) },
    ]);
    const semanticEvents = buildStreamState(events).nodes.filter((node) => node.kind === "semantic_event");

    expect(semanticEvents).toHaveLength(2);
    expect(semanticEvents.map((node) => node.kind === "semantic_event" ? node.event.label : null)).toEqual(["stop", "future_kind"]);
    expect(semanticEvents.map((node) => node.kind === "semantic_event" ? node.event.source?.timestamp : null)).toEqual([
      "2026-01-01T00:00:02Z",
      "2026-01-01T00:00:03Z",
    ]);
    expect(semanticEvents[0]).toMatchObject({
      kind: "semantic_event",
      event: { content: "provider stopped", is_error: true },
    });
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
