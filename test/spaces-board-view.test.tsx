import { invalidateApiGetCache, invalidateDashboardApiCacheForEvent } from '../../ui/src/api';
import { queryClient } from '../../ui/src/query/client';
import { establishTestClientAccess } from '../helpers/local-client-access';
// Board renderer component tests (umbrella de56ffa, child 4d4d364 / C17).
//
// Drives the rendered board with a mocked fetch (the `GET /api/spaces/:id` fact
// packet, the issue resolver, the occurrence PATCH route, and the space PATCH
// route) and a mocked EventSource (SSE reconciliation). Asserts the acceptance
// criteria: worker_status default columns, custom-column add persisted to
// spaces.metadata, drag/keyboard moves that write section_id/sort_key, and SSE
// reconciliation that does not reset selection.
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSharedSseForTests } from '../../ui/src/sse-shared';
import { h } from 'preact';

import { SpaceBoardRenderer } from '../../ui/src/views/spaces/SpaceBoard';
import { SPACE_RENDERERS_REGISTRY } from '../../ui/src/views/spaces/renderers';
import {
  defaultColumnKey,
  BOARD_METADATA_KEY,
} from '../../ui/src/views/spaces/boardModel';
import { boardStorageKey } from '../../ui/src/views/spaces/boardViewState';

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
    this.handlers.get('message')?.forEach((handler) => handler(event));
  }
}

function makeSpace(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sp1',
    project_id: 'prj1',
    title: 'Board',
    default_renderer: 'board',
    description: null,
    metadata,
    created_at: NOW,
    updated_at: NOW,
  };
}

function fullPacket(overrides: Partial<Packet> = {}): Packet {
  return {
    space: makeSpace(),
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
    renderer: 'board',
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

type Mutation = { method: string; url: string; body: unknown };

/**
 * Stub fetch over the Spaces routes. `state.packet` is mutable so mutations
 * (which call loadPacket(true) afterward) observe updated data. `workerStatus`
 * maps an issue ref_id to the worker_status the resolver should report.
 */
function stubFetch(state: {
  packet: Packet;
  workerStatus?: Record<string, string>;
  mutations: Mutation[];
  graphNodes?: Record<string, unknown>[];
  artifacts?: Record<string, unknown>[];
}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === 'GET' && url.includes('/api/graph')) {
      return new Response(JSON.stringify({ nodes: state.graphNodes ?? [], edges: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method === 'GET' && url.includes('/api/artifacts')) {
      return new Response(JSON.stringify({ artifacts: state.artifacts ?? [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Resolver: report a worker_status for the requested issue ref.
    if (url.includes('/api/spaces/resolve') || url.includes('/api/refs/resolve')) {
      const refMatch = /[?&]ref=([^&]+)/.exec(url);
      const ref = refMatch ? decodeURIComponent(refMatch[1]) : '';
      const idMatch = /issue\/([^/?]+)/.exec(ref);
      const refId = idMatch ? idMatch[1] : '';
      const ws = state.workerStatus?.[refId];
      return new Response(
        JSON.stringify({
          resolution: {
            ref,
            kind: 'issue',
            resolved: ws !== undefined,
            entity: ws !== undefined ? { id: refId, worker_status: ws, kind: 'feature' } : null,
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }

    // Space PATCH (custom-column metadata write).
    if (method === 'PATCH' && /\/api\/spaces\/sp1$/.test(url.split('?')[0])) {
      state.mutations.push({ method, url, body });
      if (body && typeof body === 'object' && 'metadata' in body) {
        state.packet.space = makeSpace((body as { metadata: Record<string, unknown> }).metadata);
      }
      return new Response(JSON.stringify({ space: state.packet.space }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Occurrence PATCH (drag / keyboard move → section_id + sort_key).
    if (method === 'PATCH' && /\/occurrences\//.test(url)) {
      state.mutations.push({ method, url, body });
      const occId = /occurrences\/([^/?]+)/.exec(url)?.[1];
      const target = state.packet.occurrences.find((o) => o.id === occId);
      if (target && body && typeof body === 'object') Object.assign(target, body);
      return new Response(JSON.stringify({ occurrence: target ?? {} }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Item POST (shared Add items picker membership creation).
    if (method === 'POST' && /\/api\/spaces\/sp1\/items$/.test(url.split('?')[0])) {
      state.mutations.push({ method, url, body });
      const input = body as { ref_type: string; ref_id: string; ref_uri?: string | null; title?: string | null };
      const existing = state.packet.items.find(
        (item) => item.ref_type === input.ref_type && item.ref_id === input.ref_id,
      );
      if (existing) {
        return new Response(JSON.stringify({ item: existing, created: false, already_present: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const item = makeItem(input.ref_id, {
        id: input.ref_id,
        ref_type: input.ref_type,
        ref_id: input.ref_id,
        ref_uri: input.ref_uri ?? null,
        title: input.title ?? null,
      });
      state.packet.items.push(item);
      return new Response(JSON.stringify({ item, created: true, already_present: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Occurrence POST (Board Add items card creation).
    if (method === 'POST' && /\/api\/spaces\/sp1\/occurrences$/.test(url.split('?')[0])) {
      state.mutations.push({ method, url, body });
      const occurrence = makeOcc(`occ-${state.packet.occurrences.length + 1}`, body as Record<string, unknown>);
      state.packet.occurrences.push(occurrence);
      return new Response(JSON.stringify({ occurrence }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Fact packet (GET) — keep this last so the more specific routes win.
    if (method === 'GET' && /\/api\/spaces\/sp1(\?|$)/.test(url)) {
      return new Response(JSON.stringify(state.packet), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

describe('SpaceBoardRenderer', () => {
  it('registers under the board renderer key', () => {
    expect(SPACE_RENDERERS_REGISTRY.board).toBe(SpaceBoardRenderer);
  });

  it('shows a prompt when no space is selected', () => {
    stubFetch({ packet: fullPacket(), mutations: [] });
    render(<SpaceBoardRenderer projectId="prj1" spaceId={null} renderer="board" />);
    expect(screen.getByTestId('space-board-empty').textContent).toContain('Select a Space');
  });

  it('renders the five worker_status default columns', async () => {
    stubFetch({ packet: fullPacket(), mutations: [] });
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    await screen.findByTestId(`board-column-${defaultColumnKey('none')}`);
    for (const status of ['none', 'in_progress', 'blocked', 'pivot-needed', 'done']) {
      expect(screen.getByTestId(`board-column-${defaultColumnKey(status as never)}`)).toBeTruthy();
    }
  });

  it('renders the default column shell before the initial packet resolves', async () => {
    const packet = createDeferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && /\/api\/spaces\/sp1(\?|$)/.test(url)) return packet.promise;
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }));
      }),
    );
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);

    for (const status of ['none', 'in_progress', 'blocked', 'pivot-needed', 'done']) {
      expect(screen.getByTestId(`board-column-${defaultColumnKey(status as never)}`)).toBeTruthy();
    }
    expect(screen.getByRole('status').textContent).toContain('Loading cards');

    packet.resolve(new Response(JSON.stringify(fullPacket()), {
      headers: { 'content-type': 'application/json' },
    }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('uses the shared Add items affordance and compact filter-column editor hook', async () => {
    stubFetch({ packet: fullPacket(), mutations: [] });
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);

    await screen.findByTestId(`board-column-${defaultColumnKey('none')}`);
    expect(screen.getByTestId('space-board-add-items').textContent).toBe('+ Add items');

    fireEvent.click(screen.getByLabelText('Board column actions'));
    expect(screen.getByLabelText('Add filter column').className).toBe('space-board-filter');
  });

  it('does not prune restored custom-column state while the shell waits for data', async () => {
    const metadata = {
      [BOARD_METADATA_KEY]: {
        version: 1,
        columns: [{ key: 'manual:triage', title: 'Triage', kind: 'manual', order: 0 }],
      },
    };
    const response = createDeferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && /\/api\/spaces\/sp1(\?|$)/.test(url)) return response.promise;
        if (url.includes('/api/spaces/resolve') || url.includes('/api/refs/resolve')) {
          return Promise.resolve(new Response(
            JSON.stringify({
              resolution: {
                ref: 'mandible://issue/iss1',
                kind: 'issue',
                resolved: true,
                entity: { id: 'iss1', worker_status: 'none', kind: 'feature' },
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ));
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }));
      }),
    );
    window.localStorage.setItem(
      boardStorageKey('prj1', 'sp1'),
      JSON.stringify({
        cardFilter: '',
        selection: { kind: 'occurrence', ids: ['o1'] },
        collapsedColumns: { 'manual:triage': true },
      }),
    );

    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    expect(screen.getByTestId(`board-column-${defaultColumnKey('none')}`)).toBeTruthy();

    response.resolve(new Response(JSON.stringify(fullPacket({
      space: makeSpace(metadata),
      items: [makeItem('iss1', { title: 'Preserved card' })],
      occurrences: [makeOcc('o1', { item_id: 'iss1', section_id: 'manual:triage' })],
    })), {
      headers: { 'content-type': 'application/json' },
    }));

    await waitFor(() => expect(screen.getByLabelText('Expand Triage')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Expand Triage'));
    const card = (await screen.findByText('Preserved card')).closest('.space-board__card') as HTMLElement;
    await waitFor(() => expect(card.getAttribute('data-selected')).toBe('true'));
  });

  it('places an issue card in its resolved worker_status column', async () => {
    const state = {
      packet: fullPacket({
        items: [makeItem('iss1', { title: 'Issue One' })],
        occurrences: [makeOcc('o1', { item_id: 'iss1' })],
      }),
      workerStatus: { iss1: 'in_progress' },
      mutations: [],
    };
    stubFetch(state);
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    const col = await screen.findByTestId(`board-column-${defaultColumnKey('in_progress')}`);
    await waitFor(() => expect(within(col).getByText('Issue One')).toBeTruthy());
  });

  it('keyboard move writes section_id + sort_key via the occurrence PATCH route', async () => {
    const state = {
      packet: fullPacket({
        items: [makeItem('iss1', { title: 'Movable' })],
        occurrences: [makeOcc('o1', { item_id: 'iss1' })],
      }),
      workerStatus: { iss1: 'none' },
      mutations: [] as Mutation[],
    };
    stubFetch(state);
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    const noneCol = await screen.findByTestId(`board-column-${defaultColumnKey('none')}`);
    const card = await within(noneCol).findByText('Movable');
    const cardEl = card.closest('.space-board__card') as HTMLElement;
    // ArrowRight moves the card one column to the right.
    fireEvent.keyDown(cardEl, { key: 'ArrowRight' });
    await waitFor(() => {
      const patch = state.mutations.find((m) => m.method === 'PATCH' && /\/occurrences\//.test(m.url));
      expect(patch).toBeTruthy();
      const body = patch!.body as { section_id?: string; sort_key?: string };
      expect(body.section_id).toBe(defaultColumnKey('in_progress'));
      expect(typeof body.sort_key).toBe('string');
    });
  });

  it('adds an Untitled manual custom column persisted to spaces.metadata', async () => {
    const state = { packet: fullPacket(), mutations: [] as Mutation[] };
    stubFetch(state);
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    await screen.findByTestId(`board-column-${defaultColumnKey('none')}`);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    fireEvent.click(screen.getByText('Add manual column'));
    await waitFor(() => {
      const patch = state.mutations.find(
        (m) => m.method === 'PATCH' && /\/api\/spaces\/sp1$/.test(m.url.split('?')[0]),
      );
      expect(patch).toBeTruthy();
      const meta = (patch!.body as { metadata: Record<string, unknown> }).metadata;
      const board = meta[BOARD_METADATA_KEY] as { columns: { title: string; kind: string }[] };
      expect(board.columns[0].title).toBe('Untitled');
      expect(board.columns[0].kind).toBe('manual');
    });
    // The new column renders after the metadata round-trips.
    await waitFor(() => expect(screen.getByText('Untitled')).toBeTruthy());
  });

  it('adds an item from the toolbar as a board card and skips duplicate board cards', async () => {
    const state = {
      packet: fullPacket(),
      mutations: [] as Mutation[],
      graphNodes: [
        { id: 'n1', type: 'issue', label: 'Issue 99', detail: { ledger_issue_id: 'issue-99', project_name: 'prj1' } },
      ],
    };
    stubFetch(state);
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    await screen.findByTestId(`board-column-${defaultColumnKey('none')}`);
    fireEvent.click(screen.getByTestId('space-board-add-items'));
    fireEvent.click(await screen.findByText('Issue 99'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() => {
      const post = state.mutations.find(
        (m) => m.method === 'POST' && /\/api\/spaces\/sp1\/occurrences$/.test(m.url.split('?')[0]),
      );
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({
        item_id: 'issue-99',
        renderer: 'board',
        section_id: defaultColumnKey('none'),
      });
    });

    fireEvent.click(screen.getByTestId('space-board-add-items'));
    await waitFor(() =>
      expect(screen.getByTestId('space-item-picker-empty').textContent).toContain(
        'Everything here is already in this view',
      ),
    );
  });

  it('renames and confirms deletion of custom columns without deleting cards', async () => {
    const metadata = {
      [BOARD_METADATA_KEY]: {
        version: 1,
        columns: [{ key: 'manual:triage', title: 'Triage', kind: 'manual', order: 0 }],
      },
    };
    const state = {
      packet: fullPacket({
        space: makeSpace(metadata),
        items: [makeItem('iss1', { title: 'Kept card' })],
        occurrences: [makeOcc('o1', { item_id: 'iss1', section_id: 'manual:triage' })],
      }),
      workerStatus: { iss1: 'none' },
      mutations: [] as Mutation[],
    };
    stubFetch(state);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    await screen.findByText('Triage');

    fireEvent.dblClick(screen.getByText('Triage'));
    const rename = screen.getByLabelText('Rename column Triage') as HTMLInputElement;
    fireEvent.input(rename, { target: { value: 'Review' } });
    fireEvent.keyDown(rename, { key: 'Enter' });

    await waitFor(() => {
      const lastPatch = state.mutations
        .filter((m) => m.method === 'PATCH' && /\/api\/spaces\/sp1$/.test(m.url.split('?')[0]))
        .at(-1);
      const meta = (lastPatch!.body as { metadata: Record<string, unknown> }).metadata;
      const board = meta[BOARD_METADATA_KEY] as { columns: { title: string }[] };
      expect(board.columns[0].title).toBe('Review');
    });

    fireEvent.click(await screen.findByLabelText('Delete column Review'));
    await waitFor(() => {
      const lastPatch = state.mutations
        .filter((m) => m.method === 'PATCH' && /\/api\/spaces\/sp1$/.test(m.url.split('?')[0]))
        .at(-1);
      const meta = (lastPatch!.body as { metadata: Record<string, unknown> }).metadata;
      const board = meta[BOARD_METADATA_KEY] as { columns: unknown[] };
      expect(board.columns).toHaveLength(0);
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Cards in this column will stay in the Space'));
    expect(state.packet.occurrences).toHaveLength(1);
  });

  it('SSE space:* event refetches without resetting the selected card', async () => {
    const state = {
      packet: fullPacket({
        items: [makeItem('iss1', { title: 'Pinned' })],
        occurrences: [makeOcc('o1', { item_id: 'iss1' })],
      }),
      workerStatus: { iss1: 'none' },
      mutations: [] as Mutation[],
    };
    stubFetch(state);
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    const card = (await screen.findByText('Pinned')).closest('.space-board__card') as HTMLElement;
    fireEvent.click(card);
    await waitFor(() => expect(card.getAttribute('data-selected')).toBe('true'));

    // Fire an SSE space:* event → triggers a reconciliation refetch.
    state.packet.items.push(makeItem('iss2', { title:'New arrival' }));
    state.packet.occurrences.push(makeOcc('o2', { item_id:'iss2' }));
    // Supply the root app's cache invalidation alongside this isolated renderer.
    invalidateDashboardApiCacheForEvent('space:occurrence:updated');
    MockEventSource.instances.forEach((es) => es.emit({ type:'space:occurrence:updated', data:{space_id:'sp1'} }));
    await screen.findByText('New arrival');

    await waitFor(() => {
      const reselected = (screen.getByText('Pinned').closest('.space-board__card') as HTMLElement);
      expect(reselected.getAttribute('data-selected')).toBe('true');
    });
  });

  it('persists column collapse across a remount (view-state persistence)', async () => {
    stubFetch({ packet: fullPacket(), mutations: [] });
    const { unmount } = render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    await screen.findByTestId(`board-column-${defaultColumnKey('none')}`);
    fireEvent.click(screen.getByLabelText('Collapse In progress'));
    await waitFor(() => expect(screen.getByLabelText('Expand In progress')).toBeTruthy());
    unmount();

    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    await screen.findByTestId(`board-column-${defaultColumnKey('none')}`);
    // Collapsed state restored from localStorage.
    await waitFor(() => expect(screen.getByLabelText('Expand In progress')).toBeTruthy());
  });
});
