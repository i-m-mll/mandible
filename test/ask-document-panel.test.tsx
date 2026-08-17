// jsdom cannot exercise CodeMirror selection geometry. This suite substitutes
// the editor boundary and tests the panel contract; decoration normalization
// and click resolution are covered by markdown-source-editor-annotations.test.tsx.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AskProjection } from '../ui/src/api';

const editorHarness = vi.hoisted(() => ({ props: null as any }));

vi.mock('../ui/src/views/spaces/MarkdownSourceEditor', () => ({
  MarkdownSourceEditor: (props: any) => {
    editorHarness.props = props;
    return (
      <div data-testid="document-editor" data-read-only={String(props.readOnly)}>
        <button type="button" onClick={() => props.onSelectionChange({ start: 0, end: 4, top: 10, left: 10 })}>
          Select source
        </button>
        <button type="button" onClick={() => props.onDecorationClick(props.decorations[0]?.id)}>
          Open decoration
        </button>
      </div>
    );
  },
}));

import { AskDocumentPanel } from '../ui/src/views/feedback/AskDocumentPanel';

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
    start_offset: 0,
    end_offset: 4,
    quote: 'Plan',
    body: 'Clarify this.',
    replacement_text: null,
    created_at: 1,
    ...overrides,
  };
}

function ask(overrides: Partial<AskProjection> = {}): AskProjection {
  return {
    ask_id: 'ask-1',
    state: 'open',
    request_key: 'review-plan',
    request_digest: 'digest',
    requester_user_id: 'agent-1',
    requester_session_id: 'session-1',
    responder_user_ids: ['human-1'],
    expires_at: 100,
    retention_expires_at: null,
    created_at: 1,
    lifecycle_event_id: 'life-1',
    latest_submission: null,
    latest_submission_for_actor: null,
    document: { artifact_version_id: 'artifact-version:version-1', previous_round_id: null },
    annotations: [],
    previous_round: null,
    items: [],
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
      size_bytes: 16,
      source: null,
      preview: { encoding: 'utf-8', text: 'Plan source text', truncated: false },
      download: { available: true, media_type: 'text/markdown', size_bytes: 16, filename: 'plan.md' },
    },
  };
}

afterEach(() => {
  cleanup();
  editorHarness.props = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AskDocumentPanel', () => {
  it('renders the full pinned source read-only and saves one selected-range suggestion before refetching', async () => {
    const posts: any[] = [];
    const refresh = vi.fn(async () => ask());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method) return json(content());
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ annotation_event_ids: ['annotation-new'] });
    }));

    render(<AskDocumentPanel ask={ask()} canMutate onRefresh={refresh} />);
    expect((await screen.findByTestId('document-editor')).getAttribute('data-read-only')).toBe('true');
    expect(editorHarness.props.value).toBe('Plan source text');

    fireEvent.click(screen.getByRole('button', { name: 'Select source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    expect(screen.getByRole('tab', { name: 'Comment' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Suggest replacement' }));
    expect((screen.getByLabelText('Replacement') as HTMLTextAreaElement).value).toBe('Plan');
    fireEvent.input(screen.getByLabelText('Replacement'), { target: { value: 'Revised plan' } });
    fireEvent.input(screen.getByLabelText('Note (optional)'), { target: { value: 'Explain the premise.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/api/asks/ask-1/annotations',
      body: {
        annotations: [{
          operation: 'set',
          annotation_kind: 'suggest_replacement',
          start_offset: 0,
          end_offset: 4,
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
    render(<AskDocumentPanel ask={ask({ annotations: [annotation()] as any })} canMutate onRefresh={async () => ask()} />);

    const row = await screen.findByRole('button', { name: /Plan.*Comment.*Clarify this/ });
    expect(row.tabIndex).toBe(0);
    fireEvent.click(row);
    fireEvent.input(screen.getByLabelText('Comment'), { target: { value: 'Revised note.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].annotations).toEqual([
      { operation: 'retract', annotation_event_id: 'annotation-1' },
      {
        operation: 'set', annotation_kind: 'comment', start_offset: 0, end_offset: 4,
        quote: 'Plan', body: 'Revised note.',
      },
    ]);
    await screen.findByText('Annotation updated.');

    fireEvent.click(screen.getByRole('button', { name: /Plan.*Comment.*Clarify this/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].annotations).toEqual([{ operation: 'retract', annotation_event_id: 'annotation-1' }]);
  });

  it('shows collapsed quote-first prior-round history linking to the old ask without decorating old quotes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(content())));
    const prior = annotation({
      annotation_event_id: 'old-annotation',
      quote: 'Old premise',
      actor_user_id: 'human-2',
      submission_ordinal: 3,
    });
    render(<AskDocumentPanel
      ask={ask({
        annotations: [annotation()] as any,
        previous_round: {
          ask_id: 'ask-old',
          artifact_version_id: 'artifact-version:old',
          annotations: [prior as any],
        },
      })}
      canMutate
      onRefresh={async () => ask()}
    />);

    const history = await screen.findByText('Round history');
    await screen.findByTestId('document-editor');
    expect((history.closest('details') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByRole('link', { name: /Old premise.*Comment.*Clarify this.*human-2.*3/ }).getAttribute('href'))
      .toBe('/#/briefing?ask=ask-old');
    expect(editorHarness.props.decorations.map((entry: any) => entry.id)).toEqual(['annotation-1']);
  });
});
