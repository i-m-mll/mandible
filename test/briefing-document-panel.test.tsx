import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BriefingResponseValue, BriefingRoundProjection } from '../ui/src/api';

import { BriefingDocumentPanel } from '../ui/src/views/feedback/BriefingDocumentPanel';
import { buildBriefingMarkdownModel } from '../ui/src/views/feedback/briefingMarkdownModel';
import { parseBriefingDirectives } from '../src/feedback/briefing-directives';

const briefingStylesheet = readFileSync('ui/src/styles/briefing.css', 'utf8');
const contextualActionStylesheet = readFileSync('ui/src/styles/contextual-action.css', 'utf8');
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

afterEach(() => {
  cleanup();
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

  it('renders and enables the authoritative detail document when generic artifact access is denied', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'forbidden' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    render(<BriefingDocumentPanel
      briefingId="briefing-1"
      briefingTitle="Review plan"
      round={round({ document: {
        artifact_version_id: 'artifact-version:version-1',
        content_hash: createHash('sha256').update(source).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v2',
        source,
      } as any })}
      roundId="round-1"
      canMutate
      onRefresh={async () => null}
    />);

    expect(await screen.findByText('Intro')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks real fenced and inline code as shared rendered Markdown', async () => {
    const fencedSource = 'Intro\n\n```ts\nconst answer = 42;\n```\n\nInline `answer`.\n\n:::spec-item{key="plan" type="verdict" required="true"}\nPlan\n:::\n';
    const [directive] = parseBriefingDirectives(fencedSource);
    vi.stubGlobal('fetch', vi.fn(async () => json({ content: {
      ...content().content,
      size_bytes: new TextEncoder().encode(fencedSource).byteLength,
      preview: { encoding: 'utf-8', text: fencedSource, raw_text: fencedSource, truncated: false },
    } })));

    render(<BriefingDocumentPanel
      briefingId="briefing-1"
      briefingTitle="Code review"
      roundId="round-1"
      round={round({
        document: {
          artifact_version_id: 'artifact-version:version-1',
          content_hash: createHash('sha256').update(fencedSource).digest('hex'),
          previous_round_id: null,
          profile: 'mandible-briefing.v2',
          source: fencedSource,
        },
        items: [{
          id: directive.key, client_item_key: directive.key, parent_item_id: null, item_kind: 'item',
          revision: { id: directive.definition_digest, ordinal: 1, title: '', prompt: directive.body, description: null, response_type: 'verdict', required: true, position: 1, options: [] },
          effective_response: null, responseVisible: true, directive,
        }],
      })}
      canMutate
      onRefresh={async () => null}
    />);

    const document = await screen.findByLabelText('Pinned briefing document');
    const prose = document.querySelector('.briefing-document__prose.rendered-markdown');
    expect(prose).toBeTruthy();
    expect(prose?.querySelector('pre code')?.textContent).toBe('const answer = 42;\n');
    expect(prose?.querySelector('p code')?.textContent).toBe('answer');
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

  it('keeps directive and ordinary list items in one rendered list with independent exact-range actions', async () => {
    const listSource = '- Before\n\n:::spec-item{key="typed" type="verdict" required="true"}\n- Typed\n:::\n\n- After\n';
    const directive = parseBriefingDirectives(listSource)[0];
    const listRound = round({
      document: {
        artifact_version_id: 'artifact-version:list',
        content_hash: createHash('sha256').update(listSource).digest('hex'),
        previous_round_id: null, profile: 'mandible-briefing.v2', source: listSource,
      },
      items: [{
        id: directive.key, client_item_key: directive.key, parent_item_id: null, item_kind: 'item',
        revision: { id: directive.definition_digest, ordinal: 1, title: '', prompt: directive.body, description: null, response_type: 'verdict', required: true, position: 1, options: [] },
        effective_response: null, responseVisible: true, directive,
      }],
    });
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="List" roundId="round-1" round={listRound} canMutate onRefresh={async () => null} />);

    const document = await screen.findByLabelText('Pinned briefing document');
    expect(document.querySelectorAll('ul')).toHaveLength(1);
    expect(document.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Comment on list-item: - Before' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Comment on list-item: - After' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Comment' })).toHaveLength(1);
  });

  it('renders all six v2 controls with native semantics, prompt names, ordered options, bounds, and canonical clear drafts', async () => {
    const typedSource = [
      '# Typed review',
      ':::spec-item{key="verdict" type="verdict" required="true"}', 'Keep this finding?', ':::',
      ':::spec-item{key="single" type="single_choice" required="true"}', 'Choose deployment mode', '::option[Alpha]{key="a"}', '::option[Beta]{key="b"}', ':::',
      ':::spec-item{key="multi" type="multi_choice" required="true"}', 'Choose evidence sources', '::option[First]{key="first"}', '::option[Second]{key="second"}', '::option[Third]{key="third"}', ':::',
      ':::spec-item{key="short" type="short_text" required="true"}', 'Give a short rationale', ':::',
      ':::spec-item{key="long" type="long_text" required="true"}', 'Give a detailed rationale', ':::',
      ':::spec-item{key="rating" type="rating" required="true"}', 'Rate confidence', ':::',
    ].join('\n');
    const directives = parseBriefingDirectives(typedSource);
    const typedRound = round({
      document: {
        artifact_version_id: 'artifact-version:version-1',
        content_hash: createHash('sha256').update(typedSource).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v2',
        source: typedSource,
      },
      items: directives.map((directive, index) => ({
        id: directive.key, client_item_key: directive.key, parent_item_id: null, item_kind: 'item' as const,
        revision: { id: directive.definition_digest, ordinal: 1, title: directive.key, prompt: directive.body, description: null, response_type: directive.type, required: directive.required, position: index, options: directive.options },
        effective_response: null, responseVisible: true, directive,
      })),
    });
    vi.stubGlobal('fetch', vi.fn(async () => json({ content: {
      ...content().content,
      size_bytes: new TextEncoder().encode(typedSource).byteLength,
      preview: { encoding: 'utf-8', text: typedSource, raw_text: typedSource, truncated: false },
    } })));
    const changes: Array<{ id: string; value: unknown }> = [];
    function Harness() {
      const [draft, setDraft] = useState<Record<string, any>>({});
      return <BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Typed review" roundId="round-1" round={typedRound} canMutate onRefresh={async () => null} draft={draft}
        onDirectiveValue={(id, value) => { changes.push({ id, value }); setDraft((current) => ({ ...current, [id]: value })); }} />;
    }
    render(<Harness />);

    const verdict = await screen.findByRole('group', { name: 'Keep this finding?' });
    fireEvent.click(within(verdict).getByRole('button', { name: 'Keep' }));
    const single = screen.getByRole('group', { name: 'Choose deployment mode' });
    expect(within(single).getAllByRole('radio').map((input) => (input as HTMLInputElement).value)).toEqual(['a', 'b']);
    expect(within(single).getAllByText(/Alpha|Beta/).map((label) => label.textContent)).toEqual(['Alpha', 'Beta']);
    fireEvent.click(within(single).getByRole('radio', { name: 'Beta' }));
    const multi = screen.getByRole('group', { name: 'Choose evidence sources' });
    fireEvent.click(within(multi).getByRole('checkbox', { name: 'Third' }));
    fireEvent.click(within(multi).getByRole('checkbox', { name: 'First' }));
    const short = screen.getByRole('textbox', { name: 'Give a short rationale' }) as HTMLInputElement;
    const long = screen.getByRole('textbox', { name: 'Give a detailed rationale' }) as HTMLTextAreaElement;
    expect(short.maxLength).toBe(240);
    expect(long.maxLength).toBe(4000);
    fireEvent.input(short, { target: { value: ' ' } });
    expect(short.value).toBe(' ');
    fireEvent.input(short, { target: { value: '  exact  ' } });
    fireEvent.input(long, { target: { value: 'Detailed' } });
    const rating = screen.getByRole('group', { name: 'Rate confidence' });
    const ratingFive = within(rating).getByRole('radio', { name: '5' }) as HTMLInputElement;
    fireEvent.click(ratingFive);
    expect(ratingFive.checked).toBe(true);
    expect(changes).toEqual(expect.arrayContaining([
      { id: 'verdict', value: { verdict: 'keep' } },
      { id: 'single', value: { option_key: 'b' } },
      { id: 'multi', value: { option_keys: ['first', 'third'] } },
      { id: 'short', value: { text: '  exact  ' } },
      { id: 'long', value: { text: 'Detailed' } },
      { id: 'rating', value: { rating: 5 } },
    ]));
    expect(screen.getAllByLabelText('Required')).toHaveLength(6);
    const shortSection = short.closest('.briefing-directive__response-host') as HTMLElement;
    fireEvent.click(within(shortSection).getByRole('button', { name: 'Clear answer' }));
    expect(changes.at(-1)).toEqual({ id: 'short', value: null });
    expect(screen.getByLabelText('Pinned briefing document').querySelector('.briefing-directive--selected')).toBeNull();
  });

  it('aligns differently indented directive rails to one document gutter without moving content', async () => {
    const railSource = [
      ':::spec-item{key="plain" type="verdict" required="true"}', 'Plain directive', ':::',
      '',
      ':::spec-item{key="list" type="verdict" required="true"}', '- Nested directive', ':::',
    ].join('\n');
    const directives = parseBriefingDirectives(railSource);
    vi.stubGlobal('fetch', vi.fn(async () => json(content())));
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review plan" roundId="round-1" round={round({
      document: {
        artifact_version_id: 'artifact-version:rails',
        content_hash: createHash('sha256').update(railSource).digest('hex'),
        previous_round_id: null, profile: 'mandible-briefing.v2', source: railSource,
      },
      items: directives.map((directive, index) => ({
        id: directive.key, client_item_key: directive.key, parent_item_id: null, item_kind: 'item' as const,
        revision: { id: directive.definition_digest, ordinal: 1, title: '', prompt: directive.body, description: null, response_type: directive.type, required: true, position: index, options: [] },
        effective_response: null, responseVisible: true, directive,
      })),
    })} canMutate onRefresh={async () => null} />);

    await screen.findAllByRole('button', { name: 'Keep' });
    const directive = screen.getByText('Plain directive').closest('.briefing-directive') as HTMLElement;
    const actions = directive.querySelector('.briefing-directive__actions') as HTMLElement;
    const sourceTree = screen.getByLabelText('Pinned briefing document').querySelector('.briefing-document__source-tree') as HTMLElement;
    const owners = Array.from(sourceTree.querySelectorAll<HTMLElement>('.briefing-directive--owner'));
    vi.spyOn(sourceTree, 'getBoundingClientRect').mockReturnValue({
      x: 448, y: 0, left: 448, right: 1088, top: 0, bottom: 600, width: 640, height: 600, toJSON: () => ({}),
    });
    vi.spyOn(owners[0], 'getBoundingClientRect').mockReturnValue({
      x: 488, y: 40, left: 488, right: 1088, top: 40, bottom: 80, width: 600, height: 40, toJSON: () => ({}),
    });
    vi.spyOn(owners[1], 'getBoundingClientRect').mockReturnValue({
      x: 528, y: 100, left: 528, right: 1088, top: 100, bottom: 140, width: 560, height: 40, toJSON: () => ({}),
    });
    fireEvent(globalThis, new Event('resize'));
    const directiveRule = briefingStylesheet.match(/\.briefing-directive \{([^}]*)\}/)?.[1] ?? '';
    const ownerRule = briefingStylesheet.match(/\.briefing-directive--owner \{([^}]*)\}/)?.[1] ?? '';
    const railRule = briefingStylesheet.match(/\.briefing-directive--owner::before \{([^}]*)\}/)?.[1] ?? '';

    expect(directive.classList.contains('contextual-action-owner')).toBe(true);
    expect(directive.classList.contains('briefing-directive--owner')).toBe(true);
    expect(actions.classList.contains('contextual-action-group')).toBe(true);
    expect(directiveRule).toContain('box-shadow: none');
    expect(directiveRule).not.toMatch(/(?:margin|padding|border-left):/);
    expect(ownerRule).toContain('position: relative');
    expect(railRule).toContain('inset-inline-start: var(--briefing-directive-rail-offset, 0px)');
    expect(railRule).toContain('width: 2px');
    expect(railRule).toContain("content: ''");
    const contentX = owners.map((owner) => owner.getBoundingClientRect().left);
    const railX = owners.map((owner) => owner.getBoundingClientRect().left
      + Number.parseFloat(owner.style.getPropertyValue('--briefing-directive-rail-offset')));
    expect(contentX).toEqual([488, 528]);
    expect(railX).toEqual([448, 448]);
    expect(owners).toHaveLength(2);
    expect(screen.getByLabelText('Pinned briefing document').querySelector('.briefing-directive__response-host.briefing-directive')).toBeNull();
    expect(briefingStylesheet).toMatch(/\.briefing-markdown__action-rail \{[^}]*position: absolute[^}]*inset-inline-end: 0/s);
    expect(briefingStylesheet).toMatch(/\.briefing-directive--owner > \.briefing-markdown__action-rail \{[^}]*inset-inline-end: calc\(-1 \* var\(--space-3\)\)/s);
    expect(briefingStylesheet).toMatch(/\.briefing-directive__response-host \{[^}]*justify-items: end/s);
    expect(briefingStylesheet).toMatch(/\.briefing-directive--owner\.briefing-directive--selected::before \{[^}]*background: var\(--accent-border\)/s);
    expect(contextualActionStylesheet).toMatch(/\.contextual-action-owner:is\(:hover, :focus-within\) > \.contextual-action-group/);
    expect(contextualActionStylesheet).toMatch(/\.contextual-action-group--persistent/);
  });

  it('selects only non-interactive directive surfaces, switches one-at-a-time, and dismisses outside', async () => {
    const selectionSource = [
      'Outside prose',
      ':::spec-item{key="first" type="verdict" required="true"}', 'First prompt', ':::',
      ':::spec-item{key="second" type="single_choice" required="true"}', 'Second prompt', '::option[Alpha]{key="a"}', '::option[Beta]{key="b"}', ':::',
    ].join('\n');
    const directives = parseBriefingDirectives(selectionSource);
    const changes: Array<{ id: string; value: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async () => json(content())));
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Selection review" roundId="round-1" round={round({
      document: {
        artifact_version_id: 'artifact-version:selection',
        content_hash: createHash('sha256').update(selectionSource).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v2',
        source: selectionSource,
      },
      items: directives.map((directive, index) => ({
        id: directive.key, client_item_key: directive.key, parent_item_id: null, item_kind: 'item' as const,
        revision: { id: directive.definition_digest, ordinal: 1, title: directive.key, prompt: directive.body, description: null, response_type: directive.type, required: true, position: index, options: directive.options },
        effective_response: null, responseVisible: true, directive,
      })),
    })} canMutate onRefresh={async () => null} onDirectiveValue={(id, value) => changes.push({ id, value })} />);

    const firstPrompt = await screen.findByText('First prompt');
    const first = firstPrompt.closest('.briefing-directive') as HTMLElement;
    const secondPrompt = screen.getByText('Second prompt');
    const second = secondPrompt.closest('.briefing-directive') as HTMLElement;
    const firstActions = first.querySelector('.briefing-directive__actions') as HTMLElement;

    fireEvent.click(firstPrompt);
    expect(first.classList.contains('briefing-directive--selected')).toBe(true);
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(firstActions.classList.contains('contextual-action-group--persistent')).toBe(true);
    expect(second.classList.contains('briefing-directive--selected')).toBe(false);
    fireEvent.click(firstPrompt);
    expect(first.classList.contains('briefing-directive--selected')).toBe(true);

    const secondComment = within(second).getByRole('button', { name: 'Comment' });
    fireEvent.click(secondComment);
    expect(first.classList.contains('briefing-directive--selected')).toBe(true);
    expect(second.classList.contains('briefing-directive--selected')).toBe(false);
    expect(secondComment.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Close annotation editor' }));
    expect(first.classList.contains('briefing-directive--selected')).toBe(false);

    fireEvent.click(firstPrompt);
    const secondControls = screen.getByRole('group', { name: 'Second prompt' });
    const beta = within(secondControls).getByText('Beta').closest('label') as HTMLLabelElement;
    fireEvent.click(beta);
    fireEvent.click(within(secondControls).getByRole('radio', { name: 'Beta' }));
    expect(first.classList.contains('briefing-directive--selected')).toBe(true);
    expect(second.classList.contains('briefing-directive--selected')).toBe(false);
    expect(changes).toContainEqual({ id: 'second', value: { option_key: 'b' } });

    const syntheticInteractive = [
      document.createElement('button'),
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      document.createElement('label'),
      Object.assign(document.createElement('a'), { href: '#selection-fixture' }),
      document.createElement('div'),
    ];
    syntheticInteractive.at(-1)?.setAttribute('contenteditable', 'true');
    for (const target of syntheticInteractive) {
      second.append(target);
      fireEvent.click(target);
      expect(first.classList.contains('briefing-directive--selected')).toBe(true);
      expect(second.classList.contains('briefing-directive--selected')).toBe(false);
    }

    fireEvent.click(secondPrompt);
    expect(first.classList.contains('briefing-directive--selected')).toBe(false);
    expect(second.classList.contains('briefing-directive--selected')).toBe(true);
    fireEvent.keyDown(within(screen.getByRole('group', { name: 'First prompt' })).getByRole('button', { name: 'Keep' }), { key: 'Enter' });
    expect(second.classList.contains('briefing-directive--selected')).toBe(true);

    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(document.activeElement).toBe(first);
    expect(first.classList.contains('briefing-directive--selected')).toBe(true);
    expect(second.classList.contains('briefing-directive--selected')).toBe(false);
    fireEvent.keyDown(first, { key: ' ' });
    expect(first.classList.contains('briefing-directive--selected')).toBe(true);

    fireEvent.click(screen.getByText('Outside prose'));
    expect(first.classList.contains('briefing-directive--selected')).toBe(false);
    expect(screen.getByLabelText('Pinned briefing document').querySelectorAll('[aria-current="true"]')).toHaveLength(0);
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
    expect(screen.queryByRole('heading', { name: 'Review plan' })).toBeNull();
    expect(screen.getByLabelText('Pinned briefing document').querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: /Body.*Comment.*Current actor note/ })).toBeTruthy();
    const region = screen.getByText('Body').closest('.briefing-directive') as HTMLElement;
    fireEvent.click(region);
    expect(region.className).toContain('briefing-directive--selected');
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(region.className).toContain('briefing-directive--selected');
    const comment = screen.getByRole('button', { name: 'Comment' });
    fireEvent.click(comment);
    expect(comment.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Add annotation' })).toBeTruthy();
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
    expect(screen.getByRole('tab', { name: 'Comment' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Suggest replacement' }));
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

  it('opens a focusable annotation row, edits by retract+set, and deletes by retract', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return json(content());
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return json({ annotation_event_ids: body.annotations.map((_: unknown, index: number) => `event-${index}`) });
    }));
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review plan" roundId="round-1" round={round({ annotations: [annotation()] as any })} canMutate onRefresh={async () => round()} />);

    const keepButton = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
    await waitFor(() => expect(keepButton.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Plan.*Comment.*Clarify this/ }));
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
    await screen.findByText('Annotation updated.');

    fireEvent.click(screen.getByRole('button', { name: /Plan.*Comment.*Clarify this/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].annotations).toEqual([{ operation: 'retract', annotation_event_id: 'annotation-1' }]);
  });

  it('renders only the active text variant and stores bounded keyed choices without manufacturing an initial answer', async () => {
    const variantSource = '# Policy\n:::spec-item{key="wording" type="text_variant"}\n::alternative[Concise]{key="concise"}\nConcise policy.\n::alternative[Detailed]{key="detailed"}\nDetailed policy with more words.\n:::\n';
    const directiveStart = variantSource.indexOf(':::');
    const bodyStart = variantSource.indexOf('::alternative[Concise]');
    const bodyEnd = variantSource.indexOf('\n:::', bodyStart);
    const directiveEnd = bodyEnd + '\n:::'.length;
    const conciseStart = variantSource.indexOf('Concise policy.');
    const conciseEnd = conciseStart + 'Concise policy.'.length;
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
            { key: 'concise', label: 'Concise', body: 'Concise policy.', start_offset: conciseMarkerStart, end_offset: conciseEnd, body_start_offset: conciseStart, body_end_offset: conciseEnd },
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

    expect(await screen.findByText('Concise policy.')).toBeTruthy();
    expect(screen.queryByText('Detailed policy with more words.')).toBeNull();
    expect(screen.queryByText('Concise', { exact: true })).toBeNull();
    expect(screen.getByRole('group', { name: 'Text variant: Concise' })).toBeTruthy();
    expect(changes).toEqual([]);
    const previous = screen.getByRole('button', { name: 'Previous text variant' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next text variant' }) as HTMLButtonElement;
    expect(briefingStylesheet).toMatch(/\.briefing-directive__variant-controls button \{[^}]*width: 2em[^}]*height: 2em[^}]*border: 0[^}]*background: transparent[^}]*box-shadow: none/s);
    expect(briefingStylesheet).toMatch(/\.briefing-directive__variant-controls button:hover,[^{]*\{[^}]*border: 0[^}]*background: transparent[^}]*box-shadow: none/s);
    expect(briefingStylesheet).toMatch(/\.briefing-directive__variant-controls button:focus-visible \{[^}]*outline: 2px solid var\(--accent-border\)/s);
    expect(briefingStylesheet).toMatch(/@media \(hover: none\), \(pointer: coarse\) \{.*?\.briefing-directive__variant-controls button \{[^}]*min-width: 44px[^}]*min-height: 44px/s);
    expect(previous.disabled).toBe(true);
    await waitFor(() => expect(next.disabled).toBe(false));
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(next);
    expect(changes).toEqual([{ id: 'wording', value: { option_key: 'detailed' } }]);
    expect(await screen.findByText('Detailed policy with more words.')).toBeTruthy();
    expect(screen.queryByText('Concise policy.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Next text variant' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const dialog = screen.getByRole('dialog', { name: 'Add annotation' });
    expect(within(dialog).getByText('Detailed policy with more words.')).toBeTruthy();
    expect(within(dialog).queryByText(/alternative|Concise policy/)).toBeNull();
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

  it('saves a heading Comment as the exact whole-section quote without exposing inert directive syntax in the editor', async () => {
    const sectionSource = '### Branches, Worktrees, and Signing\n\nIntro\n:::spec-item{key="push" type="text_variant" required="false"}\n::alternative[Current wording]{key="current"}\nCurrent policy.\n::alternative[Action-scoped wording]{key="action-scoped"}\nAction-scoped policy.\n:::\n- Closing policy.\n\n### Mandible Auth Requests\n\nTail\n';
    const [directive] = parseBriefingDirectives(sectionSource, 'mandible-briefing.v3');
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return json(content());
      const payload = JSON.parse(String(init.body));
      posts.push(payload);
      const annotation = payload.annotations[0];
      if (sectionSource.slice(annotation.start_offset, annotation.end_offset) !== annotation.quote.trim()) {
        return json({ error: 'annotation quote does not match document' }, 400);
      }
      return json({ annotation_event_ids: ['annotation-section'] });
    }));
    const sectionRound = round({
      document: {
        artifact_version_id: 'artifact-version:section',
        content_hash: createHash('sha256').update(sectionSource).digest('hex'),
        previous_round_id: null, profile: 'mandible-briefing.v3', source: sectionSource,
      },
      items: [{
        id: directive.key, client_item_key: directive.key, parent_item_id: null, item_kind: 'item',
        revision: { id: directive.definition_digest, ordinal: 1, title: 'Push', prompt: directive.body, description: null, response_type: 'text_variant', required: false, position: 1, options: [], variants: directive.variants },
        effective_response: null, responseVisible: true, directive,
      }],
    });
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Document review" roundId="round-1" round={sectionRound} canMutate onRefresh={async () => null} />);

    const action = await screen.findByRole('button', { name: 'Comment on section Branches, Worktrees, and Signing' }) as HTMLButtonElement;
    await waitFor(() => expect(action.disabled).toBe(false));
    fireEvent.click(action);
    expect(screen.getByText('Whole section:')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText('Branches, Worktrees, and Signing')).toBeTruthy();
    expect(screen.queryByText(/spec-item/)).toBeNull();
    const dialog = screen.getByRole('dialog');
    fireEvent.input(within(dialog).getByLabelText('Comment'), { target: { value: 'Review the complete policy section.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const rawEnd = sectionSource.indexOf('### Mandible Auth Requests');
    const expectedQuote = sectionSource.slice(0, rawEnd).trim();
    const expectedEnd = expectedQuote.length;
    expect(posts[0].annotations[0]).toEqual({
      operation: 'set', kind: 'comment', start_offset: 0, end_offset: expectedEnd,
      quote: expectedQuote, body: 'Review the complete policy section.', replacement_text: null,
    });
    expect(expectedQuote).toContain(':::spec-item{key="push" type="text_variant" required="false"}');
    expect(expectedQuote).toContain('::alternative[Action-scoped wording]{key="action-scoped"}');
  });

});
