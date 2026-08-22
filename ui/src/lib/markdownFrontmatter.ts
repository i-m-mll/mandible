export type MarkdownFrontmatter = {
  start: number;
  end: number;
  raw: string;
  body: string;
};

/**
 * Find one complete YAML frontmatter block at the start of a Markdown source.
 * A later thematic rule and an unterminated opening fence remain ordinary
 * Markdown. Offsets are UTF-16 source offsets, matching DOM selection and the
 * Briefing annotation contract.
 */
export function leadingMarkdownFrontmatter(source: string): MarkdownFrontmatter | null {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n)/.exec(source);
  if (!opening) return null;
  const fence = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  fence.lastIndex = opening[0].length;
  const closing = fence.exec(source);
  if (!closing) return null;
  const end = closing.index + closing[0].length;
  return {
    start: 0,
    end,
    raw: source.slice(0, end),
    body: source.slice(opening[0].length, closing.index),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Fixed, escaped presentation used by Artifact and Briefing Markdown views. */
export function renderMarkdownFrontmatter(frontmatter: MarkdownFrontmatter): string {
  return '<section class="markdown-frontmatter" aria-label="Document metadata">'
    + '<div class="markdown-frontmatter__label">Metadata</div>'
    + `<pre class="markdown-frontmatter__source"><code>${escapeHtml(frontmatter.body.replace(/\r?\n$/, ''))}</code></pre>`
    + '</section>';
}
