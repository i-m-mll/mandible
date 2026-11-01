import { expect, it } from 'vitest';
import { projectDisplayFragments } from '../src/presentation/fragments';
import { activityRunFacts, mergeActivityRunFacts, presentActivityRunFacts } from '../src/presentation/activity-presentation';
import type { CanonicalChatItemEvent, DisplayActivityItem } from '../src/presentation/types';

function message(id: string, text: string, position?: number): CanonicalChatItemEvent {
  return { type: 'chat:item', item: { type: 'message', role: 'assistant', content_completion: 'complete', parts: [{ type: 'text', text }],
    identity: { provider: 'codex', session_id: 'session', native_item_id: id, native_turn_id: 'turn', source_record_ordinal: 0, source_sub_block_ordinal: 0 },
    provenance: { provider: 'codex', source: position === undefined ? 'live-provider-event' : 'verified-provider-transcript', source_event_type: 'message' } },
    ...(position === undefined ? {} : { source: { blockId: `cblk:conversation:${position}`, position } }) };
}

it('splits source directives and prose once, with member-relative parts stable across live prepend and persistence', () => {
  const text = 'Before\n::created-thread{threadId="child"}\nAfter';
  const live = projectDisplayFragments([message('second', text)]);
  const prepended = projectDisplayFragments([message('first', 'Earlier'), message('second', text)]);
  const persisted = projectDisplayFragments([message('second', text, 8)]);
  expect(live.map(fragment => [fragment.part, fragment.node.kind])).toEqual([
    ['content:0', 'assistant_turn'], ['directive:0', 'activity'], ['content:1', 'assistant_turn'],
  ]);
  expect(prepended.filter(fragment => fragment.memberKey === live[0].memberKey).map(fragment => fragment.part)).toEqual(live.map(fragment => fragment.part));
  expect(persisted.map(fragment => fragment.part)).toEqual(live.map(fragment => fragment.part));
  expect(projectDisplayFragments([message('quoted', '```\n::created-thread{threadId="example"}\n```')])).toHaveLength(1);
});

it('folds canonical and live activity facts with the existing tool/thought wording', () => {
  const tool = (id: string): DisplayActivityItem => ({ type: 'tool-call-activity', id, name: 'read', input: 'unretained input', result: null, sessionId: 'session' });
  const thought: DisplayActivityItem = { type: 'thinking-block-activity', content: 'unretained thought body', sessionId: 'session' };
  const canonical = activityRunFacts([tool('a'), thought]);
  const combined = mergeActivityRunFacts(canonical, activityRunFacts([tool('b')]));
  expect(presentActivityRunFacts(combined)).toMatchObject({ summary: 'Read some files; thought', hasDisclosure: true, defaultExpanded: false });
  expect(JSON.stringify(canonical)).not.toContain('unretained');
});
