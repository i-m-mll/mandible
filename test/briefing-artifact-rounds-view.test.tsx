import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShellProvider } from '../ui/src/app-shell';
import { invalidateApiGetCache, normalizeBriefingProjection, normalizeBriefings } from '../ui/src/api';
import { BriefingView } from '../ui/src/views/briefing';
import { BriefingDocumentRenderer } from '../ui/src/views/feedback/BriefingDocumentRenderer';
import { BRIEFING_VIEW_STATE_KEY, DEFAULT_BRIEFING_COLLECTION_VIEW_STATE } from '../ui/src/views/feedback/collection-view-state';

const source = 'Intro\n:::spec-item{key="decision" required="true"}\nReview this round\n:::\n';
const bodyStart = source.indexOf('Review this round');
const bodyEnd = source.indexOf('\n:::', bodyStart);
const directiveEnd = bodyEnd + '\n:::'.length;
const digest = createHash('sha256').update(source.slice(source.indexOf(':::'), directiveEnd)).digest('hex');

function selectedRound(roundId: string, artifactVersion: string, submitted = false) {
  return {
    id: roundId, ordinal: roundId === 'round-1' ? 1 : 2, artifact_version_id: artifactVersion,
    previous_round_id: roundId === 'round-1' ? null : 'round-1', profile: 'mandible-briefing.v1',
    binding_digest: `binding-${roundId}`, created_at: roundId === 'round-1' ? 1 : 2,
    document: { artifact_version_id: artifactVersion, previous_round_id: roundId === 'round-1' ? null : 'round-1', profile: 'mandible-briefing.v1' },
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

function detail(roundId = 'round-2') {
  return {
    briefing: { id: 'briefing-1', briefing_key: 'recurring-review', title: 'Recurring review',
      latest_round_id: 'round-2', round_count: 2, created_at: 1, updated_at: 2 },
    rounds: [
      { id: 'round-1', artifact_version_id: 'artifact-version:v1', created_at: 1, origin: { source: 'scheduled-review', run_id: 'run-1', task_identity: 'task-1' } },
      { id: 'round-2', artifact_version_id: 'artifact-version:v1', created_at: 2, origin: { source: 'scheduled-review', run_id: 'run-2', task_identity: 'task-1' } },
    ],
    selected_round: selectedRound(roundId, 'artifact-version:v1', roundId === 'round-1'),
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
    expect(normalizeBriefingProjection(detail('round-1'))).toMatchObject({ briefing_id: 'briefing-1', selected_round_id: 'round-1', latest_round_id: 'round-2', document: { artifact_version_id: 'artifact-version:v1' } });
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
      if (method === 'GET' && url.startsWith('/api/briefings/briefing-1')) return new Response(JSON.stringify(detail(new URL(url, 'http://x').searchParams.get('round') ?? 'round-2')), { status: 200, headers: { 'content-type': 'application/json' } });
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
    expect(await screen.findByRole('option', { name: /Latest · round-2/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Briefing round' }).getAttribute('value') ?? (screen.getByRole('combobox') as HTMLSelectElement).value).toBe('round-2');
    const latestSubmit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(latestSubmit.disabled).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await waitFor(() => expect(latestSubmit.disabled).toBe(false));
    fireEvent.click(latestSubmit);
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      '/api/briefings/briefing-1/rounds/round-2/answers',
      '/api/briefings/briefing-1/rounds/round-2/submit',
    ]));
    const roundSelect = screen.getByRole('combobox', { name: 'Briefing round' }) as HTMLSelectElement;
    roundSelect.value = 'round-1';
    fireEvent.input(roundSelect);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}').selectedRoundIds).toMatchObject({ 'briefing:briefing-1': 'round-1' }));
    window.dispatchEvent(new CustomEvent('briefing:sse', { detail: { type: 'briefing:round-published' } }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((screen.getByRole('combobox', { name: 'Briefing round' }) as HTMLSelectElement).value).toBe('round-1');
    expect(screen.getByTestId('briefing-round-context').textContent).toContain('run-1');
    expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Dismiss' }).getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByRole('button', { name: 'Submit correction' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No answer or annotation changes/)).toBeTruthy();
    expect(screen.queryByText(/producer|finding/i)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}').selectedRoundIds).toMatchObject({ 'briefing:briefing-1': 'round-1' });
  });

  it('fails closed when materialized document bytes do not match the frozen directive binding', async () => {
    const tampered = source.replace('Review this round', 'Changed after binding');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/briefings/briefing-1?round=round-2') return new Response(JSON.stringify(detail()), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(tampered).byteLength, source: null, preview: { encoding: 'utf-8', text: tampered, raw_text: tampered, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: tampered.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    }));
    render(<AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined }}><BriefingDocumentRenderer briefingId="briefing-1" roundId="round-2" instance={null} /></AppShellProvider>);
    const keep = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText(/does not match its materialized prompt/)).toBeTruthy());
    expect(keep.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
