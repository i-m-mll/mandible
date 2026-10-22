import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DiffView,
  parseUnifiedDiffSections,
  renderUnifiedDiffFallbackHtml,
} from '../ui/src/components/DiffView';

const sampleDiff = [
  'diff --git a/src/one.ts b/src/one.ts',
  'index 1111111..2222222 100644',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -1,2 +1,2 @@',
  ' old line',
  '-removed line',
  '+added line',
  'diff --git a/src/two.ts b/src/two.ts',
  'index 3333333..4444444 100644',
  '--- a/src/two.ts',
  '+++ b/src/two.ts',
  '@@ -1 +1 @@',
  '-before',
  '+after',
].join('\n');

afterEach(() => {
  cleanup();
});

describe('DiffView', () => {
  it('parses unified diff text into file sections', () => {
    const sections = parseUnifiedDiffSections(sampleDiff);

    expect(sections).toHaveLength(2);
    expect(sections[0].filename).toBe('src/one.ts');
    expect(sections[0].hunks).toContain('@@ -1,2 +1,2 @@');
    expect(sections[0].hunks).toContain('+added line');
    expect(sections[0].hunks).not.toContain('diff --git');
    expect(sections[1].filename).toBe('src/two.ts');
  });

  it('renders an escaped plain pre fallback', () => {
    const html = renderUnifiedDiffFallbackHtml('@@ -1 +1 @@\n-<old>\n+<new>');

    expect(html).toContain('<pre class="diff-content">');
    expect(html).toContain('<span class="diff-hunk">@@ -1 +1 @@</span>');
    expect(html).toContain('<span class="diff-del">-&lt;old&gt;</span>');
    expect(html).toContain('<span class="diff-add">+&lt;new&gt;</span>');
    expect(html).not.toContain('<old>');
  });

  it('renders collapsible file sections and switches layout modes', () => {
    render(<DiffView diffText={sampleDiff} ariaLabel="Shared diff" />);

    const diffRegion = screen.getByLabelText('Shared diff');
    expect(diffRegion.getAttribute('data-diff-mode')).toBe('split');
    expect(screen.getByRole('group', { name: 'Diff layout' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');
    expect(diffRegion.querySelector('.d2h-files-diff')).toBeTruthy();
    const firstFile = screen.getByRole('button', { name: /src\/one\.ts/ });
    expect(firstFile).toBeTruthy();
    expect(screen.getByRole('button', { name: /src\/two\.ts/ })).toBeTruthy();

    fireEvent.click(firstFile);
    expect(firstFile.getAttribute('aria-expanded')).toBe('false');
    expect(diffRegion.textContent).not.toContain('added line');

    fireEvent.click(screen.getByRole('button', { name: 'Unified' }));
    expect(diffRegion.getAttribute('data-diff-mode')).toBe('unified');
    expect(screen.getByRole('button', { name: 'Unified' }).getAttribute('aria-pressed')).toBe('true');
    expect(diffRegion.querySelector('.d2h-file-diff')).toBeTruthy();
  });
});
