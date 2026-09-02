// Read-only document renderer tests (umbrella de56ffa, C14b / issue 591e568).
//
// Covers the acceptance criteria:
//   - Renders a `space_blocks` document (read-only) with embeds + prose through
//     the C14a pipeline.
//   - The repo-authoritative Markdown / `spaces-doc.v1` document path renders
//     directly (the `artifacts.tsx:687` swap consumes `renderDocumentText`).
//   - Refs (markdown links + directive nodes) render through the shared C6
//     parser + C12 grammar; unresolved refs show placeholders.
//   - SECURITY (standing AC #2): a document directive cannot execute script —
//     no `<script>`, no inline event handlers, no `javascript:` hrefs survive,
//     and the renderer never produces an executable surface.
//   - UI-state-persistence (standing AC #2): heading collapse state persists
//     per-Space and survives SSE reconciliation refetches without reset.

import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSharedSseForTests } from '../../ui/src/sse-shared';
import { h } from 'preact';

import {
  DocumentRenderer,
  DocumentBody,
  renderDocumentText,
  renderSpaceBlocks,
  blocksToDocTree,
} from '../../ui/src/views/spaces/DocumentRenderer';
import {
  documentStorageKey,
  normalizeDocumentViewState,
} from '../../ui/src/views/spaces/documentViewState';
import type { SpaceBlock } from '../../ui/src/api';
import { __resetResourceRefRecognizers } from '../../ui/src/resource-refs';

const NOW = 1_700_000_000_000;
const HASH64 = 'a'.repeat(64);

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

/** Stub fetch over the read-only `GET /api/spaces/:id/blocks` + resolver. */
function stubFetch(getBlocks: () => SpaceBlock[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/api\/spaces\/sp1\/blocks(\?|$)/.test(url)) {
      return new Response(JSON.stringify({ blocks: getBlocks() }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/spaces/resolve')) {
      return new Response(
        JSON.stringify({ resolution: { ref: 'x', kind: 'artifact', resolved: false, entity: null } }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
}

beforeEach(() => {
  stubLocalStorage();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  __resetSharedSseForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetResourceRefRecognizers();
});

// --- pure render path: space_blocks -> document ------------------------------

describe('renderSpaceBlocks (C12 + C14a)', () => {
  it('renders a block tree (heading + paragraph) with sanitized prose', () => {
    const blocks: SpaceBlock[] = [
      makeBlock({ id: 'b1', block_type: 'heading', sort_key: 'a', markdown: '# Title' }),
      makeBlock({ id: 'b2', parent_id: 'b1', block_type: 'paragraph', sort_key: 'b', markdown: 'Body prose.' }),
    ];
    const doc = renderSpaceBlocks(blocks, 'sp1');
    expect(doc.blocks.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(doc.blocks[0].html).toContain('<h1');
    expect(doc.blocks[1].html).toContain('Body prose.');
  });

  it('maps blocks to a C12 DocTree without re-deriving the grammar', () => {
    const tree = blocksToDocTree(
      [makeBlock({ id: 'b1', block_type: 'heading', markdown: '# H' })],
      { space_id: 'sp1' },
    );
    expect(tree.frontmatter.space_id).toBe('sp1');
    expect(tree.blocks[0]).toMatchObject({ id: 'b1', block_type: 'heading', markdown: '# H' });
  });
});

describe('DocumentBody render', () => {
  it('renders a space_blocks document with prose and an embed block', () => {
    const blocks: SpaceBlock[] = [
      makeBlock({ id: 'b1', block_type: 'paragraph', sort_key: 'a', markdown: 'Intro prose.' }),
      makeBlock({
        id: 'b2',
        block_type: 'artifact_embed',
        sort_key: 'b',
        item_id: 'item-1',
        item_snapshot: { item_id: 'item-1', ref_type: 'artifact', ref_id: `artifact:sha256:${HASH64}`, title: 'My Artifact' },
      }),
    ];
    const doc = renderSpaceBlocks(blocks, 'sp1');
    const sources = new Map(blocks.map((b) => [b.id, b]));
    render(<DocumentBody document={doc} sources={sources} />);

    expect(screen.getByTestId('spaces-document')).toBeTruthy();
    expect(screen.getByText('Intro prose.')).toBeTruthy();
    const embed = screen.getByTestId('spaces-doc-embed');
    expect(embed.getAttribute('data-block-type')).toBe('artifact_embed');
    expect(within(embed).getByText('My Artifact')).toBeTruthy();
  });

  it('renders a directive ref as a quiet unresolved placeholder link', () => {
    const blocks: SpaceBlock[] = [
      makeBlock({
        id: 'b1',
        block_type: 'paragraph',
        markdown: `See :ref[the spec]{href="artifact:sha256:${HASH64}"} here.`,
      }),
    ];
    const doc = renderSpaceBlocks(blocks, 'sp1');
    expect(doc.refs.length).toBeGreaterThan(0);
    render(<DocumentBody document={doc} sources={new Map(blocks.map((b) => [b.id, b]))} />);
    const ref = screen.getAllByTestId('spaces-doc-ref')[0];
    expect(ref.getAttribute('data-state')).toBe('unresolved');
    expect(within(ref).queryByText('resolve')).toBeNull();
    expect(within(ref).getByText('the spec')).toBeTruthy();
  });
});

// --- repo-authoritative document path (the artifacts.tsx:687 swap) -----------

describe('renderDocumentText (repo-authoritative doc path)', () => {
  it('renders plain Markdown directly as one sanitized prose body (no blocks)', () => {
    const doc = renderDocumentText('# Plain Doc\n\nHello world.');
    expect(doc.blocks.length).toBe(0);
    expect(doc.html).toContain('<h1');
    expect(doc.html).toContain('Hello world.');
    expect(doc.isSpacesDoc).toBe(false);
  });

  it('renders complete leading frontmatter as compact metadata without swallowing later rules', () => {
    const doc = renderDocumentText('---\ntitle: Repo Doc\ntags:\n  - safe\n---\n\n# Body\n\n---\n\nAfter.');
    render(<DocumentBody document={doc} />);

    const metadata = screen.getByLabelText('Document frontmatter');
    expect(within(metadata).getByText('Frontmatter')).toBeTruthy();
    expect(within(metadata).getByText('title').tagName).toBe('DT');
    expect(within(metadata).getByText('Repo Doc').tagName).toBe('DD');
    expect(within(metadata).getByText('tags').tagName).toBe('DT');
    expect(within(metadata).getByText('safe').tagName).toBe('DD');
    expect(metadata.querySelector('pre, code')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Body' })).toBeTruthy();
    expect(screen.getByText('After.')).toBeTruthy();
  });

  it('does not reinterpret non-leading or unterminated fences as metadata', () => {
    const nonLeading = renderDocumentText('# Body\n\n---\ntitle: prose\n---\n');
    expect(nonLeading.html).not.toContain('markdown-frontmatter');
    const unterminated = renderDocumentText('---\ntitle: prose\n');
    expect(unterminated.html).not.toContain('markdown-frontmatter');
  });

  it('renders spaces-doc.v1 text directly with block identity and the format marker', () => {
    const text = [
      '---',
      'mandible_format: spaces-doc.v1',
      '---',
      '',
      ':::block{id="b1" parent="root" sort="a" type="heading"}',
      '# Repo Doc',
      ':::',
      '',
    ].join('\n');
    const doc = renderDocumentText(text);
    expect(doc.isSpacesDoc).toBe(true);
    expect(doc.blocks.map((b) => b.id)).toEqual(['b1']);
  });

  it('linkifies a markdown-link resource ref in prose into a placeholder anchor', () => {
    // A markdown link whose visible text IS the ref. DOMPurify strips the
    // custom `artifact:` scheme href during sanitization, so C6's
    // linkifyResourceRefs recovers the ref from the anchor TEXT and rewrites it
    // to the internal `#/artifacts?ref=` placeholder href.
    const doc = renderDocumentText(`[artifact:sha256:${HASH64}](artifact:sha256:${HASH64})`);
    render(<DocumentBody document={doc} />);
    const anchors = screen.getAllByRole('link');
    expect(anchors.some((a) => (a.getAttribute('href') ?? '').includes('#/artifacts?ref='))).toBe(true);
  });

  it('linkifies a bracketed resource ref in prose into a placeholder anchor', () => {
    // C6's `[artifact:…]` bracket form is recognized in prose text directly.
    const doc = renderDocumentText(`See [artifact:sha256:${HASH64}] for details.`);
    render(<DocumentBody document={doc} />);
    const anchors = screen.getAllByRole('link');
    expect(anchors.some((a) => (a.getAttribute('href') ?? '').includes('#/artifacts?ref='))).toBe(true);
  });
});

// --- SECURITY: a document directive cannot execute script --------------------

describe('renderer security (standing AC #2)', () => {
  it('strips script, event handlers, and javascript: hrefs from document content', () => {
    const blocks: SpaceBlock[] = [
      makeBlock({
        id: 'b1',
        block_type: 'paragraph',
        markdown:
          'Inline <script>alert(1)</script> and ' +
          ':ref[x]{href="javascript:alert(1)"} and <img src=x onerror=alert(1)>.',
      }),
    ];
    const doc = renderSpaceBlocks(blocks, 'sp1');
    const html = doc.html.toLowerCase();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('javascript:');

    // The hostile directive is surfaced as an inert `unknown` ref, never an
    // executable component.
    const jsRef = doc.refs.find((r) => r.canonical === 'javascript:alert(1)');
    expect(jsRef?.kind).toBe('unknown');
  });

  it('produces no executable surface in the mounted DOM', () => {
    const blocks: SpaceBlock[] = [
      makeBlock({
        id: 'b1',
        block_type: 'paragraph',
        markdown: '<script>window.__pwned = true;</script>\n\n[x](javascript:alert(1))',
      }),
    ];
    const doc = renderSpaceBlocks(blocks, 'sp1');
    render(<DocumentBody document={doc} sources={new Map(blocks.map((b) => [b.id, b]))} />);
    const root = screen.getByTestId('spaces-document');
    expect(root.querySelector('script')).toBeNull();
    expect(root.innerHTML.toLowerCase()).not.toContain('javascript:');
    expect((window as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

// --- mounted renderer: fetch, SSE reconcile, collapse persistence ------------

describe('DocumentRenderer (mounted, read-only)', () => {
  it('fetches and renders the space_blocks document read-only', async () => {
    const blocks = [makeBlock({ id: 'b1', block_type: 'paragraph', markdown: 'Hello document.' })];
    const fetchImpl = stubFetch(() => blocks) as unknown as typeof fetch;
    render(<DocumentRenderer projectId="prj1" spaceId="sp1" renderer="document" fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByText('Hello document.')).toBeTruthy());
    expect(screen.getByTestId('spaces-document-renderer')).toBeTruthy();
  });

  it('persists heading collapse state per-Space and preserves it across an SSE reconcile', async () => {
    const blocks: SpaceBlock[] = [
      makeBlock({ id: 'h1', block_type: 'heading', sort_key: 'a', markdown: '# Section' }),
      makeBlock({ id: 'p1', parent_id: 'h1', block_type: 'paragraph', sort_key: 'b', markdown: 'Child prose.' }),
    ];
    const fetchImpl = stubFetch(() => blocks) as unknown as typeof fetch;
    render(<DocumentRenderer projectId="prj1" spaceId="sp1" renderer="document" fetchImpl={fetchImpl} />);

    await waitFor(() => expect(screen.getByText('Child prose.')).toBeTruthy());

    // Collapse the heading sub-tree.
    fireEvent.click(screen.getByTestId('spaces-doc-block-toggle'));
    await waitFor(() => expect(screen.queryByText('Child prose.')).toBeNull());

    // The collapse is persisted to per-Space browser-local storage.
    const persisted = normalizeDocumentViewState(JSON.parse(
      window.localStorage.getItem(documentStorageKey('prj1', 'sp1'))!,
    ));
    expect(persisted.collapsed.h1).toBe(true);
    expect(documentStorageKey('prj1', 'sp1')).toBe('mandible.spaces.document:prj1:sp1');
    expect(window.localStorage.getItem(documentStorageKey('prj1', 'sp1'))).toBeTruthy();

    // An SSE reconcile refetches blocks but MUST NOT reset the collapse state.
    MockEventSource.instances[0].emit({ type: 'space:blocks:changed', space_id: 'sp1' });
    await waitFor(() => expect(screen.getByTestId('spaces-doc-block-toggle')).toBeTruthy());
    expect(screen.queryByText('Child prose.')).toBeNull();
    expect(normalizeDocumentViewState(JSON.parse(
      window.localStorage.getItem(documentStorageKey('prj1', 'sp1'))!,
    )).collapsed.h1).toBe(true);
  });

  it('shows a select-a-space prompt when no Space is open', () => {
    render(<DocumentRenderer projectId="prj1" spaceId={null} renderer="document" />);
    expect(screen.getByText('Select a Space to view its document.')).toBeTruthy();
  });
});
