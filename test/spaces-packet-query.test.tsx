// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from './helpers/dom';
import { useState } from 'preact/hooks';
import { AppShellProvider } from '../ui/src/app-shell';
import { clearApiGetCache, invalidateDashboardApiCacheForEvent, invalidateDashboardCaches, type SpaceFactPacket } from '../ui/src/api';
import { queryClient } from '../ui/src/query/client';
import { projectionKeys } from '../ui/src/query/projectionKeys';
import { clearPersistedDetailCache } from '../ui/src/detail-cache';
import { establishTestClientAccess } from './helpers/local-client-access';
import { SpacesViewShell } from '../ui/src/views/spaces/SpacesViewShell';
import { warmInitialData } from '../ui/src/views/spaces/SpacesTab';
import { SPACE_RENDERERS_REGISTRY } from '../ui/src/views/spaces/renderers';

vi.mock('../ui/src/views/spaces/SpacesSidebar', () => ({
  SpacesSidebar: () => null, persistGroups: () => undefined, defaultInitialSpaceId: () => null,
}));

const noop = () => undefined;
function Workspace({ active = true, spaceId = 'sp1', renderer }: { active?: boolean; spaceId?: string; renderer?: string }) {
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null);
  return <AppShellProvider value={{ active, noticeHost, rightSidebar: null,
    registerRightSidebar: () => noop, registerInitialRouteLoad: noop, updateRightSidebar: noop }}>
    <div ref={setNoticeHost} />
    <SpacesViewShell projectId="p1" spaceId={spaceId} renderer={renderer} renderers={SPACE_RENDERERS_REGISTRY} />
  </AppShellProvider>;
}

function packet(title = 'Workspace', itemTitle = 'Alpha'): SpaceFactPacket {
  return {
    space: { id: 'sp1', project_id: 'p1', title, default_renderer: 'collection', description: null, metadata: {}, created_at: 1, updated_at: 1 },
    items: [{ id: 'item1', space_id: 'sp1', ref_type: 'artifact', ref_id: 'artifact-a', ref_uri: null, title: itemTitle, metadata: {}, created_at: 1, updated_at: 1 }],
    occurrences: [{ id: 'occ1', space_id: 'sp1', item_id: 'item1', renderer: 'collection', parent_id: null, x: null, y: null, width: null, height: null,
      z_index: null, sort_key: null, section_id: null, note: null, metadata: {}, created_at: 1, updated_at: 1 }],
    edges: [],
  };
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  queryClient.clear(); clearApiGetCache(); localStorage.clear(); clearPersistedDetailCache();
  await establishTestClientAccess();
});
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); });

it('shares warmup and shell/renderer packet reads, then refreshes metadata and content together', async () => {
  let current = packet();
  const fetch = vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/spaces' ? json({ groups: [] }) : json(current));
  vi.stubGlobal('fetch', fetch);
  await warmInitialData({ space: 'sp1' });
  const view = render(<Workspace />);
  await screen.findByText('Alpha');
  expect(fetch.mock.calls.filter(([input]) => String(input) === '/api/spaces/sp1')).toHaveLength(1);
  const shell = screen.getByTestId('spaces-view-shell');

  current = packet('Updated workspace', 'Updated item');
  current.space.default_renderer = 'board';
  current.occurrences[0].renderer = 'board';
  act(() => invalidateDashboardApiCacheForEvent('ledger:issue:updated'));
  await screen.findByText('Updated item');
  expect(screen.getByText('Updated workspace')).toBeTruthy();
  expect(screen.getByTestId('spaces-view-shell')).toBe(shell);
  await screen.findByTestId('space-board');
  expect(shell.getAttribute('data-active-renderer')).toBe('board');
  view.rerender(<Workspace renderer="collection" />);
  await screen.findByTestId('space-collection');
  expect(fetch.mock.calls.filter(([input]) => String(input) === '/api/spaces/sp1')).toHaveLength(2);
});

it('keeps selection, filter and scroll while a failed packet refresh trails an in-flight event', async () => {
  const refresh = deferred<Response>();
  const latest = packet('Latest workspace', 'Alpha latest');
  const fetch = vi.fn().mockResolvedValueOnce(json(packet())).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(json(latest));
  vi.stubGlobal('fetch', fetch);
  const view = render(<Workspace />);
  fireEvent.click(await screen.findByText('Alpha'));
  fireEvent.input(screen.getByLabelText('Filter collection items'), { target: { value: 'Alpha' } });
  const body = screen.getByTestId('space-collection-body'); body.scrollTop = 163;
  act(() => invalidateDashboardCaches());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  act(() => invalidateDashboardApiCacheForEvent('ledger:comment:added'));
  expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
  refresh.resolve(json({ error: 'unavailable' }, 503));
  await screen.findByText('Alpha latest');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect((screen.getByLabelText('Filter collection items') as HTMLInputElement).value).toBe('Alpha');
  expect(view.container.querySelector('[data-occurrence-id="occ1"]')?.getAttribute('data-selected')).toBe('true');
  expect(screen.getByTestId('space-collection-body')).toBe(body);
  expect(body.scrollTop).toBe(163);
});

it('abandons hidden packet reads and reconciles on activation without resetting mounted content', async () => {
  const pending = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(json(packet())).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json(packet('Visible', 'New Alpha')));
  vi.stubGlobal('fetch', fetch);
  const view = render(<Workspace />);
  await screen.findByText('Alpha');
  act(() => invalidateDashboardCaches());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const signal = fetch.mock.calls[1][1].signal;
  view.rerender(<Workspace active={false} />);
  await waitFor(() => expect(signal.aborted).toBe(true));
  expect(screen.getByText('Alpha')).toBeTruthy();
  act(() => invalidateDashboardCaches());
  expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<Workspace />);
  await screen.findByText('New Alpha');
  pending.resolve(json(packet('Obsolete', 'Old Alpha')));
  expect(screen.queryByText('Old Alpha')).toBeNull();
});

it('does not mount a cached short-ref alias before authoritative ambiguity resolution', async () => {
  const ref = '12345678';
  queryClient.setQueryData(projectionKeys.spacePacket(ref), packet('Stale alias', 'Stale item'));
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise));
  render(<Workspace spaceId={ref} renderer="collection" />);
  expect(screen.queryByText('Stale item')).toBeNull();
  expect(screen.queryByText('Stale alias')).toBeNull();
  pending.resolve(json({ error: 'ambiguous space ref' }, 409));
  await screen.findByText('ambiguous space ref');
  expect(screen.queryByTestId('space-collection')).toBeNull();
});
