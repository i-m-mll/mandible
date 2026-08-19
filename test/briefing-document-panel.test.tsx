import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BriefingRoundProjection } from '../ui/src/api';

import { BriefingDocumentPanel } from '../ui/src/views/feedback/BriefingDocumentPanel';
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
    document: { artifact_version_id: 'artifact-version:version-1', previous_round_id: null, profile: 'mandible-briefing.v2' },
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
    expect(within(verdict).getByRole('button', { name: 'Keep' })).toBeTruthy();
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
    fireEvent.click(within(rating).getByRole('radio', { name: '5' }));
    expect(changes).toEqual(expect.arrayContaining([
      { id: 'single', value: { option_key: 'b' } },
      { id: 'multi', value: { option_keys: ['first', 'third'] } },
      { id: 'short', value: { text: '  exact  ' } },
      { id: 'long', value: { text: 'Detailed' } },
      { id: 'rating', value: { rating: 5 } },
    ]));
    expect(screen.getAllByLabelText('Required')).toHaveLength(6);
    const shortSection = short.closest('.briefing-directive') as HTMLElement;
    fireEvent.click(within(shortSection).getByRole('button', { name: 'Clear answer' }));
    expect(changes.at(-1)).toEqual({ id: 'short', value: null });
  });

  it('binds directive hover to the content and control interaction region', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(content())));
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review plan" roundId="round-1" round={round()} canMutate onRefresh={async () => null} />);

    const keep = await screen.findByRole('button', { name: 'Keep' });
    const directive = keep.closest('.briefing-directive') as HTMLElement;
    const interaction = directive.firstElementChild as HTMLElement;
    const directiveRule = briefingStylesheet.match(/\.briefing-directive \{([^}]*)\}/)?.[1] ?? '';
    const interactionRule = briefingStylesheet.match(/\.briefing-directive__interaction \{([^}]*)\}/)?.[1] ?? '';

    expect(interaction.classList.contains('briefing-directive__interaction')).toBe(true);
    expect(interaction.querySelector('.briefing-directive__passage')).toBeTruthy();
    expect(interaction.querySelector('.briefing-directive__actions')).toBeTruthy();
    expect(directiveRule).toContain('padding: var(--space-3)');
    expect(interactionRule).not.toContain('padding:');
    expect(briefingStylesheet).toMatch(/\.briefing-directive:not\(\.briefing-directive--selected\):has\(> \.briefing-directive__interaction:hover\)/);
    expect(briefingStylesheet).toMatch(/\.briefing-directive__interaction:hover \.briefing-directive__actions/);
    expect(briefingStylesheet).not.toMatch(/\.briefing-directive:hover(?:\s|,|\{)/);
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
      document: { artifact_version_id: 'artifact-version:version-1', previous_round_id: null, profile: 'mandible-briefing.v2' },
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
    const region = keep.closest('.briefing-directive') as HTMLElement;
    fireEvent.click(region);
    expect(region.className).toContain('briefing-directive--selected');
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(region.className).not.toContain('briefing-directive--selected');
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
    fireEvent.click(await screen.findByRole('button', { name: 'Comment' }));
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

  it('opens a focusable annotation row, edits by retract+set, and deletes by retract', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return json(content());
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return json({ annotation_event_ids: body.annotations.map((_: unknown, index: number) => `event-${index}`) });
    }));
    render(<BriefingDocumentPanel briefingId="briefing-1" briefingTitle="Review plan" roundId="round-1" round={round({ annotations: [annotation()] as any })} canMutate onRefresh={async () => round()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Plan.*Comment.*Clarify this/ }));
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

});
