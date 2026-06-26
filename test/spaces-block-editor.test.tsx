// Spaces document block editor tests (umbrella de56ffa, C14c / issue cef3eac).
//
// Covers the acceptance criteria:
//   - The editor reads/writes `space_blocks` via the C11 routes and renders the
//     live tree through the C14b renderer (create / edit prose / reorder /
//     delete / embed all hit the right routes).
//   - Custody-aware gating (C13d): a repo-authoritative + drifted document is
//     read-only/stale with re-import / fork affordances; Mandible-custody and
//     clean repo documents are freely editable.
//   - Embed-on-delete is a user-prompted decision point, NOT hardcoded: deleting
//     an embedded item raises an explicit choice and takes no destructive action
//     until the user resolves it.
//   - Standing AC #2 (UI-state-persistence): the in-progress edit draft persists
//     per-Space and survives SSE-reconciliation refetches without reset.

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import {
  DocumentBlockEditor,
  type EmbeddableItem,
  type EmbedDeleteDecision,
} from '../ui/src/views/spaces/DocumentBlockEditor';
import {
  generateSortKey,
  isValidSortKey,
  siblingsUnder,
  appendSortKey,
  prependSortKey,
  placementForIndex,
  siblingIndexOf,
  deriveDocumentCustody,
} from '../ui/src/views/spaces/blockEditorModel';
import {
  blockEditorStorageKey,
  readBlockEditorViewState,
  reconcileBlockEditorViewState,
  normalizeBlockEditorViewState,
} from '../ui/src/views/spaces/blockEditorViewState';
import {
  listSpaceBlocks,
  createSpaceBlock,
  updateSpaceBlock,
  deleteSpaceBlock,
  detachItemFromBlocks,
} from '../ui/src/views/spaces/spaceBlocksClient';
import type { SpaceBlock, SpaceExport } from '../ui/src/api';
import { __resetResourceRefRecognizers } from '../ui/src/resource-refs';

const NOW = 1_700_000_000_000;

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
    calls.push({ method, url, body });

    const blockColl = url.match(/\/api\/spaces\/sp1\/blocks(?:\?.*)?$/);
    const blockItem = url.match(/\/api\/spaces\/sp1\/blocks\/([^/?]+)$/);
    const detach = url.match(/\/api\/spaces\/sp1\/items\/([^/?]+)\/detach-blocks$/);
    const exportsRead = url.match(/\/api\/spaces\/sp1\/exports(?:\?.*)?$/);
    const spaceRead = url.match(/\/api\/spaces\/sp1(?:\?.*)?$/);

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
    return json({});
  });

  return { fetchImpl, calls, list, blocks };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
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

// --- pure model: custody derivation (C13a exports -> C13d custody) -----------

describe('deriveDocumentCustody', () => {
  it('returns null (Mandible custody) when there is no tracked export row', () => {
    expect(deriveDocumentCustody([])).toBeNull();
  });

  it('returns the repo-authority row as the binding custody', () => {
    const custody = deriveDocumentCustody([
      makeExport({ id: 'm', authority: 'mandible', status: 'clean' }),
      makeExport({ id: 'r', authority: 'repo', status: 'repo_changed' }),
    ]);
    expect(custody).toEqual({ authority: 'repo', status: 'repo_changed' });
  });

  it('prefers the most-recently-updated repo row when several exist', () => {
    const custody = deriveDocumentCustody([
      makeExport({ id: 'r1', authority: 'repo', status: 'clean', updated_at: NOW }),
      makeExport({ id: 'r2', authority: 'repo', status: 'conflict', updated_at: NOW + 5 }),
    ]);
    expect(custody).toEqual({ authority: 'repo', status: 'conflict' });
  });

  it('treats mandible-only rows as Mandible custody', () => {
    const custody = deriveDocumentCustody([
      makeExport({ authority: 'mandible', status: 'stale' }),
    ]);
    expect(custody).toEqual({ authority: 'mandible', status: 'stale' });
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

  it('drops drafts for blocks that no longer exist but preserves live ones', () => {
    const reconciled = reconcileBlockEditorViewState(
      { editingId: 'gone', drafts: { gone: 'x', here: 'keep' } },
      ['here'],
    );
    expect(reconciled).toEqual({ editingId: null, drafts: { here: 'keep' } });
  });
});

// --- client: routes hit the C11 surface --------------------------------------

describe('spaceBlocksClient', () => {
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
    const f = vi.fn(async () => json({ error: 'boom' }, 400));
    await expect(createSpaceBlock('sp1', { block_type: 'paragraph' }, f)).rejects.toThrow('boom');
  });
});

// --- component: editable Mandible-custody editor -----------------------------

async function renderEditor(props: Partial<Parameters<typeof DocumentBlockEditor>[0]> & {
  backend: ReturnType<typeof makeBackend>;
}) {
  const { backend, ...rest } = props;
  vi.stubGlobal('fetch', backend.fetchImpl);
  render(
    <DocumentBlockEditor
      projectId="prj1"
      spaceId="sp1"
      renderer="document"
      fetchImpl={backend.fetchImpl}
      {...rest}
    />,
  );
  await waitFor(() => expect(screen.getByTestId('spaces-block-editor-list')).toBeTruthy());
}

describe('DocumentBlockEditor (editable)', () => {
  it('renders the live tree as document-like editable rows', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: '# Title' }),
      makeBlock({ id: 'b2', sort_key: 'b', markdown: 'Body prose.' }),
    ]);
    await renderEditor({ backend });

    // The editable surface uses the same rendered prose path for blurred rows.
    expect(screen.getByText('Body prose.')).toBeTruthy();
    expect(screen.getAllByTestId('spaces-block-editor-row')).toHaveLength(2);
    expect(screen.queryByTestId('spaces-block-editor-toolbar')).toBeNull();
    expect(screen.getAllByTestId('spaces-block-editor-add-items').length).toBeGreaterThan(0);
    const editor = screen.getByTestId('spaces-block-editor');
    expect(editor.getAttribute('data-editable')).toBe('true');
    expect(editor.getAttribute('data-stale')).toBe('false');
  });

  it('creates a prose block via POST /api/spaces/:id/blocks', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'x' })]);
    await renderEditor({ backend });

    fireEvent.click(screen.getByTestId('spaces-block-editor-add-paragraph'));
    await waitFor(() =>
      expect(backend.calls.some((c) => c.method === 'POST' && /\/blocks$/.test(c.url))).toBe(true),
    );
    const post = backend.calls.find((c) => c.method === 'POST');
    expect((post!.body as { block_type: string }).block_type).toBe('paragraph');
    expect((post!.body as { sort_key: string }).sort_key > 'a').toBe(true);
  });

  it('edits a prose block and autosaves via PATCH on blur', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'old' })]);
    await renderEditor({ backend });

    fireEvent.click(screen.getByTestId('spaces-block-editor-edit'));
    const textarea = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'new text' } });
    fireEvent.blur(textarea);

    await waitFor(() =>
      expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(true),
    );
    const patch = backend.calls.find((c) => c.method === 'PATCH');
    expect((patch!.body as { markdown: string }).markdown).toBe('new text');
  });

  it('debounces autosave while a prose block is being edited', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'old' })]);
    await renderEditor({ backend });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId('spaces-block-editor-edit'));
      const textarea = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
      fireEvent.input(textarea, { target: { value: 'draft autosave' } });
      expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(false);

      await vi.advanceTimersByTimeAsync(700);
      await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(true));
      expect((backend.calls.find((c) => c.method === 'PATCH')!.body as { markdown: string }).markdown)
        .toBe('draft autosave');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reorders a block down via a PATCH that changes sort_key', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'first' }),
      makeBlock({ id: 'b2', sort_key: 'm', markdown: 'second' }),
    ]);
    await renderEditor({ backend });

    // The first row is b1; move it down past b2.
    const rows = screen.getAllByTestId('spaces-block-editor-row');
    const downBtn = rows[0].querySelector('[data-testid="spaces-block-editor-down"]')!;
    fireEvent.click(downBtn);

    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = backend.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/blocks/b1');
    expect((patch.body as { sort_key: string }).sort_key > 'm').toBe(true);
  });

  it('deletes a block via DELETE', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'x' })]);
    await renderEditor({ backend });

    fireEvent.click(screen.getByTestId('spaces-block-editor-delete'));
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(backend.calls.find((c) => c.method === 'DELETE')!.url).toContain('/blocks/b1');
  });

  it('embeds an item via POST with item_id + item_snapshot placeholder', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'x' })]);
    const items: EmbeddableItem[] = [
      { id: 'it1', ref_type: 'issue', ref_id: 'mandible://repo/issue/abc', title: 'An issue' },
    ];
    await renderEditor({ backend, embeddableItems: items });

    fireEvent.click(screen.getByTestId('spaces-block-editor-edit'));
    fireEvent.click(screen.getByTestId('spaces-block-editor-embed-it1'));
    await waitFor(() =>
      expect(backend.calls.some((c) => c.method === 'POST' && (c.body as { item_id?: string }).item_id === 'it1')).toBe(true),
    );
    const post = backend.calls.find((c) => c.method === 'POST' && (c.body as { item_id?: string }).item_id === 'it1')!;
    expect((post.body as { block_type: string }).block_type).toBe('issue_embed');
    expect((post.body as { item_snapshot: { item_id: string } }).item_snapshot.item_id).toBe('it1');
  });

  it('inserts a picked Space item as an inline bracket ref in the active block', async () => {
    const backend = makeBackend(
      [makeBlock({ id: 'b1', sort_key: 'a', markdown: 'See' })],
      [],
      [makeItem({ id: 'it1', ref_type: 'issue', ref_id: 'abc123', title: 'Issue abc123' })],
    );
    await renderEditor({ backend });

    fireEvent.click(screen.getByTestId('spaces-block-editor-edit'));
    const textarea = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    textarea.setSelectionRange(3, 3);
    fireEvent.click(screen.getByTestId('spaces-block-editor-add-items'));
    await waitFor(() => expect(screen.getByTestId('space-item-picker')).toBeTruthy());
    fireEvent.click(screen.getByText('Issue abc123'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() => expect(textarea.value).toBe('See [issue:abc123]'));
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect((backend.calls.find((c) => c.method === 'PATCH')!.body as { markdown: string }).markdown)
      .toBe('See [issue:abc123]');
  });
});

// --- component: custody gating (C13d) ----------------------------------------

describe('DocumentBlockEditor (custody gating)', () => {
  it('renders read-only/stale with re-import + fork affordances for a drifted repo doc', async () => {
    const backend = makeBackend(
      [makeBlock({ id: 'b1', sort_key: 'a', markdown: 'Repo body.' })],
      [makeExport({ authority: 'repo', status: 'repo_changed' })],
    );
    vi.stubGlobal('fetch', backend.fetchImpl);
    const onReimport = vi.fn();
    const onFork = vi.fn();
    render(
      <DocumentBlockEditor
        projectId="prj1"
        spaceId="sp1"
        renderer="document"
        fetchImpl={backend.fetchImpl}
        onReimport={onReimport}
        onFork={onFork}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('spaces-block-editor-stale-banner')).toBeTruthy());
    const editor = screen.getByTestId('spaces-block-editor');
    expect(editor.getAttribute('data-editable')).toBe('false');
    expect(editor.getAttribute('data-stale')).toBe('true');

    // Read path still renders the document.
    expect(screen.getByText('Repo body.')).toBeTruthy();
    // No editing affordances.
    expect(screen.queryByTestId('spaces-block-editor-toolbar')).toBeNull();
    expect(screen.queryByTestId('spaces-block-editor-list')).toBeNull();

    // Explicit reconciliation affordances fire their callbacks.
    fireEvent.click(screen.getByTestId('spaces-block-editor-affordance-reimport'));
    fireEvent.click(screen.getByTestId('spaces-block-editor-affordance-fork'));
    expect(onReimport).toHaveBeenCalledOnce();
    expect(onFork).toHaveBeenCalledOnce();
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

    fireEvent.click(screen.getByTestId('spaces-block-editor-edit'));
    const textarea = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'work in progress' } });

    // Persisted browser-local for this space.
    const stored = readBlockEditorViewState('prj1', 'sp1');
    expect(stored.drafts.b1).toBe('work in progress');
    expect(stored.editingId).toBe('b1');

    // A `space:*` SSE event triggers a reconciliation refetch.
    expect(MockEventSource.instances.length).toBeGreaterThan(0);
    MockEventSource.instances[0].emit({ type: 'space:block:changed', space_id: 'sp1' });

    // The draft survives the refetch (Dataful-UX: reconcile never resets intent).
    await waitFor(() => {
      const ta = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
      expect(ta.value).toBe('work in progress');
    });
    expect(blockEditorStorageKey('prj1', 'sp1')).toContain('sp1');
  });
});
