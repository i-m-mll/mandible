// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderInlineMarkdown, renderMarkdown } from '../ui/src/lib/markdown';
import { renderUnifiedDiffFallbackHtml } from '../ui/src/components/DiffView';

describe('shared UI Markdown rendering', () => {
  it('renders block and inline Markdown', () => {
    expect(renderMarkdown('**strong**')).toContain('<strong>strong</strong>');
    expect(renderInlineMarkdown('**strong**')).toBe('<strong>strong</strong>');
  });

  it('uses DOMPurify for dangerous tags, attributes, and URL schemes', () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)"><script>alert(1)</script>[x](javascript:alert(1))');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });

  it('never renders transcript form controls inside prose', () => {
    const html = renderMarkdown('<codex_delegation><input>Proceed with the repair.</input></codex_delegation>');
    expect(html).not.toContain('<input');
    expect(html).toContain('Proceed with the repair.');
  });

  it('escapes diff text in the plain fallback', () => {
    const html = renderUnifiedDiffFallbackHtml('@@ -1 +1 @@\n-<old>\n+<img src=x onerror="alert(1)">');
    expect(html).toContain('-&lt;old&gt;');
    expect(html).not.toContain('<old>');
    expect(html).not.toContain('<img');
  });
});
