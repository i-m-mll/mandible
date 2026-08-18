import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShellProvider } from '../ui/src/app-shell';
import { invalidateApiGetCache, normalizeBriefingProjection, normalizeBriefings } from '../ui/src/api';
import { BriefingView } from '../ui/src/views/briefing';
import { briefingRoundLabels, BriefingDocumentRenderer } from '../ui/src/views/feedback/BriefingDocumentRenderer';
import { BRIEFING_VIEW_STATE_KEY, DEFAULT_BRIEFING_COLLECTION_VIEW_STATE } from '../ui/src/views/feedback/collection-view-state';

const source = 'Intro\n:::spec-item{key="decision" required="true"}\nReview this round\n:::\n';
const bodyStart = source.indexOf('Review this round');
const bodyEnd = source.indexOf('\n:::', bodyStart);
const directiveEnd = bodyEnd + '\n:::'.length;
const digest = createHash('sha256').update(source.slice(source.indexOf(':::'), directiveEnd)).digest('hex');
const ROUND_ONE = '11111111-1111-4111-8111-111111111111';
const ROUND_TWO = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FULL_BRIEFING_ID = `briefing:${'65db040'.padEnd(64, 'a')}`;
const FULL_ROUND_ID = `briefing-round:${'c76f940'.padEnd(64, 'b')}`;
const FULL_ARTIFACT_VERSION_REF = `artifact-version:${'264e485'.padEnd(32, 'c')}`;

function selectedRound(roundId: string, artifactVersion: string, submitted = false) {
  return {
    id: roundId, ordinal: roundId === ROUND_ONE ? 1 : 2, artifact_version_id: artifactVersion,
    previous_round_id: roundId === ROUND_ONE ? null : ROUND_ONE, profile: 'mandible-briefing.v1',
    binding_digest: `binding-${roundId}`, created_at: roundId === ROUND_ONE ? 1 : 2,
    document: { artifact_version_id: artifactVersion, previous_round_id: roundId === ROUND_ONE ? null : ROUND_ONE, profile: 'mandible-briefing.v1' },
    binding: { status: 'valid' },
    items: [{ id: `item-${roundId}`, directive_key: 'decision', position: 0, definition_digest: digest,
      response_type: 'verdict', required: 1, prompt: 'Review this round', options: [],
      start_offset: source.indexOf(':::'), end_offset: directiveEnd, body_start_offset: bodyStart, body_end_offset: bodyEnd }],
    answers: submitted ? [{ response_event_id: 'answer-old', directive_instance_id: `item-${roundId}`,
      directive_key: 'decision', response_type: 'verdict', value: { verdict: 'keep' }, created_at: 1 }] : [],
    annotations: [], latest_submission: submitted ? { id: `submission-${roundId}`, ordinal: 1 } : null,
    latest_frozen_membership: submitted ? { answer_event_ids: ['answer-old'], annotation_event_ids: [] } : null,
  };
}

function detail(roundId = ROUND_TWO) {
  return {
    briefing: { id: 'briefing-1', briefing_key: 'recurring-review', title: 'Recurring review',
      latest_round_id: ROUND_TWO, round_count: 2, created_at: 1, updated_at: 2 },
    rounds: [
      { id: ROUND_ONE, ordinal: 1, artifact_version_id: ARTIFACT_VERSION, created_at: 1, origin: { source: 'scheduled-review', run_id: 'run-1', task_identity: 'task-1' } },
      { id: ROUND_TWO, ordinal: 2, artifact_version_id: ARTIFACT_VERSION, created_at: 2, origin: { source: 'scheduled-review', run_id: 'run-2', task_identity: 'task-1' } },
    ],
    selected_round: selectedRound(roundId, ARTIFACT_VERSION, roundId === ROUND_ONE),
  };
}

function installStorage(): void {
  const rows = new Map<string, string>();
  const storage = { get length() { return rows.size; }, clear: () => rows.clear(), getItem: (key: string) => rows.get(key) ?? null,
    key: (index: number) => [...rows.keys()][index] ?? null, removeItem: (key: string) => rows.delete(key), setItem: (key: string, value: string) => rows.set(key, String(value)) } as Storage;
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

beforeEach(() => { installStorage(); invalidateApiGetCache(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('artifact-backed Briefing rounds', () => {
  it('normalizes stable logical rows and exact immutable selected-round bindings', () => {
    expect(normalizeBriefings({ briefings: [{ id: 'briefing-1', title: 'Recurring review', latest_round_id: 'round-2', round_count: 2, created_at: 1, updated_at: 2 }] })[0])
      .toMatchObject({ collectionId: 'briefing-1', latestRoundId: 'round-2', itemCount: 2 });
    const projection = normalizeBriefingProjection(detail(ROUND_ONE));
    expect(projection).toMatchObject({ briefing_id: 'briefing-1', selected_round_id: ROUND_ONE, latest_round_id: ROUND_TWO, latest_submission_for_actor: { id: `submission-${ROUND_ONE}` }, document: { artifact_version_id: ARTIFACT_VERSION } });
    expect(projection).not.toHaveProperty('latest_submission');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['unsupported', 'mandible-briefing.v2'],
  ])('fails closed for a %s selected-document profile', (_label, profile) => {
    const payload = detail() as any;
    if (profile === undefined) delete payload.selected_round.document.profile;
    else payload.selected_round.document.profile = profile;
    const projection = normalizeBriefingProjection(payload);
    expect(projection.valid).toBe(false);
    expect(projection.document).toBeNull();
  });

  it('never renders a raw-source fallback for an invalid profile', async () => {
    const payload = detail() as any;
    payload.selected_round.document.profile = 'mandible-briefing.v2';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/briefings/briefing-1?round=${ROUND_TWO}`) return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined }}><BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_TWO} instance={null} /></AppShellProvider>);

    expect((await screen.findByRole('alert')).textContent).toContain('invalid or unsupported');
    expect(screen.queryByLabelText('Briefing document')).toBeNull();
    expect(screen.queryByLabelText('Pinned briefing document source')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/artifacts/'))).toBe(false);
  });

  it('formats cadence-backed occurrence labels and adds ordinals only to collisions', () => {
    const labels = briefingRoundLabels([
      { id: 'daily', ordinal: 1, artifact_version_id: ARTIFACT_VERSION, created_at: Date.UTC(2026, 7, 18, 8), origin: { source: 'scan', run_id: '1', task_identity: 'agent-schedule/daily-digest' } },
      { id: 'weekly', ordinal: 2, artifact_version_id: ARTIFACT_VERSION, created_at: Date.UTC(2026, 7, 18, 8), origin: { source: 'scan', run_id: '2', task_identity: 'agent-schedule/weekly-digest' } },
      { id: 'adhoc-1', ordinal: 3, artifact_version_id: ARTIFACT_VERSION, created_at: Date.UTC(2026, 7, 18, 8, 30), origin: { source: 'manual', run_id: '3', task_identity: 'ad-hoc' } },
      { id: 'adhoc-2', ordinal: 4, artifact_version_id: ARTIFACT_VERSION, created_at: Date.UTC(2026, 7, 18, 8, 30), origin: { source: 'manual', run_id: '4', task_identity: 'ad-hoc' } },
    ], 'adhoc-2');
    expect(labels.get('daily')).toBe('2026-08-18');
    expect(labels.get('weekly')).toBe('2026-W34');
    expect(labels.get('adhoc-1')).toBe('2026-08-18 08:30 UTC · #3');
    expect(labels.get('adhoc-2')).toBe('Latest · 2026-08-18 08:30 UTC · #4');
  });

  it('keeps full Briefing identities as copy and mutation authority while displaying and routing compact refs', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    window.history.replaceState(null, '', '/#/briefing');
    const payload = detail() as any;
    payload.briefing = {
      ...payload.briefing,
      id: FULL_BRIEFING_ID,
      title: 'arxiv-scan',
      latest_round_id: FULL_ROUND_ID,
      round_count: 1,
    };
    payload.rounds = [{
      id: FULL_ROUND_ID,
      ordinal: 1,
      artifact_version_id: FULL_ARTIFACT_VERSION_REF,
      created_at: 2,
      origin: { source: 'arxiv-scan', run_id: 'run-1', task_identity: 'ad-hoc' },
    }];
    payload.selected_round = {
      ...selectedRound(FULL_ROUND_ID, FULL_ARTIFACT_VERSION_REF),
      ordinal: 1,
      previous_round_id: null,
    };
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/briefings') return new Response(JSON.stringify({ briefings: [payload.briefing] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && url === `/api/briefings/${encodeURIComponent(FULL_BRIEFING_ID)}`) return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(source).byteLength, source: null, preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/answers')) return new Response(JSON.stringify({ answer_event_ids: ['answer-new'] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/submit')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${method} ${url}`);
    }));

    render(<AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined }}><BriefingView instance={null} /></AppShellProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Select briefing arxiv-scan' }));
    expect(window.location.hash).toBe('#/briefing?briefing=briefing%3A65db040');

    const headerRef = await screen.findByText('briefing:65db040');
    expect(headerRef.closest('.briefing-detail__eyebrow')?.textContent).toContain('Briefing briefing:65db040');
    expect(screen.queryByText(FULL_BRIEFING_ID)).toBeNull();
    await screen.findByRole('button', { name: 'Briefing actions' });
    const header = headerRef.closest('.detail-pane-shell__header') as HTMLElement;
    expect(within(header.querySelector('.briefing-detail__eyebrow') as HTMLElement).getByText('briefing:65db040')).toBeTruthy();
    expect(within(header.querySelector('.briefing-detail__title-row') as HTMLElement).getByRole('heading', { name: 'arxiv-scan' })).toBeTruthy();
    expect(within(header.querySelector('.briefing-detail__title-row') as HTMLElement).getByRole('button', { name: 'Briefing actions' })).toBeTruthy();
    expect(within(header.querySelector('.briefing-detail__meta') as HTMLElement).getByRole('combobox', { name: 'Round occurrence' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy full Briefing ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FULL_BRIEFING_ID));

    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions' }));
    expect(screen.getByRole('menuitem', { name: 'Go to artifact version' }).getAttribute('href'))
      .toBe('#/artifacts?ref=artifact-version%3A264e485');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Metadata' }));
    const metadata = screen.getByRole('dialog', { name: 'Briefing metadata' });
    expect(within(metadata).getByText('briefing-round:c76f940')).toBeTruthy();
    expect(within(metadata).queryByText(FULL_ROUND_ID)).toBeNull();
    expect(within(metadata).getByText('artifact-version:264e485')).toBeTruthy();
    expect(within(metadata).queryByText(FULL_ARTIFACT_VERSION_REF)).toBeNull();
    fireEvent.click(within(metadata).getByRole('button', { name: 'Copy full round ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FULL_ROUND_ID));
    fireEvent.click(within(metadata).getByRole('button', { name: 'Copy exact artifact-version ref' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FULL_ARTIFACT_VERSION_REF));
    fireEvent.click(within(metadata).getByRole('button', { name: 'Close Briefing metadata' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const submit = screen.getByRole('button', { name: 'Submit' });
    await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(submit);
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      `/api/briefings/${encodeURIComponent(FULL_BRIEFING_ID)}/rounds/${encodeURIComponent(FULL_ROUND_ID)}/answers`,
      `/api/briefings/${encodeURIComponent(FULL_BRIEFING_ID)}/rounds/${encodeURIComponent(FULL_ROUND_ID)}/submit`,
    ]));
  });

  it('reports authentication failure instead of a false empty Briefing list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/briefings') {
        return new Response(JSON.stringify({ error: 'authentication_required' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ incidents: [], counts: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    render(<AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined }}><BriefingView instance={null} /></AppShellProvider>);

    const sidebar = await screen.findByRole('complementary', { name: 'Briefings' });
    expect((await within(sidebar).findByRole('alert')).textContent)
      .toContain('Authentication is required to load Briefings.');
    expect(within(sidebar).queryByText('No Briefings have been reported yet.')).toBeNull();
  });

  it('defaults to latest, preserves explicit history across reconciliation, isolates drafts, and uses Submit/correction gates', async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === '/api/briefings') return new Response(JSON.stringify({ briefings: [{ id: 'briefing-1', title: 'Recurring review', latest_round_id: 'round-2', round_count: 2, created_at: 1, updated_at: 2 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && url.startsWith('/api/briefings/briefing-1')) return new Response(JSON.stringify(detail(new URL(url, 'http://x').searchParams.get('round') ?? ROUND_TWO)), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(source).byteLength, source: null, preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/answers')) return new Response(JSON.stringify({ answer_event_ids: ['answer-new'] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/submit')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${method} ${url}`);
    }));
    window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify({ ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE, selectedCollectionId: 'briefing:briefing-1' }));
    render(<AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined }}><BriefingView instance={null} /></AppShellProvider>);
    const sidebar = await screen.findByRole('complementary', { name: 'Briefings' });
    expect((sidebar as HTMLElement).style.width).toBe('360px');
    expect(screen.getByRole('searchbox', { name: 'Search briefings' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Recurring review' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}').pinnedCollectionIds).toEqual(['briefing:briefing-1']));
    expect(await screen.findByRole('option', { name: 'Latest · 1970-01-01 00:00 UTC · #2' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Round occurrence' }).getAttribute('value') ?? (screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ROUND_TWO);
    const shell = screen.getByTestId('briefing-document-renderer').closest('.detail-pane-shell') as HTMLElement;
    expect(shell.querySelector(':scope > .detail-pane-shell__header')).toBeTruthy();
    expect(shell.querySelector(':scope > .detail-pane-shell__body')).toBeTruthy();
    expect(shell.querySelector(':scope > .detail-pane-shell__footer')).toBeTruthy();
    expect(within(shell.querySelector('.detail-pane-shell__body') as HTMLElement).queryByText(/Immutable round|Briefing round|Pinned document|Review source|Source and existing annotations/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions' }));
    expect(screen.getByRole('menuitem', { name: 'Go to artifact version' }).getAttribute('href')).toBe('#/artifacts?ref=artifact-version%3Aaaaaaaaa-aaaa-4aaa-8aaa-aaaaaaa');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Metadata' }));
    const metadata = screen.getByRole('dialog', { name: 'Briefing metadata' });
    expect(within(metadata).getByText('Round occurrence')).toBeTruthy();
    expect(within(metadata).getByText('22222222')).toBeTruthy();
    expect(within(metadata).queryByText(ROUND_TWO)).toBeNull();
    expect(within(metadata).getByText('artifact-version:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaa')).toBeTruthy();
    fireEvent.click(within(metadata).getByRole('button', { name: 'Close Briefing metadata' }));
    const latestSubmit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(latestSubmit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(latestSubmit, { key: 'Enter' });
    fireEvent.click(latestSubmit);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await waitFor(() => expect(latestSubmit.getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(latestSubmit);
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      `/api/briefings/briefing-1/rounds/${ROUND_TWO}/answers`,
      `/api/briefings/briefing-1/rounds/${ROUND_TWO}/submit`,
    ]));
    const roundSelect = screen.getByRole('combobox', { name: 'Round occurrence' }) as HTMLSelectElement;
    roundSelect.value = ROUND_ONE;
    fireEvent.input(roundSelect);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}').selectedRoundIds).toMatchObject({ 'briefing:briefing-1': ROUND_ONE }));
    window.dispatchEvent(new CustomEvent('briefing:sse', { detail: { type: 'briefing:round-published' } }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((screen.getByRole('combobox', { name: 'Round occurrence' }) as HTMLSelectElement).value).toBe(ROUND_ONE);
    expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Dismiss' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Submit correction' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/No answer or annotation changes/)).toBeTruthy();
    expect(screen.queryByText(/producer|finding/i)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}').selectedRoundIds).toMatchObject({ 'briefing:briefing-1': ROUND_ONE });
  });

  it('loads a short round deep link but keeps the resolved full round ID for mutations', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/briefings/briefing-1?round=${ROUND_TWO.slice(0, 8)}`) return new Response(JSON.stringify(detail(ROUND_TWO)), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(source).byteLength, source: null, preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/answers')) return new Response(JSON.stringify({ answer_event_ids: ['answer-new'] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/submit')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${method} ${url}`);
    }));

    render(<AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined }}><BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_TWO.slice(0, 8)} instance={null} /></AppShellProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const submit = screen.getByRole('button', { name: 'Submit' });
    await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(submit);

    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      `/api/briefings/briefing-1/rounds/${ROUND_TWO}/answers`,
      `/api/briefings/briefing-1/rounds/${ROUND_TWO}/submit`,
    ]));
    expect(calls).toContainEqual({ url: `/api/briefings/briefing-1?round=${ROUND_TWO.slice(0, 8)}`, method: 'GET' });
  });

  it('fails closed when materialized document bytes do not match the frozen directive binding', async () => {
    const tampered = source.replace('Review this round', 'Changed after binding');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/briefings/briefing-1?round=${ROUND_TWO}`) return new Response(JSON.stringify(detail()), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(tampered).byteLength, source: null, preview: { encoding: 'utf-8', text: tampered, raw_text: tampered, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: tampered.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    }));
    render(<AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined }}><BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_TWO} instance={null} /></AppShellProvider>);
    const keep = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText(/does not match its materialized prompt/)).toBeTruthy());
    expect(keep.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Submit' }).getAttribute('aria-disabled')).toBe('true');
  });
});
