import type { MarkdownFrontmatter } from '../../../src/markdown-frontmatter';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Fixed, escaped presentation used by Artifact and Briefing Markdown views. */
export function renderMarkdownFrontmatter(frontmatter: MarkdownFrontmatter): string {
  const facts = frontmatter.entries
    .map(({ key, value }) => '<div class="markdown-frontmatter__fact">'
      + `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`
      + '</div>')
    .join('');
  return '<section class="markdown-frontmatter" aria-label="Document frontmatter">'
    + '<div class="markdown-frontmatter__label">Frontmatter</div>'
    + `<dl class="markdown-frontmatter__facts">${facts}</dl>`
    + '</section>';
}
