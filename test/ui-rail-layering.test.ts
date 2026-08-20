import { describe, expect, it } from 'vitest';

import { readResolvedStylesheet } from './helpers/css-manifest';

const stylesheet = readResolvedStylesheet();
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

  it('does not add a duplicate bottom-panel divider beside the app subdivision', () => {
    const hiddenSidebarBottomPanelRule = findRule(
      '.app-layout--bottom-panel-open:not(.app-layout--view-sidebar-open)::before',
    );

    expect(hiddenSidebarBottomPanelRule).toBeUndefined();
  });

  it('keeps shared content and Spaces sidebar chrome free of competing shadows', () => {
    const sharedContentTopRule = findRule('.app-content::before');
    const spacesSidebarRule = findRule('.app-layout--view-sidebar-open .view-sidebar.spaces-tree');

    expect(sharedContentTopRule).toBeTruthy();
    expect(sharedContentTopRule).toMatch(/content:\s*none/);
    expect(sharedContentTopRule).not.toMatch(/box-shadow:/);
    expect(spacesSidebarRule).toBeTruthy();
    expect(spacesSidebarRule).toMatch(/box-shadow:\s*none/);
  });
});
