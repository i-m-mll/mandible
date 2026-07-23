import { marked } from 'marked';

import { sanitizeHtml } from '../sanitize';

// The UI previously configured the shared marked singleton from individual
// views. Keep the most complete existing synchronous GFM configuration here so
// every consumer renders deterministically regardless of module load order.
marked.setOptions({ async: false, gfm: true, breaks: false });

function parseMarkdown(source: string): string {
  try {
    const parsed = marked.parse(source, { async: false });
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return source;
  }
}

// renderMarkdown / renderInlineMarkdown run marked.parse + DOMPurify on every
// call. In the issues list, auth cards, and inbox these are invoked per row on
// every render, and every SSE event re-renders the mounted tabs, so the same
// title/body strings are re-parsed and re-sanitized constantly. A bounded
// insertion-order LRU keyed on the source string collapses those repeats to a
// map lookup. This is the measured, low-risk win; broad view-boundary memo is
// deliberately deferred to profiling (blanket memo churn can cost more than it
// saves).
const MARKDOWN_CACHE_LIMIT = 512;

class MarkdownRenderCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly limit: number) {}

  get(key: string): string | undefined {
    const cached = this.entries.get(key);
    if (cached === undefined) return undefined;
    // Refresh recency: re-insert so this key becomes most-recently used.
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached;
  }

  set(key: string, value: string): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      // Map preserves insertion order; the first key is least-recently used.
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const blockCache = new MarkdownRenderCache(MARKDOWN_CACHE_LIMIT);
const inlineCache = new MarkdownRenderCache(MARKDOWN_CACHE_LIMIT);

/**
 * Render Markdown with the UI's strictest existing sanitizer. DOMPurify is
 * intentionally used instead of the former regex allowlist so dangerous tags,
 * attributes, and URL schemes are handled consistently in every live view.
 */
export function renderMarkdown(source: string): string {
  if (!source) return '';
  const cached = blockCache.get(source);
  if (cached !== undefined) return cached;
  const html = sanitizeHtml(parseMarkdown(source));
  blockCache.set(source, html);
  return html;
}

export function renderInlineMarkdown(source: string): string {
  if (!source) return '';
  const cached = inlineCache.get(source);
  if (cached !== undefined) return cached;
  const inline = parseMarkdown(source).replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1').trim();
  const html = sanitizeHtml(inline);
  inlineCache.set(source, html);
  return html;
}

/**
 * Clear the render caches. Exposed for tests and for any future consumer that
 * needs to force re-rendering (e.g. if the sanitizer configuration changes at
 * runtime). Not used on the normal render path.
 */
export function __clearMarkdownRenderCache(): void {
  blockCache.clear();
  inlineCache.clear();
}
