import { afterEach, describe, expect, it, vi } from 'vitest';
import { marked } from 'marked';
import {
  __clearMarkdownRenderCache,
  renderInlineMarkdown,
  renderMarkdown,
} from '../../ui/src/lib/markdown';

afterEach(() => {
  __clearMarkdownRenderCache();
  vi.restoreAllMocks();
});

describe('markdown render cache', () => {
  it('returns identical output for cached and uncached calls', () => {
    const source = 'A **bold** [link](https://example.com) and `code`.';
    const first = renderMarkdown(source);
    __clearMarkdownRenderCache();
    const uncached = renderMarkdown(source);
    expect(first).toBe(uncached);
  });

  it('parses a repeated source only once for block rendering', () => {
    const source = '# Heading\n\nParagraph with _emphasis_.';
    const spy = vi.spyOn(marked, 'parse');
    const a = renderMarkdown(source);
    const b = renderMarkdown(source);
    const c = renderMarkdown(source);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('parses a repeated source only once for inline rendering', () => {
    const source = 'Inline **title** text';
    const spy = vi.spyOn(marked, 'parse');
    const a = renderInlineMarkdown(source);
    const b = renderInlineMarkdown(source);
    expect(b).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps block and inline caches separate for the same source', () => {
    const source = 'shared source line';
    const block = renderMarkdown(source);
    const inline = renderInlineMarkdown(source);
    // Block wraps in <p>...</p>; inline strips the single wrapping paragraph.
    expect(block).toContain('<p>');
    expect(inline).not.toContain('<p>');
    // Re-reading each cache returns its own stored value, not the other's.
    expect(renderMarkdown(source)).toBe(block);
    expect(renderInlineMarkdown(source)).toBe(inline);
  });

  it('does not cache empty input', () => {
    const spy = vi.spyOn(marked, 'parse');
    expect(renderMarkdown('')).toBe('');
    expect(renderInlineMarkdown('')).toBe('');
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-renders after eviction beyond the cache limit', () => {
    // Fill the cache past its 512-entry bound so an early key is evicted, then
    // confirm a re-render of that evicted key re-parses (correctness under LRU
    // eviction) and still yields the same output.
    const evictedSource = 'evicted-entry marker';
    const original = renderMarkdown(evictedSource);
    for (let i = 0; i < 600; i++) {
      renderMarkdown(`filler entry number ${i}`);
    }
    const spy = vi.spyOn(marked, 'parse');
    const again = renderMarkdown(evictedSource);
    expect(again).toBe(original);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps a recently-read entry warm across eviction pressure', () => {
    const hotSource = 'hot entry kept warm';
    renderMarkdown(hotSource);
    for (let i = 0; i < 600; i++) {
      renderMarkdown(`churn entry ${i}`);
      // Touch the hot entry regularly so its recency is refreshed.
      if (i % 50 === 0) renderMarkdown(hotSource);
    }
    const spy = vi.spyOn(marked, 'parse');
    renderMarkdown(hotSource);
    expect(spy).not.toHaveBeenCalled();
  });
});
