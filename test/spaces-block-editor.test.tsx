// @vitest-environment jsdom
// Spaces document block editor: a draft survives stale reloads, SSE refetches
// and rejected writes; reads from a previously selected document are ignored;
// deleting an embedded item waits for an explicit decision.

import { addSpaceItem, clearApiGetCache, invalidateDashboardApiCacheForEvent, invalidateDashboardCaches } from '../ui/src/api';
import { bindSpacesOperationCatalog } from './helpers/spaces-operation-catalog';
import { establishTestClientAccess } from './helpers/local-client-access';
import { render, screen, cleanup, fireEvent, waitFor } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { AppShellProvider } from '../ui/src/app-shell';
import { queryClient } from '../ui/src/query/client';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';

import {
  DocumentBlockEditor as DocumentSurface,
} from '../ui/src/views/spaces/DocumentBlockEditor';
import { useSpacePacket } from '../ui/src/query/spaces';

function DocumentBlockEditor(props: Parameters<typeof DocumentSurface>[0]) {
  const query = useSpacePacket(props.spaceId);
  return <DocumentSurface {...props} factPacket={query.packet} />;
}
import { MarkdownSourceEditor } from '../ui/src/views/spaces/MarkdownSourceEditor';
import {
  generateSortKey,
  placementForIndex,
} from '../ui/src/views/spaces/blockEditorModel';
import {
  blockEditorStorageKey,
  normalizeBlockEditorViewState,
} from '../ui/src/views/spaces/blockEditorViewState';
import type { InstanceInfo, LedgerIssueDetailProjection, SpaceBlock, SpaceExport, SpaceItem } from '../ui/src/api';
import { __resetResourceRefRecognizers } from '../ui/src/resource-refs';

const NOW = 1_700_000_000_000;

const mainInstance: InstanceInfo = {
  role: 'main',
  instance_id: 'main-editor-tests',
  installation_id: 'test-installation',
  public_origin: 'http://localhost:19420',
  backend_generation: 'test-generation',
  allowed_effects: ['ledger:read', 'ledger:write'],
  writable_roots: ['/tmp'],
  db_path: '/tmp/mandible-main.db',
  db_path_source: 'test',
};

function stubLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
  });
}

function makeBlock(over: Partial<SpaceBlock> & Pick<SpaceBlock, 'id'>): SpaceBlock {
  return {
    id: over.id,
    space_id: 'sp1',
    parent_id: null,
    block_type: 'paragraph',
    item_id: null,
    item_snapshot: null,
    sort_key: 'm',
    markdown: '',
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

/**
 * A mutable in-memory backend stub over the C11 block routes + the C13a exports
 * read. Records every write so the tests can assert the editor hit the right
 * route with the right body. Shared as both the editor `fetchImpl` and the
 * global `fetch` (the editor reads exports through the C3 `getSpaceExports`).
 */
function makeBackend(initial: SpaceBlock[], exports: SpaceExport[] = [], items: SpaceItem[] = []) {
  const blocks = new Map(initial.map((b) => [b.id, { ...b }]));
  const calls: { method: string; url: string; body: unknown }[] = [];
  let idSeq = 0;

  const list = (): SpaceBlock[] =>
    [...blocks.values()].sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0));

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/client-auth/whoami') {
      return json({ authenticated: true, session: { csrf_token: 'test-csrf' } });
    }
    if (method !== 'GET') {
      if (new Headers(init?.headers).get('X-Mandible-CSRF') !== 'test-csrf') return json({ error: 'csrf_required' }, 403);
    }
    calls.push({ method, url, body });

    const blockColl = url.match(/\/api\/spaces\/sp1\/blocks(?:\?.*)?$/);
    const blockItem = url.match(/\/api\/spaces\/sp1\/blocks\/([^/?]+)$/);
    const detach = url.match(/\/api\/spaces\/sp1\/items\/([^/?]+)\/detach-blocks$/);
    const exportsRead = url.match(/\/api\/spaces\/sp1\/exports(?:\?.*)?$/);
    const spaceRead = url.match(/\/api\/spaces\/sp1(?:\?.*)?$/);
    const issueDetail = url.match(/\/api\/ledger\/issues\/([^/?]+)$/);

    if (exportsRead && method === 'GET') {
      return json({ exports, repo_id: 'repo1', settings: { path: 'doc.md', branch: 'docs' } });
    }
    if (spaceRead && method === 'GET') {
      return json({
        space: {
          id: 'sp1',
          project_id: 'prj1',
          title: 'Space',
          default_renderer: 'document',
          description: null,
          metadata: {},
          created_at: NOW,
          updated_at: NOW,
        },
        items,
        occurrences: [],
        edges: [],
      });
    }
    if (blockColl && method === 'GET') {
      return json({ blocks: list() });
    }
    if (blockColl && method === 'POST') {
      const id = `new-${++idSeq}`;
      const created = makeBlock({
        id,
        block_type: body.block_type,
        parent_id: body.parent_id ?? null,
        item_id: body.item_id ?? null,
        item_snapshot: body.item_snapshot ?? null,
        sort_key: body.sort_key ?? 'z',
        markdown: body.markdown ?? '',
      });
      blocks.set(id, created);
      return json({ block: created }, 201);
    }
    if (blockItem && method === 'PATCH') {
      const id = blockItem[1];
      const existing = blocks.get(id);
      if (!existing) return json({ error: 'block not found' }, 404);
      const updated = { ...existing };
      if (body.markdown !== undefined) updated.markdown = body.markdown;
      if (body.sort_key !== undefined) updated.sort_key = body.sort_key;
      if (body.parent_id !== undefined) updated.parent_id = body.parent_id;
      blocks.set(id, updated);
      return json({ block: updated });
    }
    if (blockItem && method === 'DELETE') {
      const id = blockItem[1];
      if (!blocks.delete(id)) return json({ error: 'block not found' }, 404);
      return json({ ok: true, id });
    }
    if (detach && method === 'POST') {
      const itemId = detach[1];
      const detached: SpaceBlock[] = [];
      for (const [id, b] of blocks) {
        if (b.item_id === itemId) {
          const upd = { ...b, item_id: null };
          blocks.set(id, upd);
          detached.push(upd);
        }
      }
      return json({ detached });
    }
    if (url.includes('/api/spaces/resolve')) {
      return json({ resolution: { ref: 'x', kind: 'artifact', resolved: false, entity: null } });
    }
    if (issueDetail && method === 'GET') {
      return json(makeIssueDetail(issueDetail[1]));
    }
    return json({});
  });

  return { fetchImpl, calls, list, blocks };
}

function makeIssueDetail(issueId: string): LedgerIssueDetailProjection {
  return {
    kind: 'feature', priority: 'normal', source: 'mandible', resolution: null, comments: [], checkpoints: [],
    detail_stage: 'full',
    work_notes: '', work_notes_revision: null, worker_status: 'none',
    issue_branches: [], dependencies: [], dependency_warning: false, timeline_partial: false,
    id: issueId,
    display_id: issueId,
    title: `Issue ${issueId}`,
    body: '',
    status: 'open',
    labels: [],
    aliases: [],
    created_at: NOW,
    updated_at: NOW,
    closed_at: null,
    author: { id: null, type: 'mandible_user', display: 'Mandible', legacy_display: 'Mandible', attribution: null },
    project: {
      id: 'prj1',
      project_key: 'mandible',
      display_name: 'mandible',
      remote_identity: '',
      upstream_identity: '',
      repo_id: 'mandible',
      work_repo_id: 'mandible',
      repo_name: 'mandible',
      repo_root: '',
      default_branch: 'main',
    },
    relationships: [],
    sessions: [],
    auth_requests: [],
    work_units: [],
    timeline: [],
    associated_artifacts: [],
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(async () => {
  clearApiGetCache();
  stubLocalStorage();
  bindSpacesOperationCatalog(mainInstance);
  const notices = document.createElement('div');
  notices.id = 'editor-notices';
  document.body.append(notices);
  queryClient.clear();
  await establishTestClientAccess();
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }),
    });
  }
  if (!Range.prototype.getBoundingClientRect) {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      }),
    });
  }
});

afterEach(() => {
  clearApiGetCache();
  cleanup();
  document.getElementById('editor-notices')?.remove();
  queryClient.clear();
  __resetBrowserSessionForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetResourceRefRecognizers();
});

// --- pure model: sort keys ---------------------------------------------------

describe('blockEditorModel sort keys', () => {
  it('generateSortKey handles adjacent digits without collision', () => {
    const mid = generateSortKey('a', 'b');
    expect(mid > 'a').toBe(true);
    expect(mid < 'b').toBe(true);
  });

  it('placementForIndex returns a key that moves a block between neighbours', () => {
    const blocks = [
      makeBlock({ id: 'b1', sort_key: 'a' }),
      makeBlock({ id: 'b2', sort_key: 'm' }),
      makeBlock({ id: 'b3', sort_key: 'z' }),
    ];
    // Move b3 to index 0 (before b1).
    const p0 = placementForIndex(blocks, null, 0, 'b3');
    expect(p0.sort_key < 'a').toBe(true);
    // Move b1 to index 1 (between b2 and b3, after removing b1).
    const p1 = placementForIndex(blocks, null, 1, 'b1');
    expect(p1.sort_key > 'm').toBe(true);
    expect(p1.sort_key < 'z').toBe(true);
  });
});

// --- view-state persistence + reconciliation (standing AC #2) ----------------

describe('blockEditorViewState', () => {
  it('normalizes malformed stored state to a safe empty state', () => {
    expect(normalizeBlockEditorViewState(null)).toEqual({ editingId: null, drafts: {} });
    expect(normalizeBlockEditorViewState({ editingId: 5, drafts: { a: 1, b: 'x' } })).toEqual({
      editingId: null,
      drafts: { b: 'x' },
    });
  });
});

// --- client: routes hit the C11 surface --------------------------------------

// --- component: editable Mandible-custody editor -----------------------------

async function renderEditor(props: Partial<Parameters<typeof DocumentBlockEditor>[0]> & {
  backend: ReturnType<typeof makeBackend>;
}) {
  const { backend, instance = mainInstance, ...rest } = props;
  vi.stubGlobal('fetch', backend.fetchImpl);
  if (instance) bindSpacesOperationCatalog(instance);
  const content = (active: boolean) => (
    <AppShellProvider value={{ active, noticeHost: document.getElementById('editor-notices'), rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
    <DocumentBlockEditor
      projectId="prj1"
      spaceId="sp1"
      renderer="document"
      fetchImpl={backend.fetchImpl}
      instance={instance}
      {...rest}
    /></AppShellProvider>
  );
  const view = render(content(true));
  await waitFor(() => expect(screen.getByTestId('spaces-block-editor-list')).toBeTruthy());
  return { ...view, setActive: (active: boolean) => view.rerender(content(active)) };
}

type SourceHost = HTMLElement & { __spacesEditorView?: EditorView };

function sourceHost(index = 0): SourceHost {
  return screen.getAllByTestId('spaces-block-editor-source')[index] as SourceHost;
}

function sourceView(index = 0): EditorView {
  const view = sourceHost(index).__spacesEditorView;
  if (!view) throw new Error(`missing source editor view ${index}`);
  return view;
}

function sourceText(index = 0): string {
  return sourceView(index).state.doc.toString();
}

function setSourceText(index: number, value: string, cursor = value.length): EditorView {
  const view = sourceView(index);
  act(() => {
    view.focus();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: EditorSelection.cursor(Math.max(0, Math.min(cursor, value.length))),
    });
  });
  return view;
}

function blurSource(index = 0): void {
  fireEvent.blur(sourceView(index).contentDOM);
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('MarkdownSourceEditor state synchronization', () => {
  it('does not replace local editor text with a stale parent value while the draft catches up', async () => {
    const changes: Array<{ value: string; selection: { start: number; end: number } }> = [];
    const renderSource = (value: string) => (
      <MarkdownSourceEditor
        blockId="b1"
        value={value}
        ariaLabel="Edit Markdown"
        onChange={(nextValue, selection) => changes.push({ value: nextValue, selection })}
        onBlur={() => undefined}
        onCaretChange={() => undefined}
        onSelectionChange={() => undefined}
        onItemCommand={() => undefined}
        onOpenReference={() => undefined}
      />
    );
    const { rerender } = render(renderSource('## Heading'));
    await flushEffects();

    const nextValue = '## Heading\nbody';
    setSourceText(0, nextValue, nextValue.length);
    expect(changes.at(-1)).toEqual({
      value: nextValue,
      selection: { start: nextValue.length, end: nextValue.length },
    });

    rerender(renderSource('## Heading'));
    await flushEffects();

    expect(sourceText()).toBe(nextValue);
    expect(sourceView().state.selection.main.from).toBe(nextValue.length);

    rerender(renderSource(nextValue));
    await flushEffects();
    rerender(renderSource('external update'));
    await flushEffects();

    expect(sourceText()).toBe('external update');
  });
});

describe('DocumentBlockEditor (editable)', () => {
  it('ignores failed block loads from a previously selected document', async () => {
    let rejectOldBlocks: ((reason?: unknown) => void) | null = null;
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') {
        return Promise.resolve(json({ authenticated: true, session: { csrf_token: 'test-csrf' } }));
      }
      if (/\/api\/spaces\/sp1\/blocks(?:\?.*)?$/.test(url)) {
        return new Promise<Response>((_resolve, reject) => {
          rejectOldBlocks = reject;
        });
      }
      if (/\/api\/spaces\/sp2\/blocks(?:\?.*)?$/.test(url)) {
        return Promise.resolve(json({
          blocks: [
            makeBlock({
              id: 'b2',
              space_id: 'sp2',
              sort_key: 'a',
              markdown: 'Fresh document.',
            }),
          ],
        }));
      }
      if (/\/api\/spaces\/sp[12]\/exports(?:\?.*)?$/.test(url)) {
        return Promise.resolve(json({ exports: [] }));
      }
      if (/\/api\/spaces\/sp[12](?:\?.*)?$/.test(url)) {
        return Promise.resolve(json({
          space: {
            id: url.includes('/sp2') ? 'sp2' : 'sp1',
            project_id: 'prj1',
            title: 'Space',
            default_renderer: 'document',
            description: null,
            metadata: {},
            created_at: NOW,
            updated_at: NOW,
          },
          items: [],
          occurrences: [],
          edges: [],
        }));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal('fetch', fetchImpl);

    const rendered = render(
      <DocumentBlockEditor
        projectId="prj1"
        spaceId="sp1"
        renderer="document"
        fetchImpl={fetchImpl as unknown as typeof fetch}
        instance={mainInstance}
      />,
    );
    await waitFor(() => expect(rejectOldBlocks).toBeTruthy());

    rendered.rerender(
      <DocumentBlockEditor
        projectId="prj1"
        spaceId="sp2"
        renderer="document"
        fetchImpl={fetchImpl as unknown as typeof fetch}
        instance={mainInstance}
      />,
    );
    await waitFor(() => expect(screen.getByText('Fresh document.')).toBeTruthy());

    await act(async () => {
      rejectOldBlocks?.(new Error('old load failed'));
      await Promise.resolve();
    });

    expect(screen.queryByTestId('spaces-block-editor-error')).toBeNull();
    expect(screen.getByText('Fresh document.')).toBeTruthy();
  });

  it('edits a prose block and autosaves via PATCH on blur', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'old' })]);
    await renderEditor({ backend });

    setSourceText(0, 'new text');
    blurSource();

    await waitFor(() =>
      expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(true),
    );
    const patch = backend.calls.find((c) => c.method === 'PATCH');
    expect((patch!.body as { markdown: string }).markdown).toBe('new text');
  });

  it('keeps the draft visible while autosave waits for canonical reload', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'old' })]);
    const baseFetch = backend.fetchImpl;
    let blockGetCount = 0;
    let releaseReload: (() => void) | null = null;
    backend.fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (/\/api\/spaces\/sp1\/blocks(?:\?.*)?$/.test(url) && method === 'GET') {
        blockGetCount += 1;
        if (blockGetCount > 1) {
          await new Promise<void>((resolve) => {
            releaseReload = resolve;
          });
        }
      }
      return baseFetch(input, init);
    });
    await renderEditor({ backend });

    const nextValue = '## Heading\nbody';
    setSourceText(0, nextValue, nextValue.length);
    blurSource();

    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(true));
    await waitFor(() => expect(releaseReload).not.toBeNull());
    expect(normalizeBlockEditorViewState(JSON.parse(
      window.localStorage.getItem(blockEditorStorageKey('prj1', 'sp1'))!,
    )).drafts.b1).toBe(nextValue);
    expect(sourceText()).toBe(nextValue);
    expect(sourceView().state.selection.main.from).toBe(nextValue.length);

    releaseReload?.();
    await waitFor(() => expect(normalizeBlockEditorViewState(JSON.parse(
      window.localStorage.getItem(blockEditorStorageKey('prj1', 'sp1'))!,
    )).drafts.b1).toBeUndefined());
    expect(sourceText()).toBe(nextValue);
  });

  it('does not regress to stale canonical block text after autosave acknowledgement', async () => {
    const staleBlock = makeBlock({ id: 'b1', sort_key: 'a', markdown: 'old' });
    const backend = makeBackend([staleBlock]);
    const baseFetch = backend.fetchImpl;
    let blockGetCount = 0;
    backend.fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (/\/api\/spaces\/sp1\/blocks(?:\?.*)?$/.test(url) && method === 'GET') {
        blockGetCount += 1;
        if (blockGetCount === 2) {
          return json({ blocks: [staleBlock] });
        }
      }
      return baseFetch(input, init);
    });
    await renderEditor({ backend });

    const nextValue = '## Heading\nbody';
    setSourceText(0, nextValue, nextValue.length);
    blurSource();

    await waitFor(() => expect(blockGetCount).toBe(2));
    await waitFor(() => expect(normalizeBlockEditorViewState(JSON.parse(
      window.localStorage.getItem(blockEditorStorageKey('prj1', 'sp1'))!,
    )).drafts.b1).toBe(nextValue));
    expect(sourceText()).toBe(nextValue);
    expect(sourceView().state.selection.main.from).toBe(nextValue.length);
  });
});

// --- component: independent managed authoring ----------------------------------------

// --- component: embed-on-delete is a user-prompted decision ------------------

describe('DocumentBlockEditor (embed-on-delete decision)', () => {
  it('raises an explicit decision (no host handler) without auto-detaching', async () => {
    const backend = makeBackend([
      makeBlock({
        id: 'b1',
        block_type: 'issue_embed',
        sort_key: 'a',
        item_id: 'it1',
        item_snapshot: { item_id: 'it1', ref_type: 'issue', ref_id: 'mandible://r/issue/x', title: 'I' },
      }),
    ]);
    await renderEditor({ backend });

    fireEvent.click(screen.getByTestId('spaces-block-editor-delete-item'));
    // The decision surface appears; NO detach has happened yet.
    expect(screen.getByTestId('spaces-block-editor-embed-delete')).toBeTruthy();
    expect(backend.calls.some((c) => /detach-blocks/.test(c.url))).toBe(false);

    // Only on explicit confirm does the detach route fire.
    fireEvent.click(screen.getByTestId('spaces-block-editor-embed-detach'));
    await waitFor(() => expect(backend.calls.some((c) => /detach-blocks/.test(c.url))).toBe(true));
  });
});

// --- standing AC #2: draft persists across SSE reconciliation ---------------

describe('DocumentBlockEditor draft persistence (UI-state-persistence)', () => {
  it('keeps an in-progress edit draft across an SSE-reconciliation refetch', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'old' })]);
    await renderEditor({ backend });

    setSourceText(0, 'work in progress');

    // Persisted browser-local for this space.
    const stored = normalizeBlockEditorViewState(JSON.parse(
      window.localStorage.getItem(blockEditorStorageKey('prj1', 'sp1'))!,
    ));
    expect(stored.drafts.b1).toBe('work in progress');
    expect(stored.editingId).toBe('b1');

    // A `space:*` SSE event triggers a reconciliation refetch.
    invalidateDashboardApiCacheForEvent('space:block:changed', { space_id: 'sp1' });

    // The draft survives the refetch (Dataful-UX: reconcile never resets intent).
    await waitFor(() => {
      expect(sourceText()).toBe('work in progress');
    });
    expect(blockEditorStorageKey('prj1', 'sp1')).toBe('mandible.spaces.blockEditor:prj1:sp1');
  });
});

describe('document refresh reliability', () => {
  it('receives acknowledged packet membership in the open picker without another packet response', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', markdown: 'initial' })]);
    const original = backend.fetchImpl.getMockImplementation()!;
    let packetReads = 0;
    backend.fetchImpl.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/spaces/sp1' && (init?.method ?? 'GET') === 'GET' && ++packetReads > 1) return new Promise<Response>(() => undefined);
      if (url === '/api/spaces/sp1/items' && init?.method === 'POST') return Promise.resolve(json({ item: {
        id: 'published-item', space_id: 'sp1', ref_type: 'artifact', ref_id: 'artifact-published', ref_uri: null,
        title: 'Published member', metadata: {}, created_at: NOW, updated_at: NOW,
      }, created: true, already_present: false }));
      if (url.startsWith('/api/graph')) return Promise.resolve(json({ nodes: [], edges: [] }));
      if (url.startsWith('/api/artifacts')) return Promise.resolve(json({ artifacts: [] }));
      return original(input, init);
    });
    await renderEditor({ backend });
    setSourceText(0, '/item');
    fireEvent.keyDown(sourceView().contentDOM, { key: 'Enter', code: 'Enter' });
    await screen.findByTestId('space-item-picker');
    expect(packetReads).toBe(1);
    await act(async () => { await addSpaceItem('sp1', { ref_type: 'artifact', ref_id: 'artifact-published' }); });
    await screen.findByText('Published member');
  });

  it('defers hidden document reads and keeps the draft through activation reconciliation', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', markdown: 'initial' })]);
    const view = await renderEditor({ backend });
    setSourceText(0, 'my pending draft');
    view.setActive(false);
    await flushEffects();
    const readCount = () => backend.fetchImpl.mock.calls.filter(([input, init]) => (init?.method ?? 'GET') === 'GET'
      && /\/(blocks|items)$/.test(String(input))).length;
    const before = readCount();
    act(() => invalidateDashboardCaches());
    await flushEffects();
    expect(readCount()).toBe(before);
    view.setActive(true);
    await waitFor(() => expect(readCount()).toBeGreaterThan(before));
    expect(sourceText()).toBe('my pending draft');
  });

  it('rejects an older same-Space read and ignores unrelated Space events', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', markdown: 'initial' })]);
    await renderEditor({ backend });
    let resolveOlder!: (response: Response) => void;
    let blockReads = 0;
    backend.fetchImpl.mockImplementation((input, init) => {
      if (String(input).endsWith('/blocks') && (init?.method ?? 'GET') === 'GET') {
        blockReads += 1;
        if (blockReads === 1) return new Promise<Response>((resolve) => { resolveOlder = resolve; });
        return Promise.resolve(json({ blocks: [makeBlock({ id: 'b1', markdown: 'newer' })] }));
      }
      return Promise.resolve(json(String(input).endsWith('/exports') ? { exports: [] } : { items: [] }));
    });
    invalidateDashboardApiCacheForEvent('space:block:changed', { space_id: 'other' });
    await flushEffects();
    expect(blockReads).toBe(0);
    invalidateDashboardApiCacheForEvent('space:block:changed', { space_id: 'sp1' });
    await waitFor(() => expect(blockReads).toBe(1));
    invalidateDashboardApiCacheForEvent('space:block:changed', { space_id: 'sp1' });
    await waitFor(() => expect(sourceText()).toBe('newer'));
    resolveOlder(json({ blocks: [makeBlock({ id: 'b1', markdown: 'older' })] }));
    await flushEffects();
    expect(sourceText()).toBe('newer');
  });

  it('retains last-good content and a rejected draft, and recovers a server-deleted block', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', markdown: 'saved' })]);
    await renderEditor({ backend });
    const original = backend.fetchImpl.getMockImplementation()!;
    let failReads = false;
    backend.fetchImpl.mockImplementation((input, init) => {
      if (init?.method === 'PATCH') return Promise.resolve(json({ error: 'write_rejected' }, 403));
      if (failReads && String(input).endsWith('/blocks')) return Promise.resolve(json({ blocks: null }));
      return original(input, init);
    });
    setSourceText(0, 'my retained draft');
    blurSource();
    await waitFor(() =>
      expect(screen.getByTestId('spaces-block-editor-save-state').getAttribute('data-state')).toBe('error'),
    );
    expect(sourceText()).toBe('my retained draft');
    failReads = true;
    invalidateDashboardApiCacheForEvent('space:block:changed', { space_id: 'sp1' });
    await screen.findByTestId('spaces-block-editor-error');
    expect(screen.getByText('my retained draft')).toBeTruthy();
    failReads = false;
    backend.blocks.delete('b1');
    invalidateDashboardApiCacheForEvent('space:block:changed', { space_id: 'sp1' });
    await screen.findByRole('textbox', { name: 'Retained block draft' });
    expect((screen.getByRole('textbox', { name: 'Retained block draft' }) as HTMLTextAreaElement).value).toBe('my retained draft');
    fireEvent.click(screen.getByRole('button', { name: 'Restore as a new block' }));
    await waitFor(() => expect([...backend.blocks.values()].some((block) => block.markdown === 'my retained draft')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Retained block draft' })).toBeNull());
  });
});
