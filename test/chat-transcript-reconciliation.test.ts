import { describe, expect, it } from 'vitest';
import { chatItemIdentityKey, emptyProviderLiveProjection, mergeProviderLiveProjection } from '../src/conversation-control/provider-live';
import type { ProviderLiveContentEvent, ConversationControlSnapshot } from '../src/conversation-control/types';
import type { ChatItem } from '../src/parsers/types';
import { reconcileProviderProjection } from '../ui/src/chat/conversationEvents';
import { buildStreamState, groupActivityItemsForDisplay, chatItemStableKey } from '../ui/src/chat/renderModel';
import type { CanonicalChatItemEvent } from '../ui/src/components/stream-renderer/types';

function item(id: string, type: 'user' | 'assistant' | 'tool' = 'assistant', provider: 'codex' | 'claude_code' = 'claude_code'): ChatItem {
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
    const prompt = item('intent', 'user', provider);
    prompt.provenance.source_event_type = 'optimistic-user-prompt';
    const reply = item('reply', 'assistant', provider);
    const aliases = new Map<string, string>();
    const initial = reconcileProviderProjection([saved(reply, 1)], projection([live(prompt, 1), live(reply, 2)]), aliases);
    expect(buildStreamState(initial).nodes.map(node => node.kind)).toEqual(['user_message', 'assistant_turn']);
    const native = item('native-user', 'user', provider);
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
    const first = item('first', 'assistant', provider), second = item('second', 'assistant', provider);
    const projected = projection([live(first, 1), live(second, 2), live({ ...first, content_completion: 'complete' }, 3)]);
    const events = reconcileProviderProjection([], projected) as CanonicalChatItemEvent[];
    expect(events.map(event => event.item.identity.native_item_id)).toEqual(['first', 'second']);
    const swapped = reconcileProviderProjection([saved(second, 1)], projected) as CanonicalChatItemEvent[];
    expect(swapped.map(event => event.item.identity.native_item_id)).toEqual(['first', 'second']);
    expect(buildStreamState(swapped).nodes.flatMap(node => node.kind === 'assistant_turn' ? node.turn.assistantEvent.message.content : [])).toHaveLength(2);
  });

  it('retains terminal-before-durable content and hydrates lazy tool inputs under the same row identity', () => {
    const tool = item('tool', 'tool', provider);
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
  const tool1 = item('tool1', 'tool'), tool2 = item('tool2', 'tool');
  const empty = { ...item('empty'), type: 'activity', role: 'system', activity_kind: 'thinking', parts: [] } as ChatItem;
  const nodes = buildStreamState([saved(tool1, 0), saved(empty, 1), saved(tool2, 2)]).nodes;
  expect(groupActivityItemsForDisplay(nodes)[0]).toMatchObject({ kind: 'activity-group', nodes: [{ key: chatItemStableKey(tool1) }, { key: chatItemStableKey(tool2) }] });
  const gap = buildStreamState([saved(tool1, 0), { type: 'transcript:boundary' }, saved(tool2, 2)]).nodes;
  expect(groupActivityItemsForDisplay(gap).map(entry => entry.kind)).toEqual(['node', 'node', 'node']);
  const error = { ...empty, severity: 'error', execution_outcome: 'failed' } as ChatItem;
  expect(buildStreamState([saved(error, 1)]).nodes).toHaveLength(1);
});


it('marks each concurrent tool independently and clears only the completed call', () => {
  const first = item('first-tool', 'tool'), second = item('second-tool', 'tool');
  const completed = { ...first, phase: 'result', role: 'tool', output: 'done', content_completion: 'complete' } as ChatItem;
  const events = reconcileProviderProjection([], projection([live(first, 1), live(second, 2), live(completed, 3)]), new Map(), snapshot());
  const entry = groupActivityItemsForDisplay(buildStreamState(events).nodes)[0];
  expect(entry.kind).toBe('activity-group');
  if (entry.kind !== 'activity-group') return;
  expect(entry.nodes.map(node => node.item.type === 'tool-call-activity' && node.item.executionActive)).toEqual([false, true]);
});
