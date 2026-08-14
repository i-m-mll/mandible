import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeAskProjection,
  normalizeBriefingQueue,
  projectBoundedAskCollection,
  projectBriefingRecurringCollections,
} from '../ui/src/api';
import { AppShellProvider } from '../ui/src/app-shell';
import { BriefingView } from '../ui/src/views/briefing';
import { CollectionShell } from '../ui/src/views/feedback/CollectionShell';
import {
  filterFeedbackCollections,
  orderFeedbackCollections,
  type FeedbackCollection,
} from '../ui/src/views/feedback/collection-model';
import {
  BRIEFING_VIEW_STATE_KEY,
  DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  normalizeBriefingCollectionViewState,
  useBriefingCollectionViewState,
} from '../ui/src/views/feedback/collection-view-state';

function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => { store.delete(key); },
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
}

const recurring = (source: string, state: FeedbackCollection['state'] = 'open'): FeedbackCollection => ({
  id: `recurring_feed:${encodeURIComponent(source)}`,
  kind: 'recurring_feed',
  state,
  source,
  label: source,
  pendingCount: 1,
  recurring: {
    health: 'current',
    publicationRecorded: true,
    lastPublicationItemCount: 1,
    lastTaskIdentity: `task/${source}`,
  },
});

const ask: FeedbackCollection = {
  id: 'bounded_ask:ask-1',
  kind: 'bounded_ask',
  state: 'submitted',
  source: 'agent',
  label: 'Ask one',
};

function ViewStateHarness({
  collections,
  sidebarHidden = false,
}: {
  collections: FeedbackCollection[];
  sidebarHidden?: boolean;
}): JSX.Element {
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const [refreshes, setRefreshes] = useState(0);
  return (
    <CollectionShell
      collections={collections}
      sidebarHidden={sidebarHidden}
      viewState={viewState}
      setViewState={setViewState}
    >
      <button type="button" onClick={() => setRefreshes((value) => value + 1)}>Reconcile</button>
      <output data-testid="view-state">{JSON.stringify(viewState)}</output>
      <output data-testid="refresh-count">{refreshes}</output>
    </CollectionShell>
  );
}

function briefingPayload() {
  return {
    candidates: [{
      id: 'cand-1',
      source: 'alpha',
      candidate_key: 'key-1',
      state: 'pending',
      revision: {
        id: 'rev-1',
        candidate_id: 'cand-1',
        title: 'Safe title',
        why_notable: 'Safe rationale',
        refs: [],
        source_ref: '',
        evidence_hash: '',
        evidence_kind: 'finding-only',
        captured_at: null,
        run_id: null,
        digest_series_ref: null,
        digest_version: null,
        rank: 1,
        batch_key: null,
        ingested_at: 1,
      },
      revision_count: 1,
      occurrences: { count: 1, first_seen_at: 1, last_seen_at: 1 },
      task_identity: 'task/alpha',
      created_at: 1,
    }],
    sources: [{
      source: 'alpha',
      pending_count: 1,
      candidate_count: 1,
      last_task_identity: 'task/alpha',
      last_run_id: 'run-1',
      last_digest_version: 1,
      last_ingested_at: Date.now(),
      last_ingest_age_ms: 0,
      last_batch_item_count: 1,
    }],
  };
}

beforeEach(() => installMemoryLocalStorage());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recurring collection projection', () => {
  it('derives health-only and queue-only sources and preserves publication truth', () => {
    const queue = normalizeBriefingQueue({
      candidates: [
        { id: 'queued', source: 'queue-only', revision: { id: 'rev-q' } },
      ],
      sources: [
        {
          source: 'zero',
          last_ingested_at: 100,
          last_ingest_age_ms: 0,
          last_batch_item_count: 0,
          pending_count: 0,
        },
        {
          source: 'never',
          last_ingested_at: null,
          last_ingest_age_ms: null,
          last_batch_item_count: null,
          pending_count: 0,
        },
      ],
    }, 100);

    const bySource = new Map(projectBriefingRecurringCollections(queue).map((row) => [row.source, row]));
    expect([...bySource.keys()]).toEqual(['never', 'queue-only', 'zero']);
    expect(bySource.get('zero')?.recurring).toMatchObject({
      health: 'current',
      publicationRecorded: true,
      lastPublicationItemCount: 0,
    });
    expect(bySource.get('never')?.recurring).toMatchObject({
      health: 'unknown',
      publicationRecorded: false,
      lastPublicationItemCount: null,
    });
    expect(bySource.get('queue-only')).toMatchObject({
      pendingCount: 1,
      recurring: { health: 'unknown', publicationRecorded: false },
    });
  });
});

describe('collection filtering and ordering', () => {
  const rows = [recurring('zeta'), recurring('alpha', 'closed'), ask];

  it('filters kind, source, and state independently and in combination', () => {
    expect(filterFeedbackCollections(rows, { kind: 'bounded_ask', source: '', state: 'all' }).map((row) => row.id))
      .toEqual(['bounded_ask:ask-1']);
    expect(filterFeedbackCollections(rows, { kind: 'all', source: 'ALP', state: 'all' }).map((row) => row.source))
      .toEqual(['alpha']);
    expect(filterFeedbackCollections(rows, { kind: 'all', source: '', state: 'closed' }).map((row) => row.source))
      .toEqual(['alpha']);
    expect(filterFeedbackCollections(rows, { kind: 'recurring_feed', source: 'z', state: 'open' }).map((row) => row.source))
      .toEqual(['zeta']);
    expect(filterFeedbackCollections(rows, { kind: 'bounded_ask', source: 'z', state: 'open' }))
      .toEqual([]);
  });

  it('orders pinned collections first and deterministically within sections', () => {
    expect(orderFeedbackCollections(rows, ['recurring_feed:zeta']).map((row) => row.id)).toEqual([
      'recurring_feed:zeta',
      'bounded_ask:ask-1',
      'recurring_feed:alpha',
    ]);
  });
});

describe('bounded collection projection', () => {
  it('uses stable ask identity and only the loaded projection without inventing a source', () => {
    const projection = normalizeAskProjection({
      ask_id: 'ask/one', state: 'submitted', request_key: 'Choose', request_digest: 'd',
      requester_user_id: 'agent', requester_session_id: 'session', responder_user_ids: ['human'],
      expires_at: 1, retention_expires_at: null, created_at: 1,
      lifecycle_event_id: 'life', latest_submission: { id: 'submission', ordinal: 1 },
      items: [{
        id: 'item', client_item_key: 'item', parent_item_id: null, item_kind: 'item',
        revision: { id: 'revision', ordinal: 1, title: 'Title', prompt: 'Prompt', description: null,
          response_type: 'verdict', required: true, position: 0, options: [] },
        effective_response: { response_event_id: 'response', value: { verdict: 'keep' } },
      }],
    });
    expect(projectBoundedAskCollection(projection)).toEqual({
      id: 'bounded_ask:ask%2Fone',
      kind: 'bounded_ask',
      state: 'submitted',
      label: 'Choose',
      boundedAsk: { askId: 'ask/one', itemCount: 1, requiredCount: 1, answeredRequiredCount: 1 },
    });
  });
});

describe('browser-local collection view state', () => {
  it('normalizes legacy, partial, hostile, and malformed stored values safely', () => {
    expect(normalizeBriefingCollectionViewState({
      filter: 'judged',
      source: 'alpha',
      healthOpen: true,
      expandedCandidateId: 'cand-1',
    })).toMatchObject({
      filter: 'judged',
      source: 'alpha',
      healthOpen: true,
      expandedCandidateId: 'cand-1',
      collectionKindFilter: 'all',
      pinnedCollectionIds: [],
    });
    expect(normalizeBriefingCollectionViewState({
      collectionKindFilter: 'wrong',
      collectionStateFilter: 7,
      pinnedCollectionIds: ['a', 'a', 3, ''],
    })).toMatchObject({
      collectionKindFilter: 'all',
      collectionStateFilter: 'all',
      pinnedCollectionIds: ['a'],
    });

    window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, '{not json');
    render(<ViewStateHarness collections={[recurring('alpha')]} />);
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}'))
      .toEqual(DEFAULT_BRIEFING_COLLECTION_VIEW_STATE);
  });

  it('persists pins and filters across remount and keeps them through reconciliation', async () => {
    const rows = [recurring('alpha'), recurring('beta')];
    const view = render(<ViewStateHarness collections={rows} />);
    fireEvent.input(screen.getByLabelText('Search collections'), { target: { value: 'alp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Collection filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recurring review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin alpha' }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}');
      expect(stored).toMatchObject({
        collectionKindFilter: 'recurring_feed',
        collectionSourceFilter: 'alp',
        collectionStateFilter: 'open',
        pinnedCollectionIds: ['recurring_feed:alpha'],
      });
    });

    view.rerender(<ViewStateHarness collections={[recurring('beta')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}')).toMatchObject({
      collectionSourceFilter: 'alp',
      pinnedCollectionIds: ['recurring_feed:alpha'],
    });

    view.unmount();
    render(<ViewStateHarness collections={rows} />);
    expect((screen.getByLabelText('Search collections') as HTMLInputElement).value).toBe('alp');
    expect(screen.getByRole('button', { name: 'Unpin alpha' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('uses the shared sidebar frame and hides it without deleting stored state', async () => {
    window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify({
      ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
      collectionSourceFilter: 'alpha',
      pinnedCollectionIds: ['recurring_feed:alpha'],
    }));
    const view = render(<ViewStateHarness collections={[recurring('alpha')]} />);
    const frame = screen.getByRole('complementary', { name: 'Feedback collections' });
    expect(frame.classList.contains('view-sidebar')).toBe(true);
    expect(frame.classList.contains('feedback-collections-sidebar')).toBe(true);
    expect(screen.getByTestId('feedback-collections-sidebar')).toBeTruthy();
    expect(frame.querySelector('.view-sidebar__resize-handle')).toBeTruthy();

    view.rerender(<ViewStateHarness collections={[recurring('alpha')]} sidebarHidden />);
    expect(screen.queryByTestId('feedback-collections-sidebar')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Feedback collections' })).toBeNull();
    expect(view.container.querySelector('.view-sidebar')).toBeNull();
    expect(view.container.querySelector('.view-sidebar__resize-handle')).toBeNull();
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}')).toMatchObject({
      collectionSourceFilter: 'alpha',
      pinnedCollectionIds: ['recurring_feed:alpha'],
    });
    await waitFor(() => expect(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY)).toContain('recurring_feed:alpha'));
  });
});

describe('collection shell accessibility and reconciliation', () => {
  it('renders a full-height split shell with content isolated in its scroll pane', () => {
    const view = render(<ViewStateHarness collections={[recurring('alpha')]} />);
    const shell = screen.getByTestId('feedback-collection-shell');
    const sidebar = shell.querySelector(':scope > .view-sidebar.feedback-collections-sidebar');
    const content = shell.querySelector(':scope > .feedback-collection-shell__content');
    const readingWidth = content?.querySelector(':scope > .feedback-collection-shell__content-inner');

    expect(sidebar).toBeTruthy();
    expect(content).toBeTruthy();
    expect(readingWidth).toBeTruthy();
    expect(readingWidth?.contains(screen.getByRole('button', { name: 'Reconcile' }))).toBe(true);
    expect(view.container.querySelector('.feedback-collection-shell__content-inner > .view-sidebar')).toBeNull();
  });

  it('provides accessible selection and pressed pin controls with an honest empty state', () => {
    render(<ViewStateHarness collections={[recurring('alpha'), ask]} />);
    const sidebar = screen.getByTestId('feedback-collections-sidebar');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Select collection alpha' }));
    expect(within(sidebar).getByRole('button', { name: 'Select collection alpha' }).getAttribute('aria-current')).toBe('true');
    const pin = within(sidebar).getByRole('button', { name: 'Pin alpha' });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);
    expect(within(sidebar).getByRole('button', { name: 'Unpin alpha' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.input(screen.getByLabelText('Search collections'), { target: { value: 'no-match' } });
    expect(within(sidebar).getByRole('status').textContent).toContain('No collections match');
    expect(screen.queryByRole('textbox', { name: /answer|response/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /submit answer|send response/i })).toBeNull();
  });

  it('uses the shared search, filter popover, dismissal, count, and list navigation idioms', () => {
    const view = render(<ViewStateHarness collections={[recurring('beta'), recurring('alpha'), ask]} />);
    const search = screen.getByRole('searchbox', { name: 'Search collections' });
    fireEvent.input(search, { target: { value: 'alp' } });
    expect(screen.getByRole('button', { name: 'Select collection alpha' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Select collection beta' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear collection search' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collection filters' }));
    expect(screen.getByRole('dialog', { name: 'Collection filter controls' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recurring review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
    const trigger = screen.getByRole('button', { name: 'Collection filters' });
    expect(trigger.textContent).toContain('2');
    expect(trigger.classList.contains('sidebar-search-filter__trigger--active')).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Collection filter controls' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear collection search' }));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    trigger.focus();
    fireEvent(trigger, new FocusEvent('focusout', {
      bubbles: true,
      relatedTarget: screen.getByRole('button', { name: 'Reconcile' }),
    }));
    expect(screen.queryByRole('dialog', { name: 'Collection filter controls' })).toBeNull();

    const alpha = screen.getByRole('button', { name: 'Select collection alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    const beta = screen.getByRole('button', { name: 'Select collection beta' });
    expect(document.activeElement).toBe(beta);
    expect(beta.getAttribute('aria-current')).toBe('true');
    expect(alpha.getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(beta, { key: 'ArrowUp' });
    expect(alpha.getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(beta, { key: 'Enter' });
    fireEvent.click(beta);
    expect(beta.getAttribute('aria-current')).toBe('true');

    view.unmount();
    render(<ViewStateHarness collections={[]} />);
    const emptySidebar = screen.getByTestId('feedback-collections-sidebar');
    expect(within(emptySidebar).getByRole('status').textContent).toContain('have been reported yet');
    expect(within(emptySidebar).getByRole('status').parentElement?.classList.contains('feedback-collections-sidebar__list')).toBe(true);
  });

  it('reconciles after feedback SSE without resetting filters, pins, selection, or expansion', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/briefing/queue') return new Response(JSON.stringify(briefingPayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      if (String(input).includes('/history')) return new Response(JSON.stringify({
        candidate: { id: 'cand-1', source: 'alpha', candidate_key: 'key-1', current_revision_id: 'rev-1', created_at: 1, state: 'pending' },
        revisions: [], decisions: [], comments: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify({
      ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
      source: 'alpha',
      selectedCollectionId: 'recurring_feed:alpha',
      expandedCandidateId: 'cand-1',
      collectionKindFilter: 'recurring_feed',
      collectionSourceFilter: 'alp',
      collectionStateFilter: 'open',
      pinnedCollectionIds: ['recurring_feed:alpha'],
    }));

    render(
      <AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined }}>
        <BriefingView instance={null} />
      </AppShellProvider>,
    );
    expect(await screen.findByTestId('briefing-detail-cand-1')).toBeTruthy();
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'briefing:ingested' } }));
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'briefing:decided' } }));
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'briefing:commented' } }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/briefing/queue')).toHaveLength(2);
    });
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'ask:created' } }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/briefing/queue')).toHaveLength(2);
    expect((screen.getByLabelText('Search collections') as HTMLInputElement).value).toBe('alp');
    expect(screen.getByRole('button', { name: 'Unpin alpha' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('briefing-detail-cand-1')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}')).toMatchObject({
      selectedCollectionId: 'recurring_feed:alpha',
      expandedCandidateId: 'cand-1',
    });
  });
});
