// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from './helpers/dom.js';
import { useRef, useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { establishTestClientAccess } from './helpers/local-client-access';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import type { BriefingResponseValue, BriefingRoundProjection } from '../ui/src/api';

import { BriefingDocumentPanel as DocumentPanel } from '../ui/src/views/feedback/BriefingDocumentPanel';
import type { MarkdownDocumentHandle } from '../ui/src/components/MarkdownDocument';
import { DocumentCommentsButton, useDocumentComments } from '../ui/src/components/shared/DocumentComments';
import { installReadingBrowserFixture } from './helpers/reading-browser-fixture';
import { selectBriefingEditorText, stubBriefingEditorBounds } from './helpers/briefing-editor';

function BriefingDocumentPanel(props: Pick<Parameters<typeof DocumentPanel>[0],
  'briefingId' | 'roundId' | 'round' | 'canMutate' | 'onRefresh' | 'draft' | 'onDirectiveValue'>) {
  const [suggesting, setSuggesting] = useState(false);
  const [refreshed, setRefreshed] = useState<BriefingRoundProjection | null>(null);
  const controller = useDocumentComments(props.roundId);
  const documentRef = useRef<MarkdownDocumentHandle>(null);
  const projection = refreshed ?? props.round;
  return <>
    <DocumentCommentsButton controller={controller} count={projection.annotations?.length ?? 0} />
    <DocumentPanel {...props} round={projection} comments={controller} documentRef={documentRef}
      draftIdentity={null} showChanges showSource={false} suggesting={suggesting} onSuggest={() => setSuggesting(true)}
      onRefresh={async () => {
        const updated = await props.onRefresh();
        if (updated) setRefreshed(updated);
        return updated;
      }}
      onChangePosition={() => {}} onPendingSuggestionChange={() => {}}
      onDocumentFailureChange={() => {}} onContentGateChange={() => {}} />
  </>;
}

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

let restoreLayout: () => void;
beforeEach(() => {
  establishTestClientAccess();
  stubBriefingEditorBounds();
  restoreLayout = installReadingBrowserFixture();
});

afterEach(() => {
  cleanup();
  restoreLayout();
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

  it('renders profiled directive bodies as sanitized prose without directive fences', async () => {
    const profiledSource = '# Review plan\n\nIntro\n:::spec-item{key="verdict" type="verdict" required="true"}\nBody ![photo](https://example.invalid/photo.png) <img src=x onerror=alert(1)>\n:::\nTail';
    vi.stubGlobal('fetch', vi.fn(async () => json({ content: {
      ...content().content,
      size_bytes: new TextEncoder().encode(profiledSource).byteLength,
      preview: { encoding: 'utf-8', text: profiledSource, raw_text: profiledSource, truncated: false },
    } })));
    const source = profiledSource;
    const start = source.indexOf(':::'); const bodyStart = source.indexOf('Body'); const bodyEnd = source.indexOf('\n:::', bodyStart);
    const definitionDigest = createHash('sha256').update(source.slice(start, bodyEnd + 4)).digest('hex');
    render(<BriefingDocumentPanel briefingId="briefing-1" roundId="round-1" round={round({
      document: {
        artifact_version_id: 'artifact-version:version-1',
        content_hash: createHash('sha256').update(profiledSource).digest('hex'),
        previous_round_id: null,
        profile: 'mandible-briefing.v2',
        source: profiledSource,
      },
      directive_binding: { status: 'valid', reason: null }, latest_frozen_membership: { answer_event_ids: [], annotation_event_ids: [] },
      annotations: [],
      items: [{ id: 'verdict', client_item_key: 'verdict', parent_item_id: null, item_kind: 'item', revision: { id: 'rev', ordinal: 1, title: '', prompt: source.slice(bodyStart, bodyEnd), description: null, response_type: 'verdict', required: true, position: 1, options: [] }, effective_response: null, responseVisible: true, directive: { key: 'verdict', definition_digest: definitionDigest, start_offset: start, end_offset: bodyEnd + 4, body_start_offset: bodyStart, body_end_offset: bodyEnd } }],
    })} canMutate onRefresh={async () => null} />);
    const keep = await screen.findByRole('button', { name: 'Keep' });
    expect(keep).toBeTruthy();
    expect(screen.queryByText(':::spec-item{key="verdict" type="verdict" required="true"}')).toBeNull();
    expect(screen.getByLabelText('Pinned briefing document').querySelector('img[src]')).toBeNull();
    expect(screen.getByLabelText('Directive text').querySelector('img[src]')).toBeNull();
  });

  it('edits a selected directive in the mounted Markdown editor and keeps the pinned anchor', async () => {
    const posts: unknown[] = [];
    const refresh = vi.fn(async () => round({ annotations: [annotation({
      annotation_event_id: 'annotation-new', annotation_kind: 'suggest_replacement', body: null,
      replacement_text: 'Revised plan', presentation: { source: 'current_draft', actor: null },
    })] }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return json({ annotation_event_ids: ['annotation-new'] });
    }));

    render(<BriefingDocumentPanel briefingId="briefing-1" roundId="round-1" round={round()} canMutate onRefresh={refresh} />);
    selectBriefingEditorText(await screen.findByLabelText('Directive text'), 'Plan');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit', exact: true }));
    const mountedEditor = () => EditorView.findFromDOM(screen.getByLabelText('Pinned briefing document').closest('.cm-editor') as HTMLElement)!;
    const surface = mountedEditor();
    await waitFor(() => expect(surface.state.readOnly).toBe(false));
    await waitFor(() => expect(surface.state.sliceDoc(surface.state.selection.main.from, surface.state.selection.main.to)).toBe('Plan'));
    surface.dispatch(surface.state.replaceSelection('Revised plan'));
    expect(mountedEditor()).toBe(surface);
    expect(screen.queryByRole('dialog')).toBeNull();

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/api/briefings/briefing-1/rounds/round-1/annotations',
      body: {
        annotations: [{
          operation: 'set', kind: 'suggest_replacement', start_offset: bodyStart, end_offset: bodyEnd,
          quote: 'Plan', replacement_text: 'Revised plan', body: null,
        }],
      },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(surface.state.doc.toString()).toBe(source.replace('Plan', 'Revised plan'));
  });

  it('posts an exact sub-selection across CRLF and a surrogate pair', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return json({ annotation_event_ids: ['range-comment'] });
    }));
    const source = 'Lead 😀\r\ncontinued.';
    const quote = '😀\r\ncon';
    render(<BriefingDocumentPanel briefingId="briefing-1" roundId="round-1"
      round={round({ items: [], document: { ...round().document!,
        profile: 'mandible-briefing.v3', source,
        content_hash: createHash('sha256').update('\uFEFF' + source).digest('hex'), utf8_bom: true,
      } })} canMutate onRefresh={async () => null} />);
    selectBriefingEditorText(await screen.findByLabelText('Pinned briefing document'), '😀\ncon');
    fireEvent.click(await screen.findByRole('button', { name: 'Comment', exact: true }));
    const composer = await screen.findByRole('textbox', { name: 'Add a comment…' });
    fireEvent.input(composer, { target: { value: 'Comment on the middle.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].annotations[0]).toEqual({
      operation: 'set', kind: 'comment', start_offset: 5, end_offset: 12,
      quote, body: 'Comment on the middle.', replacement_text: null,
    });
  });

  it('edits and deletes the current actor’s draft from the comments sidebar', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return json(content());
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return json({ annotation_event_ids: body.annotations.map((_: unknown, index: number) => `event-${index}`) });
    }));
    render(<BriefingDocumentPanel briefingId="briefing-1" roundId="round-1" round={round({ annotations: [annotation({
      presentation: { source: 'current_draft', actor: null },
    })] as any })} canMutate onRefresh={async () => round({ annotations: [annotation({ presentation: { source: 'current_draft', actor: null } })] })} />);

    const keepButton = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
    await waitFor(() => expect(keepButton.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Comments (1)' }));
    const drawer = screen.getByRole('dialog', { name: 'Comments' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Clarify this.' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit', exact: true }))[0]);
    const composer = (await screen.findAllByRole('textbox', { name: 'Add a comment…' }))[0];
    fireEvent.input(composer, { target: { value: 'Revised note.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].annotations).toEqual([
      { operation: 'retract', annotation_event_id: 'annotation-1' },
      {
        operation: 'set', kind: 'comment', start_offset: bodyStart, end_offset: bodyEnd,
        quote: 'Plan', body: 'Revised note.', replacement_text: null,
      },
    ]);
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Add a comment…' })).toBeNull());
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete', exact: true }))[0]);
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
      return <BriefingDocumentPanel briefingId="briefing-1" roundId="round-1" round={variantRound}
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
    selectBriefingEditorText(screen.getByLabelText('Directive text'), 'Detailed policy with more words.');
    fireEvent.click(await screen.findByRole('button', { name: 'Comment', exact: true }));
    const composer = await screen.findByRole('textbox', { name: 'Add a comment…' });
    fireEvent.input(composer, { target: { value: 'Keep the detailed wording.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].annotations).toEqual([{
      operation: 'set', kind: 'comment', start_offset: detailedStart, end_offset: detailedEnd,
      quote: 'Detailed policy with more words.', body: 'Keep the detailed wording.', replacement_text: null,
    }]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous text variant' }));
    expect(changes.at(-1)).toEqual({ id: 'wording', value: { option_key: 'concise' } });

    view.rerender(<Harness canMutate={false} />);
    expect((screen.getByRole('button', { name: 'Next text variant' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Comment', exact: true })).toBeNull();
  });
});
