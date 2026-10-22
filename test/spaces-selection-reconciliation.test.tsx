// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { act, cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { ApiError, listSpacesGrouped, type Space, type SpaceFactPacket } from '../ui/src/api';
import { AppShellProvider } from '../ui/src/app-shell';
import { clearPersistedDetailCache } from '../ui/src/detail-cache';
import { parseRouteFromHash, replaceRouteHash, spacesRouteFromHash, type SpacesRouteTarget } from '../ui/src/routing';
import { SpacesViewShell, type SpaceRendererMountProps } from '../ui/src/views/spaces/SpacesViewShell';
import { readSpacesLastView, savedSpacesSelection, writeSpacesLastView } from '../ui/src/views/spaces/last-view';

vi.mock('../ui/src/api', async (original) => ({
  ...await original<typeof import('../ui/src/api')>(),
  listSpacesGrouped: vi.fn(),
}));

const context = 'sidebar=hidden&agent_session=bound&sentinel=a%26b%2Bc';
const mountedTargets: Array<string | null> = [];
const register = () => undefined;
const registerSidebar = () => () => undefined;
const renderers = { document: (props: SpaceRendererMountProps) => {
  mountedTargets.push(props.spaceId);
  return <output aria-label="Opened space">{props.spaceId}</output>;
} };

function space(id: string): Space {
  return { id, project_id: null, title: `Space ${id}`, default_renderer: 'document',
    description: null, metadata: {}, created_at: 0, updated_at: 0 };
}

function packet(id: string): SpaceFactPacket {
  return { space: space(id), items: [], occurrences: [], edges: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Harness({ load, active = true, navigated }: {
  load: (id: string) => Promise<SpaceFactPacket>; active?: boolean; navigated: (target: SpacesRouteTarget) => void;
}) {
  const [route, setRoute] = useState(() => parseRouteFromHash(window.location.hash));
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const update = () => setRoute(parseRouteFromHash(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (active && route.tab === 'spaces' && route.params.space) {
      writeSpacesLastView({ projectId: route.params.project ?? null, spaceId: route.params.space });
    }
  }, [active, route]);
  const navigate = useCallback((target: SpacesRouteTarget) => {
    if (!active || parseRouteFromHash(window.location.hash).tab !== 'spaces') return;
    navigated(target);
    replaceRouteHash(spacesRouteFromHash(window.location.hash, target));
  }, [active, navigated]);
  return <AppShellProvider value={{ active, noticeHost, rightSidebar: null,
    registerRightSidebar: registerSidebar, updateRightSidebar: register, registerInitialRouteLoad: register }}>
    <div ref={setNoticeHost} />
    <SpacesViewShell projectId={route.params.project ?? ''} spaceId={route.params.space ?? null}
      savedSelection={savedSpacesSelection(route.params)} renderer={route.params.renderer}
      loadSpaceFactPacket={load} onNavigate={navigate} renderers={renderers} />
  </AppShellProvider>;
}

function expectContext() {
  const params = new URLSearchParams(window.location.hash.split('?')[1]);
  expect(params.get('sidebar')).toBe('hidden');
  expect(params.get('agent_session')).toBe('bound');
  expect(params.get('sentinel')).toBe('a&b+c');
  return params;
}

beforeEach(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  vi.stubGlobal('localStorage', storage);
  window.localStorage.clear();
  clearPersistedDetailCache();
  mountedTargets.length = 0;
  writeSpacesLastView({ projectId: null, spaceId: 'A' });
  window.history.replaceState(null, '', `#/spaces?${context}`);
  vi.mocked(listSpacesGrouped).mockResolvedValue([{ project_id: null, project_key: null, project_name: null, spaces: [space('B'), space('C')] }]);
});

afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('validates an unlisted saved space before URL promotion without mounting the first row', async () => {
  const a = deferred<SpaceFactPacket>();
  const load = vi.fn((id: string) => id === 'A' ? a.promise : Promise.resolve(packet(id)));
  const navigated = vi.fn();
  render(<Harness load={load} navigated={navigated} />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Space B (Document)' })).toBeTruthy();
  expect(navigated).not.toHaveBeenCalled();
  expect(expectContext().get('space')).toBeNull();
  await act(async () => replaceRouteHash('#/spaces?sentinel=a%26b%2Bc&agent_session=bound&sidebar=hidden'));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => a.resolve(packet('A')));
  await waitFor(() => expect(screen.getByLabelText('Opened space').textContent).toBe('A'));
  expect(expectContext().get('space')).toBe('A');
  expect(mountedTargets).not.toContain('B');
});

it('discards a deleted saved space after 404, selects the first eligible space and restores it on refresh', async () => {
  const a = deferred<SpaceFactPacket>();
  const load = vi.fn((id: string) => id === 'A' ? a.promise : Promise.resolve(packet(id)));
  const navigated = vi.fn();
  const view = render(<Harness load={load} navigated={navigated} />);
  await screen.findByRole('button', { name: 'Space B (Document)' });
  expect(navigated).not.toHaveBeenCalled();
  await act(async () => a.reject(new ApiError('saved space deleted', 404)));
  await waitFor(() => expect(screen.getByLabelText('Opened space').textContent).toBe('B'));
  expect(expectContext().get('space')).toBe('B');
  await waitFor(() => expect(readSpacesLastView()?.spaceId).toBe('B'));
  view.unmount();
  window.history.replaceState(null, '', `#/spaces?${context}`);
  render(<Harness load={load} navigated={navigated} />);
  await waitFor(() => expect(screen.getByLabelText('Opened space').textContent).toBe('B'));
  expect(expectContext().get('space')).toBe('B');
});

it('leaves a genuine empty collection after a deleted saved target is authoritatively missing', async () => {
  vi.mocked(listSpacesGrouped).mockResolvedValue([]);
  const navigated = vi.fn();
  const load = vi.fn(async () => { throw new ApiError('deleted', 404); });
  render(<Harness load={load} navigated={navigated} />);
  await waitFor(() => expect(readSpacesLastView()).toBeNull());
  expect(navigated).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Opened space')).toBeNull();
  expect(expectContext().get('space')).toBeNull();
});

it.each([404, 409])('retains an explicit unavailable target with status %s instead of selecting an eligible row', async (status) => {
  window.history.replaceState(null, '', `#/spaces?space=A&${context}`);
  const navigated = vi.fn();
  const load = vi.fn(async () => { throw new ApiError(status === 409 ? 'ambiguous space ref' : 'explicit space missing', status); });
  render(<Harness load={load} navigated={navigated} />);
  await screen.findByText(status === 409 ? 'ambiguous space ref' : 'explicit space missing');
  expect(navigated).not.toHaveBeenCalled();
  expect(expectContext().get('space')).toBe('A');
  expect(screen.queryByLabelText('Opened space')).toBeNull();
});

it.each(['link', 'row'])('lets a later %s selection supersede pending saved restoration', async (choice) => {
  const a = deferred<SpaceFactPacket>();
  const load = vi.fn((id: string) => id === 'A' ? a.promise : Promise.resolve(packet(id)));
  const navigated = vi.fn();
  render(<Harness load={load} navigated={navigated} />);
  if (choice === 'row') fireEvent.click(await screen.findByRole('button', { name: 'Space C (Document)' }));
  else await act(async () => replaceRouteHash(`#/spaces?space=C&${context}`));
  await waitFor(() => expect(screen.getByLabelText('Opened space').textContent).toBe('C'));
  await act(async () => a.resolve(packet('A')));
  expect(screen.getByLabelText('Opened space').textContent).toBe('C');
  expect(expectContext().get('space')).toBe('C');
  expect(mountedTargets).not.toContain('A');
});

it.each([409, 503])('retains saved intent on status %s and retries the same target', async (status) => {
  const load = vi.fn().mockRejectedValueOnce(new ApiError(status === 409 ? 'saved ref ambiguous' : 'temporarily unavailable', status))
    .mockResolvedValue(packet('A'));
  const navigated = vi.fn();
  render(<Harness load={load} navigated={navigated} />);
  await screen.findByText(status === 409 ? 'saved ref ambiguous' : 'temporarily unavailable');
  expect(navigated).not.toHaveBeenCalled();
  expect(readSpacesLastView()?.spaceId).toBe('A');
  expect(expectContext().get('space')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry space' }));
  await waitFor(() => expect(screen.getByLabelText('Opened space').textContent).toBe('A'));
  expect(load.mock.calls.every(([id]) => id === 'A')).toBe(true);
  expect(expectContext().get('space')).toBe('A');
});

it('does not navigate from an inactive view after a pending saved result', async () => {
  const a = deferred<SpaceFactPacket>();
  const load = vi.fn(() => a.promise);
  const navigated = vi.fn();
  const view = render(<Harness load={load} navigated={navigated} />);
  await waitFor(() => expect(load).toHaveBeenCalledWith('A'));
  window.history.replaceState(null, '', `#/tasks?${context}`);
  view.rerender(<Harness load={load} navigated={navigated} active={false} />);
  await act(async () => {
    a.resolve(packet('A'));
  });
  expect(navigated).not.toHaveBeenCalled();
  expect(window.location.hash.startsWith('#/tasks?')).toBe(true);
  expectContext();
});
