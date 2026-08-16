import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeFeedbackCollections,
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

const recurring = (
  source: string,
  state: FeedbackCollection['state'] = 'open',
  updatedAt = 10,
): FeedbackCollection => ({
  id: `feedback_collection:${encodeURIComponent(source)}`,
  collectionId: source,
  kind: 'recurring_feed',
  interactionMode: 'immediate_per_item',
  state,
  source,
  label: source,
  itemCount: 1,
  expiresAt: null,
  createdAt: 1,
  updatedAt,
  expiryReversible: state === 'expired',
});

const ask: FeedbackCollection = {
  id: 'feedback_collection:ask-1',
  collectionId: 'ask-1',
  kind: 'bounded_ask',
  interactionMode: 'explicit_submit',
  state: 'expired',
  source: null,
  label: 'Ask one',
  itemCount: 2,
  expiresAt: 5,
  createdAt: 2,
  updatedAt: 30,
  expiryReversible: true,
};

function ViewStateHarness({
  collections,
  sidebarHidden = false,
  onSetExpiry,
}: {
  collections: FeedbackCollection[];
  sidebarHidden?: boolean;
  onSetExpiry?(collection: FeedbackCollection): Promise<void>;
}): JSX.Element {
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const [refreshes, setRefreshes] = useState(0);
  return (
    <CollectionShell
      collections={collections}
      sidebarHidden={sidebarHidden}
      viewState={viewState}
      setViewState={setViewState}
      onSetExpiry={onSetExpiry}
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

describe('collection-general projection', () => {
  it('normalizes recurring feeds and bounded asks through one row shape', () => {
    expect(normalizeFeedbackCollections({ collections: [
      {
        id: 'recurring', kind: 'recurring_feed', interaction_mode: 'immediate_per_item',
        state: 'open', source: 'daily', label: 'daily', item_count: 3,
        expires_at: null, created_at: 1, updated_at: 8,
      },
      {
        id: 'ask', kind: 'bounded_ask', interaction_mode: 'explicit_submit',
        state: 'expired', source: null, label: 'Question', item_count: 1,
        expires_at: 7, created_at: 2, updated_at: 9,
      },
    ] })).toEqual([
      expect.objectContaining({
        id: 'feedback_collection:recurring', collectionId: 'recurring',
        kind: 'recurring_feed', interactionMode: 'immediate_per_item', state: 'open',
      }),
      expect.objectContaining({
        id: 'feedback_collection:ask', collectionId: 'ask',
        kind: 'bounded_ask', interactionMode: 'explicit_submit', state: 'expired',
      }),
    ]);
  });
});

describe('collection filtering and ordering', () => {
  const rows = [recurring('zeta', 'open', 10), recurring('alpha', 'expired', 20), ask];

  it('filters kind, source, and state independently and in combination', () => {
    expect(filterFeedbackCollections(rows, { kind: 'bounded_ask', source: '', state: 'all' }).map((row) => row.id))
      .toEqual(['feedback_collection:ask-1']);
    expect(filterFeedbackCollections(rows, { kind: 'all', source: 'ALP', state: 'all' }).map((row) => row.source))
      .toEqual(['alpha']);
    expect(filterFeedbackCollections(rows, { kind: 'all', source: '', state: 'expired' }).map((row) => row.source))
      .toEqual(['alpha', null]);
    expect(filterFeedbackCollections(rows, { kind: 'recurring_feed', source: 'z', state: 'open' }).map((row) => row.source))
      .toEqual(['zeta']);
    expect(filterFeedbackCollections(rows, { kind: 'bounded_ask', source: 'z', state: 'open' }))
      .toEqual([]);
  });

  it('orders pinned collections first and deterministically within sections', () => {
    expect(orderFeedbackCollections(rows, ['feedback_collection:zeta']).map((row) => row.id)).toEqual([
      'feedback_collection:zeta',
      'feedback_collection:ask-1',
      'feedback_collection:alpha',
    ]);
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
      collectionKindFilter: 'Wrong kind!',
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
    fireEvent.click(screen.getByRole('button', { name: 'Recurring feed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin alpha' }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}');
      expect(stored).toMatchObject({
        collectionKindFilter: 'recurring_feed',
        collectionSourceFilter: 'alp',
        collectionStateFilter: 'open',
        pinnedCollectionIds: ['feedback_collection:alpha'],
      });
    });

    view.rerender(<ViewStateHarness collections={[recurring('beta')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}')).toMatchObject({
      collectionSourceFilter: 'alp',
      pinnedCollectionIds: ['feedback_collection:alpha'],
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
      pinnedCollectionIds: ['feedback_collection:alpha'],
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
      pinnedCollectionIds: ['feedback_collection:alpha'],
    });
    await waitFor(() => expect(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY)).toContain('feedback_collection:alpha'));
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

  it('shows the two-state indicator and exposes reversible expiry without changing row identity', async () => {
    const setExpiry = vi.fn(async () => undefined);
    const openAsk = { ...ask, state: 'open' as const, expiresAt: 50 };
    const view = render(<ViewStateHarness collections={[recurring('alpha'), openAsk]} onSetExpiry={setExpiry} />);
    expect(screen.getAllByLabelText('State: open').every(
      (indicator) => indicator.classList.contains('feedback-collection-row__state--open'),
    )).toBe(true);
    expect(screen.queryByRole('button', { name: 'Expire alpha' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expire Ask one' }));
    await waitFor(() => expect(setExpiry).toHaveBeenCalledWith(expect.objectContaining({
      id: 'feedback_collection:ask-1', state: 'open',
    })));

    view.rerender(<ViewStateHarness collections={[recurring('alpha'), ask]} onSetExpiry={setExpiry} />);
    expect(screen.getByLabelText('State: expired').classList.contains('feedback-collection-row__state--expired')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Un-expire Ask one' }));
    await waitFor(() => expect(setExpiry).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'feedback_collection:ask-1', state: 'expired',
    })));
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
    fireEvent.click(screen.getByRole('button', { name: 'Recurring feed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expired' }));
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
      if (String(input) === '/api/feedback/collections') return new Response(JSON.stringify({
        state: 'all',
        collections: [{
          id: 'recurring', kind: 'recurring_feed', interaction_mode: 'immediate_per_item',
          state: 'open', source: 'alpha', label: 'alpha', item_count: 1,
          expires_at: null, created_at: 1, updated_at: 1,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
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
      selectedCollectionId: 'feedback_collection:recurring',
      expandedCandidateId: 'cand-1',
      collectionKindFilter: 'recurring_feed',
      collectionSourceFilter: 'alp',
      collectionStateFilter: 'open',
      pinnedCollectionIds: ['feedback_collection:recurring'],
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
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/feedback/collections')).toHaveLength(2);
    });
    window.dispatchEvent(new CustomEvent('feedback:sse', { detail: { type: 'ask:created' } }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/briefing/queue')).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/feedback/collections')).toHaveLength(3);
    expect((screen.getByLabelText('Search collections') as HTMLInputElement).value).toBe('alp');
    expect(screen.getByRole('button', { name: 'Unpin alpha' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('briefing-detail-cand-1')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}')).toMatchObject({
      selectedCollectionId: 'feedback_collection:recurring',
      expandedCandidateId: 'cand-1',
    });
  });
});
