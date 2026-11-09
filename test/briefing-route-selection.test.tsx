import { useAppHistory } from '../ui/src/hooks/useAppHistory';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../ui/src/api';
import { ApiError, normalizeBriefingProjection, type BriefingSidebarSnapshot } from '../ui/src/api';
import type { CollectionShellProps } from '../ui/src/views/feedback/CollectionShell';
import { queryClient } from '../ui/src/query/client';
import { routeFromUrl } from '../ui/src/routing';
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
  const navigation = useAppHistory();
  const route = routeFromUrl(new URL(navigation.href));
  return <BriefingView instance={null} entityRef={route.entity?.ref ?? null}
    initialGroupKey={route.params.group} initialRoundId={route.params.round} />;
}

beforeEach(() => {
  queryClient.clear();
  vi.spyOn(api, 'resolveEntityRoute').mockImplementation(async (kind, ref) => {
    if (ref === 'target') return { kind, ref, status: 'ambiguous', matches: [], total: 2 };
    if (ref === 'absent') return { kind, ref, status: 'not_found' };
    if (ref === 'offline') throw new Error('offline');
    return { kind, ref, status: 'resolved', entity: { id: ref, ref: `briefing:${ref}` } };
  });
  vi.spyOn(api, 'getBriefing').mockImplementation(async (id) => projection(id));
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
  it('never presents saved detail while an entity path resolves, fails, or is ambiguous', async () => {
    query.data = snapshot(); query.isFetching = false;
    const view = render(<BriefingView instance={null} entityRef="target" />);
    expect(screen.queryByTestId('document')).toBeNull();
    for (const ref of ['target', 'absent', 'offline']) {
      view.rerender(<BriefingView instance={null} entityRef={ref} />);
      await waitFor(() => expect(api.resolveEntityRoute).toHaveBeenCalledWith('briefing', ref, expect.anything()));
      await act(async () => {});
      expect(document.querySelector('.entity-route-state')).not.toBeNull();
      expect(screen.queryByTestId('document')).toBeNull();
      expect(screen.getByTestId('sidebar-selection').textContent).toBe('');
    }
    await act(async () => {});
    expect(saved().selectedCollectionId).toBe('briefing:saved');
    view.rerender(<BriefingView instance={null} entityRef="target-one" initialRoundId="linked-round" />);
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one'));
    expect(screen.getByTestId('document').getAttribute('data-round')).toBe('linked-round');
  });

  it('resolves group keys, and lets the Briefing identity own conflicting group context', async () => {
    query.data = snapshot(); query.isFetching = false;
    const view = render(<BriefingView instance={null} initialGroupKey="policy-health" />);
    expect(screen.getByTestId('group').getAttribute('data-group')).toBe('group-uuid');
    view.rerender(<BriefingView instance={null} initialGroupKey="policy-health" entityRef="target-one" />);
    expect(screen.queryByTestId('group')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one'));
    expect(screen.getByTestId('document').getAttribute('data-round')).toBe('latest');
  });

  it('keeps deliberate selection and query context through a sidebar refetch and remount', async () => {
    query.data = snapshot(); query.isFetching = false;
    window.history.replaceState(null, '', '/briefing/saved?round=linked-round&sidebar=hidden&agent_session=worker&unknown=keep');
    const view = render(<RoutedView />);
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-round')).toBe('linked-round'));
    fireEvent.click(screen.getByRole('button', { name: 'target-one' }));
    await waitFor(() => expect(screen.getByTestId('document').getAttribute('data-briefing')).toBe('target-one'));
    expect(routeFromUrl(window.location)).toMatchObject({ entity: { kind: 'briefing', ref: 'target-one' },
      params: { round: 'old-target-round', sidebar: 'hidden', agent_session: 'worker', unknown: 'keep' } });
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

  it('warms the sidebar and saved detail when the route has no explicit target', async () => {
    const fetch = vi.spyOn(queryClient, 'fetchQuery').mockResolvedValue(snapshot());
    await warmInitialData({});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0].queryKey).toContain('saved');
  });
});
