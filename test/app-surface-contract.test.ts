import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { readResolvedStylesheet } from './helpers/css-manifest';

const tokens = readFileSync('ui/src/styles/tokens.css', 'utf8');
const base = readFileSync('ui/src/styles/base.css', 'utf8');
const detailShellCss = readFileSync('ui/src/styles/detail-pane-shell.css', 'utf8');
const stylesheet = readResolvedStylesheet();
const appSource = readFileSync('ui/src/app.tsx', 'utf8');
const viewSidebarSource = readFileSync('ui/src/components/ViewSidebar.tsx', 'utf8');
const detailShellSource = readFileSync('ui/src/components/shared/DetailPaneShell.tsx', 'utf8');
const consoleCss = readFileSync('ui/src/styles/console.css', 'utf8');
const graphCss = readFileSync('ui/src/styles/graph.css', 'utf8');

function tokenBlock(theme: 'dark' | 'light'): string {
  const selector = theme === 'dark' ? ':root' : "[data-theme='light']";
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return tokens.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
}

function tokenValue(block: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^;]+);`))?.[1]?.trim() ?? '';
}

function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.split(',').map((entry) => entry.trim()).includes(selector)) return match[2]!;
  }
  return '';
}

describe('Codex app subdivision surface contract', () => {
  it('defines the exact light and dark main/chrome values', () => {
    expect(tokenValue(tokenBlock('dark'), '--surface-main')).toBe('#181818');
    expect(tokenValue(tokenBlock('dark'), '--surface-chrome')).toBe('#222222');
    expect(tokenValue(tokenBlock('light'), '--surface-main')).toBe('#FFFFFF');
    expect(tokenValue(tokenBlock('light'), '--surface-chrome')).toBe('#FCFCFC');
  });

  it('marks direct app, sidebar, and detail consumers with one inherited contract', () => {
    expect(appSource).toMatch(/<header[\s\S]*?data-app-surface="chrome"/);
    expect(appSource).toContain('<aside className="app-rail" data-app-surface="chrome"');
    expect(appSource).toMatch(/<main[\s\S]*?data-app-surface="main"/);
    expect(viewSidebarSource).toContain('data-app-surface="chrome"');
    expect(detailShellSource).toContain('data-app-surface="main"');

    for (const selector of [
      '.detail-pane-shell',
      '.detail-pane-shell__header',
      '.detail-pane-shell__header-primary',
      '.detail-pane-shell__subheader',
      '.detail-pane-shell__body',
      '.detail-pane-shell__footer',
      '.detail-pane-header',
    ]) {
      expect(ruleBody(detailShellCss, selector), selector).toContain('background: inherit');
      expect(ruleBody(detailShellCss, selector), selector).toContain('box-shadow: none');
    }
  });

  it('keeps every left structural region on chrome without per-view surface overrides', () => {
    expect(ruleBody(base, '.view-sidebar')).toContain('background: var(--surface-chrome)');
    expect(ruleBody(stylesheet, '.sidebar-search-filter')).toContain('background: inherit');

    const structuralSources = [
      ['ui/src/styles/auth.css', '.auth-sidebar'],
      ['ui/src/styles/briefing.css', '.feedback-collections-sidebar'],
      ['ui/src/styles/chat-history.css', '.chat-history-sidebar'],
      ['ui/src/styles/graph.css', '.graph-sidebar'],
      ['ui/src/styles/inbox.css', '.inbox-sidebar'],
      ['ui/src/styles/issues.css', '.issues-tree'],
      ['ui/src/styles/issues.css', '.artifacts-sidebar'],
      ['ui/src/styles/timeline.css', '.timeline-sidebar'],
      ['ui/src/styles/work.css', '.work-sidebar'],
      ['ui/src/views/spaces/SpacesSidebar.css', '.spaces-tree'],
    ] as const;
    for (const [path, selector] of structuralSources) {
      const body = ruleBody(readFileSync(path, 'utf8'), selector);
      expect(body, `${path}:${selector}`).not.toMatch(/background(?:-color)?\s*:/);
    }
  });

  it('owns one full-height left-casting structural shadow at the app subdivision', () => {
    const edge = ruleBody(base, '.app-layout::after');
    expect(edge).toContain('top: 0');
    expect(edge).toContain('bottom: 0');
    expect(edge).toContain('left: var(--app-detail-edge-x)');
    expect(edge).toContain('width: 1px');
    expect(edge).toContain('background: var(--app-divider)');
    expect(edge).toContain('box-shadow: var(--shadow-app-subdivision)');
    expect(tokenValue(tokenBlock('dark'), '--app-divider')).toBe('#5A5A5A');
    expect(tokenValue(tokenBlock('light'), '--app-divider')).toBe('#D7D7D8');
    expect(tokenValue(tokenBlock('dark'), '--app-divider-emphasis')).toBe('#5B5B5B');
    expect(tokenValue(tokenBlock('light'), '--app-divider-emphasis')).toBe('#CFCFD0');
    expect(tokenValue(tokenBlock('dark'), '--shadow-app-subdivision')).toBe('-4px 0 10px 0 rgba(0, 0, 0, 0.32)');
    expect(tokenValue(tokenBlock('light'), '--shadow-app-subdivision')).toBe('-4px 0 10px 0 rgba(15, 23, 42, 0.14)');

    expect(ruleBody(base, '.app-header')).toContain('border-right: none');
    expect(ruleBody(base, '.app-rail')).toContain('border-right: none');
    expect(base).toMatch(/\.app-layout--view-sidebar-open \.view-sidebar,\s*\.app-layout--route-work \.work-sidebar\s*\{[^}]*border-right:\s*0;/s);
    const activeResizeEdge = base.match(/\.app-layout:has\(\.sidebar-drag-handle:is\(:hover, :focus-visible\)\)::after\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(activeResizeEdge).toContain('background: var(--app-divider-emphasis)');
    expect(activeResizeEdge).not.toMatch(/(?:width|box-shadow|border)\s*:/);
    expect(base.match(/background:\s*var\(--app-divider\);/g)).toHaveLength(1);
    expect(base).not.toContain('border-right: 1px solid var(--app-divider)');

    for (const selector of ['.app-rail', '.app-bottom-panel', '.view-sidebar', '.detail-pane-shell__header', '.detail-pane-shell__body', '.detail-pane-shell__footer', '.briefing-detail__footer', '.composer-host']) {
      const shadow = ruleBody(stylesheet, selector).match(/box-shadow:\s*([^;]+)/)?.[1]?.trim();
      expect([undefined, 'none'], selector).toContain(shadow);
    }
    expect(ruleBody(stylesheet, '.briefing-detail__footer')).not.toMatch(/background:/);
    expect(ruleBody(stylesheet, '.composer-host')).not.toMatch(/background:/);
    expect(stylesheet.match(/box-shadow:\s*var\(--shadow-app-subdivision\)/g)).toHaveLength(1);
  });

  it('preserves the single persisted settings owner and exact root theme application', () => {
    const settingsSource = readFileSync('ui/src/views/settings.tsx', 'utf8');
    expect(settingsSource).toContain("settings.app_theme");
    expect(settingsSource).toContain("onSave('app_theme'");
    expect(appSource).toContain('normalizeAppThemeMode');
    expect(appSource).toContain('resolveAppThemeMode');
    expect(appSource).toContain("dark: '#181818'");
    expect(appSource).toContain("light: '#FFFFFF'");
  });

  it('keeps cards, menus, modals, code, and tables on their semantic surfaces', () => {
    expect(stylesheet).toMatch(/\.repo-card,[\s\S]*?background:\s*var\(--bg-card\)/);
    expect(stylesheet).toMatch(/\.app-anchored-menu\s*\{[^}]*z-index:\s*var\(--z-anchored-menu\)/s);
    expect(stylesheet).toMatch(/\.ledger-issue-modal__panel\s*\{[^}]*background:\s*var\(--bg-secondary\)/s);
    expect(tokens).toContain('--surface-code:');
    expect(stylesheet).toMatch(/th,[\s\S]*?td\s*\{/);
  });

  it('keeps Channel Events and the Graph right root on main in both themes', () => {
    expect(ruleBody(consoleCss, '.channel-events-pane')).toContain('background: var(--surface-main)');
    expect(graphCss).toMatch(/:root\[data-theme='light'\] \.graph-detail-pane,\s*:root\[data-theme='light'\] \.graph-canvas-wrap\s*\{\s*background:\s*var\(--surface-main\);\s*\}/);
    expect(consoleCss).not.toContain('#0b0f14');
    expect(graphCss).not.toContain('#eef3f8');
    expect(tokenValue(tokenBlock('dark'), '--surface-main')).toBe('#181818');
    expect(tokenValue(tokenBlock('light'), '--surface-main')).toBe('#FFFFFF');
  });

  it('adopts the viewport/top-layer menu contract across shared and detail actions', () => {
    const menuHook = readFileSync('ui/src/hooks/useAnchoredMenu.ts', 'utf8');
    expect(menuHook).toContain('showPopover?.()');
    expect(menuHook).toContain("window.addEventListener('resize', position)");
    expect(menuHook).toContain("window.addEventListener('scroll', position, true)");
    expect(menuHook).toContain("window.addEventListener('keydown', handleKeyDown, true)");
    expect(menuHook).toContain("document.addEventListener('pointerdown', handlePointerDown, true)");

    for (const path of [
      'ui/src/components/shared/SidebarSearchFilterHeader.tsx',
      'ui/src/components/shared/SidebarItemRow.tsx',
      'ui/src/components/ledger/IssueDetail.tsx',
      'ui/src/views/auth.tsx',
      'ui/src/views/artifacts.tsx',
      'ui/src/views/feedback/BriefingDocumentRenderer.tsx',
      'ui/src/views/spaces/SpaceCanvas.tsx',
      'ui/src/components/spaces/AddToSpace.tsx',
      'ui/src/views/work.tsx',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain('useAnchoredMenu');
      expect(source, path).toContain('app-anchored-menu');
      expect(source, path).toContain('popover="manual"');
    }
  });
});
