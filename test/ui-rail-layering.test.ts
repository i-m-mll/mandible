import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync('ui/src/style.css', 'utf8');
const rules = Array.from(stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({
  selectors: match[1].split(',').map((selector) => selector.trim()),
  body: match[2],
}));

function findRule(selector: string): string | undefined {
  return rules.find((rule) => rule.selectors.includes(selector))?.body;
}

describe('app rail layering styles', () => {
  it('does not cast an outer rail shadow over content when the view sidebar is hidden', () => {
    const hiddenSidebarRailRule = findRule('.app-layout:not(.app-layout--view-sidebar-open) .app-rail');

    expect(hiddenSidebarRailRule).toBeTruthy();
    expect(hiddenSidebarRailRule).toMatch(/box-shadow:\s*none/);
  });

  it('uses a separator, not a shadow overlay, for the hidden-sidebar bottom-panel rail edge', () => {
    const hiddenSidebarBottomPanelRule = findRule(
      '.app-layout--bottom-panel-open:not(.app-layout--view-sidebar-open)::before',
    );

    expect(hiddenSidebarBottomPanelRule).toBeTruthy();
    expect(hiddenSidebarBottomPanelRule).toMatch(/background:\s*var\(--border-muted\)/);
    expect(hiddenSidebarBottomPanelRule).toMatch(/box-shadow:\s*none/);
    expect(hiddenSidebarBottomPanelRule).not.toMatch(/box-shadow:\s*var\(--shadow-rail\)/);
  });
});
