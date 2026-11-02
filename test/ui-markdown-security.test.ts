// @vitest-environment jsdom
import { marked } from 'marked';
import { linkifyResourceRefs } from '../ui/src/resource-refs';
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

function mathDocument(source: string): HTMLDivElement {
  const element = document.createElement('div');
  element.innerHTML = renderMarkdown(source);
  return element;
}

describe('shared Markdown mathematics', () => {
  it('renders accessible equations without altering the provider lexer', () => {
    const source = String.raw`\[\boxed{A_\theta\ge\alpha(M-r).}\]`;
    const result = mathDocument(source);
    expect(result.querySelector('.katex-display math')).not.toBeNull();
    expect(result.querySelector('annotation')?.textContent).toBe(String.raw`\boxed{A_\theta\ge\alpha(M-r).}`);
    expect(result.querySelector('.katex-html')?.getAttribute('aria-hidden')).toBe('true');
    expect(marked.parse(source)).not.toContain('katex');
    const formulas = mathDocument(String.raw`Inline \(\frac{1}{2}\) and $x^2$ with $2 + 2 = 4$.

$$
\begin{aligned}a&=b\\c&=d\end{aligned}
$$

\[\begin{pmatrix}1&2\\3&4\end{pmatrix}\]`);
    expect(formulas.querySelectorAll('math')).toHaveLength(5);
    expect(formulas.querySelectorAll('.katex-error')).toHaveLength(0);
  });

  it('preserves code, currency, escapes, attributes and unfinished streams', () => {
    const source = 'Cost $5 and $10. `\\(x\\)` \\$x$ \\\\(x\\) [link](https://example.com/$x$) <span title="$x$">text</span>\n\n```tex\n$$x$$\n```\n\nUnfinished \\[x';
    const result = mathDocument(source);
    expect(result.querySelector('math')).toBeNull();
    expect(result.textContent).toContain('Cost $5 and $10.');
    expect(result.querySelector('code')?.textContent).toBe(String.raw`\(x\)`);
    expect(result.querySelector('a')?.getAttribute('href')).toBe('https://example.com/$x$');
    expect(result.querySelector('span')?.title).toBe('$x$');
    expect(result.textContent).toContain('Unfinished [x');
  });

  it('isolates authored macros and renders errors without losing surrounding prose', () => {
    const result = mathDocument(String.raw`Before \(\gdef\private{z}\private\) then \(\private\) after \(\frac{\) end.`);
    expect(result.querySelectorAll('math')).toHaveLength(2);
    expect(result.querySelector('.katex-error')).not.toBeNull();
    expect(result.textContent).toContain('Before');
    expect(result.textContent).toContain('end.');
    expect(result.textContent).toContain('\\private');
  });

  it('keeps math opaque to reference linkification and rejects executable content', () => {
    const result = document.createElement('div');
    result.innerHTML = linkifyResourceRefs(renderMarkdown(String.raw`\(\text{[issue:139c4b7]}\) [issue:139c4b7]

\[\href{javascript:alert(1)}{x}+\htmlClass{resource-ref}{y}+\includegraphics{https://example.com/x}\]
<img src="x" onerror="alert(1)"><script>alert(1)</script>`));
    expect(result.querySelector('.katex .resource-ref')).toBeNull();
    expect(result.querySelector('.katex annotation')?.textContent).toBe(String.raw`\text{[issue:139c4b7]}`);
    expect(result.querySelector('.resource-ref')).not.toBeNull();
    expect(result.querySelector('script, [onerror], a[href^="javascript:"], .katex img')).toBeNull();
  });
});
