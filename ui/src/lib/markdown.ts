import { Marked, type TokenizerAndRendererExtension } from 'marked';
import katex from 'katex';

import { sanitizeHtml } from '../sanitize';

type MathToken = { type: string; raw: string; text: string; display: boolean };
const delimiters = [
  { open: '\\[', close: '\\]', display: true },
  { open: '$$', close: '$$', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false },
];

function escaped(source: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && source[--index] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

function mathToken(source: string, block: boolean): MathToken | undefined {
  for (const { open, close, display } of delimiters) {
    if ((block && !display) || !source.startsWith(open)) continue;
    if (open === '$' && (source[1] === '$' || /\s/.test(source[1] ?? '') || /^\$\d[\d,.]*[.,;:!?](?=\s|$)/.test(source))) continue;
    let end = open.length;
    while ((end = source.indexOf(close, end)) !== -1) {
      if (escaped(source, end)) { end += close.length; continue; }
      const text = source.slice(open.length, end);
      if (open === '$' && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] ?? '') || text.includes('\n'))) return;
      if (!text.trim()) return;
      return { type: block ? 'blockMath' : 'inlineMath', raw: source.slice(0, end + close.length), text, display };
    }
  }
}

function mathExtension(block: boolean): TokenizerAndRendererExtension {
  return {
    name: block ? 'blockMath' : 'inlineMath',
    level: block ? 'block' : 'inline',
    start(source) {
      const openings = block ? /^(?:\\\[|\$\$)/gm : /\\(?:\(|\[)|\$/g;
      for (const match of source.matchAll(openings)) {
        if (!escaped(source, match.index) && mathToken(source.slice(match.index), block)) return match.index;
      }
    },
    tokenizer(source) { return mathToken(source, block); },
    renderer(token) {
      const math = token as MathToken;
      return katex.renderToString(math.text, {
        displayMode: math.display,
        output: 'htmlAndMathml',
        throwOnError: false,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 100,
        macros: {},
      }) + (block ? '\n' : '');
    },
  };
}

// Provider directives use Marked's global lexer; UI syntax must stay local.
const marked = new Marked({ async: false, gfm: true, breaks: false, extensions: [mathExtension(true), mathExtension(false)] });

function parseMarkdown(source: string): string {
  try {
    const parsed = marked.parse(source, { async: false });
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return source;
  }
}

// renderMarkdown / renderInlineMarkdown run marked.parse + DOMPurify on every
// call. In the issues list and auth cards these are invoked per row on
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
