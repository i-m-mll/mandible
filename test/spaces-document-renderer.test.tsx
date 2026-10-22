import { render, screen, cleanup, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import {
  DocumentBody,
  renderDocumentText,
  renderSpaceBlocks,
  blocksToDocTree,
} from '../ui/src/views/spaces/DocumentRenderer';
import type { SpaceBlock } from '../ui/src/api';
import { __resetResourceRefRecognizers } from '../ui/src/resource-refs';

const NOW = 1_700_000_000_000;
const HASH64 = 'a'.repeat(64);

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

  it('retains controlled heading collapse when document data is reconciled', () => {
    const blocks = [
      makeBlock({ id: 'heading', block_type: 'heading', sort_key: 'a', markdown: '# Section' }),
      makeBlock({ id: 'child', parent_id: 'heading', sort_key: 'b', markdown: 'Child prose' }),
    ];
    const view = render(<DocumentBody document={renderSpaceBlocks(blocks, 'sp1')} collapsed={{ heading: true }} />);
    expect(screen.queryByText('Child prose')).toBeNull();
    view.rerender(<DocumentBody document={renderSpaceBlocks([
      ...blocks, makeBlock({ id: 'new-child', parent_id: 'heading', sort_key: 'c', markdown: 'New child prose' }),
    ], 'sp1')} collapsed={{ heading: true }} />);
    expect(screen.queryByText('Child prose')).toBeNull();
    expect(screen.queryByText('New child prose')).toBeNull();
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
