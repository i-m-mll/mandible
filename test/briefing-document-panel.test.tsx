import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { establishTestClientAccess } from './helpers/local-client-access';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import type { BriefingResponseValue, BriefingRoundProjection } from '../ui/src/api';

import { BriefingDocumentPanel } from '../ui/src/views/feedback/BriefingDocumentPanel';
import { buildBriefingMarkdownModel, changedBriefingEntityIndexes, compareBriefingEntities } from '../ui/src/views/feedback/briefingMarkdownModel';
import { parseBriefingDirectives } from '../src/feedback/briefing-directives';

const briefingStylesheet = readFileSync('ui/src/styles/briefing.css', 'utf8');
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

  it('uses one shared rendered Markdown rhythm for quoted prose and readable tables', async () => {
    const proseSource = [
      '# Presentation',
      '',
      '> A restrained quotation.',
      '',
      '| Name | State |',
      '| --- | --- |',
      '| Shared | Ready |',
    ].join('\n');
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Presentation" roundId="round-1" round={round({
      document: {
        artifact_version_id: 'artifact-version:presentation',
        content_hash: createHash('sha256').update(proseSource).digest('hex'),
        previous_round_id: null, profile: 'mandible-briefing.v3', source: proseSource,
      },
      items: [],
    })} canMutate onRefresh={async () => null} />);

    const document = await screen.findByLabelText('Pinned briefing document');
    expect(document.querySelector('blockquote')?.textContent).toContain('A restrained quotation.');
    expect(Array.from(document.querySelectorAll('th'), (cell) => cell.textContent)).toEqual(['Name', 'State']);
    expect(Array.from(document.querySelectorAll('td'), (cell) => cell.textContent)).toEqual(['Shared', 'Ready']);
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

  it('source-maps only complete leading YAML frontmatter and keeps later rules as Markdown', () => {
    const frontmatter = '---\ntitle: Review\ntags:\n  - markdown\n---\n';
    const mappedSource = `${frontmatter}\n# Policy\n\nBody.\n\n---\n\nAfter rule.`;
    const model = buildBriefingMarkdownModel(mappedSource, [], {});
    const metadata = model.entities[0];

    expect(metadata).toMatchObject({
      kind: 'frontmatter',
      start: 0,
      end: frontmatter.length,
      quote: frontmatter,
      label: 'Frontmatter',
    });
    expect(model.frontmatter).toMatchObject({
      start: 0,
      end: frontmatter.length,
      raw: frontmatter,
      body: 'title: Review\ntags:\n  - markdown\n',
      entries: [
        { key: 'title', value: 'Review' },
        { key: 'tags', value: 'markdown' },
      ],
    });
    expect(model.markdown).toBe('\n# Policy\n\nBody.\n\n---\n\nAfter rule.');
    expect(model.entities.filter((entity) => entity.kind === 'frontmatter')).toHaveLength(1);

    const nonLeading = buildBriefingMarkdownModel('Intro.\n\n---\ntitle: Not metadata\n---\n', [], {});
    expect(nonLeading.frontmatter).toBeNull();
    expect(nonLeading.entities.some((entity) => entity.kind === 'frontmatter')).toBe(false);

    const unterminated = buildBriefingMarkdownModel('---\ntitle: Still Markdown\n', [], {});
    expect(unterminated.frontmatter).toBeNull();
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

  it('renders directive-free comparison changes with keyboard-operable compact navigation and no-base parity', async () => {
    const baseSource = '# Policy\n\nOriginal wording.\n\nUnchanged.\n';
    const proposedSource = '# Policy\n\nRevised wording.\n\nUnchanged.\n';
    const comparisonRound = round({
      document: {
        artifact_version_id: 'artifact-version:proposed',
        content_hash: createHash('sha256').update(proposedSource).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v3',
        source: proposedSource,
        comparison_base: {
          artifact_version_id: 'artifact-version:base',
          content_hash: createHash('sha256').update(baseSource).digest('hex'),
          source: baseSource,
        },
      },
      items: [],
    });
    const rendered = render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review" roundId="round-1"
      round={comparisonRound} canMutate onRefresh={async () => null} />);
    expect(await screen.findByText('1 changed')).toBeTruthy();
    const changed = rendered.container.querySelector<HTMLElement>('.briefing-markdown__entity--changed');
    expect(changed?.getAttribute('aria-label')).toContain('Changed paragraph: Revised wording.');
    const next = screen.getByRole('button', { name: 'Next changed entity' });
    expect(next.classList.contains('contextual-action--compact')).toBe(true);
    next.focus();
    fireEvent.keyDown(next, { key: 'Enter' });
    fireEvent.click(next);
    expect(globalThis.document.activeElement).toBe(changed);

    cleanup();
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review" roundId="round-1"
      round={round({ document: { ...comparisonRound.document!, comparison_base: null }, items: [] })}
      canMutate onRefresh={async () => null} />);
    await screen.findByText('Revised wording.');
    expect(screen.queryByLabelText('Changed proposed entities')).toBeNull();
    expect(globalThis.document.querySelector('.briefing-markdown__entity--changed')).toBeNull();
  });

  it('renders frontmatter as metadata and navigates every comparison change sequentially', async () => {
    const baseSource = '---\ntitle: Old\n---\n\n# Policy\n\nOne.\n\nTwo.\n';
    const proposedSource = '---\ntitle: New\n---\n\n# Policy\n\nChanged one.\n\nChanged two.\n';
    const comparisonRound = round({
      document: {
        artifact_version_id: 'artifact-version:proposed-frontmatter',
        content_hash: createHash('sha256').update(proposedSource).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v3',
        source: proposedSource,
        comparison_base: {
          artifact_version_id: 'artifact-version:base-frontmatter',
          content_hash: createHash('sha256').update(baseSource).digest('hex'),
          source: baseSource,
        },
      },
      items: [],
    });
    const rendered = render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review" roundId="round-1"
      round={comparisonRound} canMutate onRefresh={async () => null} />);

    const metadata = await screen.findByLabelText('Changed document frontmatter');
    expect(metadata.textContent).toContain('titleNew');
    expect(metadata.textContent).not.toContain('---');
    const changed = Array.from(rendered.container.querySelectorAll<HTMLElement>('[data-briefing-changed-order]'));
    expect(changed).toHaveLength(3);

    const next = screen.getByRole('button', { name: 'Next changed entity' });
    fireEvent.click(next);
    expect(globalThis.document.activeElement).toBe(changed[0]);
    expect(screen.getByText('1 of 3 changed')).toBeTruthy();
    fireEvent.click(next);
    expect(globalThis.document.activeElement).toBe(changed[1]);
    fireEvent.click(next);
    expect(globalThis.document.activeElement).toBe(changed[2]);

    fireEvent.click(screen.getByRole('button', { name: 'Previous changed entity' }));
    expect(globalThis.document.activeElement).toBe(changed[1]);
  });

  it('keeps the change console persistent and list highlights non-additive', () => {
    const navigationRule = briefingStylesheet.match(/\.briefing-document__change-navigation \{([^}]*)\}/)?.[1] ?? '';
    const changedRule = briefingStylesheet.match(/\.briefing-markdown__entity--changed \{([^}]*)\}/)?.[1] ?? '';

    expect(navigationRule).toContain('position: sticky');
    expect(navigationRule).toContain('inset-block-start: var(--space-2)');
    expect(changedRule).not.toContain('box-shadow');
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
    const keep = within(verdict).getByRole('button', { name: 'Keep' });
    const dismiss = within(verdict).getByRole('button', { name: 'Dismiss' });
    expect(verdict.closest('.briefing-directive__response-host')).toBeTruthy();
    expect(verdict.classList.contains('briefing-directive__compact-controls')).toBe(true);
    expect(keep.classList.contains('contextual-action')).toBe(true);
    expect(keep.classList.contains('contextual-action--compact')).toBe(true);
    expect(dismiss.classList.contains('contextual-action--compact')).toBe(true);
    fireEvent.click(keep);
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
    expect(screen.queryByText('Required')).toBeNull();
    expect(verdict.getAttribute('aria-required')).toBe('true');
    expect(single.getAttribute('aria-required')).toBe('true');
    expect(multi.getAttribute('aria-required')).toBe('true');
    expect(short.getAttribute('aria-required')).toBe('true');
    expect(long.getAttribute('aria-required')).toBe('true');
    expect(rating.getAttribute('aria-required')).toBe('true');
    const shortSection = short.closest('.briefing-directive__response-host') as HTMLElement;
    expect(shortSection.className).toBe('briefing-directive__response-host');
    expect(shortSection.previousElementSibling).toBe(screen.getByText('Give a short rationale').closest('.briefing-directive'));
    [verdict, single, multi, short, long, rating].forEach((control) => {
      expect(control.closest('.briefing-directive__response-host')?.className).toBe('briefing-directive__response-host');
    });
    const shortOwner = shortSection.previousElementSibling as HTMLElement;
    const shortActions = shortOwner.querySelector('.briefing-directive__actions') as HTMLElement;
    expect(shortActions.children[0].classList.contains('briefing-directive__clear-slot')).toBe(true);
    expect(shortActions.children[1].classList.contains('briefing-annotation-action')).toBe(true);
    expect(screen.queryByText('Clear answer')).toBeNull();
    fireEvent.click(within(shortOwner).getByRole('button', { name: 'Clear response' }));
    expect(changes.at(-1)).toEqual({ id: 'short', value: null });
    expect(screen.getByLabelText('Pinned briefing document').querySelector('.briefing-directive--selected')).toBeNull();
  });

  it('aligns zero-indent and indented directive rails ten pixels outside one document gutter', async () => {
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
    const responseHosts = Array.from(sourceTree.querySelectorAll<HTMLElement>('.briefing-directive__response-host'));
    vi.spyOn(sourceTree, 'getBoundingClientRect').mockReturnValue({
      x: 448, y: 0, left: 448, right: 1088, top: 0, bottom: 600, width: 640, height: 600, toJSON: () => ({}),
    });
    vi.spyOn(owners[0], 'getBoundingClientRect').mockReturnValue({
      x: 448, y: 40, left: 448, right: 1088, top: 40, bottom: 80, width: 640, height: 40, toJSON: () => ({}),
    });
    vi.spyOn(owners[1], 'getBoundingClientRect').mockReturnValue({
      x: 528, y: 100, left: 528, right: 1088, top: 100, bottom: 140, width: 560, height: 40, toJSON: () => ({}),
    });
    sourceTree.style.paddingRight = '160px';
    sourceTree.style.paddingBottom = '0px';
    owners.forEach((owner) => { owner.style.lineHeight = '24px'; });
    fireEvent(globalThis, new Event('resize'));

    expect(directive.classList.contains('contextual-action-owner')).toBe(true);
    expect(directive.classList.contains('briefing-directive--owner')).toBe(true);
    expect(actions.classList.contains('contextual-action-group')).toBe(true);
    const contentX = owners.map((owner) => owner.getBoundingClientRect().left);
    const railX = owners.map((owner) => owner.getBoundingClientRect().left
      + Number.parseFloat(owner.style.getPropertyValue('--briefing-directive-rail-offset')));
    expect(contentX).toEqual([448, 528]);
    expect(railX).toEqual([438, 438]);
    expect(owners).toHaveLength(2);
    expect(actions.style.getPropertyValue('--briefing-right-rail-action-offset')).toBe('488px');
    expect(actions.style.getPropertyValue('--briefing-right-rail-top')).toBe('0px');
    expect(responseHosts.every((host) => host.className === 'briefing-directive__response-host')).toBe(true);
    expect(screen.getByLabelText('Pinned briefing document').querySelector('.briefing-directive__response-host.briefing-directive')).toBeNull();
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
    expect(screen.queryByText('Current actor note.')).toBeNull();
    const region = screen.getByText('Body').closest('.briefing-directive') as HTMLElement;
    fireEvent.click(region);
    expect(region.className).toContain('briefing-directive--selected');
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(region.className).toContain('briefing-directive--selected');
    const comment = screen.getByRole('button', { name: 'Comment' });
    fireEvent.click(comment);
    expect(comment.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Add annotation' })).toBeTruthy();
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
    const commentTab = within(dialog).getByRole('tab', { name: 'Comment' });
    const replacementTab = within(dialog).getByRole('tab', { name: 'Suggest replacement' });
    expect(commentTab.getAttribute('aria-selected')).toBe('true');
    expect(commentTab.parentElement?.children).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('status').textContent).toBe('Comment text is required.');
    fireEvent.keyDown(commentTab, { key: 'ArrowRight' });
    expect(replacementTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(replacementTab);
    expect(within(dialog).getByRole('button', { name: 'Save' }).classList.contains('btn--sm')).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
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
    await screen.findByText('Annotation updated.');

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Edit annotation by You: Clarify this.' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].annotations).toEqual([{ operation: 'retract', annotation_event_id: 'annotation-1' }]);
  });

  it('keeps repeated comments out of Markdown flow and shows inert newest-first attributed history with draft-only edit', async () => {
    const createdAt = Date.UTC(2026, 0, 2, 15, 4, 37);
    const older = annotation({
      annotation_event_id: 'saved-annotation', annotation_kind: 'suggest_replacement', body: 'Immutable policy note.',
      replacement_text: 'Updated policy', created_at: createdAt - 60_000,
      presentation: { source: 'annotation_set', actor: { slug: 'reviewer', display_name: 'Reviewer' } },
    });
    const newer = annotation({
      annotation_event_id: 'draft-annotation', body: 'Current follow-up.', created_at: createdAt,
      presentation: { source: 'current_draft', actor: null },
    });
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review plan" roundId="round-1"
      round={round({ annotations: [older, newer] as any })} canMutate onRefresh={async () => null} />);

    const keep = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
    await waitFor(() => expect(keep.disabled).toBe(false));
    expect(screen.queryByText('Immutable policy note.')).toBeNull();
    expect(screen.queryByText('Current follow-up.')).toBeNull();
    const comment = screen.getByRole('button', { name: 'Comment' });
    expect(comment.getAttribute('title')).toBe('Comment · 2');
    expect(comment.parentElement?.querySelector('.briefing-annotation-action__count')?.textContent).toBe('2');
    expect((comment as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(comment);

    const history = within(screen.getByRole('dialog')).getByRole('region', { name: 'Comment history' });
    const entries = within(history).getAllByRole('listitem');
    expect(entries[0].textContent).toContain('You');
    expect(entries[1].textContent).toContain('Reviewer');
    expect(entries[0].textContent).toContain('Current follow-up.');
    expect(entries[1].textContent).toContain('Immutable policy note.');
    expect(entries[1].textContent).toContain('Replace with “Updated policy”');
    expect(within(history).queryByText('Current draft')).toBeNull();
    expect(within(history).queryByText('Comment', { exact: true })).toBeNull();
    expect(entries[0].textContent).not.toContain(':37');
    expect(entries[0].classList.contains('briefing-annotation-history__entry--draft')).toBe(true);
    expect(within(entries[0]).getByRole('button', { name: 'Edit annotation by You: Current follow-up.' })).toBeTruthy();
    expect(within(entries[1]).queryByRole('button', { name: /Edit annotation/ })).toBeNull();
    fireEvent.click(within(entries[0]).getByText('Current follow-up.'));
    expect(screen.getByRole('dialog', { name: 'Add annotation' })).toBeTruthy();
  });

  it('keeps gutter counts on exact entity ranges across immutable and current-draft annotations', async () => {
    const exactSource = '# Section\n\n- Parent\n  - Child\n';
    const model = buildBriefingMarkdownModel(exactSource, [], {}, 0);
    const heading = model.entities.find((entity) => entity.kind === 'heading')!;
    const listItems = model.entities.filter((entity) => entity.kind === 'list-item');
    const child = listItems.reduce((smallest, entity) => entity.end - entity.start < smallest.end - smallest.start ? entity : smallest);
    const parent = listItems.find((entity) => entity !== child)!;
    const headingRawQuote = exactSource.slice(heading.start, heading.sectionEnd);
    const headingQuote = headingRawQuote.trim();
    const headingStart = heading.start + headingRawQuote.indexOf(headingQuote);
    const headingEnd = headingStart + headingQuote.length;
    const exactRound = round({
      document: {
        artifact_version_id: 'artifact-version:exact-entity',
        content_hash: createHash('sha256').update(exactSource).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v3',
        source: exactSource,
      },
      items: [],
      annotations: [
        annotation({ annotation_event_id: 'child-saved', start_offset: child.start, end_offset: child.end, quote: child.quote,
          presentation: { source: 'annotation_set', actor: { slug: 'reviewer', display_name: 'Reviewer' } } }),
        annotation({ annotation_event_id: 'child-draft', start_offset: child.start, end_offset: child.end, quote: child.quote,
          presentation: { source: 'current_draft', actor: null } }),
        annotation({ annotation_event_id: 'heading-saved', start_offset: headingStart, end_offset: headingEnd, quote: headingQuote,
          presentation: { source: 'annotation_set', actor: { slug: 'reviewer', display_name: 'Reviewer' } } }),
      ] as any,
    });
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Exact entities" roundId="round-1"
      round={exactRound} canMutate onRefresh={async () => null} />);

    const headingAction = await screen.findByRole('button', { name: `Comment on section ${heading.label}` });
    const parentAction = screen.getByRole('button', { name: `Comment on list-item: ${parent.label}` });
    const childAction = screen.getByRole('button', { name: `Comment on list-item: ${child.label}` });
    expect(headingAction.getAttribute('title')).toContain('· 1');
    expect(childAction.getAttribute('title')).toContain('· 2');
    expect(parentAction.getAttribute('title')).not.toContain('·');
    expect(headingAction.parentElement?.querySelector('.briefing-annotation-action__count')?.textContent).toBe('1');
    expect(childAction.parentElement?.querySelector('.briefing-annotation-action__count')?.textContent).toBe('2');
    expect(parentAction.parentElement?.querySelector('.briefing-annotation-action__count')).toBeNull();
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

    const concise = await screen.findByText('This is a layout and rail specimen.');
    expect(screen.queryByText('Detailed policy with more words.')).toBeNull();
    expect(screen.queryByText('Concise', { exact: true })).toBeNull();
    expect(screen.getByRole('group', { name: 'Text variant: Concise' })).toBeTruthy();
    const sourceTree = screen.getByLabelText('Pinned briefing document').querySelector('.briefing-document__source-tree') as HTMLElement;
    const owner = concise.closest('.briefing-directive--owner') as HTMLElement;
    const heading = screen.getByRole('heading', { name: 'Briefing directive layout specimens' });
    const responseHost = screen.getByRole('group', { name: 'Text variant: Concise' }).closest('.briefing-directive__response-host') as HTMLElement;
    const actionHost = owner.querySelector('[data-briefing-directive-action]') as HTMLElement;
    vi.spyOn(sourceTree, 'getBoundingClientRect').mockReturnValue({ x: 448, y: 0, left: 448, right: 1088, top: 0, bottom: 600, width: 640, height: 600, toJSON: () => ({}) });
    vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue({ x: 448, y: 40, left: 448, right: 928, top: 40, bottom: 64, width: 480, height: 24, toJSON: () => ({}) });
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue({ x: 448, y: 72, left: 448, right: 928, top: 72, bottom: 104, width: 480, height: 32, toJSON: () => ({}) });
    const variantControls = responseHost.querySelector('.briefing-directive__variant-controls') as HTMLElement;
    vi.spyOn(actionHost, 'getBoundingClientRect').mockImplementation(() => {
      const top = owner.getBoundingClientRect().top + Number.parseFloat(actionHost.style.getPropertyValue('--briefing-right-rail-top') || '0');
      return { x: 936, y: top, left: 936, right: 956, top, bottom: top + 20, width: 20, height: 20, toJSON: () => ({}) };
    });
    sourceTree.style.paddingRight = '160px';
    sourceTree.style.paddingBottom = '0px';
    owner.style.lineHeight = '24px';
    fireEvent(globalThis, new Event('resize'));
    expect(responseHost.previousElementSibling).toBe(owner);
    expect(responseHost.nextElementSibling).toBe(heading);
    expect(responseHost.className).toBe('briefing-directive__response-host');
    expect(changes).toEqual([]);
    const previous = screen.getByRole('button', { name: 'Previous text variant' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next text variant' }) as HTMLButtonElement;
    expect(variantControls.classList.contains('briefing-directive__compact-controls')).toBe(true);
    expect(previous.classList.contains('contextual-action--compact')).toBe(true);
    expect(next.classList.contains('contextual-action--compact')).toBe(true);
    expect(previous.disabled).toBe(true);
    await waitFor(() => expect(next.disabled).toBe(false));
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(next);
    expect(changes).toEqual([{ id: 'wording', value: { option_key: 'detailed' } }]);
    const detailed = await screen.findByText('Detailed policy with more words.');
    expect(within(detailed.closest('.briefing-directive--owner') as HTMLElement).getByRole('button', { name: 'Clear response' })).toBeTruthy();
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
