import { AppShellProvider, useAppShell } from '../ui/src/app-shell';
// @vitest-environment jsdom
import { clearApiGetCache, invalidateDashboardApiCacheForEvent } from '../ui/src/api';
import { queryClient } from '../ui/src/query/client';
import { establishTestClientAccess } from './helpers/local-client-access';
// Board renderer component tests (umbrella de56ffa, child 4d4d364 / C17).
//
// Drives the rendered board with a mocked fetch (the `GET /api/spaces/:id` fact
// packet, the issue resolver, the occurrence PATCH route, and the space PATCH
// route) and a mocked EventSource (SSE reconciliation). Asserts the acceptance
// criteria: worker_status default columns, custom-column add persisted to
// spaces.metadata, drag/keyboard moves that write section_id/sort_key, and SSE
// reconciliation that does not reset selection.
import { act, render, screen, cleanup, fireEvent, waitFor, within } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpaceBoardRenderer as Surface } from '../ui/src/views/spaces/SpaceBoard';
import { useSpacePacket } from '../ui/src/query/spaces';
import { LIVE_REFRESH_MIN_INTERVAL_MS } from '../ui/src/lib/coalesced-refresh';
import type { SpaceFactPacket } from '../ui/src/api';
import type { SpaceRendererMountProps } from '../ui/src/views/spaces/SpacesViewShell';

function SpaceBoardRenderer(props: SpaceRendererMountProps) {
  const query = useSpacePacket(props.spaceId);
  return <Surface {...props} factPacket={query.packet} />;
}
import {
  defaultColumnKey,
  BOARD_METADATA_KEY,
} from '../ui/src/views/spaces/boardModel';
import { boardStorageKey } from '../ui/src/views/spaces/boardViewState';

const NOW = 1_700_000_000_000;

type Packet = {
  space: Record<string, unknown>;
  items: Record<string, unknown>[];
  occurrences: Record<string, unknown>[];
  edges: Record<string, unknown>[];
};


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
      const idMatch = /^issue:([^/?]+)/.exec(ref);
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
  clearApiGetCache();
  queryClient.clear();
  await establishTestClientAccess();
  stubLocalStorage();
});

afterEach(() => {
  vi.useRealTimers();
  clearApiGetCache();
  queryClient.clear();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SpaceBoardRenderer', () => {
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
                ref: 'issue:iss1',
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
    const card = (await screen.findByText('Preserved card')).closest('[data-occurrence-id]') as HTMLElement;
    await waitFor(() => expect(card.getAttribute('data-selected')).toBe('true'));
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
    const cardEl = card.closest('[data-occurrence-id]') as HTMLElement;
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

    const remove = await screen.findByLabelText('Delete column Review') as HTMLButtonElement;
    await waitFor(() => expect(remove.disabled).toBe(false));
    fireEvent.click(remove);
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
    const card = (await screen.findByText('Pinned')).closest('[data-occurrence-id]') as HTMLElement;
    fireEvent.click(card);
    await waitFor(() => expect(card.getAttribute('data-selected')).toBe('true'));

    // Fire an SSE space:* event → triggers a reconciliation refetch.
    state.packet.items.push(makeItem('iss2', { title:'New arrival' }));
    state.packet.occurrences.push(makeOcc('o2', { item_id:'iss2' }));
    // Supply the root app's cache invalidation alongside this isolated renderer.
    invalidateDashboardApiCacheForEvent('space:occurrence:updated');
    await screen.findByText('New arrival');

    await waitFor(() => {
      const reselected = (screen.getByText('Pinned').closest('[data-occurrence-id]') as HTMLElement);
      expect(reselected.getAttribute('data-selected')).toBe('true');
    });
  });
  it('reconciles live facts and packet edits while preserving mounted and remounted local intent', async () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64);
    const packet = fullPacket({
      space: makeSpace({ [BOARD_METADATA_KEY]: { version: 1, columns: [
        { key: 'manual:triage', title: 'Triage', kind: 'manual', order: 0 },
        { key: 'urgent', title: 'Urgent', kind: 'filter', order: 1, scope: { type: 'label', name: 'urgent' } },
        { key: 'bugs', title: 'Bugs', kind: 'filter', order: 2, scope: { type: 'kind', kind: 'bug' } },
      ] } }),
      items: [makeItem('derived', { ref_id: a, title: 'Card derived' }), makeItem('explicit', { ref_id: a, title: 'Card explicit' }), makeItem('other', { ref_id: b, title: 'Card other' })],
      occurrences: [makeOcc('derived-occ', { item_id: 'derived' }), makeOcc('explicit-occ', { item_id: 'explicit', section_id: 'worker_status:done' }), makeOcc('other-occ', { item_id: 'other' })],
    });
    let entity = { id: a, worker_status: 'in_progress', kind: 'bug', labels: [] as string[] };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test');
      expect(init?.method ?? 'GET').toBe('GET');
      expect(url.pathname).toBe('/api/spaces/resolve');
      expect(url.searchParams.get('project')).toBeNull(); // canonical IDs are globally keyed
      const id = url.searchParams.get('ref')!.replace('issue:', '');
      return new Response(JSON.stringify({ resolution: { ref: `issue:${id}`, kind: 'issue', resolved: true, entity: id === a ? entity : { id: b, worker_status: 'none', kind: 'feature', labels: [] } } }));
    });
    vi.stubGlobal('fetch', fetcher);
    const props = { projectId: 'sidebar-project', spaceId: 'sp1', renderer: 'board' as const, factPacket: packet as unknown as SpaceFactPacket };
    const ui = render(<Surface {...props} />);
    const column = (key: string) => document.querySelector(`[data-column-key="${key}"].space-board__column`)!;
    const cards = (key: string) => [...column(key).querySelectorAll('[data-occurrence-id]')].map((card) => card.getAttribute('data-occurrence-id'));
    await waitFor(() => expect(cards('worker_status:in_progress')).toEqual(['derived-occ']));
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(column('worker_status:in_progress').querySelector('[data-occurrence-id]')!);
    fireEvent.click(screen.getByLabelText('Collapse Unstarted'));
    fireEvent.input(screen.getByLabelText('Filter board cards'), { target: { value: 'Card' } });
    fireEvent.dblClick(screen.getByText('Triage'));
    fireEvent.input(screen.getByLabelText('Rename column Triage'), { target: { value: 'My unfinished rename' } });
    const form = screen.getByRole('form', { name: 'Add filter column' });
    const token = within(form).getByLabelText('Filter') as HTMLInputElement;
    fireEvent.input(token, { target: { value: 'label:urgent' } });
    fireEvent.keyDown(token, { key: 'Enter' });
    expect(within(form).getByRole('button', { name: 'Remove label:urgent' })).toBeTruthy();
    expect(token.value).toBe('');
    fireEvent.input(token, { target: { value: 'kind:bug' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add chip' }));
    expect(within(form).getByRole('button', { name: 'Remove kind:bug' })).toBeTruthy();
    expect(token.value).toBe('');
    fireEvent.input(token, { target: { value: 'label:unfinished' } });
    const columns = document.querySelector('.space-board__columns') as HTMLElement;
    columns.scrollLeft = 240; fireEvent.scroll(columns);
    const list = column('worker_status:in_progress').querySelector('ul')!;
    list.scrollTop = 75; fireEvent.scroll(list);
    const mounted = screen.getByTestId('space-board');
    entity = { id: a, worker_status: 'blocked', kind: 'feature', labels: ['urgent'] };
    vi.useFakeTimers();
    await act(async () => {
      invalidateDashboardApiCacheForEvent('ledger:issue:updated', { issue_id: a });
      invalidateDashboardApiCacheForEvent('ledger:label:updated', { issue_id: a });
      invalidateDashboardApiCacheForEvent('ledger:event:created', { entity_type: 'issue', entity_id: a, event_type: 'issue.updated' });
      await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MIN_INTERVAL_MS + 1);
    });
    expect(cards('worker_status:blocked')).toEqual(['derived-occ']);
    expect(cards('worker_status:done')).toEqual(['explicit-occ']);
    expect(cards('urgent')).toEqual(['derived-occ', 'explicit-occ']);
    expect(cards('bugs')).toEqual([]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes(`ref=issue%3A${b}`))).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('space-board')).toBe(mounted);
    expect(column('worker_status:blocked').querySelector('[data-occurrence-id]')?.getAttribute('data-selected')).toBe('true');
    expect(screen.getByLabelText('Expand Unstarted')).toBeTruthy();
    expect((screen.getByLabelText('Rename column Triage') as HTMLInputElement).value).toBe('My unfinished rename');
    expect(columns.scrollLeft).toBe(240);
    const next = structuredClone(packet);
    const meta = next.space.metadata as Record<string, { columns: Array<{ key: string; title: string }> }>;
    meta[BOARD_METADATA_KEY].columns[0].title = 'Server title';
    next.items[0].title = 'Card authored update';
    ui.rerender(<Surface {...props} factPacket={next as unknown as SpaceFactPacket} />);
    expect((screen.getByLabelText('Rename column Server title') as HTMLInputElement).value).toBe('My unfinished rename');
    expect(screen.getAllByText('Card authored update').length).toBe(2);
    vi.useRealTimers();
    ui.unmount();
    const restored = render(<Surface {...props} factPacket={next as unknown as SpaceFactPacket} />);
    expect((screen.getByLabelText('Filter board cards') as HTMLInputElement).value).toBe('Card');
    expect((screen.getByLabelText('Rename column Server title') as HTMLInputElement).value).toBe('My unfinished rename');
    expect((within(screen.getByRole('form', { name: 'Add filter column' })).getByLabelText('Filter') as HTMLInputElement).value).toBe('label:unfinished');
    expect(document.querySelector('.space-board__columns')!.scrollLeft).toBe(240);
    expect(column('worker_status:in_progress').querySelector('ul')!.scrollTop).toBe(75);
    expect(column('worker_status:blocked').querySelector('[data-occurrence-id]')?.getAttribute('data-selected')).toBe('true');
    expect(screen.getByLabelText('Expand Unstarted')).toBeTruthy();
    const removed = structuredClone(next);
    removed.items = removed.items.filter((item) => item.id !== 'derived');
    removed.occurrences = removed.occurrences.filter((occ) => occ.id !== 'derived-occ');
    (removed.space.metadata as typeof meta)[BOARD_METADATA_KEY].columns.shift();
    restored.rerender(<Surface {...props} factPacket={removed as unknown as SpaceFactPacket} />);
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(boardStorageKey('sidebar-project', 'sp1'))!);
      expect(stored.selection.ids).toEqual([]);
      expect(stored.renameDrafts).toEqual({});
      expect(stored.collapsedColumns['worker_status:none']).toBe(true);
      expect(stored.filterDraft.token).toBe('label:unfinished');
    });
  });

  it('distinguishes cold failure, retained background facts, authoritative negatives, and a retargeted pending ref', async () => {
    const packet = fullPacket({ items: [makeItem('item', { ref_id: 'short', title: 'Known card' })], occurrences: [makeOcc('occ', { item_id: 'item' })] });
    let mode: 'error' | 'success' | 'negative' | 'pending' = 'error';
    const pending = createDeferred<Response>();
    let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const ref = new URL(url, 'http://test').searchParams.get('ref');
      expect(new URL(url, 'http://test').searchParams.get('project')).toBe('prj1');
      if (ref === 'issue:replacement') return new Response(JSON.stringify({ resolution: { ref, kind: 'issue', resolved: true, entity: { id: 'replacement', worker_status: 'done' } } }));
      if (mode === 'error') throw new Error('Temporary failure');
      if (mode === 'pending') { oldSignal = init?.signal as AbortSignal; return pending.promise; }
      return new Response(JSON.stringify({ resolution: { ref, kind: 'issue', resolved: mode !== 'negative', entity: mode === 'negative' ? null : { id: 'canonical', worker_status: 'blocked' }, error: mode === 'negative' ? 'ambiguous' : undefined } }));
    });
    vi.stubGlobal('fetch', fetcher);
    const props = { projectId: 'sidebar-other', spaceId: 'sp1', renderer: 'board' as const, factPacket: packet as unknown as SpaceFactPacket };
    const noticeHost = document.createElement('div'); document.body.appendChild(noticeHost);
    function WithNotices({ packet }: { packet: SpaceFactPacket }) {
      const shell = useAppShell();
      return <AppShellProvider value={{ ...shell, noticeHost }}><Surface {...props} factPacket={packet} /></AppShellProvider>;
    }
    const ui = render(<WithNotices packet={props.factPacket} />);
    await screen.findByRole('button', { name: 'Retry issue facts' });
    const location = () => screen.getByText('Known card').closest('[data-occurrence-id]')!.getAttribute('data-column-key');
    mode = 'success';
    fireEvent.click(screen.getByRole('button', { name: 'Retry issue facts' }));
    await waitFor(() => expect(location()).toBe('worker_status:blocked'));
    mode = 'error'; vi.useFakeTimers();
    await act(async () => { invalidateDashboardApiCacheForEvent('ledger:issue:updated', { issue_id: 'canonical' }); await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MIN_INTERVAL_MS + 1); });
    expect(location()).toBe('worker_status:blocked');
    expect(screen.getByRole('button', { name: 'Retry issue facts' })).toBeTruthy();
    mode = 'negative';
    await act(async () => { invalidateDashboardApiCacheForEvent('ledger:issue:updated', { issue_id: 'canonical' }); await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MIN_INTERVAL_MS + 1); });
    expect(location()).toBe('worker_status:none');
    expect(screen.queryByRole('button', { name: 'Retry issue facts' })).toBeNull();
    mode = 'pending';
    await act(async () => { invalidateDashboardApiCacheForEvent('ledger:issue:created', { issue_id: 'new-identity' }); await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MIN_INTERVAL_MS + 1); });
    const replacement = structuredClone(packet); replacement.items[0].ref_uri = 'issue:replacement';
    ui.rerender(<WithNotices packet={replacement as unknown as SpaceFactPacket} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(oldSignal?.aborted).toBe(true);
    expect(location()).toBe('worker_status:done');
    await act(async () => { pending.resolve(new Response(JSON.stringify({ resolution: { resolved: true, kind: 'issue', entity: { worker_status: 'blocked' } } }))); await vi.advanceTimersByTimeAsync(1); });
    expect(location()).toBe('worker_status:done');
    expect(fetcher.mock.calls.every(([url]) => url.startsWith('/api/spaces/resolve?'))).toBe(true);
    vi.useRealTimers();
  });

  it('restores saved column scroll after delayed facts make its content scrollable', async () => {
    const positions = new WeakMap<HTMLUListElement, number>();
    const original = Object.getOwnPropertyDescriptor(HTMLUListElement.prototype, 'scrollTop');
    Object.defineProperty(HTMLUListElement.prototype, 'scrollTop', { configurable: true,
      get() { return positions.get(this) ?? 0; },
      set(value: number) { positions.set(this, Math.min(value, this.querySelector('[data-occurrence-id]') ? 100 : 0)); },
    });
    try {
      const response = createDeferred<Response>();
      vi.stubGlobal('fetch', vi.fn(() => response.promise));
      window.localStorage.setItem(boardStorageKey('prj1', 'sp1'), JSON.stringify({ scroll: { left: 0, columns: { 'worker_status:blocked': 88 } } }));
      const packet = fullPacket({ items: [makeItem('a', { title: 'Delayed card' })], occurrences: [makeOcc('occ', { item_id: 'a' })] });
      const props = { projectId: 'prj1', spaceId: 'sp1', renderer: 'board' as const };
      const ui = render(<Surface {...props} />);
      const blocked = () => screen.getByTestId('board-column-worker_status:blocked');
      expect(blocked().scrollTop).toBe(0);
      ui.rerender(<Surface {...props} factPacket={packet as unknown as SpaceFactPacket} />);
      expect(blocked().scrollTop).toBe(0);
      response.resolve(new Response(JSON.stringify({ resolution: { resolved: true, kind: 'issue', entity: { id: 'a', worker_status: 'blocked' } } })));
      await waitFor(() => expect(within(blocked()).getByText('Delayed card')).toBeTruthy());
      expect(blocked().scrollTop).toBe(88);
      fireEvent.wheel(blocked()); blocked().scrollTop = 42; fireEvent.scroll(blocked());
      const next = structuredClone(packet); next.items[0].title = 'Changed authored label';
      ui.rerender(<Surface {...props} factPacket={next as unknown as SpaceFactPacket} />);
      expect(blocked().scrollTop).toBe(42);
    } finally {
      if (original) Object.defineProperty(HTMLUListElement.prototype, 'scrollTop', original);
      else delete (HTMLUListElement.prototype as unknown as Record<string, unknown>).scrollTop;
    }
  });

  it('writes selection, collapse and drafts to the newly selected Space while the renderer stays mounted', () => {
    const first = fullPacket({ items: [makeItem('first', { ref_type: 'artifact', title: 'First card' })], occurrences: [makeOcc('first-occ', { item_id: 'first' })] });
    const second = fullPacket({ space: { ...makeSpace(), id: 'sp2' }, items: [makeItem('second', { ref_type: 'artifact', title: 'Second card' })], occurrences: [makeOcc('second-occ', { item_id: 'second' })] });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const ui = render(<Surface projectId="prj1" spaceId="sp1" renderer="board" factPacket={first as unknown as SpaceFactPacket} />);
    fireEvent.click(screen.getByText('First card').closest('[data-occurrence-id]')!);
    fireEvent.click(screen.getByLabelText('Collapse Blocked'));
    const original = window.localStorage.getItem(boardStorageKey('prj1', 'sp1'));
    ui.rerender(<Surface projectId="prj1" spaceId="sp2" renderer="board" factPacket={second as unknown as SpaceFactPacket} />);
    fireEvent.click(screen.getByText('Second card').closest('[data-occurrence-id]')!);
    fireEvent.click(screen.getByLabelText('Collapse Done'));
    const token = within(screen.getByRole('form', { name: 'Add filter column' })).getByLabelText('Filter');
    fireEvent.input(token, { target: { value: 'kind:bug' } });
    fireEvent.keyDown(token, { key: 'Enter' });
    const next = JSON.parse(window.localStorage.getItem(boardStorageKey('prj1', 'sp2'))!);
    expect(next.selection.ids).toEqual(['second-occ']);
    expect(next.collapsedColumns).toEqual({ 'worker_status:done': true });
    expect(next.filterDraft.chips).toEqual([{ field: 'kind', values: ['bug'], negated: false }]);
    expect(window.localStorage.getItem(boardStorageKey('prj1', 'sp1'))).toBe(original);
    expect(fetcher).not.toHaveBeenCalled();
  });

});
