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

describe('Briefing document panel', () => {
  it('renders profiled directive bodies as sanitized prose without directive fences', async () => {
    const profiledSource = 'Intro\n:::spec-item{key="verdict" required="true"}\nBody <img src=x onerror=alert(1)>\n:::\nTail';
    vi.stubGlobal('fetch', vi.fn(async () => json({ content: {
      ...content().content,
      size_bytes: new TextEncoder().encode(profiledSource).byteLength,
      preview: { encoding: 'utf-8', text: profiledSource, raw_text: profiledSource, truncated: false },
    } })));
    const source = profiledSource;
    const start = source.indexOf(':::'); const bodyStart = source.indexOf('Body'); const bodyEnd = source.indexOf('\n:::', bodyStart);
    render(<AskDocumentPanel briefingId="briefing-1" roundId="round-1" ask={ask({
      document: { artifact_version_id: 'artifact-version:version-1', previous_round_id: null, profile: 'mandible-briefing.v1' },
      directive_binding: { status: 'valid', reason: null }, latest_frozen_membership: { answer_event_ids: [], annotation_event_ids: [] },
      items: [{ id: 'verdict', client_item_key: 'verdict', parent_item_id: null, item_kind: 'item', revision: { id: 'rev', ordinal: 1, title: '', prompt: 'Body', description: null, response_type: 'verdict', required: true, position: 1, options: [] }, effective_response: null, responseVisible: true, directive: { key: 'verdict', definition_digest: 'a'.repeat(64), start_offset: start, end_offset: bodyEnd + 4, body_start_offset: bodyStart, body_end_offset: bodyEnd } }],
    })} canMutate onRefresh={async () => null} onDirectiveVerdict={() => undefined} />);
    const keep = await screen.findByRole('button', { name: 'Keep' });
    expect(keep).toBeTruthy();
    expect(screen.queryByText(':::spec-item{key="verdict" required="true"}')).toBeNull();
    expect(screen.getByText(/Body/).querySelector('img')).toBeNull();
    const region = keep.closest('.briefing-directive') as HTMLElement;
    fireEvent.click(region);
    expect(region.className).toContain('briefing-directive--selected');
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(region.className).not.toContain('briefing-directive--selected');
  });

  it('renders the full pinned source read-only and saves one selected-range suggestion before refetching', async () => {
    const posts: any[] = [];
    const refresh = vi.fn(async () => ask());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method) return json(content());
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ annotation_event_ids: ['annotation-new'] });
    }));

    render(<AskDocumentPanel briefingId="briefing-1" roundId="round-1" ask={ask()} canMutate onRefresh={refresh} />);
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
      url: '/api/briefings/briefing-1/rounds/round-1/annotations',
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
    render(<AskDocumentPanel briefingId="briefing-1" roundId="round-1" ask={ask({ annotations: [annotation()] as any })} canMutate onRefresh={async () => ask()} />);

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

});
