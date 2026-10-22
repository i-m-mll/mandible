import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { establishTestClientAccess } from './helpers/local-client-access';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import type { BriefingResponseValue, BriefingRoundProjection } from '../ui/src/api';

import { BriefingDocumentPanel } from '../ui/src/views/feedback/BriefingDocumentPanel';
import { buildBriefingMarkdownModel, changedBriefingEntityIndexes, compareBriefingEntities } from '../ui/src/views/feedback/briefingMarkdownModel';
import { parseBriefingDirectives } from '../src/feedback/briefing-directives';

const source = 'Intro\n:::spec-item{key="plan" type="verdict" required="true"}\nPlan\n:::\n';
const directiveStart = source.indexOf(':::');
const bodyStart = source.indexOf('Plan');
const bodyEnd = source.indexOf('\n:::', bodyStart);
const directiveEnd = bodyEnd + '\n:::'.length;
const definitionDigest = createHash('sha256').update(source.slice(directiveStart, directiveEnd)).digest('hex');

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function annotation(overrides: Record<string, unknown> = {}) {
  return {
    annotation_event_id: 'annotation-1',
    annotation_kind: 'comment',
    start_offset: bodyStart,
    end_offset: bodyEnd,
    quote: 'Plan',
    body: 'Clarify this.',
    replacement_text: null,
    created_at: 1,
    ...overrides,
  };
}

function round(overrides: Partial<BriefingRoundProjection> = {}): BriefingRoundProjection {
  return {
    round_id: 'round-1',
    state: 'open',
    briefing_key: 'review-plan',
    binding_digest: 'digest',
    created_at: 1,
    latest_submission_for_actor: null,
    document: {
      artifact_version_id: 'artifact-version:version-1',
      content_hash: createHash('sha256').update(source).digest('hex'),
      previous_round_id: null,
      profile: 'mandible-briefing.v2',
      source,
    },
    directive_binding: { status: 'valid' },
    latest_frozen_membership: { answer_event_ids: [], annotation_event_ids: [] },
    annotations: [],
    items: [{
      id: 'plan', client_item_key: 'plan', parent_item_id: null, item_kind: 'item',
      revision: { id: 'rev', ordinal: 1, title: '', prompt: 'Plan', description: null, response_type: 'verdict', required: true, position: 1, options: [] },
      effective_response: null, responseVisible: true,
      directive: { key: 'plan', definition_digest: definitionDigest, start_offset: directiveStart, end_offset: directiveEnd, body_start_offset: bodyStart, body_end_offset: bodyEnd },
    }],
    valid: true,
    ...overrides,
  };
}

function content() {
  return {
    content: {
      artifact_id: 'artifact:plan',
      status: 'available',
      kind: 'markdown',
      media_type: 'text/markdown',
      size_bytes: new TextEncoder().encode(source).byteLength,
      source: null,
      preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false },
      download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'plan.md' },
    },
  };
}

beforeEach(establishTestClientAccess);

afterEach(() => {
  cleanup();
  __resetBrowserSessionForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Briefing document panel', () => {
  it('renders authoritative detail prose instead of drifted generic artifact prose', async () => {
    const authoritativeSource = source.replace('Intro', 'Truth');
    const driftedSource = source.replace('Intro', 'Drift');
    const fetchMock = vi.fn(async () => json({ content: {
      ...content().content,
      size_bytes: new TextEncoder().encode(driftedSource).byteLength,
      preview: { encoding: 'utf-8', text: driftedSource, raw_text: driftedSource, truncated: false },
    } }));
    vi.stubGlobal('fetch', fetchMock);

    render(<BriefingDocumentPanel
      briefingId="briefing-1"
      briefingTitle="Review plan"
      round={round({ document: {
        artifact_version_id: 'artifact-version:version-1',
        content_hash: createHash('sha256').update(authoritativeSource).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v2',
        source: authoritativeSource,
      } as any })}
      roundId="round-1"
      canMutate
      onRefresh={async () => null}
    />);

    expect(await screen.findByText('Truth')).toBeTruthy();
    expect(screen.queryByText('Drift')).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps coherent Markdown entities to exact UTF-16 ranges with deterministic nested targets', () => {
    const mappedSource = [
      '## Policy 😀',
      '',
      'Opening paragraph.',
      '',
      '- Parent item',
      '  - Nested item',
      '',
      '> Quoted paragraph.',
      '',
      '| A | B |',
      '| - | - |',
      '| x | y |',
      '',
      '```ts',
      'const value = 1;',
      '```',
      '',
      ':::spec-item{key="typed" type="verdict" required="true"}',
      '- Typed list item',
      ':::',
    ].join('\n');
    const directive = parseBriefingDirectives(mappedSource)[0];
    const item = {
      id: directive.key, client_item_key: directive.key, parent_item_id: null, item_kind: 'item' as const,
      revision: { id: directive.definition_digest, ordinal: 1, title: '', prompt: directive.body, description: null, response_type: directive.type, required: true, position: 1, options: [] },
      effective_response: null, responseVisible: true, directive,
    };
    const model = buildBriefingMarkdownModel(mappedSource, [item], {});

    expect(model.entities.map((entity) => entity.kind)).toEqual([
      'heading', 'paragraph', 'list-item', 'list-item', 'block-quote', 'table', 'fenced-code',
    ]);
    expect(model.entities.every((entity) => mappedSource.slice(entity.start, entity.end) === entity.quote)).toBe(true);
    expect(model.entities.find((entity) => entity.kind === 'heading')?.start).toBe(0);
    expect(model.entities.find((entity) => entity.kind === 'heading')?.end).toBe('## Policy 😀'.length);
    expect(model.entities.filter((entity) => entity.kind === 'paragraph')).toHaveLength(1);
    expect(model.entities.some((entity) => entity.quote.includes('Typed list item'))).toBe(false);
    expect(model.markdown).not.toContain(':::spec-item');
  });

  it('marks one modified proposed entity, preserves unchanged entities, and treats duplicate ambiguity as changed', () => {
    const base = buildBriefingMarkdownModel('# Policy\n\nOriginal wording.\n\nUnchanged.\n', [], {});
    const proposed = buildBriefingMarkdownModel('# Policy\n\nRevised wording.\n\nUnchanged.\n', [], {});
    expect(changedBriefingEntityIndexes(proposed, base)).toEqual([1]);
    expect(compareBriefingEntities(proposed, base)).toEqual([{ proposedIndex: 1, classification: 'modified' }]);
    expect(changedBriefingEntityIndexes(base, base)).toEqual([]);
    const added = buildBriefingMarkdownModel('# Policy\n\nOriginal wording.\n\nUnchanged.\n\nAdded.\n', [], {});
    expect(compareBriefingEntities(added, base)).toEqual([{ proposedIndex: 3, classification: 'added' }]);

    const ambiguousBase = buildBriefingMarkdownModel('# Policy\n\nSame.\n\nSame.\n', [], {});
    const ambiguousProposed = buildBriefingMarkdownModel('# Policy\n\nSame.\n\nSame.\n', [], {});
    expect(changedBriefingEntityIndexes(ambiguousProposed, ambiguousBase)).toEqual([1, 2]);

    const sectionBase = buildBriefingMarkdownModel('## One\n\nShared.\n\n## Two\n\nOther.\n', [], {});
    const sectionProposed = buildBriefingMarkdownModel('## One\n\nShared.\n\n## Two\n\nShared.\n', [], {});
    expect(changedBriefingEntityIndexes(sectionProposed, sectionBase)).toEqual([3]);
  });

  it('renders profiled directive bodies as sanitized prose without directive fences', async () => {
    const profiledSource = '# Review plan\n\nIntro\n:::spec-item{key="verdict" type="verdict" required="true"}\nBody <img src=x onerror=alert(1)>\n:::\nTail';
    vi.stubGlobal('fetch', vi.fn(async () => json({ content: {
      ...content().content,
      size_bytes: new TextEncoder().encode(profiledSource).byteLength,
      preview: { encoding: 'utf-8', text: profiledSource, raw_text: profiledSource, truncated: false },
    } })));
    const source = profiledSource;
    const start = source.indexOf(':::'); const bodyStart = source.indexOf('Body'); const bodyEnd = source.indexOf('\n:::', bodyStart);
    const definitionDigest = createHash('sha256').update(source.slice(start, bodyEnd + 4)).digest('hex');
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review plan" roundId="round-1" round={round({
      document: {
        artifact_version_id: 'artifact-version:version-1',
        content_hash: createHash('sha256').update(profiledSource).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v2',
        source: profiledSource,
      },
      directive_binding: { status: 'valid', reason: null }, latest_frozen_membership: { answer_event_ids: [], annotation_event_ids: [] },
      annotations: [annotation({ start_offset: bodyStart, end_offset: bodyEnd, quote: 'Body', body: 'Current actor note.' })] as any,
      items: [{ id: 'verdict', client_item_key: 'verdict', parent_item_id: null, item_kind: 'item', revision: { id: 'rev', ordinal: 1, title: '', prompt: 'Body', description: null, response_type: 'verdict', required: true, position: 1, options: [] }, effective_response: null, responseVisible: true, directive: { key: 'verdict', definition_digest: definitionDigest, start_offset: start, end_offset: bodyEnd + 4, body_start_offset: bodyStart, body_end_offset: bodyEnd } }],
    })} canMutate onRefresh={async () => null} onDirectiveVerdict={() => undefined} />);
    const keep = await screen.findByRole('button', { name: 'Keep' });
    expect(keep).toBeTruthy();
    expect(screen.queryByText(':::spec-item{key="verdict" type="verdict" required="true"}')).toBeNull();
    expect(screen.getByLabelText('Pinned briefing document').querySelector('img')).toBeNull();
    expect(screen.queryByText('Current actor note.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(within(screen.getByRole('dialog')).getByText(/Current actor note/)).toBeTruthy();
  });

  it('creates an annotation from a profiled directive before refetching', async () => {
    const posts: any[] = [];
    const refresh = vi.fn(async () => round());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method) return json(content());
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ annotation_event_ids: ['annotation-new'] });
    }));

    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review plan" roundId="round-1" round={round()} canMutate onRefresh={refresh} />);
    const commentButton = await screen.findByRole('button', { name: 'Comment' }) as HTMLButtonElement;
    await waitFor(() => expect(commentButton.disabled).toBe(false));
    fireEvent.click(commentButton);
    const dialog = screen.getByRole('dialog', { name: 'Add annotation' });
    const replacementTab = within(dialog).getByRole('tab', { name: 'Suggest replacement' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(posts).toHaveLength(0);
    fireEvent.click(replacementTab);
    expect((screen.getByLabelText('Replacement') as HTMLTextAreaElement).value).toBe('Plan');
    fireEvent.input(screen.getByLabelText('Replacement'), { target: { value: 'Revised plan' } });
    fireEvent.input(screen.getByLabelText('Note (optional)'), { target: { value: 'Explain the premise.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/api/briefings/briefing-1/rounds/round-1/annotations',
      body: {
        annotations: [{
          operation: 'set',
          kind: 'suggest_replacement',
          start_offset: bodyStart,
          end_offset: bodyEnd,
          quote: 'Plan',
          replacement_text: 'Revised plan',
          body: 'Explain the premise.',
        }],
      },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('posts an ordinary Markdown entity comment with its exact source range and quote', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return json(content());
      posts.push(JSON.parse(String(init.body)));
      return json({ annotation_event_ids: ['annotation-entity'] });
    }));
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review plan" roundId="round-1" round={round()} canMutate onRefresh={async () => null} />);

    const action = await screen.findByRole('button', { name: 'Comment on paragraph: Intro' }) as HTMLButtonElement;
    await waitFor(() => expect(action.disabled).toBe(false));
    fireEvent.click(action);
    fireEvent.input(within(screen.getByRole('dialog')).getByLabelText('Comment'), { target: { value: 'Explain the introduction.' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].annotations[0]).toEqual({
      operation: 'set', kind: 'comment', start_offset: 0, end_offset: 5,
      quote: 'Intro', body: 'Explain the introduction.', replacement_text: null,
    });
  });

  it('edits and deletes a current-draft annotation only through its bare history action', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return json(content());
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return json({ annotation_event_ids: body.annotations.map((_: unknown, index: number) => `event-${index}`) });
    }));
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review plan" roundId="round-1" round={round({ annotations: [annotation({
      presentation: { source: 'current_draft', actor: null },
    })] as any })} canMutate onRefresh={async () => round()} />);

    const keepButton = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
    await waitFor(() => expect(keepButton.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const firstHistory = within(screen.getByRole('dialog')).getByRole('region', { name: 'Comment history' });
    fireEvent.click(within(firstHistory).getByText('Clarify this.'));
    expect(screen.getByRole('dialog', { name: 'Add annotation' })).toBeTruthy();
    fireEvent.click(within(firstHistory).getByRole('button', { name: 'Edit annotation by You: Clarify this.' }));
    expect(screen.getByRole('dialog', { name: 'Edit annotation' })).toBeTruthy();
    fireEvent.input(within(screen.getByRole('dialog')).getByLabelText('Comment'), { target: { value: 'Revised note.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].annotations).toEqual([
      { operation: 'retract', annotation_event_id: 'annotation-1' },
      {
        operation: 'set', kind: 'comment', start_offset: bodyStart, end_offset: bodyEnd,
        quote: 'Plan', body: 'Revised note.', replacement_text: null,
      },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Edit annotation by You: Clarify this.' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].annotations).toEqual([{ operation: 'retract', annotation_event_id: 'annotation-1' }]);
  });

  it('renders only the active text variant and stores bounded keyed choices without manufacturing an initial answer', async () => {
    const variantSource = '# Policy\n:::spec-item{key="wording" type="text_variant"}\n::alternative[Concise]{key="concise"}\nThis is a layout and rail specimen.\n::alternative[Detailed]{key="detailed"}\nDetailed policy with more words.\n:::\n# Briefing directive layout specimens\n';
    const directiveStart = variantSource.indexOf(':::');
    const bodyStart = variantSource.indexOf('::alternative[Concise]');
    const bodyEnd = variantSource.indexOf('\n:::', bodyStart);
    const directiveEnd = bodyEnd + '\n:::'.length;
    const conciseStart = variantSource.indexOf('This is a layout and rail specimen.');
    const conciseEnd = conciseStart + 'This is a layout and rail specimen.'.length;
    const detailedStart = variantSource.indexOf('Detailed policy with more words.');
    const detailedEnd = detailedStart + 'Detailed policy with more words.'.length;
    const conciseMarkerStart = variantSource.indexOf('::alternative[Concise]');
    const detailedMarkerStart = variantSource.indexOf('::alternative[Detailed]');
    const variantRound = round({
      document: {
        artifact_version_id: 'artifact-version:variants',
        content_hash: createHash('sha256').update(variantSource).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v3',
        source: variantSource,
      },
      items: [{
        id: 'wording', client_item_key: 'wording', parent_item_id: null, item_kind: 'item',
        revision: {
          id: 'variant-revision', ordinal: 1, title: 'Wording', prompt: 'Choose wording', description: null,
          response_type: 'text_variant', required: true, position: 1, options: [],
          variants: [
            { key: 'concise', label: 'Concise', body: 'This is a layout and rail specimen.', start_offset: conciseMarkerStart, end_offset: conciseEnd, body_start_offset: conciseStart, body_end_offset: conciseEnd },
            { key: 'detailed', label: 'Detailed', body: 'Detailed policy with more words.', start_offset: detailedMarkerStart, end_offset: detailedEnd, body_start_offset: detailedStart, body_end_offset: detailedEnd },
          ],
        },
        effective_response: null, responseVisible: true,
        directive: {
          key: 'wording', definition_digest: createHash('sha256').update(variantSource.slice(directiveStart, directiveEnd)).digest('hex'),
          start_offset: directiveStart, end_offset: directiveEnd, body_start_offset: bodyStart, body_end_offset: bodyEnd,
        },
      }],
    });
    const changes: unknown[] = [];
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json({ annotation_event_ids: ['annotation-variant'] });
      }
      return json(content());
    }));
    function Harness({ canMutate = true }: { canMutate?: boolean }) {
      const [draft, setDraft] = useState<Record<string, BriefingResponseValue | null>>({});
      return <BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Document review" roundId="round-1" round={variantRound}
        canMutate={canMutate} onRefresh={async () => null} draft={draft}
        onDirectiveValue={(id, value) => { changes.push({ id, value }); setDraft((current) => ({ ...current, [id]: value })); }} />;
    }
    const view = render(<Harness />);

    await screen.findByText('This is a layout and rail specimen.');
    expect(screen.queryByText('Detailed policy with more words.')).toBeNull();
    expect(screen.queryByText('Concise', { exact: true })).toBeNull();
    expect(screen.getByRole('group', { name: 'Text variant: Concise' })).toBeTruthy();
    expect(changes).toEqual([]);
    const previous = screen.getByRole('button', { name: 'Previous text variant' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next text variant' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    await waitFor(() => expect(next.disabled).toBe(false));
    fireEvent.click(next);
    expect(changes).toEqual([{ id: 'wording', value: { option_key: 'detailed' } }]);
    await screen.findByText('Detailed policy with more words.');
    expect(screen.queryByText('This is a layout and rail specimen.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Next text variant' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const dialog = screen.getByRole('dialog', { name: 'Add annotation' });
    expect(within(dialog).getByText('Detailed policy with more words.')).toBeTruthy();
    expect(within(dialog).queryByText(/alternative|layout and rail specimen/)).toBeNull();
    fireEvent.input(within(dialog).getByLabelText('Comment'), { target: { value: 'Keep the detailed wording.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].annotations).toEqual([{
      operation: 'set', kind: 'comment', start_offset: detailedStart, end_offset: detailedEnd,
      quote: 'Detailed policy with more words.', body: 'Keep the detailed wording.', replacement_text: null,
    }]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous text variant' }));
    expect(changes.at(-1)).toEqual({ id: 'wording', value: { option_key: 'concise' } });

    view.rerender(<Harness canMutate={false} />);
    expect((screen.getByRole('button', { name: 'Next text variant' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
