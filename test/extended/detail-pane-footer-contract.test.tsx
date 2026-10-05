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
    expect(slots).toEqual(['header', 'notice', 'body', 'footer', 'overlay-host']);
    expect(shell?.querySelectorAll(':scope > .detail-pane-shell__footer')).toHaveLength(1);
    expect(shell?.querySelector(':scope > .detail-pane-shell__footer')?.getAttribute('aria-label'))
      .toBe('Selection actions');
    expect(shell?.querySelector(':scope > .detail-pane-shell__footer')?.textContent)
      .toContain('PrimarySelection status');

    rerender(<DetailPaneShell header={<span>Header</span>}>Scrollable body</DetailPaneShell>);
    expect(container.querySelector('.detail-pane-shell__footer')).toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8');
  });

});
