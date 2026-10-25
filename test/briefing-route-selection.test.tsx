// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { useEffect, useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../ui/src/api';
import { ApiError, normalizeBriefingProjection, type BriefingSidebarSnapshot } from '../ui/src/api';
import type { CollectionShellProps } from '../ui/src/views/feedback/CollectionShell';
import { queryClient } from '../ui/src/query/client';
import { ROUTE_DATA_FRESH_MS } from '../ui/src/detail-cache';
import { browserResourceKeys } from '../ui/src/query/browserResources';
import { parseRouteFromHash } from '../ui/src/routing';
import { BriefingView, warmInitialData } from '../ui/src/views/briefing';
import { BRIEFING_VIEW_STATE_KEY } from '../ui/src/views/feedback/collection-view-state';

const query = vi.hoisted(() => ({ data: undefined as BriefingSidebarSnapshot | undefined,
  error: null as Error | null, isFetching: true, refetch: vi.fn(async () => undefined) }));
vi.mock('@tanstack/preact-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/preact-query')>();
  return { ...actual, useQuery: (options: Parameters<typeof actual.useQuery>[0], client: Parameters<typeof actual.useQuery>[1]) =>
    options.queryKey[1] === 'sidebar' ? query : actual.useQuery(options, client) };
});
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
const projection = (id: string) => normalizeBriefingProjection({
  briefing: { id, title: id, latest_round_id: 'latest', round_count: 1 },
  rounds: [{ id: 'latest', ordinal: 1, artifact_version_id: 'version', created_at: 1 }],
  selected_round: { id: 'latest' },
});

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
  queryClient.clear();
  vi.spyOn(api, 'getBriefing').mockImplementation(async (id) => {
    if (id === 'target') throw new ApiError('Ambiguous including archived row', 409, 'ambiguous_ref');
    if (id === 'absent') throw new ApiError('Not found', 404, 'not_found');
    if (id === 'offline') throw new Error('offline');
    return projection(id);
  });
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
  queryClient.clear();
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
    await waitFor(() => expect(screen.getByRole('alert').getAttribute('data-route-state')).toBe('ambiguous'));
    expect(screen.getByTestId('sidebar-selection').textContent).toBe('');
    view.rerender(<BriefingView instance={null} initialBriefingId="absent" />);
    await waitFor(() => expect(screen.getByRole('alert').getAttribute('data-route-state')).toBe('not-found'));
    view.rerender(<BriefingView instance={null} initialBriefingId="offline" />);
    await waitFor(() => expect(screen.getByRole('alert').getAttribute('data-route-state')).toBe('error'));
    expect(screen.queryByTestId('document')).toBeNull();
    await act(async () => {});
    expect(saved().selectedCollectionId).toBe('briefing:saved');
    query.error = null;
    view.rerender(<BriefingView instance={null} initialBriefingId="target-one" initialRoundId="linked-round" />);
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one'));
    expect(screen.getByTestId('document').getAttribute('data-round')).toBe('linked-round');
  });

  it('resolves group keys and ID prefixes, and lets the Briefing identity own conflicting group context', async () => {
    query.data = snapshot(); query.isFetching = false;
    const view = render(<BriefingView instance={null} initialGroupId="policy-health" />);
    expect(screen.getByTestId('group').getAttribute('data-group')).toBe('group-uuid');
    view.rerender(<BriefingView instance={null} initialGroupId="group-u" />);
    expect(screen.getByTestId('group').getAttribute('data-group')).toBe('group-uuid');
    view.rerender(<BriefingView instance={null} initialGroupId="policy-health" initialBriefingId="target-one" />);
    expect(screen.queryByTestId('group')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one'));
    expect(screen.getByTestId('document').getAttribute('data-round')).toBe('latest');
  });

  it('keeps deliberate selection and query context through a sidebar refetch and remount', async () => {
    query.data = snapshot(); query.isFetching = false;
    window.history.replaceState(null, '', '#/briefing?briefing=saved&round=linked-round&sidebar=hidden&agent_session=worker&unknown=keep');
    const view = render(<RoutedView />);
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-round')).toBe('linked-round'));
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

  it('resolves an unlisted archived target to canonical identity and honors hidden-collision ambiguity', async () => {
    query.data = { ...snapshot(), briefings: [rows[1]] }; query.isFetching = false;
    vi.mocked(api.getBriefing).mockImplementation(async (ref) => {
      if (ref === 'target') throw new ApiError('Hidden archived collision', 409, 'ambiguous_ref');
      return projection(ref === 'active-short' ? 'target-one' : 'archived-canonical');
    });
    const view = render(<BriefingView instance={null} initialBriefingId="archived-short" initialRoundId="linked-round" />);
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('archived-canonical'));
    expect(api.getBriefing).toHaveBeenCalledWith('archived-short', 'linked-round', null, expect.any(AbortSignal));
    expect(screen.getByTestId('sidebar-selection').textContent).toBe('briefing:archived-canonical');
    view.rerender(<BriefingView instance={null} initialBriefingId="active-short" />);
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one'));
    expect(screen.getByTestId('sidebar-selection').textContent).toBe('briefing:target-one');
    view.rerender(<BriefingView instance={null} initialBriefingId="target" />);
    await waitFor(() => expect(screen.getByRole('alert').getAttribute('data-route-state')).toBe('ambiguous'));
    expect(screen.queryByTestId('document')).toBeNull();
    expect(screen.getByTestId('sidebar-selection').textContent).toBe('');
  });

  it('warms explicit refs authoritatively before reading sidebar eligibility or saved detail', async () => {
    await expect(warmInitialData({ briefing: 'absent' })).rejects.toMatchObject({ status: 404 });
    await expect(warmInitialData({ briefing: 'target' })).rejects.toMatchObject({ status: 409 });
    await warmInitialData({ briefing: 'archived', round: 'linked-round' });
    expect(api.getBriefing).toHaveBeenCalledWith('archived', 'linked-round', null, expect.any(AbortSignal));
    const fetch = vi.spyOn(queryClient, 'fetchQuery').mockResolvedValue(snapshot());
    await warmInitialData({});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0].queryKey).toContain('saved');
  });

  it('honors an authoritative ambiguity even when an earlier resolution remains cached', async () => {
    query.data = snapshot(); query.isFetching = false;
    queryClient.setQueryData(
      browserResourceKeys.briefingProjection('target', null, null),
      projection('target-one'),
      { updatedAt: Date.now() - ROUTE_DATA_FRESH_MS - 1 },
    );
    render(<BriefingView instance={null} initialBriefingId="target" />);
    await waitFor(() => expect(screen.getByRole('alert').getAttribute('data-route-state')).toBe('ambiguous'));
    expect(screen.queryByTestId('document')).toBeNull();
    expect(screen.getByTestId('sidebar-selection').textContent).toBe('');
  });
});
