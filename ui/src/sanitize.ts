// Bug: e20c88e — Shared DOMPurify-based HTML sanitization for rendered Markdown
import DOMPurify from 'dompurify';

/**
 * Sanitize HTML output from marked before use with dangerouslySetInnerHTML.
 * Uses DOMPurify for robust sanitization, replacing the previous regex-based approach.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}

/**
 * Render Markdown source to sanitized HTML using the global `marked` instance.
 * Callers must import `marked` themselves and pass the raw HTML here.
 */
export function sanitizeMarkdown(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml);
}
