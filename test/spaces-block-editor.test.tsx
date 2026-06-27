// Spaces document block editor tests (umbrella de56ffa, C14c / issue cef3eac).
//
// Covers the acceptance criteria:
//   - The editor reads/writes `space_blocks` via the C11 routes and renders the
//     live tree through the C14b renderer. Authoring controls must stay
//     transparent: typed document commands and transient overlays, not persistent
//     block chrome.
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
import { act } from 'preact/test-utils';

import {
  DocumentBlockEditor,
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
import type { LedgerIssueDetailProjection, SpaceBlock, SpaceExport, SpaceItem } from '../ui/src/api';
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
    conflicts: [],
    sync: { state: 'clean', last_synced_at: null, message: null },
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
      />,
    );
    await waitFor(() => expect(rejectOldBlocks).toBeTruthy());

    rendered.rerender(
      <DocumentBlockEditor
        projectId="prj1"
        spaceId="sp2"
        renderer="document"
        fetchImpl={fetchImpl as unknown as typeof fetch}
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

  it('uses a selectable rendered document surface and preserves text selection', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'Selectable prose.' }),
    ]);
    await renderEditor({ backend });

    const surface = screen.getByTestId('spaces-block-editor-edit');
    expect(surface.tagName).toBe('DIV');
    expect(surface.getAttribute('role')).toBeNull();
    expect(surface.getAttribute('tabindex')).toBeNull();

    const prose = screen.getByText('Selectable prose.');
    const range = document.createRange();
    range.selectNodeContents(prose);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.click(prose);

    expect(screen.queryByTestId('spaces-block-editor-textarea')).toBeNull();
    expect(document.getSelection()?.toString()).toBe('Selectable prose.');
    selection?.removeAllRanges();
  });

  it('still enters paragraph edit mode from ordinary rendered prose clicks', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', sort_key: 'a', markdown: 'Editable prose.' }),
    ]);
    await renderEditor({ backend });

    fireEvent.click(screen.getByText('Editable prose.'));

    const textarea = await screen.findByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.value).toBe('Editable prose.');
  });

  it('renders headings as headings before the first edit and focuses on first click', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: '# Title' }),
    ]);
    await renderEditor({ backend });

    const heading = screen.getByRole('heading', { name: 'Title' });
    expect(heading).toBeTruthy();
    expect(heading.closest('[data-heading-hit-area="true"]')).toBeTruthy();
    fireEvent.click(heading);

    const textarea = await screen.findByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.value).toBe('# Title');
    expect(textarea.className).toBe('spaces-block-editor__textarea');
    expect(textarea.className).not.toContain('rendered');
    expect(textarea.selectionStart).toBe(2);
  });

  it('does not enter heading edit mode when only the rendered wrapper receives a click', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: '# Title' }),
    ]);
    await renderEditor({ backend });

    const surface = screen.getByTestId('spaces-block-editor-edit');
    const heading = screen.getByRole('heading', { name: 'Title' }) as HTMLElement;
    heading.getClientRects = () =>
      ({
        length: 1,
        item: (index: number) =>
          index === 0
            ? ({
                x: 0,
                y: 0,
                width: 120,
                height: 24,
                top: 0,
                right: 120,
                bottom: 24,
                left: 0,
                toJSON: () => ({}),
              } as DOMRect)
            : null,
        0: {
          x: 0,
          y: 0,
          width: 120,
          height: 24,
          top: 0,
          right: 120,
          bottom: 24,
          left: 0,
          toJSON: () => ({}),
        } as DOMRect,
      }) as DOMRectList;

    fireEvent.click(surface, { clientX: 16, clientY: 12 });

    expect(screen.queryByTestId('spaces-block-editor-textarea')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
  });

  it('enters edit mode for heading blocks whose markdown has no hash prefix', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: 'New heading' }),
    ]);
    await renderEditor({ backend });

    fireEvent.click(screen.getByText('New heading'));

    const textarea = await screen.findByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.value).toBe('New heading');
  });

  it('does not enter heading edit mode from adjacent rendered-block whitespace', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: '# Title' }),
    ]);
    await renderEditor({ backend });

    fireEvent.click(screen.getByTestId('spaces-block-editor-edit'), { clientX: 120, clientY: 12 });

    expect(screen.queryByTestId('spaces-block-editor-textarea')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
  });

  it('does not enter heading edit mode outside the rendered heading line box', async () => {
    const backend = makeBackend([
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: '# Title' }),
    ]);
    await renderEditor({ backend });

    const heading = screen.getByRole('heading', { name: 'Title' }) as HTMLElement;
    heading.getClientRects = () =>
      ({
        length: 1,
        item: (index: number) =>
          index === 0
            ? ({
                x: 0,
                y: 0,
                width: 80,
                height: 24,
                top: 0,
                right: 80,
                bottom: 24,
                left: 0,
                toJSON: () => ({}),
              } as DOMRect)
            : null,
        0: {
          x: 0,
          y: 0,
          width: 80,
          height: 24,
          top: 0,
          right: 80,
          bottom: 24,
          left: 0,
          toJSON: () => ({}),
        } as DOMRect,
      }) as DOMRectList;

    fireEvent.click(heading, { clientX: 12, clientY: 40 });

    expect(screen.queryByTestId('spaces-block-editor-textarea')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
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
      fireEvent.click(heading, { clientX: 48, clientY: 12 });
      const textarea = await screen.findByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
      await waitFor(() => expect(document.activeElement).toBe(textarea));
      expect(textarea.value).toBe('## Some heading');
      expect(textarea.selectionStart).toBe(8);
      expect(textarea.selectionStart).not.toBe(textarea.value.length);
    } finally {
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: priorCaretRangeFromPoint,
      });
    }
  });

  it('edits paragraph lines around a mixed Markdown heading as independent line regions', async () => {
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

    fireEvent.click(screen.getByText('intro'));
    let textarea = await screen.findByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.value).toBe('intro');
    fireEvent.blur(textarea);

    fireEvent.click(screen.getByText('body'));
    textarea = await screen.findByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.value).toBe('body');
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy();
  });

  it('maps a clicked rendered heading in a mixed block to the matching markdown line region', async () => {
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
      fireEvent.click(heading, { clientX: 48, clientY: 12 });
      const textarea = await screen.findByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
      await waitFor(() => expect(document.activeElement).toBe(textarea));
      expect(textarea.value).toBe('## Heading');
      expect(textarea.selectionStart).toBe('## He'.length);
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

    fireEvent.click(screen.getByTestId('spaces-block-editor-edit'));
    let textarea = await screen.findByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: '## Something' } });
    textarea = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(await screen.findByRole('heading', { name: 'Something' })).toBeTruthy();
    textarea = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.value).toBe('');

    for (const value of ['b', 'bo', 'bod', 'body']) {
      fireEvent.input(textarea, { target: { value } });
      textarea = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
      await waitFor(() => expect(document.activeElement).toBe(textarea));
      expect(textarea.value).toBe(value);
    }
    fireEvent.blur(textarea);

    await waitFor(() => expect(backend.blocks.get('b1')?.markdown).toBe('## Something\nbody'));
  });

  it('renders blank paragraph blocks as blank document content', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: '' })]);
    await renderEditor({ backend });

    expect(screen.queryByText('Write here…')).toBeNull();
    expect(screen.getByTestId('spaces-block-editor-edit').textContent).toBe('');
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

  it('creates the first prose block via POST /api/spaces/:id/blocks', async () => {
    const backend = makeBackend([]);
    vi.stubGlobal('fetch', backend.fetchImpl);
    render(
      <DocumentBlockEditor
        projectId="prj1"
        spaceId="sp1"
        renderer="document"
        fetchImpl={backend.fetchImpl}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('spaces-block-editor-empty-author')).toBeTruthy());
    fireEvent.click(screen.getByText('Start writing'));
    await waitFor(() =>
      expect(backend.calls.some((c) => c.method === 'POST' && /\/blocks$/.test(c.url))).toBe(true),
    );
    const post = backend.calls.find((c) => c.method === 'POST');
    expect((post!.body as { block_type: string }).block_type).toBe('paragraph');
    expect(typeof (post!.body as { sort_key: string }).sort_key).toBe('string');
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
    await waitFor(() => expect(screen.getByTestId('spaces-block-editor-save-state')).toBeTruthy());
    const saveState = screen.getByTestId('spaces-block-editor-save-state');
    expect(saveState.parentElement?.classList.contains('spaces-block-editor__viewport')).toBe(true);
    expect(saveState.closest('.spaces-block-editor__scroller')).toBeNull();
    expect(saveState.closest('.spaces-block-editor__list')).toBeNull();
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

  it('shows a transient selected-text formatting menu and wraps the selected Markdown', async () => {
    const backend = makeBackend([makeBlock({ id: 'b1', sort_key: 'a', markdown: 'Body text' })]);
    await renderEditor({ backend });

    fireEvent.click(screen.getByTestId('spaces-block-editor-edit'));
    const textarea = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 4);
    fireEvent.select(textarea);

    expect(screen.getByTestId('spaces-block-editor-selection-menu')).toBeTruthy();
    fireEvent.mouseDown(screen.getByLabelText('Bold'));
    await waitFor(() => expect(textarea.value).toBe('**Body** text'));
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

    fireEvent.click(screen.getAllByTestId('spaces-block-editor-edit')[0]);
    const textarea = screen.getByTestId('spaces-block-editor-textarea') as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('spaces-block-editor-picker-overlay')).toBeTruthy());
    fireEvent.mouseEnter(screen.getAllByTestId('spaces-block-editor-row')[1]);
    await waitFor(() => expect(screen.getByTestId('space-item-picker')).toBeTruthy());
    fireEvent.click(screen.getByText('Issue abc123'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() => expect(textarea.value).toBe('See [issue:abc123]'));
    expect(backend.blocks.get('b2')?.markdown).toBe('Other block');
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
