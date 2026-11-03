// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { useState } from 'preact/hooks';
import { cleanup, fireEvent, render } from './helpers/dom';
import { CodexParser } from '../src/parsers/codex';
import type { ActivityItem } from '../src/parsers/types';
import { projectDisplayBlock } from '../src/conversations/display-block';
import { ActivityRow } from '../ui/src/components/message-blocks/ActivityBlock';
import { ThinkingBlock } from '../ui/src/components/message-blocks/ThinkingBlock';

afterEach(cleanup);

async function reasoning(summary: string[]) {
  const result = await new CodexParser().parseIncremental({
    filePath: '/tmp/reasoning-disclosure.jsonl',
    raw: [
      { type: 'session_meta', payload: { id: 'reasoning' } },
      { type: 'response_item', payload: { type: 'reasoning', id: 'thought', summary: summary.map(text => ({ type: 'summary_text', text })) } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n',
    baseBlockCount: 0, baseRecordCount: 0, sourceHash: 'reasoning', sourceMtime: 1,
  });
  const block = result.blocks[0];
  const item = block.metadata.chat_item;
  if (!item || item.type !== 'activity') throw new Error('fixture did not produce reasoning');
  const compact = projectDisplayBlock({
    id: 'source', conversation_id: 'reasoning', type: block.type, role: block.role, content: block.content,
    position: 0, timestamp: null, parent_id: null, metadata_json: JSON.stringify(block.metadata),
    dag_uuid: null, dag_parent_uuid: null, locator: null,
  });
  const metadata = JSON.parse(compact.metadata_json) as { chat_item: ActivityItem; display_has_body: boolean };
  return { item, compact: metadata.chat_item, hasBody: metadata.display_has_body };
}

function HydratedReasoning({ item, compact, hasBody }: Awaited<ReturnType<typeof reasoning>>) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return <ActivityRow item={loaded ? item : compact} expanded={expanded} detailsAvailable={!loaded && hasBody}
    onExpandedChange={next => { setLoaded(true); setExpanded(next); }} />;
}

it('retains the first provider prose and all later sections in one refoldable disclosure after hydration', async () => {
  const parts = [
    '**Considering table edits**\n\nI need to compile a complete table without dropping the first paragraph.',
    '**Evaluating commit statuses**\n\nThe status evidence belongs to the next part.',
    '**Clarifying Git status**\n\nKeep the final paragraph as well.',
  ];
  const firstProse = 'I need to compile a complete table without dropping the first paragraph.';
  for (const { summary, expected } of [
    { summary: parts.slice(0, 1), expected: firstProse },
    { summary: parts, expected: `${firstProse}\n\nEvaluating commit statuses\n\nThe status evidence belongs to the next part.\n\nClarifying Git status\n\nKeep the final paragraph as well.` },
    { summary: ['Only one line of untitled reasoning'], expected: 'Only one line of untitled reasoning' },
    { summary: ['**Title only**'], expected: 'Title only' },
  ]) {
    const input = await reasoning(summary);
    expect(input.hasBody).toBe(true);
    const view = render(<HydratedReasoning {...input} />);
    for (let cycle = 0; cycle < 2; cycle++) {
      const header = view.getByRole('button');
      fireEvent.click(header);
      expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true');
      const region = view.getByRole('region');
      expect(region.textContent).toBe(expected);
      fireEvent.click(view.getByRole('button'));
      expect(view.queryByRole('region')).toBeNull();
      expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false');
    }
    view.unmount();
  }
});

it('keeps untitled thinking intact and exposes the same full payload on repeated expansion', () => {
  const content = 'One source line\n\nA later paragraph with whitespace.';
  const view = render(<ThinkingBlock content={content} />);
  for (let cycle = 0; cycle < 2; cycle++) {
    fireEvent.click(view.getByRole('button', { name: 'Thought' }));
    expect(view.getByRole('region').textContent).toBe(content);
    fireEvent.click(view.getByRole('button', { name: 'Thought' }));
    expect(view.queryByRole('region')).toBeNull();
  }
});
