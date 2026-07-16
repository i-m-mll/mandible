import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppShellProvider,
  type AppBottomPanelDescriptor,
  type AppShellContextValue,
} from '../ui/src/app-shell';
import { GraphView } from '../ui/src/views/graph';

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  ReactFlow: ({ children }: { children?: JSX.Element | JSX.Element[] }) => <div>{children}</div>,
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

function renderGraph(refreshToken = 0) {
  let descriptor: AppBottomPanelDescriptor | null = null;
  const registerBottomPanel: AppShellContextValue['registerBottomPanel'] = (next) => {
    descriptor = next;
    return () => {
      if (descriptor === next) descriptor = null;
    };
  };
  const value: AppShellContextValue = { bottomPanel: null, registerBottomPanel };
  const rendered = render(
    <AppShellProvider value={value}>
      <GraphView onNavigate={() => undefined} refreshToken={refreshToken} />
    </AppShellProvider>,
  );
  return {
    ...rendered,
    getDescriptor: () => descriptor,
    rerenderGraph: (nextRefreshToken: number) => rendered.rerender(
      <AppShellProvider value={value}>
        <GraphView onNavigate={() => undefined} refreshToken={nextRefreshToken} />
      </AppShellProvider>,
    ),
  };
}

beforeEach(() => {
  installMemoryLocalStorage();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(graphResponse())));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GraphView persisted detail panel state', () => {
  it('restores, clamps, writes through, and preserves panel intent across refetches', async () => {
    const openKey = 'mandible_graph_detail_panel_open:v1';
    const heightKey = 'mandible_graph_detail_panel_height:v1';
    const { values } = installMemoryLocalStorage({
      [openKey]: 'false',
      [heightKey]: '999',
    });
    const view = renderGraph();

    await waitFor(() => expect(view.getDescriptor()).not.toBeNull());
    expect(view.getDescriptor()).toMatchObject({ open: false, height: 520 });
    expect(values.get(openKey)).toBe('false');
    expect(values.get(heightKey)).toBe('999');

    act(() => {
      view.getDescriptor()!.onOpenChange(true);
      view.getDescriptor()!.onHeightChange(400);
    });
    await waitFor(() => {
      expect(values.get(openKey)).toBe('true');
      expect(values.get(heightKey)).toBe('400');
    });

    const fetchCountBeforeRefetch = vi.mocked(fetch).mock.calls.length;
    view.rerenderGraph(1);
    await waitFor(() => expect(
      vi.mocked(fetch).mock.calls.length,
    ).toBeGreaterThan(fetchCountBeforeRefetch));
    expect(view.getDescriptor()).toMatchObject({ open: true, height: 400 });
  });

  it('uses current defaults for malformed panel state without rewriting on mount', async () => {
    const openKey = 'mandible_graph_detail_panel_open:v1';
    const heightKey = 'mandible_graph_detail_panel_height:v1';
    const { storage, values } = installMemoryLocalStorage({
      [openKey]: '{malformed',
      [heightKey]: '"not-a-number"',
    });
    const view = renderGraph();

    await waitFor(() => expect(view.getDescriptor()).not.toBeNull());
    expect(view.getDescriptor()).toMatchObject({ open: true, height: 340 });
    expect(values.get(openKey)).toBe('{malformed');
    expect(values.get(heightKey)).toBe('"not-a-number"');
    expect(vi.mocked(storage.setItem).mock.calls).not.toContainEqual([openKey, expect.any(String)]);
    expect(vi.mocked(storage.setItem).mock.calls).not.toContainEqual([heightKey, expect.any(String)]);
  });
});
