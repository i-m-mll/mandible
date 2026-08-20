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

type Rgb = readonly [number, number, number];

const screenshotCalibration = {
  darkNormal: {
    sha256: 'e6b18b02f19f6c581524f53ffeac8a42ad54fc99fd8bd0f67bdc5d5e45f0d16a',
    size: [116, 12], mode: 'RGBA8', rows: '12/12 identical',
    chrome: [34, 34, 34], shadow: [[88, 98, [33, 33, 33]]],
    accent: [67, 67, 67], main: [24, 24, 24],
  },
  lightNormal: {
    sha256: '00c72aaa5377bae7d37953915d8f0162729a57c1bc3d0140eef81572e3e09dc7',
    size: [140, 32], mode: 'RGBA8', rows: '32/32 identical',
    chrome: [252, 252, 252],
    shadowRuns: [[83, 93, 251], [94, 100, 250], [101, 105, 249], [106, 109, 247], [110, 112, 245], [113, 113, 244], [114, 114, 243], [115, 116, 242]],
    accent: [215, 215, 216], main: [255, 255, 255],
  },
  darkHover: {
    sha256: 'f3c014f906ca312ea39e2fff795653921cb9dff09b677f59ad26edccfda504be',
    size: [62, 20], mode: 'RGBA8', rows: '20/20 identical',
    chrome: [34, 34, 34], shadow: [[22, 32, [33, 33, 33]]],
    mainSideAccentMedian: [67, 67, 67], main: [24, 24, 24],
  },
  lightHover: {
    sha256: '7ba8334684995a8baa1f6d020cd0c39859390fa323a03746ace197cba6ddaf07',
    size: [70, 18], mode: 'RGBA8', rows: '9 unique; diffuse columns identical',
    chrome: [252, 252, 252],
    shadowRuns: [[17, 27, 251], [28, 34, 250], [35, 39, 249], [40, 43, 247], [44, 46, 245], [47, 47, 244], [48, 48, 243], [49, 50, 242]],
    shadowSideEdgeMedian: [168, 169, 170],
    shadowSideEdgeRange: [[167, 168, 170], [169, 169, 171]],
    mainSideAccentMedian: [198, 198, 199],
    mainSideAccentRange: [[197, 197, 198], [199, 199, 200]],
    main: [255, 255, 255],
  },
} as const;

function hexRgb(value: string): Rgb {
  const hex = value.slice(1);
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
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

  it('owns one full-height left-casting structural falloff at the app subdivision', () => {
    const edge = ruleBody(base, '.app-shell::after');
    expect(edge).toContain('inset: 0 auto 0 calc(var(--app-detail-edge-x) - var(--app-shadow-gutter-width))');
    expect(edge).toContain('width: calc(var(--app-shadow-gutter-width) + 1px)');
    expect(edge).toContain('--app-boundary-shadow-x: calc(0px - var(--app-boundary-shadow-offset))');
    expect(edge).toContain('--app-boundary-accent: var(--app-divider)');
    expect(edge).toContain('var(--shadow-app-subdivision-paint)');
    expect(edge).toContain('background-size: 1px 100%, var(--app-shadow-gutter-width) 100%');
    expect(tokenValue(tokenBlock('dark'), '--app-divider')).toBe('#434343');
    expect(tokenValue(tokenBlock('light'), '--app-divider')).toBe('#D7D7D8');
    expect(tokenValue(tokenBlock('dark'), '--app-divider-emphasis')).toBe('#434343');
    expect(tokenValue(tokenBlock('light'), '--app-divider-emphasis')).toBe('#C6C6C7');
    expect(tokenValue(tokenBlock('dark'), '--app-boundary-shadow-offset')).toBe('8px');
    expect(tokenValue(tokenBlock('dark'), '--app-boundary-shadow-blur')).toBe('36px');
    expect(tokenValue(tokenBlock('dark'), '--app-boundary-shadow-spread')).toBe('0px');
    expect(tokenValue(tokenBlock('dark'), '--app-boundary-shadow-color')).toBe('rgba(0, 0, 0, 0.0375)');
    expect(stylesheet).toMatch(/:where\(\.app-shell\)::after,\s*:where\(\.app-shell--codex-iab\)::before\s*\{[^}]*--shadow-app-subdivision:[^}]*--shadow-app-subdivision-paint:/s);

    expect(ruleBody(base, '.app-header')).toContain('border-right: none');
    expect(ruleBody(base, '.app-rail')).toContain('border-right: none');
    expect(base).toMatch(/\.app-layout--view-sidebar-open \.view-sidebar,\s*\.app-layout--route-work \.work-sidebar\s*\{[^}]*border-right:\s*0;/s);
    const activeResizeEdge = base.match(/\.app-shell:has\(\.sidebar-drag-handle:is\(:hover, :focus-visible\)\)::after\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(activeResizeEdge).toContain('--app-boundary-accent: var(--app-divider-emphasis)');
    expect(activeResizeEdge).not.toMatch(/(?:width|box-shadow|border)\s*:/);
    expect(edge).toContain('linear-gradient(var(--app-boundary-accent), var(--app-boundary-accent))');
    expect(base).not.toContain('border-right: 1px solid var(--app-divider)');

    for (const selector of ['.app-rail', '.app-bottom-panel', '.view-sidebar', '.detail-pane-shell__header', '.detail-pane-shell__body', '.detail-pane-shell__footer', '.briefing-detail__footer', '.composer-host']) {
      const shadow = ruleBody(stylesheet, selector).match(/box-shadow:\s*([^;]+)/)?.[1]?.trim();
      expect([undefined, 'none'], selector).toContain(shadow);
    }
    expect(ruleBody(stylesheet, '.briefing-detail__footer')).not.toMatch(/background:/);
    expect(ruleBody(stylesheet, '.composer-host')).not.toMatch(/background:/);
    expect(stylesheet.match(/box-shadow:\s*var\(--shadow-app-subdivision\)/g)).toHaveLength(1);
  });

  it('retains the measured profile positions at 30% of the prior light and dark intensity', () => {
    expect(screenshotCalibration.darkNormal.size).toEqual([116, 12]);
    expect(screenshotCalibration.lightNormal.size).toEqual([140, 32]);
    expect(screenshotCalibration.darkHover.size).toEqual([62, 20]);
    expect(screenshotCalibration.lightHover.size).toEqual([70, 18]);
    for (const fixture of Object.values(screenshotCalibration)) {
      expect(fixture.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.mode).toBe('RGBA8');
    }

    expect(hexRgb(tokenValue(tokenBlock('dark'), '--surface-chrome'))).toEqual(screenshotCalibration.darkNormal.chrome);
    expect(hexRgb(tokenValue(tokenBlock('dark'), '--surface-main'))).toEqual(screenshotCalibration.darkNormal.main);
    expect(hexRgb(tokenValue(tokenBlock('light'), '--surface-chrome'))).toEqual(screenshotCalibration.lightNormal.chrome);
    expect(hexRgb(tokenValue(tokenBlock('light'), '--surface-main'))).toEqual(screenshotCalibration.lightNormal.main);
    expect(hexRgb(tokenValue(tokenBlock('dark'), '--app-divider'))).toEqual(screenshotCalibration.darkNormal.accent);
    expect(hexRgb(tokenValue(tokenBlock('light'), '--app-divider'))).toEqual(screenshotCalibration.lightNormal.accent);
    expect(hexRgb(tokenValue(tokenBlock('dark'), '--app-divider-emphasis'))).toEqual(screenshotCalibration.darkHover.mainSideAccentMedian);
    expect(hexRgb(tokenValue(tokenBlock('light'), '--app-divider-emphasis'))).toEqual(screenshotCalibration.lightHover.mainSideAccentMedian);

    expect(tokenValue(tokenBlock('dark'), '--app-boundary-shadow-offset')).toBe('8px');
    expect(tokenValue(tokenBlock('dark'), '--app-boundary-shadow-blur')).toBe('36px');
    expect(tokenValue(tokenBlock('dark'), '--app-boundary-shadow-spread')).toBe('0px');
    const profile = tokenValue(tokenBlock('dark'), '--app-boundary-shadow-gradient-stops');
    expect(profile).toContain('transparent 0%');
    expect(profile).toContain('rgba(0, 0, 0, 0.0054) 24%');
    expect(profile).toContain('rgba(0, 0, 0, 0.0156) 59%');
    expect(0.0054 / 0.018).toBeCloseTo(0.3, 8);
    expect(0.0156 / 0.052).toBeCloseTo(0.3, 8);
    expect(0.0375 / 0.125).toBeCloseTo(0.3, 8);
  });

  it('spans the rail footer divider across the chrome gutter', () => {
    const rail = ruleBody(base, '.app-rail');
    const footer = ruleBody(base, '.app-rail__footer');
    expect(rail).toContain('--app-rail-inline-padding: 12px');
    expect(rail).toContain('padding: calc(var(--app-header-height) + 18px) var(--app-rail-inline-padding) 18px');
    expect(footer).toContain('padding-inline: var(--app-rail-inline-padding)');
    expect(footer).toContain('margin-inline: calc(-1 * var(--app-rail-inline-padding))');
    expect(footer).toContain('border-top: 1px solid var(--border-muted)');
    const continuation = ruleBody(base, '.app-rail__footer::before');
    expect(continuation).toContain('left: 100%');
    expect(continuation).toContain('width: calc(var(--app-detail-edge-x) - var(--app-rail-width))');
    expect(continuation).toContain('border-top: 1px solid var(--border-muted)');
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
