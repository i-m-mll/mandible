// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { useEffect, useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefingSidebarSnapshot } from '../ui/src/api';
import type { CollectionShellProps } from '../ui/src/views/feedback/CollectionShell';
import { queryClient } from '../ui/src/query/client';
import { parseRouteFromHash } from '../ui/src/routing';
import { BriefingView, warmInitialData } from '../ui/src/views/briefing';
import { BRIEFING_VIEW_STATE_KEY } from '../ui/src/views/feedback/collection-view-state';

const query = vi.hoisted(() => ({ data: undefined as BriefingSidebarSnapshot | undefined,
  error: null as Error | null, isFetching: true, refetch: vi.fn(async () => undefined) }));
vi.mock('@tanstack/preact-query', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/preact-query')>(), useQuery: () => query,
}));
vi.mock('../ui/src/views/feedback/BriefingDocumentRenderer', () => ({
  BriefingDocumentRenderer: ({ briefingId, roundId }: { briefingId: string; roundId: string | null }) =>
    <article data-testid="document" data-briefing={briefingId} data-round={roundId ?? 'latest'} />,
}));
vi.mock('../ui/src/views/feedback/BriefingGroupDetail', () => ({
  BriefingGroupDetail: ({ group }: { group: { id: string } }) => <article data-testid="group" data-group={group.id} />,
}));
vi.mock('../ui/src/views/feedback/CollectionShell', () => ({
  CollectionShell: ({ collections, groups = [], onSelect, onSelectGroup, children, viewState }: CollectionShellProps) => <div>
    <span data-testid="sidebar-selection">{viewState.selectedCollectionId ?? viewState.selectedGroupId ?? ''}</span>
    {collections.map((row) => <button onClick={() => onSelect?.(row)}>{row.label}</button>)}
    {groups.map((row) => <button onClick={() => onSelectGroup?.(row)}>{row.name}</button>)}
    {children}
  </div>,
}));

const rows = ['saved', 'target-one', 'target-two'].map((id) => ({ id: `briefing:${id}`, collectionId: id,
  label: id, description: null, publicationMode: null, unansweredDirectiveCount: 0,
  latestRoundId: 'latest', createdAt: 1, updatedAt: 1 }));
const snapshot = (): BriefingSidebarSnapshot => ({ briefings: rows, bundles: [], invalidBriefings: [], groups: [{
  id: 'group-uuid', key: 'policy-health', name: 'Policy', current: null, updates: [],
  destinations: [], destinationHistory: [], createdAt: 1, updatedAt: 1,
}] });
const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
const saved = () => JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}');

function RoutedView() {
  const [route, setRoute] = useState(() => parseRouteFromHash(window.location.hash));
  useEffect(() => {
    const change = () => setRoute(parseRouteFromHash(window.location.hash));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return <BriefingView instance={null} initialBriefingId={route.params.briefing}
    initialGroupId={route.params.group} initialRoundId={route.params.round} />;
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify({ selectedCollectionId: 'briefing:saved',
    selectedRoundIds: { 'briefing:saved': 'saved-round', 'briefing:target-one': 'old-target-round' }, search: 'kept' }));
  query.data = undefined; query.error = null; query.isFetching = true;
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
});

describe('Briefing route intent', () => {
  it('never presents saved detail while an explicit target resolves, fails, or is ambiguous', async () => {
    const view = render(<BriefingView instance={null} initialBriefingId="target" />);
    expect(screen.queryByTestId('document')).toBeNull();
    expect(screen.getByRole('status').getAttribute('data-route-state')).toBe('resolving');
    query.data = snapshot(); query.isFetching = false;
    view.rerender(<BriefingView instance={null} initialBriefingId="target" />);
    expect(screen.getByRole('alert').getAttribute('data-route-state')).toBe('ambiguous');
    expect(screen.getByTestId('sidebar-selection').textContent).toBe('');
    view.rerender(<BriefingView instance={null} initialBriefingId="absent" />);
    expect(screen.getByRole('alert').getAttribute('data-route-state')).toBe('not-found');
    query.error = new Error('offline');
    view.rerender(<BriefingView instance={null} initialBriefingId="absent" />);
    expect(screen.getByRole('alert').getAttribute('data-route-state')).toBe('error');
    expect(screen.queryByTestId('document')).toBeNull();
    await act(async () => {});
    expect(saved().selectedCollectionId).toBe('briefing:saved');
    query.error = null;
    view.rerender(<BriefingView instance={null} initialBriefingId="target-one" initialRoundId="linked-round" />);
    expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one');
    expect(screen.getByTestId('document').getAttribute('data-round')).toBe('linked-round');
  });

  it('resolves group keys and ID prefixes, and lets the Briefing identity own conflicting group context', () => {
    query.data = snapshot(); query.isFetching = false;
    const view = render(<BriefingView instance={null} initialGroupId="policy-health" />);
    expect(screen.getByTestId('group').getAttribute('data-group')).toBe('group-uuid');
    view.rerender(<BriefingView instance={null} initialGroupId="group-u" />);
    expect(screen.getByTestId('group').getAttribute('data-group')).toBe('group-uuid');
    view.rerender(<BriefingView instance={null} initialGroupId="policy-health" initialBriefingId="target-one" />);
    expect(screen.queryByTestId('group')).toBeNull();
    expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one');
    expect(screen.getByTestId('document').getAttribute('data-round')).toBe('latest');
  });

  it('keeps deliberate selection and query context through a sidebar refetch and remount', async () => {
    query.data = snapshot(); query.isFetching = false;
    window.history.replaceState(null, '', '#/briefing?briefing=saved&round=linked-round&sidebar=hidden&agent_session=worker&unknown=keep');
    const view = render(<RoutedView />);
    expect(screen.getByTestId('document').getAttribute('data-round')).toBe('linked-round');
    fireEvent.click(screen.getByRole('button', { name: 'target-one' }));
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one'));
    expect(parseRouteFromHash(window.location.hash).params).toEqual({ briefing: 'target-one', round: 'old-target-round',
      sidebar: 'hidden', agent_session: 'worker', unknown: 'keep' });
    query.data = { ...snapshot(), briefings: [...rows] };
    view.rerender(<RoutedView />);
    expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one');
    view.unmount(); render(<RoutedView />);
    expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one');
  });

  it('restores saved detail and its round when the route has no explicit target', () => {
    query.data = snapshot(); query.isFetching = false;
    render(<BriefingView instance={null} />);
    expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('saved');
    expect(screen.getByTestId('document').getAttribute('data-round')).toBe('saved-round');
  });

  it('does not warm unrelated saved detail for a missing or ambiguous explicit link', async () => {
    const fetch = vi.spyOn(queryClient, 'fetchQuery').mockResolvedValue(snapshot());
    await warmInitialData({ briefing: 'missing' });
    await warmInitialData({ briefing: 'target' });
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockClear();
    await warmInitialData({});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0].queryKey).toContain('saved');
  });
});
