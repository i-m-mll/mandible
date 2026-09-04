import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { DetailPaneShell } from '../../ui/src/components/shared/DetailPaneShell';

describe('anchored detail pane footer contract', () => {
  it('renders one optional outer footer after the scroll-owned body for one or more content pieces', () => {
    const { container, rerender } = render(
      <DetailPaneShell
        header={<span>Header</span>}
        footer={{
          ariaLabel: 'Selection actions',
          content: (
            <>
              <button type="button">Primary</button>
              <span>Selection status</span>
            </>
          ),
        }}
      >
        <div>Scrollable body</div>
      </DetailPaneShell>,
    );

    const shell = container.querySelector('.detail-pane-shell');
    const slots = Array.from(shell?.children ?? [])
      .map((element) => element.getAttribute('data-detail-pane-slot'));
    expect(slots).toEqual(['header', 'body', 'footer', 'overlay-host']);
    expect(shell?.querySelectorAll(':scope > .detail-pane-shell__footer')).toHaveLength(1);
    expect(shell?.querySelector(':scope > .detail-pane-shell__footer')?.getAttribute('aria-label'))
      .toBe('Selection actions');
    expect(shell?.querySelector(':scope > .detail-pane-shell__footer')?.textContent)
      .toContain('PrimarySelection status');

    rerender(<DetailPaneShell header={<span>Header</span>}>Scrollable body</DetailPaneShell>);
    expect(container.querySelector('.detail-pane-shell__footer')).toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8');
    expect(css).toMatch(/\.detail-pane-shell__body\s*\{[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;/s);
    expect(css).toMatch(/\.detail-pane-shell__footer\s*\{[^}]*flex:\s*none;/s);
  });

  it('keeps an explicit inventory of every current DetailPaneShell footer consumer', () => {
    const sourceRoot = resolve(process.cwd(), 'ui/src');
    const consumers = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        return Array.from(source.matchAll(/<DetailPaneShell\b[\s\S]*?<\/DetailPaneShell>/g))
          .some((match) => /\bfooter=\{/.test(match[0]));
      })
      .map((path) => path.slice(process.cwd().length + 1))
      .sort();

    expect(consumers).toEqual([
      'ui/src/views/feedback/BriefingDocumentRenderer.tsx',
    ]);
    for (const path of consumers) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      const shell = Array.from(source.matchAll(/<DetailPaneShell\b[\s\S]*?<\/DetailPaneShell>/g))
        .find((match) => /\bfooter=\{/.test(match[0]))?.[0] ?? '';
      expect(shell, path).toMatch(/footer=\{[\s\S]*?\?\s*\{[\s\S]*?content:/);
    }
  });
});
