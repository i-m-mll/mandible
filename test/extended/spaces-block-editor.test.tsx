// Spaces document block editor tests (umbrella de56ffa, C14c / issue cef3eac).
//
// Covers the acceptance criteria:
//   - The editor reads/writes `space_blocks` via the C11 routes and renders the
//     live tree through the C14b renderer. Authoring controls must stay
//     transparent: typed document commands and transient overlays, not persistent
//     block chrome.
//   - Managed authoring stays editable independently of historical publication state.
//   - Embed-on-delete is a user-prompted decision point, NOT hardcoded: deleting
//     an embedded item raises an explicit choice and takes no destructive action
//     until the user resolves it.
//   - Standing AC #2 (UI-state-persistence): the in-progress edit draft persists
//     per-Space and survives SSE-reconciliation refetches without reset.

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSharedSseForTests } from '../../ui/src/sse-shared';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { undo } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { AppShellProvider } from '../../ui/src/app-shell';
import { queryClient } from '../../ui/src/query/client';
import { __resetBrowserSessionForTests } from '../../ui/src/client-auth-token';

import {
  DocumentBlockEditor,
  type EmbedDeleteDecision,
} from '../../ui/src/views/spaces/DocumentBlockEditor';
import { MarkdownSourceEditor } from '../../ui/src/views/spaces/MarkdownSourceEditor';
import {
  generateSortKey,
  isValidSortKey,
  siblingsUnder,
  appendSortKey,
  prependSortKey,
  placementForIndex,
  siblingIndexOf,
} from '../../ui/src/views/spaces/blockEditorModel';
import {
  blockEditorStorageKey,
  normalizeBlockEditorViewState,
} from '../../ui/src/views/spaces/blockEditorViewState';
import {
  listSpaceBlocks,
  createSpaceBlock,
  updateSpaceBlock,
  deleteSpaceBlock,
  detachItemFromBlocks,
} from '../../ui/src/api';
import type { InstanceInfo, LedgerIssueDetailProjection, SpaceBlock, SpaceExport, SpaceItem } from '../../ui/src/api';
import { __resetResourceRefRecognizers } from '../../ui/src/resource-refs';

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

// --- SSE mock (matches the createSSEClient EventSource transport) ------------

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

function makeExport(over: Partial<SpaceExport>): SpaceExport {
  return {
    id: 'ex1',
    space_id: 'sp1',
    repo_id: 'repo1',
    branch: 'docs',
    path: 'doc.md',
    authority: 'mandible',
    status: 'clean',
    last_export_artifact_id: null,
    pre_export_snapshot_artifact_id: null,
    last_export_commit: null,
    last_export_blob_sha: null,
    last_export_content_sha256: null,
    last_seen_commit: null,
    last_seen_content_sha256: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function makeItem(over: Partial<SpaceItem> & Pick<SpaceItem, 'id'>): SpaceItem {
  return {
    id: over.id,
    space_id: 'sp1',
    ref_type: 'issue',
    ref_id: 'abc123',
    ref_uri: null,
    title: 'Issue abc123',
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function makePreviewInstance(allowedEffects: string[]): InstanceInfo {
  return {
    role: 'preview',
    instance_id: 'preview-1',
    installation_id: 'install-1',
    public_origin: 'http://localhost:19420',
    backend_generation: 'test-generation',
    allowed_effects: allowedEffects,
    writable_roots: ['/tmp/mandible-preview'],
    db_path: '/tmp/mandible-preview/mandible.db',
    db_path_source: 'iab-preview-copy',
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
    author: { id: null, type: 'mandible_user', display: 'Mandible' },
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
  } as unknown as LedgerIssueDetailProjection;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  stubLocalStorage();
  const notices = document.createElement('div');
  notices.id = 'editor-notices';
  document.body.append(notices);
  queryClient.clear();
  __resetBrowserSessionForTests();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  __resetSharedSseForTests();
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
  it('generateSortKey produces a key strictly between bounds (matches C11)', () => {
    const mid = generateSortKey('a', 'c');
    expect(mid > 'a').toBe(true);
    expect(mid < 'c').toBe(true);
    expect(isValidSortKey(mid)).toBe(true);
  });

  it('generateSortKey handles adjacent digits without collision', () => {
    const mid = generateSortKey('a', 'b');
    expect(mid > 'a').toBe(true);
    expect(mid < 'b').toBe(true);
  });

  it('appends after the last sibling and prepends before the first', () => {
    const blocks = [
      makeBlock({ id: 'b1', sort_key: 'g' }),
      makeBlock({ id: 'b2', sort_key: 'm' }),
    ];
    expect(appendSortKey(blocks, null) > 'm').toBe(true);
    expect(prependSortKey(blocks, null) < 'g').toBe(true);
  });

  it('siblingsUnder orders by sort_key then id and scopes to the parent', () => {
    const blocks = [
      makeBlock({ id: 'b2', sort_key: 'm' }),
      makeBlock({ id: 'b1', sort_key: 'g' }),
      makeBlock({ id: 'c1', parent_id: 'b1', sort_key: 'a' }),
    ];
    expect(siblingsUnder(blocks, null).map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(siblingsUnder(blocks, 'b1').map((b) => b.id)).toEqual(['c1']);
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

  it('siblingIndexOf reports the current sibling position', () => {
    const blocks = [
      makeBlock({ id: 'b1', sort_key: 'a' }),
      makeBlock({ id: 'b2', sort_key: 'm' }),
    ];
    expect(siblingIndexOf(blocks, 'b2')).toBe(1);
    expect(siblingIndexOf(blocks, 'missing')).toBe(-1);
  });
});

// --- view-state persistence + reconciliation (standing AC #2) ----------------

describe('blockEditorViewState', () => {
  it('keeps the established per-space storage key', () => {
    expect(blockEditorStorageKey('prj1', 'sp1')).toBe('mandible.spaces.blockEditor:prj1:sp1');
  });

  it('normalizes malformed stored state to a safe empty state', () => {
    expect(normalizeBlockEditorViewState(null)).toEqual({ editingId: null, drafts: {} });
    expect(normalizeBlockEditorViewState({ editingId: 5, drafts: { a: 1, b: 'x' } })).toEqual({
      editingId: null,
      drafts: { b: 'x' },
    });
  });


});

// --- client: routes hit the C11 surface --------------------------------------

describe('Spaces block API transport', () => {
  it('lists, creates, updates, deletes, and detaches against the C11 routes', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'hi' })]);
    const f = backend.fetchImpl;

    expect((await listSpaceBlocks('sp1', f)).map((b) => b.id)).toEqual(['b1']);

    const created = await createSpaceBlock('sp1', { block_type: 'paragraph', sort_key: 'b' }, f);
    expect(created.block_type).toBe('paragraph');

    const updated = await updateSpaceBlock('sp1', 'b1', { markdown: 'bye' }, f);
    expect(updated.markdown).toBe('bye');

    await deleteSpaceBlock('sp1', 'b1', f);
    expect(backend.blocks.has('b1')).toBe(false);

    const detach = await detachItemFromBlocks('sp1', 'item-x', f);
    expect(Array.isArray(detach.detached)).toBe(true);

    expect(backend.calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api/, '/api')}`)).toEqual([
      'GET /api/spaces/sp1/blocks',
      'POST /api/spaces/sp1/blocks',
      'PATCH /api/spaces/sp1/blocks/b1',
      'DELETE /api/spaces/sp1/blocks/b1',
      'POST /api/spaces/sp1/items/item-x/detach-blocks',
    ]);
  });

  it('surfaces a server error message on a failed write', async () => {
    const f = vi.fn(async (input) => String(input) === '/api/client-auth/whoami' ? json({ authenticated: true, session: { csrf_token: 'test-csrf' } }) : json({ error: 'boom' }, 400));
    await expect(createSpaceBlock('sp1', { block_type: 'paragraph' }, f)).rejects.toThrow('boom');
  });
});

// --- component: editable Mandible-custody editor -----------------------------

async function renderEditor(props: Partial<Parameters<typeof DocumentBlockEditor>[0]> & {
  backend: ReturnType<typeof makeBackend>;
}) {
  const { backend, instance = mainInstance, ...rest } = props;
  vi.stubGlobal('fetch', backend.fetchImpl);
  render(
    <AppShellProvider value={{ active: true, noticeHost: document.getElementById('editor-notices'), rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
    <DocumentBlockEditor
      projectId="prj1"
      spaceId="sp1"
      renderer="document"
      fetchImpl={backend.fetchImpl}
      instance={instance}
      {...rest}
    /></AppShellProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('spaces-block-editor-list')).toBeTruthy());
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

function setSourceSelection(index: number, start: number, end: number): EditorView {
  const view = sourceView(index);
  act(() => {
    view.focus();
    view.dispatch({ selection: EditorSelection.range(start, end) });
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
  it('keeps editor undo history active', async () => {
    render(
      <MarkdownSourceEditor
        blockId="b1"
        value="before"
        ariaLabel="Edit Markdown"
        onChange={() => undefined}
        onBlur={() => undefined}
        onCaretChange={() => undefined}
        onSelectionChange={() => undefined}
        onItemCommand={() => undefined}
        onOpenReference={() => undefined}
      />,
    );
    await flushEffects();

    setSourceText(0, 'after');
    expect(sourceText()).toBe('after');
    act(() => {
      expect(undo(sourceView())).toBe(true);
    });
    expect(sourceText()).toBe('before');
  });

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
  it('renders the live tree as document-like editable rows', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: '# Title' }),
      makeBlock({ id: 'b2', sort_key: 'b', markdown: 'Body prose.' }),
    ]);
    await renderEditor({ backend });

    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByText('Body prose.')).toBeTruthy();
    expect(sourceText(0)).toBe('# Title');
    expect(sourceText(1)).toBe('Body prose.');
    expect(screen.getAllByTestId('spaces-block-editor-row')).toHaveLength(2);
    expect(screen.queryByTestId('spaces-block-editor-toolbar')).toBeNull();
    expect(screen.queryByTestId('spaces-block-editor-command-trigger')).toBeNull();
    expect(screen.queryByTestId('spaces-block-editor-picker-overlay')).toBeNull();
    expect(screen.queryByTestId('spaces-block-editor-add-items')).toBeNull();
    expect(screen.queryByTestId('spaces-block-editor-up')).toBeNull();
    expect(screen.queryByTestId('spaces-block-editor-down')).toBeNull();
    expect(screen.queryByTestId('spaces-block-editor-delete')).toBeNull();
    const editor = screen.getByTestId('spaces-block-editor');
    expect(editor.getAttribute('data-editable')).toBe('true');
    expect(editor.getAttribute('data-stale')).toBe('false');
  });

  it('renders the document without waiting for the space fact packet', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'Body prose.' }),
    ]);
    const baseFetch = backend.fetchImpl;
    backend.fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/api\/spaces\/sp1(?:\?.*)?$/.test(url)) {
        return new Promise<Response>(() => undefined);
      }
      return baseFetch(input, init);
    });

    await renderEditor({ backend });

    expect(screen.queryByText('Loading document…')).toBeNull();
    expect(screen.getByText('Body prose.')).toBeTruthy();
  });

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
    expect(screen.queryByText('Loading document…')).toBeNull();
    expect(screen.getByText('Fresh document.')).toBeTruthy();
  });

  it('uses one source editor per editable Markdown block without textarea islands', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'Selectable prose.' }),
    ]);
    await renderEditor({ backend });

    const surface = screen.getByTestId('spaces-block-editor-edit');
    expect(surface.tagName).toBe('DIV');
    expect(surface.getAttribute('role')).toBeNull();
    expect(surface.getAttribute('tabindex')).toBeNull();
    expect(sourceText()).toBe('Selectable prose.');
    expect(sourceView().contentDOM.getAttribute('role')).toBe('textbox');
    expect(screen.queryByTestId('spaces-block-editor-textarea')).toBeNull();
  });

  it('keeps paragraph prose directly editable in the source editor', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'Editable prose.' }),
    ]);
    await renderEditor({ backend });

    sourceView().focus();
    await waitFor(() => expect(document.activeElement).toBe(sourceView().contentDOM));
    expect(sourceText()).toBe('Editable prose.');
  });

  it('renders headings as headings until the caret enters that source line', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: '# Title' }),
    ]);
    await renderEditor({ backend });

    const heading = screen.getByRole('heading', { name: 'Title' });
    expect(heading).toBeTruthy();
    expect(heading.closest('[data-heading-hit-area="true"]')).toBeTruthy();
    fireEvent.mouseDown(heading);

    const view = sourceView();
    await waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
    expect(sourceText()).toBe('# Title');
    expect(view.state.selection.main.from).toBe(2);
    expect(screen.queryByRole('heading', { name: 'Title' })).toBeNull();
  });

  it('keeps rendered headings visible while focus is outside their source line', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'paragraph', sort_key: 'a', markdown: 'intro\n# Title' }),
    ]);
    await renderEditor({ backend });

    setSourceSelection(0, 2, 2);
    expect(screen.queryByTestId('spaces-block-editor-textarea')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
  });

  it('shows plain source for heading blocks whose markdown has no hash prefix', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: 'New heading' }),
    ]);
    await renderEditor({ backend });

    expect(sourceText()).toBe('New heading');
    expect(screen.getByText('New heading')).toBeTruthy();
  });

  it('places the caret inside a clicked rendered heading instead of selecting the end', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: '## Some heading' }),
    ]);
    await renderEditor({ backend });

    const heading = screen.getByRole('heading', { name: 'Some heading' });
    const textNode = heading.firstChild;
    expect(textNode).toBeTruthy();
    const range = document.createRange();
    range.setStart(textNode!, 5);
    range.setEnd(textNode!, 5);
    const priorCaretRangeFromPoint = (
      document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
    ).caretRangeFromPoint;
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => range,
    });
    try {
      fireEvent.mouseDown(heading, { clientX: 48, clientY: 12 });
      const view = sourceView();
      await waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
      expect(sourceText()).toBe('## Some heading');
      expect(view.state.selection.main.from).toBe(8);
      expect(view.state.selection.main.from).not.toBe(sourceText().length);
    } finally {
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: priorCaretRangeFromPoint,
      });
    }
  });

  it('keeps lines before and after a mixed Markdown heading in one editable source buffer', async () => {
    const backend = makeBackend([
      makeBlock({
        id: 'b1',
        block_type: 'paragraph',
        sort_key: 'a',
        markdown: 'intro\n## Heading\nbody',
      }),
    ]);
    await renderEditor({ backend });

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy();
    expect(sourceText()).toBe('intro\n## Heading\nbody');
    setSourceSelection(0, 0, 0);
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy();
    setSourceSelection(0, sourceText().length, sourceText().length);
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy();
  });

  it('maps a clicked rendered heading in a mixed block to the matching markdown source line', async () => {
    const backend = makeBackend([
      makeBlock({
        id: 'b1',
        block_type: 'paragraph',
        sort_key: 'a',
        markdown: 'intro\n## Heading\nbody',
      }),
    ]);
    await renderEditor({ backend });

    const heading = screen.getByRole('heading', { name: 'Heading' });
    const textNode = heading.firstChild;
    expect(textNode).toBeTruthy();
    const range = document.createRange();
    range.setStart(textNode!, 2);
    range.setEnd(textNode!, 2);
    const priorCaretRangeFromPoint = (
      document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
    ).caretRangeFromPoint;
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => range,
    });
    try {
      fireEvent.mouseDown(heading, { clientX: 48, clientY: 12 });
      const view = sourceView();
      await waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
      expect(sourceText()).toBe('intro\n## Heading\nbody');
      expect(view.state.selection.main.from).toBe('intro\n## He'.length);
    } finally {
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: priorCaretRangeFromPoint,
      });
    }
  });

  it('renders a typed Markdown heading as soon as Enter moves the caret to the next line', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'paragraph', sort_key: 'a', markdown: '' }),
    ]);
    await renderEditor({ backend });

    setSourceText(0, '## Something\n', '## Something\n'.length);

    expect(await screen.findByRole('heading', { name: 'Something' })).toBeTruthy();
    expect(sourceView().state.selection.main.from).toBe('## Something\n'.length);

    for (const value of ['b', 'bo', 'bod', 'body']) {
      setSourceText(0, `## Something\n${value}`, `## Something\n${value}`.length);
      expect(sourceText()).toBe(`## Something\n${value}`);
    }
    blurSource();

    await waitFor(() => expect(backend.blocks.get('b1')?.markdown).toBe('## Something\nbody'));
  });

  it('renders inline Markdown emphasis visually while preserving source text', async () => {
    const backend = makeBackend([
      makeBlock({
        id: 'b1',
        block_type: 'paragraph',
        sort_key: 'a',
        markdown: '*one* _two_ **three** __four__',
      }),
    ]);
    await renderEditor({ backend });

    const emphasis = Array.from(sourceHost().querySelectorAll('.spaces-markdown-source__emphasis'));
    expect(emphasis.map((node) => node.textContent)).toEqual(['one', 'two', 'three', 'four']);
    expect(sourceHost().querySelectorAll('.spaces-markdown-source__emphasis--em')).toHaveLength(2);
    expect(sourceHost().querySelectorAll('.spaces-markdown-source__emphasis--strong')).toHaveLength(2);
    expect(sourceText()).toBe('*one* _two_ **three** __four__');
  });

  it('reveals raw Markdown emphasis source when the caret enters that span', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'paragraph', sort_key: 'a', markdown: 'A **bold** move' }),
    ]);
    await renderEditor({ backend });

    expect(sourceHost().querySelector('.spaces-markdown-source__emphasis--strong')?.textContent)
      .toBe('bold');
    expect(sourceHost().textContent).not.toContain('**bold**');

    setSourceSelection(0, 'A **b'.length, 'A **b'.length);

    expect(sourceHost().querySelector('.spaces-markdown-source__emphasis--strong')).toBeNull();
    expect(sourceHost().textContent).toContain('**bold**');
    expect(sourceText()).toBe('A **bold** move');
  });

  it('keeps prose Enter focused on an editable following line', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'paragraph', sort_key: 'a', markdown: '' }),
    ]);
    await renderEditor({ backend });

    setSourceText(0, 'first\n', 'first\n'.length);
    expect(document.activeElement).toBe(sourceView().contentDOM);
    expect(sourceText()).toBe('first\n');

    for (const value of ['s', 'se', 'sec', 'seco', 'secon', 'second']) {
      setSourceText(0, `first\n${value}`, `first\n${value}`.length);
      expect(document.activeElement).toBe(sourceView().contentDOM);
    }
    blurSource();

    await waitFor(() => expect(backend.blocks.get('b1')?.markdown).toBe('first\nsecond'));
  });

  it('Backspace at an empty line or line start removes the newline normally', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'paragraph', sort_key: 'a', markdown: 'first\nsecond' }),
    ]);
    await renderEditor({ backend });

    const emptyLine = 'first\n\nsecond';
    setSourceText(0, emptyLine, 'first\n\n'.length);
    act(() => {
      const view = sourceView();
      view.dispatch({
        changes: { from: 'first\n'.length, to: 'first\n\n'.length, insert: '' },
        selection: EditorSelection.cursor('first\n'.length),
      });
    });
    expect(sourceText()).toBe('first\nsecond');

    act(() => {
      const view = sourceView();
      view.dispatch({
        changes: { from: 'first'.length, to: 'first\n'.length, insert: '' },
        selection: EditorSelection.cursor('first'.length),
      });
    });
    expect(sourceText()).toBe('firstsecond');
  });

  it('renders blank paragraph blocks as blank document content', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: '' })]);
    await renderEditor({ backend });

    expect(screen.queryByText('Write here…')).toBeNull();
    expect(sourceText()).toBe('');
  });

  it('focuses the final editable block at document end when blank space below content is clicked', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'First block' }),
      makeBlock({ id: 'b2', sort_key: 'b', markdown: 'Final block' }),
    ]);
    await renderEditor({ backend });

    setSourceSelection(0, 0, 0);
    const scroller = document.querySelector('.spaces-block-editor__scroller') as HTMLElement;
    fireEvent.mouseDown(scroller, { button: 0, clientX: 16, clientY: 640 });

    await waitFor(() => expect(document.activeElement).toBe(sourceView(1).contentDOM));
    expect(sourceView(1).state.selection.main.from).toBe('Final block'.length);
  });

  it('places the caret at line end when horizontal whitespace beside a line is clicked', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'alpha\nbeta' }),
    ]);
    await renderEditor({ backend });

    const view = sourceView();
    vi.spyOn(view, 'lineBlockAtHeight').mockReturnValue({
      from: 0,
      to: 'alpha'.length,
    } as ReturnType<EditorView['lineBlockAtHeight']>);
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({
      left: 48,
      right: 52,
      top: 0,
      bottom: 20,
    });

    fireEvent.mouseDown(screen.getByTestId('spaces-block-editor-row'), {
      button: 0,
      clientX: 320,
      clientY: 10,
    });

    await waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
    expect(view.state.selection.main.from).toBe('alpha'.length);
  });

  it('moves arrow focus through legacy empty blocks around headings', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: '' }),
      makeBlock({ id: 'b2', block_type: 'heading', sort_key: 'b', markdown: 'New heading' }),
      makeBlock({ id: 'b3', sort_key: 'c', markdown: '' }),
      makeBlock({ id: 'b4', block_type: 'heading', sort_key: 'd', markdown: '## gad' }),
    ]);
    await renderEditor({ backend });

    setSourceSelection(0, 0, 0);
    fireEvent.keyDown(sourceView(0).contentDOM, { key: 'ArrowDown', code: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(sourceView(1).contentDOM));
    expect(sourceView(1).state.selection.main.from).toBe(0);

    setSourceSelection(1, 0, 0);
    fireEvent.keyDown(sourceView(1).contentDOM, { key: 'ArrowUp', code: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement).toBe(sourceView(0).contentDOM));
    expect(sourceView(0).state.selection.main.from).toBe(0);

    setSourceSelection(1, 'New heading'.length, 'New heading'.length);
    fireEvent.keyDown(sourceView(1).contentDOM, { key: 'ArrowDown', code: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(sourceView(2).contentDOM));
    expect(sourceView(2).state.selection.main.from).toBe(0);

    setSourceSelection(3, 0, 0);
    fireEvent.keyDown(sourceView(3).contentDOM, { key: 'ArrowUp', code: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement).toBe(sourceView(2).contentDOM));
    expect(sourceView(2).state.selection.main.from).toBe(0);
  });

  it('opens the shared bottom detail panel for inline issue references', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'See [issue:abc123].' }),
    ]);
    await renderEditor({ backend });

    const refLink = screen.getByText('issue:abc123');
    expect(refLink.classList.contains('resource-ref__link')).toBe(true);

    fireEvent.click(refLink);

    expect(screen.getByTestId('spaces-block-editor-inspector')).toBeTruthy();
    expect(screen.getByTestId('spaces-block-editor-inspector-resize')).toBeTruthy();
    expect(screen.queryByTestId('spaces-block-editor-textarea')).toBeNull();
    expect(document.querySelector('.spaces-block-editor__inspector-meta')).toBeNull();
    expect(screen.queryByText('issue:abc123', { selector: '.spaces-block-editor__inspector-meta code' })).toBeNull();
    await waitFor(() =>
      expect(backend.calls.some((c) => c.method === 'GET' && /\/api\/ledger\/issues\/abc123$/.test(c.url))).toBe(true),
    );
    expect(screen.queryByTestId('spaces-block-editor-embed-delete')).toBeNull();
  });

  it('resizes the bottom reference inspector from its top-edge separator', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'See [issue:abc123].' }),
    ]);
    await renderEditor({ backend });

    fireEvent.click(screen.getByText('issue:abc123'));
    const inspector = screen.getByTestId('spaces-block-editor-inspector') as HTMLElement;
    const handle = screen.getByTestId('spaces-block-editor-inspector-resize') as HTMLElement;
    const editor = screen.getByTestId('spaces-block-editor') as HTMLElement;

    inspector.getBoundingClientRect = () => ({
      x: 0,
      y: 440,
      width: 800,
      height: 220,
      top: 440,
      right: 800,
      bottom: 660,
      left: 0,
      toJSON: () => ({}),
    });
    editor.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseDown(handle, { clientY: 440 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 380 }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });

    await waitFor(() => expect(inspector.style.flexBasis).toBe('280px'));
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('opens an empty document directly in a blank focused editor', async () => {
    const backend = makeBackend([]);
    await renderEditor({ backend });

    expect(screen.queryByTestId('spaces-block-editor-empty-author')).toBeNull();
    expect(screen.queryByText('Start writing')).toBeNull();
    await waitFor(() =>
      expect(backend.calls.some((c) => c.method === 'POST' && /\/blocks$/.test(c.url))).toBe(true),
    );
    const post = backend.calls.find((c) => c.method === 'POST');
    expect((post!.body as { block_type: string }).block_type).toBe('paragraph');
    expect(typeof (post!.body as { sort_key: string }).sort_key).toBe('string');
    expect(sourceText()).toBe('');
    await waitFor(() => expect(document.activeElement).toBe(sourceView().contentDOM));
    expect(sourceView().state.selection.main.from).toBe(0);

    sourceView().contentDOM.blur();
    fireEvent.mouseDown(screen.getByTestId('spaces-block-editor-row'), {
      button: 0,
      clientX: 320,
      clientY: 10,
    });

    await waitFor(() => expect(document.activeElement).toBe(sourceView().contentDOM));
    expect(sourceView().state.selection.main.from).toBe(0);
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
    await waitFor(() => expect(screen.getByTestId('spaces-block-editor-save-state')).toBeTruthy());
    const saveState = screen.getByTestId('spaces-block-editor-save-state');
    expect(saveState.parentElement?.classList.contains('spaces-block-editor__viewport')).toBe(true);
    expect(saveState.closest('.spaces-block-editor__scroller')).toBeNull();
    expect(saveState.closest('.spaces-block-editor__list')).toBeNull();
  });

  it('autosaves a prose edit to the copied preview ledger when ledger writes are allowed', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'old' })]);
    await renderEditor({
      backend,
      instance: makePreviewInstance(['ledger:read', 'ledger:write', 'files:preview']),
    });

    setSourceText(0, 'edited in preview');
    blurSource();

    await waitFor(() => expect(backend.blocks.get('b1')?.markdown).toBe('edited in preview'));
    expect(backend.calls.some((call) => call.method === 'PATCH')).toBe(true);
  });

  it('debounces autosave while a prose block is being edited', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'old' })]);
    await renderEditor({ backend });
    vi.useFakeTimers();
    try {
      setSourceText(0, 'draft autosave');
      expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(false);

      await vi.advanceTimersByTimeAsync(700);
      await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(true));
      expect((backend.calls.find((c) => c.method === 'PATCH')!.body as { markdown: string }).markdown)
        .toBe('draft autosave');
    } finally {
      vi.useRealTimers();
    }
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

  it('shows a transient selected-text formatting menu and wraps the selected Markdown', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'Body text' })]);
    await renderEditor({ backend });

    setSourceSelection(0, 0, 4);

    expect(screen.getByTestId('spaces-block-editor-selection-menu')).toBeTruthy();
    fireEvent.mouseDown(screen.getByLabelText('Bold'));
    await waitFor(() => expect(sourceText()).toBe('**Body** text'));
  });

  it('opens the item picker from typed /item and replaces that command range with a bracket ref', async () => {
    const backend = makeBackend(
      [
        makeBlock({ id: 'b1', sort_key: 'a', markdown: 'See /item' }),
        makeBlock({ id: 'b2', sort_key: 'b', markdown: 'Other block' }),
      ],
      [],
      [makeItem({ id: 'it1', ref_type: 'issue', ref_id: 'abc123', title: 'Issue abc123' })],
    );
    await renderEditor({ backend });

    const view = sourceView(0);
    act(() => {
      view.focus();
      view.dispatch({ selection: EditorSelection.cursor(sourceText(0).length) });
    });
    fireEvent.keyDown(view.contentDOM, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('spaces-block-editor-picker-overlay')).toBeTruthy());
    fireEvent.mouseEnter(screen.getAllByTestId('spaces-block-editor-row')[1]);
    await waitFor(() => expect(screen.getByTestId('space-item-picker')).toBeTruthy());
    fireEvent.click(await screen.findByText('Issue abc123'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() => expect(sourceText(0)).toBe('See [issue:abc123]'));
    expect(backend.blocks.get('b2')?.markdown).toBe('Other block');
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect((backend.calls.find((c) => c.method === 'PATCH')!.body as { markdown: string }).markdown)
      .toBe('See [issue:abc123]');
  });
});

// --- component: independent managed authoring ----------------------------------------

describe('DocumentBlockEditor (managed authoring)', () => {
  it('keeps the managed document editable without reading legacy export authority', async () => {
    const backend = makeBackend(
      [makeBlock({ id: 'b1', sort_key: 'a', markdown: 'Managed body.' })],
      [makeExport({ authority: 'repo', status: 'repo_changed' })],
    );
    await renderEditor({ backend });
    expect(screen.getByTestId('spaces-block-editor').getAttribute('data-editable')).toBe('true');
    expect(backend.calls.some(call=>call.url.includes('/exports'))).toBe(false);
  });

  it('stays editable for a clean repo-authoritative document', async () => {
    const backend = makeBackend(
      [makeBlock({ id: 'b1', sort_key: 'a', markdown: 'x' })],
      [makeExport({ authority: 'repo', status: 'clean' })],
    );
    await renderEditor({ backend });
    expect(screen.getByTestId('spaces-block-editor').getAttribute('data-editable')).toBe('true');
    expect(screen.getByTestId('spaces-block-editor-list')).toBeTruthy();
    expect(screen.queryByTestId('spaces-block-editor-toolbar')).toBeNull();
  });
});

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

  it('delegates the decision to a host handler when one is provided, taking no action itself', async () => {
    const backend = makeBackend([
      makeBlock({
        id: 'b1',
        block_type: 'artifact_embed',
        sort_key: 'a',
        item_id: 'it1',
        item_snapshot: { item_id: 'it1', ref_type: 'artifact', ref_id: 'artifact:sha256:x', title: 'A' },
      }),
    ]);
    let captured: EmbedDeleteDecision | null = null;
    await renderEditor({
      backend,
      onEmbedDeleteDecision: (d) => {
        captured = d;
      },
    });

    fireEvent.click(screen.getByTestId('spaces-block-editor-delete-item'));
    // Host handler receives the decision; the editor surfaces nothing itself and
    // performs no destructive action.
    expect(captured).not.toBeNull();
    expect(captured!.itemId).toBe('it1');
    expect(captured!.embeddingBlocks.map((b) => b.id)).toEqual(['b1']);
    expect(screen.queryByTestId('spaces-block-editor-embed-delete')).toBeNull();
    expect(backend.calls.some((c) => /detach-blocks/.test(c.url))).toBe(false);
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
    expect(MockEventSource.instances.length).toBeGreaterThan(0);
    MockEventSource.instances[0].emit({ type: 'space:block:changed', data: { space_id: 'sp1' } });

    // The draft survives the refetch (Dataful-UX: reconcile never resets intent).
    await waitFor(() => {
      expect(sourceText()).toBe('work in progress');
    });
    expect(blockEditorStorageKey('prj1', 'sp1')).toBe('mandible.spaces.blockEditor:prj1:sp1');
  });
});


describe('document refresh reliability', () => {
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
    const stream = MockEventSource.instances[0];
    stream.emit({ type: 'space:block:changed', data: { space_id: 'other' } });
    await flushEffects();
    expect(blockReads).toBe(0);
    stream.emit({ type: 'space:block:changed', data: { space_id: 'sp1' } });
    await waitFor(() => expect(blockReads).toBe(1));
    stream.emit({ type: 'space:block:changed', data: { space_id: 'sp1' } });
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
    await screen.findByText('Autosave failed: write_rejected');
    expect(sourceText()).toBe('my retained draft');
    failReads = true;
    MockEventSource.instances[0].emit({ type: 'space:block:changed', data: { space_id: 'sp1' } });
    await screen.findByTestId('spaces-block-editor-error');
    expect(screen.getByText('my retained draft')).toBeTruthy();
    failReads = false;
    backend.blocks.delete('b1');
    MockEventSource.instances[0].emit({ type: 'space:block:changed', data: { space_id: 'sp1' } });
    await screen.findByRole('textbox', { name: 'Retained block draft' });
    expect((screen.getByRole('textbox', { name: 'Retained block draft' }) as HTMLTextAreaElement).value).toBe('my retained draft');
    fireEvent.click(screen.getByRole('button', { name: 'Restore as a new block' }));
    await waitFor(() => expect([...backend.blocks.values()].some((block) => block.markdown === 'my retained draft')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Retained block draft' })).toBeNull());
  });
});
