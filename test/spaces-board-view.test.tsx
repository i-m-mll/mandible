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
import { h } from 'preact';

import { SpaceBoardRenderer } from '../ui/src/views/spaces/SpaceBoard';
import { SPACE_RENDERERS_REGISTRY } from '../ui/src/views/spaces/renderers';
import {
  defaultColumnKey,
  BOARD_METADATA_KEY,
} from '../ui/src/views/spaces/boardModel';

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
}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

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

beforeEach(() => {
  stubLocalStorage();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
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

  it('adds a manual custom column persisted to spaces.metadata', async () => {
    const state = { packet: fullPacket(), mutations: [] as Mutation[] };
    stubFetch(state);
    render(<SpaceBoardRenderer projectId="prj1" spaceId="sp1" renderer="board" />);
    await screen.findByTestId(`board-column-${defaultColumnKey('none')}`);
    const titleInput = screen.getByLabelText('Custom column title') as HTMLInputElement;
    fireEvent.input(titleInput, { target: { value: 'Triage' } });
    fireEvent.click(screen.getByText('Add column'));
    await waitFor(() => {
      const patch = state.mutations.find(
        (m) => m.method === 'PATCH' && /\/api\/spaces\/sp1$/.test(m.url.split('?')[0]),
      );
      expect(patch).toBeTruthy();
      const meta = (patch!.body as { metadata: Record<string, unknown> }).metadata;
      const board = meta[BOARD_METADATA_KEY] as { columns: { title: string; kind: string }[] };
      expect(board.columns[0].title).toBe('Triage');
      expect(board.columns[0].kind).toBe('manual');
    });
    // The new column renders after the metadata round-trips.
    await waitFor(() => expect(screen.getByText('Triage')).toBeTruthy());
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
    MockEventSource.instances.forEach((es) => es.emit({ type: 'space:occurrence.updated', space_id: 'sp1' }));

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
