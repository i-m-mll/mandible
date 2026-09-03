// Bug: e20c88e — Shared DOMPurify-based HTML sanitization for rendered Markdown
import DOMPurify from 'dompurify';

// Rendered Markdown is prose, never an executable form surface. Provider
// transcripts can contain XML-like envelopes whose field names overlap real
// HTML controls (for example <input>); forbid those controls centrally so raw
// transcript content cannot create interactive UI inside a message.
const PROSE_FORBIDDEN_TAGS = [
  'button',
  'fieldset',
  'form',
  'input',
  'label',
  'option',
  'select',
  'textarea',
];

/**
 * Sanitize HTML output from marked before use with dangerouslySetInnerHTML.
 * Uses DOMPurify for robust sanitization, replacing the previous regex-based approach.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS: PROSE_FORBIDDEN_TAGS });
}

/**
 * Render Markdown source to sanitized HTML using the global `marked` instance.
 * Callers must import `marked` themselves and pass the raw HTML here.
 */
export function sanitizeMarkdown(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, { FORBID_TAGS: PROSE_FORBIDDEN_TAGS });
}
