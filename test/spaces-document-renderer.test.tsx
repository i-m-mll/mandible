// @vitest-environment jsdom
import { render, screen, cleanup } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DocumentBody,
  renderDocumentText,
  renderSpaceBlocks,
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
});

// --- repo-authoritative document path (the artifacts.tsx:687 swap) -----------

describe('renderDocumentText (repo-authoritative doc path)', () => {
  it('does not reinterpret non-leading or unterminated fences as metadata', () => {
    const nonLeading = renderDocumentText('# Body\n\n---\ntitle: prose\n---\n');
    expect(nonLeading.html).not.toContain('markdown-frontmatter');
    const unterminated = renderDocumentText('---\ntitle: prose\n');
    expect(unterminated.html).not.toContain('markdown-frontmatter');
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
