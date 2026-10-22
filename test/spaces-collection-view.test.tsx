import { invalidateApiGetCache, invalidateDashboardApiCacheForEvent } from '../ui/src/api';
import { queryClient } from '../ui/src/query/client';
import { establishTestClientAccess } from './helpers/local-client-access';
// Collection renderer component tests (umbrella de56ffa, C8 / issue fa83ec7).
//
// Drives the rendered view with a mocked fetch (the `GET /api/spaces/:id` fact
// packet + mutation routes) and a mocked EventSource (SSE reconciliation). It
// asserts the acceptance criteria: tree render, flat Items section, add/remove,
// quiet unresolved-ref placeholders, filter, and view-state persistence + SSE-without-
// reset of selection.
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSharedSseForTests } from '../ui/src/sse-shared';

import { SpaceCollectionRenderer } from '../ui/src/views/spaces/space-collection';
import { collectionStorageKey } from '../ui/src/views/spaces/collectionViewState';

const NOW = 1_700_000_000_000;

type Packet = {
  space: Record<string, unknown>;
  items: Record<string, unknown>[];
  occurrences: Record<string, unknown>[];
  edges: Record<string, unknown>[];
};

class MockEventSource {
  static instances: MockEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private handlers = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (e: MessageEvent) => void): void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
  }
  removeEventListener(type: string, handler: (e: MessageEvent) => void): void {
    this.handlers.get(type)?.delete(handler);
  }
  close(): void {
    this.readyState = 2;
  }
  emit(data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    this.handlers.get('message')?.forEach((h) => h(event));
  }
}

function fullPacket(overrides: Partial<Packet> = {}): Packet {
  return {
    space: {
      id: 'sp1',
      project_id: 'prj1',
      title: 'Space',
      default_renderer: 'collection',
      description: null,
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
    },
    items: [],
    occurrences: [],
    edges: [],
    ...overrides,
  };
}

function makeItem(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    space_id: 'sp1',
    ref_type: 'issue',
    ref_id: id,
    ref_uri: null,
    title: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

function makeOcc(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    space_id: 'sp1',
    item_id: null,
    renderer: 'collection',
    parent_id: null,
    x: null,
    y: null,
    width: null,
    height: null,
    z_index: null,
    sort_key: null,
    section_id: null,
    note: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

/**
 * Stub fetch over the Spaces routes. `getPacket` returns the current packet so
 * mutations (which call loadPacket(true) afterward) observe updated data.
 */
function stubFetch(opts: {
  getPacket: () => Packet;
  onMutation?: (method: string, url: string) => void;
  graphNodes?: Record<string, unknown>[];
  artifacts?: Record<string, unknown>[];
}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && /\/api\/spaces\/sp1(\?|$)/.test(url)) {
      return new Response(JSON.stringify(opts.getPacket()), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // The "Add items" picker reads candidate issues from the graph adapter and
    // artifacts from the artifacts list.
    if (method === 'GET' && url.includes('/api/graph')) {
      return new Response(JSON.stringify({ nodes: opts.graphNodes ?? [], edges: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'GET' && url.includes('/api/artifacts')) {
      return new Response(JSON.stringify({ artifacts: opts.artifacts ?? [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/spaces/resolve') || url.includes('/api/refs/resolve')) {
      return new Response(JSON.stringify({ resolution: { ref: 'x', kind: 'issue', resolved: false, entity: null } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // Mutations: items POST/DELETE, occurrences DELETE.
    opts.onMutation?.(method, url);
    return new Response(JSON.stringify({ ok: true, id: 'x', item: makeItem('new'), created: true, already_present: false }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function stubLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
    },
  });
}

beforeEach(async () => {
  invalidateApiGetCache();
  queryClient.clear();
  await establishTestClientAccess();
  stubLocalStorage();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  __resetSharedSseForTests();
});

afterEach(() => {
  invalidateApiGetCache();
  queryClient.clear();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SpaceCollectionRenderer', () => {
  it('surfaces item-only membership in the Items section (never lost)', async () => {
    stubFetch({
      getPacket: () =>
        fullPacket({
          items: [makeItem('placed', { title: 'Placed' }), makeItem('lonely', { title: 'Lonely' })],
          occurrences: [makeOcc('o', { item_id: 'placed' })],
        }),
    });
    render(<SpaceCollectionRenderer projectId="prj1" spaceId="sp1" renderer="collection" />);
    const shelf = await screen.findByTestId('space-collection-shelf');
    expect(within(shelf).getByText('Lonely')).toBeTruthy();
    // 'Placed' is in the tree, not the shelf.
    expect(within(shelf).queryByText('Placed')).toBeNull();
  });

  it('keeps a missing or unresolved ref visible instead of dropping it', async () => {
    stubFetch({
      getPacket: () =>
        fullPacket({
          items: [makeItem('i1', { ref_type: 'issue', ref_id: 'abc123', title: null })],
          occurrences: [],
        }),
    });
    const { container } = render(
      <SpaceCollectionRenderer projectId="prj1" spaceId="sp1" renderer="collection" />,
    );
    await screen.findByTestId('space-collection-shelf');
    const ref = container.querySelector('[data-ref-state]');
    expect(ref?.getAttribute('data-ref-state')).toBe('unresolved');
  });

  it('persists view-state (collapse) across remount', async () => {
    stubFetch({
      getPacket: () =>
        fullPacket({
          items: [makeItem('a', { title: 'Alpha' }), makeItem('b', { title: 'Beta' })],
          occurrences: [makeOcc('root', { item_id: 'a' }), makeOcc('kid', { item_id: 'b', parent_id: 'root' })],
        }),
    });
    const first = render(<SpaceCollectionRenderer projectId="prj1" spaceId="sp1" renderer="collection" />);
    await screen.findByTestId('space-collection-tree');
    // Collapse the root, hiding the child.
    fireEvent.click(screen.getByLabelText('Collapse'));
    await waitFor(() => expect(screen.queryByText('Beta')).toBeNull());
    // Persisted to localStorage.
    expect(window.localStorage.getItem(collectionStorageKey('prj1', 'sp1'))).toContain('root');
    first.unmount();
    // Remount: collapse state restored, child still hidden.
    render(<SpaceCollectionRenderer projectId="prj1" spaceId="sp1" renderer="collection" />);
    await screen.findByTestId('space-collection-tree');
    await waitFor(() => expect(screen.queryByText('Beta')).toBeNull());
  });

  it('reconciles an SSE event without resetting the current selection', async () => {
    let current = fullPacket({
      items: [makeItem('a', { title: 'Alpha' })],
      occurrences: [makeOcc('root', { item_id: 'a' })],
    });
    stubFetch({ getPacket: () => current });
    const { container } = render(
      <SpaceCollectionRenderer projectId="prj1" spaceId="sp1" renderer="collection" />,
    );
    await screen.findByTestId('space-collection-tree');
    // Select the root occurrence.
    fireEvent.click(screen.getByText('Alpha'));
    await waitFor(() =>
      expect(container.querySelector('[data-occurrence-id="root"]')?.getAttribute('data-selected')).toBe('true'),
    );
    // A space:* SSE event arrives; the packet still contains 'root'.
    current = fullPacket({
      items: [makeItem('a', { title: 'Alpha' }), makeItem('b', { title: 'Beta' })],
      occurrences: [makeOcc('root', { item_id: 'a' })],
    });
    // The isolated renderer fixture also supplies the root app's cache invalidation.
    invalidateDashboardApiCacheForEvent('space:item:added');
    MockEventSource.instances[0].emit({ type: 'space:item:added', data: { space_id: 'sp1' } });
    // New data shows up AND the selection survives reconciliation.
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());
    expect(container.querySelector('[data-occurrence-id="root"]')?.getAttribute('data-selected')).toBe('true');
  });
});
