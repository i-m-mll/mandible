// @vitest-environment jsdom
import { establishTestClientAccess } from './helpers/local-client-access';
import { act, cleanup, fireEvent, render, waitFor } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppShellProvider,
  type AppRightSidebarDescriptor,
  type AppShellContextValue,
} from '../ui/src/app-shell';
import { invalidateApiGetCache, clearApiGetCache, invalidateDashboardApiCacheForEvent } from '../ui/src/api';
import { GraphView } from '../ui/src/views/graph';
import { useMemo, useState } from 'preact/hooks';
import { queryClient } from '../ui/src/query/client';
import { clearPersistedDetailCache } from '../ui/src/detail-cache';

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  ReactFlow: ({ children, nodes, onNodeClick }: { children?: JSX.Element | JSX.Element[]; nodes: any[]; onNodeClick: (event: unknown, node: any) => void }) => {
    const [viewport, setViewport] = useState('fit');
    return <div data-testid="flow-canvas" data-viewport={viewport}>
      <button onClick={() => setViewport('x:120,y:60,zoom:0.75')}>Pan and zoom</button>
      {nodes.map((node) => <button key={node.id} onClick={() => onNodeClick({}, node)}>Select {node.data.node.label}</button>)}
      {children}
    </div>;
  },
  ViewportPortal: ({ children }: { children?: JSX.Element | JSX.Element[] }) => children ?? null,
}));

function installMemoryLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  return { storage, values };
}

function graphResponse(): Response {
  return new Response(JSON.stringify({
    mode: 'issue',
    nodes: [],
    edges: [],
  }), { headers: { 'content-type': 'application/json' } });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function renderGraph(refreshToken = 0, initialFocus?: string) {
  let descriptor: AppRightSidebarDescriptor | null = null;
  let owner: string | null = null;
  const registerRightSidebar: AppShellContextValue['registerRightSidebar'] = (ownerId) => {
    owner = ownerId;
    return () => {
      if (owner === ownerId) owner = null;
      if (descriptor?.id === ownerId) descriptor = null;
    };
  };
  const updateRightSidebar: AppShellContextValue['updateRightSidebar'] = (ownerId, next) => {
    if (owner === ownerId) descriptor = next;
  };
  const value: AppShellContextValue = {
    rightSidebar: null,
    registerRightSidebar,
    registerInitialRouteLoad: () => undefined,
    updateRightSidebar,
    setViewSidebarWidth: () => undefined,
    active: true,
  };
  const onNavigate = () => undefined;
  function Shell({ token, focus }: { token: number; focus?: string }) {
    const [inspector, setInspector] = useState<AppRightSidebarDescriptor | null>(null);
    const [noticeHost, setNoticeHost] = useState<HTMLDivElement | null>(null);
    const context = useMemo(() => ({ ...value, noticeHost, updateRightSidebar: (ownerId: string, next: AppRightSidebarDescriptor) => {
      updateRightSidebar(ownerId, next);
      setInspector(next);
    } }), [noticeHost]);
    return <AppShellProvider value={context}>
      <GraphView onNavigate={onNavigate} refreshToken={token} initialFocus={focus} />
      <div ref={setNoticeHost} />
      <div data-testid="graph-inspector">{inspector?.content}</div>
    </AppShellProvider>;
  }
  const rendered = render(<Shell token={refreshToken} focus={initialFocus} />);
  return {
    ...rendered,
    getDescriptor: () => descriptor,
    rerenderGraph: (nextRefreshToken: number, focus = initialFocus) => rendered.rerender(
      <Shell token={nextRefreshToken} focus={focus} />,
    ),
  };
}

beforeEach(async () => {
  installMemoryLocalStorage();
  clearApiGetCache();
  queryClient.clear();
  clearPersistedDetailCache();
  await establishTestClientAccess();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(graphResponse())));
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GraphView persisted detail panel state', () => {
  it('preserves viewport, selection and inspector through pending/error and empty topology reconciliation', async () => {
    const payload = (label: string, second = false) => ({ mode: 'issue', nodes: [
      { id: 'first', type: 'repo', label },
      ...(second ? [{ id: 'second', type: 'repo', label: 'Second repo' }] : []),
    ], edges: [] });
    let response: () => Promise<Response> = async () => jsonResponse(payload('First repo'));
    const fetcher = vi.fn(() => response());
    vi.stubGlobal('fetch', fetcher);
    const view = renderGraph();
    fireEvent.click(await view.findByRole('button', { name: 'Select First repo' }));
    fireEvent.click(view.getByRole('button', { name: 'Pan and zoom' }));
    const canvas = view.getByTestId('flow-canvas');
    act(() => view.getDescriptor()!.onWidthChange(420));
    response = async () => jsonResponse(payload('First updated', true));
    act(() => invalidateDashboardApiCacheForEvent('ledger:relationship:added'));
    expect(await view.findByRole('button', { name: 'Select Second repo' })).toBeTruthy();
    expect(view.getByTestId('flow-canvas')).toBe(canvas);
    expect(canvas.dataset.viewport).toBe('x:120,y:60,zoom:0.75');
    expect(view.getByTestId('graph-inspector').textContent).toContain('First updated');
    expect(view.getDescriptor()).toMatchObject({ open: true, width: 420 });
    let finish!: (response: Response) => void;
    response = () => new Promise((resolve) => { finish = resolve; });
    act(() => invalidateDashboardApiCacheForEvent('ledger:label:updated'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(view.getByRole('button', { name: 'Select Second repo' })).toBeTruthy();
    finish(jsonResponse({ error: 'Temporary graph failure' }, 503));
    expect(await view.findByText('Temporary graph failure')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Select Second repo' })).toBeTruthy();
    response = async () => jsonResponse({ mode: 'issue', nodes: [], edges: [] });
    act(() => invalidateDashboardApiCacheForEvent('artifact:changed'));
    expect(await view.findByText('No graph data')).toBeTruthy();
    expect(view.getByTestId('flow-canvas')).toBe(canvas);
    response = async () => jsonResponse(payload('First returned', true));
    act(() => invalidateDashboardApiCacheForEvent('ledger:comment:created'));
    expect(await view.findByRole('button', { name: 'Select First returned' })).toBeTruthy();
    expect(view.getByTestId('graph-inspector').textContent).toContain('First returned');
    expect(canvas.dataset.viewport).toBe('x:120,y:60,zoom:0.75');
  });

  it('keeps a later spec when its older request completes last', async () => {
    let finishOld!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const since = new URL(String(input), 'http://localhost').searchParams.get('since');
      return since === '1d' ? Promise.resolve(jsonResponse({ mode: 'issue', nodes: [{ id: 'new', type: 'repo', label: 'New spec' }], edges: [] }))
        : new Promise<Response>((resolve) => { finishOld = resolve; });
    }));
    const view = renderGraph();
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    fireEvent.click(view.getByRole('button', { name: '1d' }));
    expect(await view.findByRole('button', { name: 'Select New spec' })).toBeTruthy();
    await act(async () => finishOld(jsonResponse({ mode: 'issue', nodes: [{ id: 'old', type: 'repo', label: 'Old spec' }], edges: [] })));
    expect(view.queryByRole('button', { name: 'Select Old spec' })).toBeNull();
    expect(view.getByRole('button', { name: 'Select New spec' })).toBeTruthy();
  });

  it('keeps a missing mounted focus unresolved and preserves an optional closed inspector on refetch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      mode: 'issue', nodes: [{ id: 'loaded', type: 'issue', label: 'Loaded issue', status: 'open' }], edges: [],
    }), { headers: { 'content-type': 'application/json' } }))));
    const view = renderGraph(0, 'loaded');
    await waitFor(() => {
      expect(view.getByTestId('graph-inspector').textContent).toContain('Loaded issue');
    });
    view.rerenderGraph(0, 'absent');
    await waitFor(() => {
      expect(view.getByTestId('graph-inspector').textContent).toContain('absent');
      expect(view.getByTestId('graph-inspector').textContent).not.toContain('Loaded issue');
    });
    act(() => view.getDescriptor()!.onOpenChange(false));
    invalidateApiGetCache('/api/graph');
    view.rerenderGraph(1, 'absent');
    await waitFor(() => expect(view.getDescriptor()?.open).toBe(false));
  });

  it('restores, clamps, writes through, and preserves panel intent across refetches', async () => {
    const openKey = 'mandible_graph_detail_panel_open:v1';
    const heightKey = 'mandible_graph_detail_panel_height:v1';
    const { values } = installMemoryLocalStorage({
      [openKey]: 'false',
      [heightKey]: '999',
    });
    const view = renderGraph();

    await waitFor(() => expect(view.getDescriptor()).not.toBeNull());
    expect(view.getDescriptor()).toMatchObject({ open: false, width: 380 });
    expect(values.has(openKey)).toBe(false);
    expect(values.has(heightKey)).toBe(false);

    act(() => {
      view.getDescriptor()!.onOpenChange(true);
      view.getDescriptor()!.onWidthChange(400);
    });
    await waitFor(() => {
      expect(values.get('mandible_app_right_sidebar:graph:v1')).toBe(JSON.stringify({ open: true, width: 400 }));
    });

    const fetchCountBeforeRefetch = vi.mocked(fetch).mock.calls.length;
    invalidateApiGetCache('/api/graph');
    view.rerenderGraph(1);
    await waitFor(() => expect(
      vi.mocked(fetch).mock.calls.length,
    ).toBeGreaterThan(fetchCountBeforeRefetch));
    expect(view.getDescriptor()).toMatchObject({ open: true, width: 400 });
  });
});
