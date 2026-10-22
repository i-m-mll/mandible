import { describe, expect, it } from "vitest";
import {
  buildStreamState,
  computeLiveTail,
  conversationBlocksToStreamEvents,
  deriveStreamingState,
  flushPendingSSE,
  reconcileProviderProjection,
} from "../ui/src/chat";
import { chatItemIdentityKey } from "../src/conversation-control/provider-live";
import type { ChatItem, ConversationSource } from "../src/parsers/types";
import type { StreamEvent } from "../ui/src/components/stream-renderer/types";

function item(
  provider: ConversationSource,
  sessionId: string,
  nativeId: string,
  value: Omit<ChatItem, "identity" | "provenance" | "content_completion">,
  source: "verified-provider-transcript" | "live-provider-event" = "verified-provider-transcript",
): ChatItem {
  return {
    ...value,
    identity: {
      provider,
      session_id: sessionId,
      native_item_id: nativeId,
      native_turn_id: "turn-1",
      source_record_ordinal: 0,
      source_sub_block_ordinal: 0,
    },
    provenance: { source, provider, source_event_type: "test" },
    content_completion: source === "live-provider-event" ? "streaming" : "complete",
  } as ChatItem;
}

function event(value: ChatItem, blockId?: string): StreamEvent {
  return { type: "chat:item", item: value, ...(blockId ? { source: { blockId } } : {}) };
}

function block(id: string, value: ChatItem, timestamp?: string) {
  return {
    id,
    type: "event" as const,
    content: "provider-shaped content must not be used",
    timestamp,
    metadata_json: JSON.stringify({ chat_item: value }),
  };
}

describe("chat render orchestration", () => {
  it("reconciles provisional items only by exact canonical identity", () => {
    const durable = item("codex", "s1", "durable-1", {
      type: "message", role: "assistant", parts: [{ type: "text", text: "durable" }],
    });
    const history = [event(durable, "durable-block")];
    const live = (sequence: number, nativeId: string, text: string) => {
      const liveItem = item("codex", "s1", nativeId, {
        type: "message", role: "assistant", parts: [{ type: "text", text }],
      }, "live-provider-event");
      return {
        kind: "provisional-content" as const,
        conversation_id: "conversation-1",
        provider_session_id: "s1",
        generation: 1,
        sequence,
        observed_at: sequence,
        identity: chatItemIdentityKey(liveItem)!,
        item: liveItem,
      };
    };
    const projection = {
      conversation_id: "conversation-1",
      revision: 4,
      generation: 1,
      events: [
        live(3, "live-1", "latest"),
        live(1, "live-1", "stale"),
        live(4, "durable-1", "must disappear"),
        { ...live(5, "invalid", "must fail closed"), identity: "invented" },
      ],
    };

    const reconciled = reconcileProviderProjection(history, projection);
    expect(reconciled).toHaveLength(2);
    expect((reconciled[1] as { item: ChatItem }).item.parts[0]?.text).toBe("latest");
  });

  it("builds the same render model from durable and live canonical items", () => {
    const values: ChatItem[] = [
      item("claude_code", "s1", "u1", { type: "message", role: "user", parts: [{ type: "text", text: "Fix the test" }] }),
      item("claude_code", "s1", "thought-1", { type: "activity", role: "assistant", activity_kind: "thinking", parts: [{ type: "text", text: "Inspecting" }] }),
      item("claude_code", "s1", "tool-1-call", { type: "tool-call", role: "assistant", phase: "call", tool_id: "tool-1", tool_name: "Read", input: { file: "a.ts" }, parts: [] }),
      item("claude_code", "s1", "tool-1-result", { type: "tool-call", role: "tool", phase: "result", tool_id: "tool-1", output: "test output", parts: [] }),
      item("claude_code", "s1", "a1", { type: "message", role: "assistant", parts: [{ type: "text", text: "Fixed." }] }),
    ];
    const historyEvents = conversationBlocksToStreamEvents("s1", values.map((value, index) => block(`b${index}`, value)));
    const liveEvents = values.map((value) => event({
      ...value,
      provenance: { ...value.provenance, source: "live-provider-event" },
    }));

    const project = (events: StreamEvent[]) => buildStreamState(events).nodes.map((node) => {
      if (node.kind === "user_message") return { kind: node.kind, text: node.text };
      if (node.kind === "activity") return { kind: node.kind, text: node.item.parts.map((part) => part.text).join("") };
      if (node.kind === "assistant_turn") return {
        kind: node.kind,
        content: node.turn.assistantEvent.message.content.map((part) => part.type),
        results: [...node.turn.toolResults.keys()],
      };
      return { kind: node.kind };
    });
    expect(project(historyEvents)).toEqual(project(liveEvents));
    expect(project(historyEvents)).toEqual([
      { kind: "user_message", text: "Fix the test" },
      { kind: "activity", text: "Inspecting" },
      { kind: "assistant_turn", content: ["tool_use", "text"], results: ["tool-1"] },
    ]);
  });

  it("uses exact retained parent evidence without hiding genuine orphan results", () => {
    const call = item("codex", "s1", "split-call", {
      type: "tool-call", role: "assistant", phase: "call", tool_id: "split", tool_name: "exec", input: "opaque", parts: [],
    });
    const result = item("codex", "s1", "split-result", {
      type: "tool-call", role: "tool", phase: "result", tool_id: "split", output: "done", parts: [],
    });
    const activity = item("codex", "s1", "between", {
      type: "activity", role: "assistant", activity_kind: "reasoning-summary", parts: [{ type: "text", text: "Checking" }],
    });

    const separated = conversationBlocksToStreamEvents("s1", [
      { ...block("call-block", call), parent_id: null },
      { ...block("activity-block", activity), parent_id: null },
      { ...block("result-block", result), parent_id: "call-block" },
    ]);
    const separatedNodes = buildStreamState(separated).nodes;
    expect(separatedNodes.map((node) => node.kind)).toEqual(["assistant_turn", "activity"]);
    expect(separatedNodes[0]).toMatchObject({ kind: "assistant_turn" });
    if (separatedNodes[0].kind === "assistant_turn") {
      expect(separatedNodes[0].turn.toolResults.get("split")?.content).toBe("done");
    }

    const offWindow = conversationBlocksToStreamEvents("s1", [
      { ...block("result-only", result), parent_id: "call-outside-window" },
    ]);
    expect(buildStreamState(offWindow).nodes).toEqual([]);

    const orphan = conversationBlocksToStreamEvents("s1", [
      { ...block("genuine-orphan", result), parent_id: null },
    ]);
    expect(buildStreamState(orphan).nodes).toMatchObject([{ kind: "unmatched_tool_result" }]);
  });

  it("keeps only the raw-console live tail after persisted history", () => {
    const historyEvents = [{
      type: "assistant", uuid: "assistant-tail-anchor", session_id: "s1", parent_tool_use_id: null,
      message: { id: "assistant-tail-anchor", role: "assistant", content: [{ type: "text", text: "persisted" }] },
    }] as StreamEvent[];
    const memEvents: StreamEvent[] = [
      { type: "system", subtype: "init", session_id: "s1" },
      historyEvents[0],
      { type: "assistant", uuid: "tail", session_id: "s1", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "tail" }] } },
    ];
    expect(computeLiveTail(historyEvents, memEvents)).toEqual(memEvents.slice(2));
  });

  it("fails closed on provider-shaped transcript blocks and preserves canonical activity evidence", () => {
    const activity = item("gemini", "s1", "diagnostic-1", {
      type: "activity",
      role: "system",
      activity_kind: "diagnostic",
      severity: "error",
      execution_outcome: "failed",
      parts: [{ type: "text", text: "provider stopped" }],
    });
    const events = conversationBlocksToStreamEvents("s1", [
      { id: "legacy", type: "event", content: "must not render", metadata_json: JSON.stringify({ event_type: "legacy" }) },
      block("canonical", activity, "2026-01-01T00:00:04Z"),
    ]);
    const nodes = buildStreamState(events).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: "activity",
      source: { blockId: "canonical", timestamp: "2026-01-01T00:00:04Z" },
      item: { activity_kind: "diagnostic", severity: "error", execution_outcome: "failed" },
    });
  });

  it("deduplicates buffered SSE and derives stopped streaming state", () => {
    const resultEvent: StreamEvent = {
      type: "result", subtype: "success", session_id: "s1", duration_ms: 0, num_turns: 1,
      result: "", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, is_error: false,
    };
    const pending = { current: [resultEvent, resultEvent] };
    let events: StreamEvent[] = [resultEvent];
    let streaming = true;
    flushPendingSSE(pending, (fn) => { events = fn(events); }, (value) => { streaming = value; });
    expect(events).toEqual([resultEvent]);
    expect(streaming).toBe(false);
    expect(pending.current).toEqual([]);
    expect(deriveStreamingState([resultEvent])).toBe(false);
  });
});
