import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShellProvider } from '../ui/src/app-shell';
import { normalizeAskProjection } from '../ui/src/api';
import { BriefingView } from '../ui/src/views/briefing';
import { BoundedAskRenderer } from '../ui/src/views/feedback/BoundedAskRenderer';
import {
  BRIEFING_VIEW_STATE_KEY,
  DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
} from '../ui/src/views/feedback/collection-view-state';
import {
  askDraftStorageKey,
  loadAskDraft,
  normalizeAskDraft,
  saveAskDraft,
} from '../ui/src/views/feedback/ask-view-state';

function installMemoryLocalStorage(): Storage {
  const rows = new Map<string, string>();
  const storage: Storage = {
    get length() { return rows.size; },
    clear: () => rows.clear(),
    getItem: (key) => rows.get(key) ?? null,
    key: (index) => [...rows.keys()][index] ?? null,
    removeItem: (key) => { rows.delete(key); },
    setItem: (key, value) => { rows.set(key, String(value)); },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  return storage;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function item(
  id: string,
  responseType: 'verdict' | 'free_text' | 'single_choice' | 'multi_choice' | null,
  options: Array<{ option_key: string; label: string }> = [],
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    client_item_key: id,
    parent_item_id: extra.parent_item_id ?? null,
    item_kind: responseType === null ? 'group' : 'item',
    revision: {
      id: `rev-${id}`,
      ordinal: 1,
      title: String(extra.title ?? id),
      prompt: String(extra.prompt ?? `Prompt ${id}`),
      description: extra.description ?? null,
      response_type: responseType,
      required: extra.required === true,
      position: Number(extra.position ?? 0),
      options: options.map((option, position) => ({ ...option, description: null, position })),
    },
    effective_response: extra.effective_response ?? null,
    ...(extra.directive ? { directive: extra.directive } : {}),
  };
}

function askPayload(overrides: Record<string, unknown> = {}) {
  return {
    ask_id: 'ask-1',
    state: 'open',
    request_key: 'review-plan',
    request_digest: 'digest',
    requester_user_id: 'agent-1',
    requester_session_id: 'session-1',
    responder_user_ids: ['human-1'],
    expires_at: Date.now() + 60_000,
    retention_expires_at: null,
    created_at: Date.now(),
    lifecycle_event_id: 'life-open',
    latest_submission: null,
    latest_submission_for_actor: null,
    document: null,
    annotations: [],
    previous_round: null,
    lifecycle: { id: 'life-open', operation: 'opened', actor_user_id: null, created_at: 1 },
    items: [
      item('group', null, [], { title: '<b>Questions</b>', position: 0 }),
      item('verdict', 'verdict', [], { parent_item_id: 'group', required: true, position: 1 }),
      item('text', 'free_text', [], { parent_item_id: 'group', position: 2 }),
      item('single', 'single_choice', [
        { option_key: 'stable-a', label: 'Display A' },
        { option_key: 'stable-b', label: '<img src=x onerror=alert(1)>' },
      ], { parent_item_id: 'group', required: true, position: 3 }),
      item('multi', 'multi_choice', [
        { option_key: 'm1', label: 'Multi one' },
        { option_key: 'm2', label: 'Multi two' },
      ], { position: 4 }),
    ],
    ...overrides,
  };
}

function shell(child: JSX.Element) {
  return (
    <AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined }}>
      {child}
    </AppShellProvider>
  );
}

beforeEach(() => installMemoryLocalStorage());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bounded ask renderer', () => {
  it('fails closed for malformed profiled directive projections', () => {
    const profiled = askPayload({
      document: { artifact_version_id: 'artifact-version:current', previous_round_id: null, profile: 'mandible-briefing.v1' },
      directive_binding: { status: 'valid' },
      latest_frozen_membership: null,
      items: [item('verdict', 'verdict', [], {
        required: true,
        directive: { key: 'verdict', definition_digest: 'a'.repeat(64), start_offset: 0, end_offset: 32, body_start_offset: 20, body_end_offset: 28 },
      })],
    });
    expect(normalizeAskProjection(profiled).valid).toBe(true);
    expect(normalizeAskProjection({ ...profiled, directive_binding: { status: 'valid', reason: 1 } }).valid).toBe(false);
    expect(normalizeAskProjection({ ...profiled, document: { ...profiled.document as object, profile: 'unknown.v1' } }).valid).toBe(false);
    expect(normalizeAskProjection({ ...profiled, items: [item('verdict', 'free_text', [], {
      directive: { key: 'verdict', definition_digest: 'a'.repeat(64), start_offset: 0, end_offset: 32, body_start_offset: 20, body_end_offset: 28 },
    })] }).valid).toBe(false);
    expect(normalizeAskProjection(askPayload({ document: { artifact_version_id: 'artifact-version:legacy', previous_round_id: null, profile: null }, directive_binding: null })).valid).toBe(true);
  });

  it('normalizes the exact document, annotation, and previous-round projection shapes', () => {
    const current = {
      annotation_event_id: 'annotation-current',
      annotation_kind: 'suggest_replacement',
      start_offset: 0,
      end_offset: 4,
      quote: 'Plan',
      body: null,
      replacement_text: '',
      created_at: 2,
    };
    const projection = normalizeAskProjection(askPayload({
      document: { artifact_version_id: 'artifact-version:current', previous_round_id: 'ask-old' },
      annotations: [current],
      previous_round: {
        ask_id: 'ask-old',
        artifact_version_id: 'artifact-version:old',
        annotations: [{ ...current, annotation_event_id: 'annotation-old', actor_user_id: 'human-2', submission_ordinal: 3 }],
      },
    }));
    expect(projection.valid).toBe(true);
    expect(projection.document).toEqual({ artifact_version_id: 'artifact-version:current', previous_round_id: 'ask-old', profile: null });
    expect(projection.annotations).toEqual([current]);
    expect(projection.previous_round?.annotations[0]).toMatchObject({
      annotation_event_id: 'annotation-old', actor_user_id: 'human-2', submission_ordinal: 3,
    });

    const malformed = normalizeAskProjection(askPayload({
      annotations: [{ ...current, annotation_kind: 'comment', body: 'Note', replacement_text: 'forbidden' }],
    }));
    expect(malformed.valid).toBe(false);
  });

  it('keeps directive controls and Submit disabled when pinned content fails binding verification', async () => {
    const source = ':::spec-item{key="verdict" required="true"}\nPrompt verdict\n:::\n';
    const bodyStart = source.indexOf('Prompt verdict');
    const bodyEnd = source.indexOf('\n:::', bodyStart);
    const directiveEnd = bodyEnd + '\n:::'.length;
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return json({ authenticated: true, user: { id: 'human-1', kind: 'human' } });
      if (url === '/api/asks/ask-1' && !init?.method) return json(askPayload({
        document: { artifact_version_id: 'artifact-version:current', previous_round_id: null, profile: 'mandible-briefing.v1' },
        directive_binding: { status: 'valid' },
        latest_frozen_membership: null,
        items: [item('verdict', 'verdict', [], {
          prompt: 'Prompt verdict',
          required: true,
          directive: {
            key: 'verdict', definition_digest: '0'.repeat(64), start_offset: 0,
            end_offset: directiveEnd, body_start_offset: bodyStart, body_end_offset: bodyEnd,
          },
        })],
      }));
      if (url === '/api/artifacts/artifact-version%3Acurrent/content') return json({ content: {
        artifact_id: 'artifact:briefing', status: 'available', kind: 'markdown', media_type: 'text/markdown',
        size_bytes: new TextEncoder().encode(source).byteLength, source: null,
        preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false },
        download: { available: true, media_type: 'text/markdown', size_bytes: new TextEncoder().encode(source).byteLength, filename: 'briefing.md' },
      } });
      if (init?.method === 'POST') { posts.push(url); return json({}); }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    }));

    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    const keep = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
    const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText(/does not match its binding/)).toBeTruthy());
    expect(keep.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    fireEvent.click(keep);
    fireEvent.click(submit);
    expect(posts).toEqual([]);
  });

  it('loads the deep-linked ask, renders all frozen types and groups as inert composition, and mutates only on Submit', async () => {
    const requests: Array<{ url: string; body: any }> = [];
    let projection = askPayload();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/client-auth/whoami') return json({ authenticated: true, user: { id: 'human-1', slug: 'human', kind: 'human', display_name: 'Human' } });
      if (url === '/api/asks/ask-1' && method === 'GET') return json(projection);
      if (url === '/api/asks/ask-1/answers') {
        const body = JSON.parse(String(init?.body));
        requests.push({ url, body });
        return json({ answer_event_ids: body.answers.map((_: unknown, index: number) => `event-${index}`) });
      }
      if (url === '/api/asks/ask-1/submit') {
        requests.push({ url, body: JSON.parse(String(init?.body)) });
        projection = askPayload({ state: 'submitted', lifecycle_event_id: 'life-submitted', latest_submission: { id: 'submission-1', ordinal: 1 } });
        return json({ state: 'submitted', submission: { id: 'submission-1' } });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    expect(await screen.findByRole('heading', { name: 'review-plan' })).toBeTruthy();
    expect(screen.getByText('<b>Questions</b>').querySelector('b')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>').querySelector('img')).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(4); // verdict + single choice
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByRole('textbox')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Keep'));
    fireEvent.input(screen.getByRole('textbox'), { target: { value: '  answer  ' } });
    fireEvent.click(screen.getByLabelText('Display A'));
    fireEvent.click(screen.getByLabelText('Multi two'));
    expect(requests).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].body.answers).toEqual([
      expect.objectContaining({ item_id: 'verdict', value: { verdict: 'keep' }, expected_response_event_id: null }),
      expect.objectContaining({ item_id: 'text', value: { text: '  answer  ' }, expected_response_event_id: null }),
      expect.objectContaining({ item_id: 'single', value: { option_key: 'stable-a' }, expected_response_event_id: null }),
      expect.objectContaining({ item_id: 'multi', value: { option_keys: ['m2'] }, expected_response_event_id: null }),
    ]);
    expect(requests[0].body.answers.some((answer: any) => answer.item_id === 'group')).toBe(false);
    expect(JSON.stringify(requests)).not.toContain('Display A');
    expect(requests[1].body).toMatchObject({ expected_lifecycle_event_id: 'life-open' });
    expect(requests[1].body).not.toHaveProperty('supersedes_submission_id');
    expect(requests[1].body.answers).toEqual([
      { item_id: 'verdict', item_revision_id: 'rev-verdict', response_event_id: 'event-0' },
      { item_id: 'text', item_revision_id: 'rev-text', response_event_id: 'event-1' },
      { item_id: 'single', item_revision_id: 'rev-single', response_event_id: 'event-2' },
      { item_id: 'multi', item_revision_id: 'rev-multi', response_event_id: 'event-3' },
    ]);
    expect(requests[1].body.annotations).toEqual([]);
  });

  it('submits the exact effective annotation event membership', async () => {
    const submissions: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('whoami')) return json({ authenticated: true, user: { id: 'human-1', kind: 'human' } });
      if (url === '/api/asks/ask-1' && !init?.method) return json(askPayload({
        items: [],
        annotations: [
          {
            annotation_event_id: 'annotation-current',
            annotation_kind: 'comment',
            start_offset: 0,
            end_offset: 4,
            quote: 'Plan',
            body: 'Clarify this.',
            replacement_text: null,
            created_at: 1,
          },
        ],
      }));
      if (url.endsWith('/submit')) {
        submissions.push(JSON.parse(String(init?.body)));
        return json({ state: 'submitted', submissions: [] });
      }
      throw new Error(`unexpected ${url}`);
    }));

    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0].annotations).toEqual([{ annotation_event_id: 'annotation-current' }]);
  });

  it('validates every required type before either network mutation', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('whoami')) return json({ authenticated: true, user: { id: 'human-1', kind: 'human' } });
      if (url === '/api/asks/ask-1') return json(askPayload({ items: [
        item('verdict', 'verdict', [], { required: true, position: 0 }),
        item('text', 'free_text', [], { required: true, position: 1 }),
        item('single', 'single_choice', [{ option_key: 's', label: 'S' }], { required: true, position: 2 }),
        item('multi', 'multi_choice', [{ option_key: 'm', label: 'M' }], { required: true, position: 3 }),
      ] }));
      throw new Error(`unexpected ${url}`);
    }));
    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    await screen.findByRole('button', { name: 'Submit' });
    fireEvent.input(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect((await screen.findByRole('alert')).textContent).toContain('4 required answers');
    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(0);
  });

  it('uses existing answer CAS, retracts omitted optional answers, and refresh-safe latest submission identity for a correction', async () => {
    const posts: Array<{ url: string; body: any }> = [];
    const submitted = askPayload({
      state: 'submitted',
      lifecycle_event_id: 'life-previous',
      latest_submission: { id: 'authoritative-submission', ordinal: 4 },
      latest_submission_for_actor: { id: 'authoritative-submission', ordinal: 4 },
      items: [
        item('single', 'single_choice', [
          { option_key: 'a', label: 'A' }, { option_key: 'b', label: 'B' },
        ], { required: true, effective_response: { response_event_id: 'old-single', value: { option_key: 'a' } } }),
        item('text', 'free_text', [], { position: 1, effective_response: { response_event_id: 'old-text', value: { text: 'old' } } }),
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('whoami')) return json({ authenticated: true, user: { id: 'human-1', kind: 'human' } });
      if (url === '/api/asks/ask-1' && !init?.method) return json(submitted);
      const body = JSON.parse(String(init?.body));
      posts.push({ url, body });
      if (url.endsWith('/answers')) return json({ answer_event_ids: ['new-single', 'retract-text'] });
      return json({ state: 'submitted', submission: { id: 'next' } });
    }));

    const first = render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    await screen.findByRole('button', { name: 'Submit' });
    first.unmount();
    // A full remount/refresh obtains both the effective response and the latest
    // submission ID from GET, not component memory from the prior mount.
    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    await screen.findByRole('button', { name: 'Submit' });
    fireEvent.click(screen.getByLabelText('B'));
    fireEvent.input(screen.getByRole('textbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0].body.answers).toEqual([
      expect.objectContaining({ item_id: 'single', operation: 'set', expected_response_event_id: 'old-single', value: { option_key: 'b' } }),
      expect.objectContaining({ item_id: 'text', operation: 'retract', expected_response_event_id: 'old-text' }),
    ]);
    expect(posts[1].body).toMatchObject({
      expected_lifecycle_event_id: 'life-previous',
      supersedes_submission_id: 'authoritative-submission',
      answers: [{ item_id: 'single', item_revision_id: 'rev-single', response_event_id: 'new-single' }],
    });
  });

  it('refetches on 409 and answer-success/submit-failure while preserving the local draft', async () => {
    let answers = 0;
    let reads = 0;
    const submissions: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('whoami')) return json({ authenticated: true, user: { id: 'human-1', kind: 'human' } });
      if (url === '/api/asks/ask-1' && !init?.method) {
        reads += 1;
        return json(reads === 1
          ? askPayload({ items: [item('text', 'free_text', [], { required: true })] })
          : askPayload({
              state: 'submitted',
              lifecycle_event_id: 'life-authoritative',
              latest_submission: { id: 'submission-authoritative', ordinal: 1 },
              latest_submission_for_actor: { id: 'submission-authoritative', ordinal: 1 },
              items: [item('text', 'free_text', [], {
                required: true,
                effective_response: { response_event_id: 'landed-answer', value: { text: 'unsaved local value' } },
              })],
            }));
      }
      if (url.endsWith('/answers')) { answers += 1; return json({ answer_event_ids: ['landed-answer'] }); }
      submissions.push(JSON.parse(String(init?.body)));
      return submissions.length === 1
        ? json({ error: 'stale lifecycle' }, 409)
        : json({ state: 'submitted', submission: { id: 'correction' } });
    }));
    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    const textbox = await screen.findByRole('textbox');
    fireEvent.input(textbox, { target: { value: 'unsaved local value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('ask changed'));
    expect(answers).toBe(1);
    expect(reads).toBeGreaterThan(1);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('unsaved local value');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(submissions).toHaveLength(2));
    expect(answers).toBe(1);
    expect(submissions[1]).toEqual({
      expected_lifecycle_event_id: 'life-authoritative',
      supersedes_submission_id: 'submission-authoritative',
      answers: [{ item_id: 'text', item_revision_id: 'rev-text', response_event_id: 'landed-answer' }],
      annotations: [],
    });
  });

  it('coalesces ask SSE reconciliation without overwriting an unsaved draft', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('whoami')) return json({ authenticated: true, user: { id: 'human-1', kind: 'human' } });
      reads += 1;
      return json(askPayload({ items: [item('text', 'free_text')] }));
    }));
    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    const textbox = await screen.findByRole('textbox');
    fireEvent.input(textbox, { target: { value: 'draft survives SSE' } });
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'ask:submitted' } }));
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'ask:cancelled' } }));
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'ask:expired' } }));
    await waitFor(() => expect(reads).toBe(2));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('draft survives SSE');
  });

  it('isolates drafts by responder and degrades safely for malformed or unavailable storage', () => {
    const projection = normalizeAskProjection(askPayload());
    const storage = window.localStorage;
    saveAskDraft(storage, 'human-1', projection.ask_id, { text: { text: 'private' } });
    expect(loadAskDraft(storage, 'human-1', projection.ask_id, projection.items)).toEqual({ text: { text: 'private' } });
    expect(loadAskDraft(storage, 'human-2', projection.ask_id, projection.items)).toEqual({});
    storage.setItem(askDraftStorageKey('human-1', projection.ask_id), '{bad');
    expect(loadAskDraft(storage, 'human-1', projection.ask_id, projection.items)).toEqual({});
    expect(normalizeAskDraft({ version: 1, answers: { unknown: { text: 'x' }, multi: { option_keys: ['m2', 'm2', 'bad'] } } }, projection.items))
      .toEqual({ multi: { option_keys: ['m2'] } });
    const broken = { getItem: () => { throw new Error('disabled'); } };
    expect(loadAskDraft(broken, 'human-1', projection.ask_id, projection.items)).toEqual({});
  });

  it('restores a responder draft after a real remount', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('whoami')
      ? json({ authenticated: true, user: { id: 'human-1', kind: 'human' } })
      : json(askPayload({ items: [item('text', 'free_text')] }))));
    const first = render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    fireEvent.input(await screen.findByRole('textbox'), { target: { value: 'persisted private draft' } });
    await waitFor(() => expect(window.localStorage.getItem(askDraftStorageKey('human-1', 'ask-1')))
      .toContain('persisted private draft'));
    first.unmount();
    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    expect((await screen.findByRole('textbox') as HTMLTextAreaElement).value).toBe('persisted private draft');
  });

  it('keeps drafts memory-only without identity and survives quota failures while mounted', async () => {
    let setAttempts = 0;
    const quotaStorage: Storage = {
      length: 0,
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => { setAttempts += 1; throw new Error('quota exceeded'); },
    };
    Object.defineProperty(window, 'localStorage', { value: quotaStorage, configurable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: quotaStorage, configurable: true });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('whoami')
      ? json({ authenticated: true, user: { id: 'human-1', kind: 'human' } })
      : json(askPayload({ items: [item('text', 'free_text')] }))));
    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    fireEvent.input(await screen.findByRole('textbox'), { target: { value: 'quota-safe draft' } });
    await waitFor(() => expect(setAttempts).toBeGreaterThan(0));
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'ask:submitted' } }));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('quota-safe draft'));

    cleanup();
    const memoryStorage = installMemoryLocalStorage();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('whoami')
      ? json({ authenticated: false, user: null })
      : json(askPayload({ items: [item('text', 'free_text')] }))));
    render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
    fireEvent.input(await screen.findByRole('textbox'), { target: { value: 'identity-free draft' } });
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'ask:expired' } }));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('identity-free draft'));
    expect(memoryStorage.length).toBe(0);
  });

  it('gates requester, every terminal lifecycle, malformed projections, and preview instances read-only', async () => {
    for (const payload of [
      askPayload({ responder_user_ids: ['someone-else'] }),
      askPayload({ state: 'expired', lifecycle_event_id: 'expired' }),
      askPayload({ state: 'cancelled', lifecycle_event_id: 'cancelled' }),
      askPayload({ state: 'closed', lifecycle_event_id: 'closed' }),
      askPayload({ items: [{ ...item('unsupported', 'free_text'), revision: { ...item('unsupported', 'free_text').revision, response_type: 'resource_ref' } }] }),
      askPayload({ items: [item('required-group', null, [], { required: true })] }),
      askPayload({ items: [item('empty-choice', 'single_choice')] }),
      askPayload({ items: [item('verdict-options', 'verdict', [{ option_key: 'wrong', label: 'Wrong' }])] }),
      askPayload({ items: [item('unknown-single', 'single_choice', [{ option_key: 'known', label: 'Known' }], {
        effective_response: { response_event_id: 'response', value: { option_key: 'unknown' } },
      })] }),
      askPayload({ items: [item('unknown-multi', 'multi_choice', [{ option_key: 'known', label: 'Known' }], {
        effective_response: { response_event_id: 'response', value: { option_keys: ['unknown'] } },
      })] }),
      askPayload({ latest_submission: { id: 'impossible-open-submission', ordinal: 1 } }),
      askPayload({ state: 'submitted', lifecycle_event_id: 'submitted', latest_submission: null }),
    ]) {
      cleanup();
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('whoami')
        ? json({ authenticated: true, user: { id: 'human-1', kind: 'human' } })
        : json(payload)));
      render(shell(<BoundedAskRenderer askId="ask-1" instance={null} />));
      await waitFor(() => expect(screen.queryByText('Loading ask…')).toBeNull());
      expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    }
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('whoami')
      ? json({ authenticated: true, user: { id: 'human-1', kind: 'human' } })
      : json(askPayload())));
    render(shell(<BoundedAskRenderer askId="ask-1" instance={{ role: 'preview', operational_mutations: 'reject', operational_mutations_overridden: false, db_path: null, db_path_source: null }} />));
    await screen.findByText(/read-only for the current identity or instance/i);
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('loads ask deep links inside the shared shell and reconciles later ask navigation', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/briefing/queue') return json({ candidates: [], sources: [] });
      if (url.includes('whoami')) return json({ authenticated: true, user: { id: 'human-1', kind: 'human' } });
      if (url.startsWith('/api/asks/')) {
        const id = decodeURIComponent(url.split('/').pop()!);
        seen.push(id);
        return json(askPayload({ ask_id: id, request_key: `Ask ${id}` }));
      }
      throw new Error(`unexpected ${url}`);
    }));
    const rendered = render(shell(<BriefingView instance={null} initialAskId="ask-1" sidebarHidden />));
    expect(await screen.findByRole('heading', { name: 'Ask ask-1' })).toBeTruthy();
    expect(screen.queryByTestId('feedback-collections-sidebar')).toBeNull();
    rendered.rerender(shell(<BriefingView instance={null} initialAskId="ask-2" sidebarHidden />));
    expect(await screen.findByRole('heading', { name: 'Ask ask-2' })).toBeTruthy();
    expect(seen).toContain('ask-2');
  });

  it('clears stale ask authority during failed later navigation and ignores the old mutation completion', async () => {
    let resolveAnswers!: (response: Response) => void;
    let resolveAskB!: (response: Response) => void;
    const pendingAnswers = new Promise<Response>((resolve) => { resolveAnswers = resolve; });
    const pendingAskB = new Promise<Response>((resolve) => { resolveAskB = resolve; });
    let answerStarted = false;
    const submissions: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/briefing/queue') return json({ candidates: [], sources: [] });
      if (url.includes('whoami')) return json({ authenticated: true, user: { id: 'human-1', kind: 'human' } });
      if (url === '/api/asks/ask-1' && !init?.method) {
        return json(askPayload({ items: [item('text', 'free_text', [], { required: true })] }));
      }
      if (url === '/api/asks/ask-2' && !init?.method) return pendingAskB;
      if (url === '/api/asks/ask-1/answers') {
        answerStarted = true;
        return pendingAnswers;
      }
      if (url === '/api/asks/ask-1/submit') {
        submissions.push(JSON.parse(String(init?.body)));
        return json({ state: 'submitted', submission: { id: 'submission-a' } });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    }));
    const rendered = render(shell(<BriefingView instance={null} initialAskId="ask-1" sidebarHidden />));
    fireEvent.input(await screen.findByRole('textbox'), { target: { value: 'submit A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(answerStarted).toBe(true));

    rendered.rerender(shell(<BriefingView instance={null} initialAskId="ask-2" sidebarHidden />));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'review-plan' })).toBeNull());
    expect(screen.getByText('Loading ask…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();

    resolveAnswers(json({ answer_event_ids: ['answer-a'] }));
    await waitFor(() => expect(submissions).toHaveLength(1));
    resolveAskB(json({ error: 'ask B unavailable' }, 500));
    expect((await screen.findByRole('alert')).textContent).toContain('ask B unavailable');
    expect(screen.queryByRole('heading', { name: 'review-plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('preserves ask draft and recurring shell state while switching collections', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/feedback/collections') return json({ state: 'all', collections: [
        {
          id: 'recurring', kind: 'recurring_feed', interaction_mode: 'immediate_per_item',
          state: 'open', source: 'alpha', label: 'alpha', item_count: 0,
          expires_at: null, created_at: 1, updated_at: 1, expiry_reversible: 0,
        },
        {
          id: 'ask-1', kind: 'bounded_ask', interaction_mode: 'explicit_submit',
          state: 'open', source: null, label: 'review-plan', item_count: 1,
          expires_at: Date.now() + 60_000, created_at: 2, updated_at: 2, expiry_reversible: 0,
        },
      ] });
      if (url === '/api/briefing/queue') return json({
        candidates: [],
        sources: [{
          source: 'alpha', pending_count: 0, last_ingested_at: 1, last_ingest_age_ms: 0,
          last_task_identity: 'task/alpha', last_run_id: 'run', last_digest_version: 1,
          last_batch_item_count: 0,
        }],
      });
      if (url.includes('whoami')) return json({ authenticated: true, user: { id: 'human-1', kind: 'human' } });
      if (url === '/api/asks/ask-1') return json(askPayload({ items: [item('text', 'free_text')] }));
      throw new Error(`unexpected ${url}`);
    }));
    render(shell(<BriefingView instance={null} />));
    await screen.findByRole('button', { name: 'Select collection alpha' });
    fireEvent.click(screen.getByRole('button', { name: 'Select collection review-plan' }));
    const textbox = await screen.findByRole('textbox');
    fireEvent.input(textbox, { target: { value: 'keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select collection alpha' }));
    expect(await screen.findByTestId('briefing-view')).toBeTruthy();
    expect(screen.getByTestId('briefing-selected-recurring-source').textContent).toContain('Recurring source: alpha');
    expect(screen.queryByTestId('briefing-producers')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'review-plan' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select collection review-plan' }));
    expect(((await screen.findByRole('textbox')) as HTMLTextAreaElement).value).toBe('keep this draft');
  });

  it('keeps an unavailable persisted selection authoritative over a stale recurring source', async () => {
    window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify({
      ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
      source: 'alpha',
      selectedCollectionId: 'bounded_ask:unavailable',
      collectionKindFilter: 'recurring_feed',
      collectionSourceFilter: 'alp',
      pinnedCollectionIds: ['recurring_feed:alpha', 'bounded_ask:unavailable'],
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/feedback/collections') return json({ state: 'all', collections: [{
        id: 'recurring', kind: 'recurring_feed', interaction_mode: 'immediate_per_item',
        state: 'open', source: 'alpha', label: 'alpha', item_count: 0,
        expires_at: null, created_at: 1, updated_at: 1, expiry_reversible: 0,
      }] });
      if (String(input) === '/api/briefing/queue') return json({
        candidates: [],
        sources: [{
          source: 'alpha', pending_count: 0, last_ingested_at: 1, last_ingest_age_ms: 0,
          last_task_identity: 'task/alpha', last_run_id: 'run', last_digest_version: 1,
          last_batch_item_count: 0,
        }],
      });
      throw new Error(`unexpected ${String(input)}`);
    }));
    render(shell(<BriefingView instance={null} />));
    expect(await screen.findByTestId('briefing-view')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('selected feedback collection is unavailable');
    expect((await screen.findByRole('button', { name: 'Select collection alpha' })).getAttribute('aria-current')).toBeNull();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}')).toMatchObject({
      selectedCollectionId: 'bounded_ask:unavailable',
      collectionKindFilter: 'recurring_feed',
      collectionSourceFilter: 'alp',
      pinnedCollectionIds: ['feedback_collection:recurring', 'bounded_ask:unavailable'],
    }));
  });
});
