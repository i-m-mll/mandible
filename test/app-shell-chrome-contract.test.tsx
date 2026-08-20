import { readFileSync } from 'node:fs';
import { render } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { DetailPaneHeader } from '../ui/src/components/shared/DetailPaneHeader';
import { DetailPaneShell } from '../ui/src/components/shared/DetailPaneShell';

const base = readFileSync('ui/src/styles/base.css', 'utf8');
const detailPaneShell = readFileSync('ui/src/styles/detail-pane-shell.css', 'utf8');
const appShellSource = readFileSync('ui/src/app-shell.tsx', 'utf8');
const appSource = readFileSync('ui/src/app.tsx', 'utf8');
const graphSource = readFileSync('ui/src/views/graph.tsx', 'utf8');
const timelineSource = readFileSync('ui/src/views/timeline.tsx', 'utf8');

function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.split(',').map((entry) => entry.trim()).includes(selector)) return match[2]!;
  }
  return '';
}

afterEach(() => {
  document.head.querySelector('[data-test-app-shell-styles]')?.remove();
});

describe('shared app-shell chrome contract', () => {
  it('aligns the brand to sidebar content and centers the route after the wordmark', () => {
    const identity = ruleBody(base, '.app-header__identity');
    const text = ruleBody(base, '.app-header__text');
    const route = ruleBody(base, '.app-header__route');

    expect(identity).toContain('grid-template-columns: var(--app-rail-width) minmax(0, 1fr)');
    expect(text).toContain('padding-left: 14px');
    expect(text).toContain('grid-template-columns: max-content minmax(0, 1fr)');
    expect(ruleBody(base, '.app-header__brand')).toContain('justify-self: start');
    expect(route).toContain('grid-column: 2');
    expect(route).toContain('justify-self: stretch');
    expect(route).toContain('text-align: center');
  });

  it('keeps the app name on AppHeader-owned theme literals', () => {
    expect(ruleBody(base, '.app-header__brand')).toContain('color: #747474');
    expect(ruleBody(base, ":root[data-theme='light'] .app-header__brand")).toContain('color: #A8A9A9');
    expect(ruleBody(base, '.app-header__brand')).not.toMatch(/var\(--(?:text-subdued|text-chrome-muted)\)/);
    expect(ruleBody(base, ":root[data-theme='light'] .app-header__brand"))
      .not.toMatch(/var\(--(?:text-subdued|text-chrome-muted)\)/);
  });

  it('keeps chrome-internal hairlines on one token and below the unsubdivided header', () => {
    const header = ruleBody(base, '.app-header');
    const railSidebarDivider = ruleBody(base, '.app-layout--view-sidebar-open::before');
    const footer = ruleBody(base, '.app-rail__footer');

    expect(header).toContain('border-bottom: 1px solid var(--border-muted)');
    expect(header).toContain('border-right: none');
    expect(railSidebarDivider).toContain('top: var(--app-header-height)');
    expect(railSidebarDivider).toContain('left: var(--app-rail-width)');
    expect(railSidebarDivider).toContain('width: 1px');
    expect(railSidebarDivider).toContain('background: var(--border-muted)');
    expect(footer).toContain('border-top: 1px solid var(--border-muted)');
    expect(footer).toContain('align-self: stretch');
    expect(footer).toContain('padding-inline: var(--app-rail-inline-padding)');
    expect(footer).toContain('margin-inline: calc(-1 * var(--app-rail-inline-padding))');
    expect(ruleBody(base, '.app-layout::after')).toContain('var(--shadow-app-subdivision-paint)');
  });

  it('gives compact detail chrome exactly the app-header physical height', () => {
    const style = document.createElement('style');
    style.dataset.testAppShellStyles = '';
    style.textContent = `
      * { box-sizing: border-box; }
      .app-shell { ${ruleBody(base, '.app-shell')} }
      .app-header { ${ruleBody(base, '.app-header')} }
      .detail-pane-shell--compact .detail-pane-shell__header {
        ${ruleBody(detailPaneShell, '.detail-pane-shell--compact .detail-pane-shell__header')}
      }
      .detail-pane-header--compact {
        ${ruleBody(detailPaneShell, '.detail-pane-header--compact')}
      }
    `;
    document.head.append(style);

    const { container } = render(h('div', { className: 'app-shell' }, [
      h('header', { className: 'app-header' }),
      h(DetailPaneShell, {
        as: 'section',
        variant: 'compact',
        header: h(DetailPaneHeader, { variant: 'compact', title: 'Chat' }),
      }, h('div', {}, 'Body')),
    ]));
    const appHeader = container.querySelector<HTMLElement>('.app-header');
    const compactHeader = container.querySelector<HTMLElement>('.detail-pane-header--compact');
    const compactShellHeader = container.querySelector<HTMLElement>('.detail-pane-shell__header');

    expect(appHeader).toBeTruthy();
    expect(compactHeader?.dataset.detailPaneHeaderVariant).toBe('compact');
    expect(compactShellHeader).toBeTruthy();
    const appHeaderStyle = getComputedStyle(appHeader!);
    const compactHeaderStyle = getComputedStyle(compactHeader!);
    const compactShellHeaderStyle = getComputedStyle(compactShellHeader!);
    expect(compactHeaderStyle.height).toBe(appHeaderStyle.height);
    expect(compactHeaderStyle.minHeight).toBe(appHeaderStyle.minHeight);
    expect(compactShellHeaderStyle.height).toBe(appHeaderStyle.height);
    expect(compactShellHeaderStyle.minHeight).toBe(appHeaderStyle.minHeight);
    expect(ruleBody(detailPaneShell, '.detail-pane-header')).not.toContain('height: var(--app-header-height)');
    expect(ruleBody(detailPaneShell, '.detail-pane-header--versioned')).not.toContain('height: var(--app-header-height)');
  });

  it('confines Graph and Timeline bottom panels to the shared detail boundary', () => {
    expect(appShellSource).toContain("layout: 'full-content' | 'anchored-detail'");
    expect(graphSource).toContain("layout: 'anchored-detail'");
    expect(timelineSource).toContain("layout: 'anchored-detail'");
    expect(timelineSource).not.toContain("layout: 'full-content'");
    expect(appSource).toContain('app-bottom-panel--${bottomPanel.layout}');

    expect(ruleBody(base, '.app-bottom-panel')).toContain('grid-column: 2');
    expect(ruleBody(base, '.app-layout--view-sidebar-open .app-bottom-panel--anchored-detail'))
      .toContain('margin-left: var(--app-view-sidebar-outer-width)');
    expect(ruleBody(base, '.app-bottom-panel--anchored-detail .app-bottom-panel__content'))
      .toContain('overflow: hidden');
    expect(ruleBody(base, '.app-bottom-panel__content')).toContain('overflow: auto');
  });

  it('leaves lazy view loading unowned by the shell', () => {
    const appSource = readFileSync('ui/src/app.tsx', 'utf8');

    expect(appSource).toContain('<Suspense fallback={null}>');
    expect(appSource).not.toContain('TabChunkFallback');
    expect(appSource).not.toContain('LoadingSkeleton variant="tab"');
  });
});
