import { describe, expect, it } from "vitest";
import {
  buildStreamState,
  conversationBlocksToStreamEvents,
  deriveStreamingState,
  flushPendingSSE,
  reconcileProviderProjection,
} from "../ui/src/chat";
import { emptyProviderLiveProjection, mergeProviderLiveProjection, chatItemIdentityKey } from "../src/conversation-control/provider-live";
import type { ChatItem, ConversationSource } from "../src/parsers/types";
import type { ProviderLiveContentEvent, ConversationControlSnapshot } from '../src/conversation-control/types';
import { groupActivityItemsForDisplay, chatItemStableKey } from '../ui/src/chat/renderModel';
import type { CanonicalChatItemEvent } from '../ui/src/components/stream-renderer/types';
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
    expect(reconciled.find(value => value.type === "chat:item" && value.item.identity.native_item_id === "live-1")).toMatchObject({ item: { parts: [{ text: "latest" }] } });
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

  it("retains distinct raw events without identity and derives stopped streaming state", () => {
    const resultEvent: StreamEvent = {
      type: "result", subtype: "success", session_id: "s1", duration_ms: 0, num_turns: 1,
      result: "", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, is_error: false,
    };
    const pending = { current: [resultEvent, resultEvent] };
    let events: StreamEvent[] = [resultEvent];
    let streaming = true;
    flushPendingSSE(pending, (fn) => { events = fn(events); }, (value) => { streaming = value; });
    expect(events).toEqual([resultEvent, resultEvent, resultEvent]);
    expect(streaming).toBe(false);
    expect(pending.current).toEqual([]);
    expect(deriveStreamingState([resultEvent])).toBe(false);
  });
});

function reconciliationItem(id: string, type: 'user' | 'assistant' | 'tool' = 'assistant', provider: 'codex' | 'claude_code' = 'claude_code'): ChatItem {
  return {
    ...(type === 'tool' ? { type: 'tool-call', role: 'assistant', phase: 'call', tool_id: id, tool_name: 'Bash', input: { command: 'pwd' } }
      : { type: 'message', role: type }),
    identity: { provider, session_id: 'session', native_item_id: id, native_turn_id: 'turn', source_record_ordinal: 0, source_sub_block_ordinal: 0 },
    provenance: { provider, source: 'live-provider-event', source_event_type: 'native' },
    parts: type === 'tool' ? [] : [{ type: 'text', text: 'same text' }], content_completion: 'streaming',
  } as ChatItem;
}
function live(value: ChatItem, sequence: number): ProviderLiveContentEvent {
  return { kind: 'provisional-content', conversation_id: 'conversation', provider_session_id: 'session', generation: 1, sequence, observed_at: sequence, identity: chatItemIdentityKey(value)!, item: value };
}
function saved(value: ChatItem, position: number): CanonicalChatItemEvent {
  return { type: 'chat:item', item: { ...value, content_completion: 'complete', provenance: { ...value.provenance, source: 'verified-provider-transcript' } }, source: { blockId: `block-${position}`, position } };
}
function projection(events: ProviderLiveContentEvent[]) {
  return events.reduce((current, event) => mergeProviderLiveProjection(current, event), emptyProviderLiveProjection('conversation'));
}
function snapshot(kind = 'running'): ConversationControlSnapshot {
  return { ownership: { kind: 'mandible', generation: 1 }, turn: { kind, turn_id: 'turn' }, controller: { kind: 'running' }, provider_capabilities: { stop: true } } as unknown as ConversationControlSnapshot;
}

for (const provider of ['claude_code', 'codex'] as const) describe(`${provider} transcript reconciliation`, () => {
  it('places a prompt before its already saved first reply and replaces native echoes idempotently', () => {
    const prompt = reconciliationItem('intent', 'user', provider);
    prompt.provenance.source_event_type = 'optimistic-user-prompt';
    const reply = reconciliationItem('reply', 'assistant', provider);
    const aliases = new Map<string, string>();
    const initial = reconcileProviderProjection([saved(reply, 1)], projection([live(prompt, 1), live(reply, 2)]), aliases);
    expect(buildStreamState(initial).nodes.map(node => node.kind)).toEqual(['user_message', 'assistant_turn']);
    const native = reconciliationItem('native-user', 'user', provider);
    const echo = { ...live(native, 3), correlation: { intent_id: 'intent', delivery_id: 'delivery', turn_id: 'turn' } };
    const projected = projection([live(prompt, 1), live(reply, 2), echo]);
    const streaming = reconcileProviderProjection([], projected, aliases);
    expect(buildStreamState(streaming).nodes.map(node => node.kind)).toEqual(['user_message', 'assistant_turn']);
    const events = reconcileProviderProjection([saved(native, 0), saved(reply, 1)], projected, aliases);
    expect(events).toHaveLength(2);
    expect(buildStreamState(events).nodes[0].key).toBe(buildStreamState(initial).nodes[0].key);
    expect(reconcileProviderProjection([saved(native, 0), saved(reply, 1)], projected, aliases)).toEqual(events);
    expect(buildStreamState(reconcileProviderProjection([saved(native, 0), saved(reply, 1)], null, aliases)).nodes[0].key).toBe('intent:intent');
  });

  it('keeps first observation order through deltas and preserves identical distinct messages', () => {
    const first = reconciliationItem('first', 'assistant', provider), second = reconciliationItem('second', 'assistant', provider);
    const projected = projection([live(first, 1), live(second, 2), live({ ...first, content_completion: 'complete' }, 3)]);
    const events = reconcileProviderProjection([], projected) as CanonicalChatItemEvent[];
    expect(events.map(event => event.item.identity.native_item_id)).toEqual(['first', 'second']);
    const swapped = reconcileProviderProjection([saved(second, 1)], projected) as CanonicalChatItemEvent[];
    expect(swapped.map(event => event.item.identity.native_item_id)).toEqual(['first', 'second']);
    expect(buildStreamState(swapped).nodes.flatMap(node => node.kind === 'assistant_turn' ? node.turn.assistantEvent.message.content : [])).toHaveLength(2);
  });

  it('retains terminal-before-durable content and hydrates lazy tool inputs under the same row identity', () => {
    const tool = reconciliationItem('tool', 'tool', provider);
    const projected = projection([live(tool, 1)]);
    const liveRow = groupActivityItemsForDisplay(buildStreamState(reconcileProviderProjection([], projected, new Map(), snapshot())).nodes)[0];
    const lazy = saved({ ...tool, input: undefined } as ChatItem, 0); lazy.source!.detailsLoaded = false;
    const pendingRow = groupActivityItemsForDisplay(buildStreamState(reconcileProviderProjection([lazy], projected, new Map(), snapshot())).nodes)[0];
    expect(pendingRow.kind === 'node' && pendingRow.node.key).toBe(liveRow.kind === 'node' && liveRow.node.key);
    expect(pendingRow.kind === 'node' && pendingRow.node.kind === 'activity' && pendingRow.node.item).toMatchObject({ input: '{\n  "command": "pwd"\n}', executionActive: true });
    for (const terminal of ['completed', 'cancelled', 'failed', 'unknown']) {
      const events = reconcileProviderProjection([], projected, new Map(), snapshot(terminal));
      expect(events).toHaveLength(1);
      const row = groupActivityItemsForDisplay(buildStreamState(events).nodes)[0];
      expect(row.kind === 'node' && row.node.kind === 'activity' && row.node.item).toMatchObject({ executionActive: false });
    }
    expect(chatItemStableKey(tool)).toBe(chatItemStableKey(saved(tool, 0).item));
  });
});

it('groups adjacent activity across empty status and thoughts while retaining explicit gaps and failures', () => {
  const tool1 = reconciliationItem('tool1', 'tool'), tool2 = reconciliationItem('tool2', 'tool');
  const empty = { ...reconciliationItem('empty'), type: 'activity', role: 'system', activity_kind: 'thinking', parts: [] } as ChatItem;
  const nodes = buildStreamState([saved(tool1, 0), saved(empty, 1), saved(tool2, 2)]).nodes;
  expect(groupActivityItemsForDisplay(nodes)[0]).toMatchObject({ kind: 'activity-group', nodes: [{ key: chatItemStableKey(tool1) }, { key: chatItemStableKey(tool2) }] });
  const gap = buildStreamState([saved(tool1, 0), { type: 'transcript:boundary' }, saved(tool2, 2)]).nodes;
  expect(groupActivityItemsForDisplay(gap).map(entry => entry.kind)).toEqual(['node', 'node', 'node']);
  const error = { ...empty, severity: 'error', execution_outcome: 'failed' } as ChatItem;
  expect(buildStreamState([saved(error, 1)]).nodes).toHaveLength(1);
});


it('marks each concurrent tool independently and clears only the completed call', () => {
  const first = reconciliationItem('first-tool', 'tool'), second = reconciliationItem('second-tool', 'tool');
  const completed = { ...first, phase: 'result', role: 'tool', output: 'done', content_completion: 'complete' } as ChatItem;
  const events = reconcileProviderProjection([], projection([live(first, 1), live(second, 2), live(completed, 3)]), new Map(), snapshot());
  const entry = groupActivityItemsForDisplay(buildStreamState(events).nodes)[0];
  expect(entry.kind).toBe('activity-group');
  if (entry.kind !== 'activity-group') return;
  expect(entry.nodes.map(node => node.item.type === 'tool-call-activity' && node.item.executionActive)).toEqual([false, true]);
});
