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

/**
 * Render Markdown with the UI's strictest existing sanitizer. DOMPurify is
 * intentionally used instead of the former regex allowlist so dangerous tags,
 * attributes, and URL schemes are handled consistently in every live view.
 */
export function renderMarkdown(source: string): string {
  if (!source) return '';
  return sanitizeHtml(parseMarkdown(source));
}

export function renderInlineMarkdown(source: string): string {
  if (!source) return '';
  const inline = parseMarkdown(source).replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1').trim();
  return sanitizeHtml(inline);
}
