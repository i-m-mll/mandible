import { readFileSync } from 'node:fs';
import { render } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { DetailPaneHeader } from '../../ui/src/components/shared/DetailPaneHeader';
import { DetailPaneShell } from '../../ui/src/components/shared/DetailPaneShell';

const base = readFileSync('ui/src/styles/base.css', 'utf8');
const tokens = readFileSync('ui/src/styles/tokens.css', 'utf8');
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

  it('routes app and detail titles through one exact cross-theme token', () => {
    expect(ruleBody(tokens, ':root')).toContain('--text-header-title: #fff');
    expect(ruleBody(tokens, "[data-theme='light']")).toContain('--text-header-title: #000');
    expect(ruleBody(base, '.app-header__route')).toContain('color: var(--text-header-title)');
    expect(ruleBody(detailPaneShell, '.detail-pane-header__title'))
      .toContain('color: var(--text-header-title)');
    expect(ruleBody(detailPaneShell, '.detail-pane-header--compact .detail-pane-header__title'))
      .not.toContain('color:');
    expect(ruleBody(detailPaneShell, '.detail-pane-shell--compact .detail-pane-shell__title'))
      .toContain('color: var(--text-header-title)');
  });

  it('keeps shared horizontal chrome hairlines equivalent and below the unsubdivided header', () => {
    const header = ruleBody(base, '.app-header');
    const railSidebarDivider = ruleBody(base, '.app-layout--view-sidebar-open::before');
    const footer = ruleBody(base, '.app-rail__footer');

    expect(header).toContain('border-bottom: 1px solid var(--neutral-alpha-06)');
    expect(header).toContain('border-right: none');
    expect(railSidebarDivider).toContain('top: var(--app-left-chrome-height)');
    expect(railSidebarDivider).toContain('left: calc(var(--app-left-boundary-width) + var(--app-rail-width))');
    expect(railSidebarDivider).toContain('width: 1px');
    expect(railSidebarDivider).toContain('background: var(--border-muted)');
    expect(footer).toContain('border-top: 1px solid var(--neutral-alpha-06)');
    expect(footer).toContain('align-self: stretch');
    expect(footer).toContain('padding-inline: var(--app-rail-inline-padding)');
    expect(footer).toContain('margin-inline: calc(-1 * var(--app-rail-inline-padding))');
    expect(ruleBody(base, '.app-shell::after')).toContain('var(--shadow-app-subdivision-paint)');
  });

  it('keeps native titlebar space in left chrome and tints only glass-backed chrome', () => {
    const shell = base.match(/\.app-shell\s*\{[^{}]*--app-header-height:[^{}]*\}/)?.[0] ?? '';
    const nativeShell = ruleBody(base, '.tauri-window .app-shell');
    const nativeHeader = ruleBody(base, '.tauri-window .app-header');
    const rail = ruleBody(base, '.app-rail');
    const sidebar = ruleBody(base, '.app-layout--view-sidebar-open .view-sidebar');
    const resizeHandle = ruleBody(base, '.app-layout--view-sidebar-open .view-sidebar__resize-handle.sidebar-drag-handle');
    const nativeGlassChrome = ruleBody(base, ":root[data-native-glass='regular'] .app-rail");
    const nativeSidebarBacking = ruleBody(base, ":root[data-native-glass='regular'] .app-layout--view-sidebar-open .app-content--view-sidebar");

    expect(shell).toContain('--app-header-height: 48px');
    expect(shell).toContain('--app-left-chrome-height: var(--app-header-height)');
    expect(nativeShell).toContain('--app-titlebar-inset: 30.75px');
    expect(nativeShell).toContain('--app-left-chrome-height: calc(var(--app-titlebar-inset) + var(--app-header-height))');
    expect(nativeShell).not.toContain('--app-header-height:');
    expect(ruleBody(base, '.app-header')).toContain('height: var(--app-header-height)');
    expect(nativeHeader).toContain('height: var(--app-left-chrome-height)');
    expect(nativeHeader).toContain('padding-top: var(--app-titlebar-inset)');
    expect(ruleBody(base, '.app-right-sidebar')).toContain('grid-template-rows: var(--app-header-height) minmax(0, 1fr)');
    expect(rail).toContain('padding: calc(var(--app-left-chrome-height) + 18px)');
    expect(sidebar).toContain('padding-top: var(--app-left-chrome-height)');
    expect(resizeHandle).toContain('top: var(--app-left-chrome-height)');

    expect(ruleBody(tokens, ':root')).toContain('--surface-glass-tint: color-mix(in srgb, var(--surface-chrome) 72%, transparent)');
    expect(ruleBody(base, ":root[data-native-glass='regular'] .app-header"))
      .toContain('background: var(--surface-glass-tint)');
    expect(nativeGlassChrome).toContain('var(--surface-glass-regular) 0 var(--app-left-chrome-height)');
    expect(nativeGlassChrome).toContain('var(--surface-glass-tint) var(--app-left-chrome-height) 100%');
    expect(ruleBody(base, ":root[data-native-glass='regular'] .app-layout--view-sidebar-open .view-sidebar"))
      .toBe(nativeGlassChrome);
    expect(nativeSidebarBacking).toContain('var(--surface-glass-regular) 0 var(--app-view-sidebar-outer-width)');
    expect(nativeSidebarBacking).toContain('var(--surface-main) var(--app-view-sidebar-outer-width) 100%');
    expect(nativeSidebarBacking).not.toContain('var(--surface-glass-tint)');
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

  it('confines Graph and Timeline to the canonical full-height right sidebar', () => {
    expect(appShellSource).not.toMatch(/\blayout:\s*'full-content'\s*\|\s*'anchored-detail'/);
    expect(graphSource).not.toMatch(/\blayout:\s*['"](?:full-content|anchored-detail)['"]/);
    expect(timelineSource).not.toMatch(/\blayout:\s*['"](?:full-content|anchored-detail)['"]/);
    expect(appShellSource).toContain('className={`app-right-sidebar app-right-sidebar--${resolvedLayout.presentation}');
    expect(appSource).toContain('<AppRightSidebarSurface');
    expect(appSource).not.toContain('rightSidebar.layout');

    expect(ruleBody(base, '.app-right-sidebar')).toContain('grid-column: 3');
    expect(base).not.toContain('overlay-drawer');
    expect(appShellSource).not.toContain('mainMinWidth');
    expect(appSource).toContain('responsiveSidebarThresholdTransition');
    expect(ruleBody(base, '.app-right-sidebar')).toContain('grid-template-rows: var(--app-header-height)');
    expect(base).toMatch(/\.app-right-sidebar__body\s*\{[^}]*overflow:\s*auto/s);
    expect(base).not.toContain('.app-right-sidebar--anchored-detail');
    expect(timelineSource).toContain('className="timeline-inspector"');
    expect(timelineSource).not.toContain('header={<DetailPaneHeader variant="compact" title="Timeline inspector" />}');
    expect(timelineSource).toContain("icon: <PreviewIcon size={18} />");
    expect(graphSource).toContain("icon: <PreviewIcon size={18} />");
  });

  it('leaves lazy view loading unowned by the shell', () => {
    const appSource = readFileSync('ui/src/app.tsx', 'utf8');

    expect(appSource).toContain('<Suspense fallback={null}>');
    expect(appSource).not.toContain('TabChunkFallback');
    expect(appSource).not.toContain('LoadingSkeleton variant="tab"');
  });
});
