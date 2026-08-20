import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Rect = Pick<DOMRect, 'left' | 'right' | 'width'>;

type GutterGeometry = {
  gutter: number;
  shellWidth: number;
  header: Rect;
  headerGutterWidth: number;
  rail: Rect;
  nav: Rect;
  footer: Rect;
  sidebar: Rect | null;
  sidebarHeader: Rect | null;
  sidebarBody: Rect | null;
  sidebarFooter: Rect | null;
  sidebarPaddingRight: number | null;
  handle: Rect | null;
  handleHitLeft: number | null;
  handleHitWidth: number | null;
  edgeLeft: number;
  edgeWidth: number;
  edgeShadow: string;
  edgeAccent: string;
  edgeShadowX: string;
  resolvedComposition: string;
  tokenComposition: string;
  supportsResolvedComposition: boolean;
  supportsTokenComposition: boolean;
  directProbeShadow: string;
  iabHeaderWidth: number;
  iabRailWidth: number;
  iabHeaderShadow: string;
  iabRailShadow: string;
};

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

const chrome = CHROME_CANDIDATES.find(existsSync);
const tokens = readFileSync(resolve('ui/src/styles/tokens.css'), 'utf8');
const base = readFileSync(resolve('ui/src/styles/base.css'), 'utf8');

function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.split(',').map((entry) => entry.trim()).includes(selector)) return match[2]!;
  }
  return '';
}

function renderGeometry({
  viewport,
  railWidth,
  outerWidth,
  sidebar,
  work = false,
  theme = 'dark',
  codexIab = false,
}: {
  viewport: number;
  railWidth: number;
  outerWidth: number;
  sidebar: boolean;
  work?: boolean;
  theme?: 'dark' | 'light';
  codexIab?: boolean;
}): GutterGeometry {
  if (!chrome) throw new Error('A Chromium browser is required for the shadow-gutter geometry regression.');
  const openClass = sidebar ? ' app-shell--view-sidebar-open' : '';
  const layoutOpenClass = sidebar ? ' app-layout--view-sidebar-open' : '';
  const workClass = work ? ' app-layout--route-work' : '';
  const iabClass = codexIab ? ' app-shell--codex-iab' : '';
  const sidebarMarkup = sidebar
    ? '<aside class="view-sidebar work-sidebar"><div class="sidebar-drag-handle view-sidebar__resize-handle"></div><div class="view-sidebar__header">Search</div><div class="view-sidebar__body"><div>Row</div></div><div class="view-sidebar__footer">Footer</div></aside>'
    : '';
  const html = `<!doctype html><html data-theme="${theme}"><head><style>${tokens}\n${base}
    .fixture-split { display:grid; grid-template-columns:var(--app-view-sidebar-width) minmax(0,1fr); height:100%; }
    </style></head><body><div class="app-shell${openClass}${iabClass}" style="--app-rail-width:${railWidth}px;--app-view-sidebar-persisted-width:${outerWidth}px;--app-view-sidebar-width:${outerWidth}px">
      <header class="app-header"><div class="app-header__identity"><span class="app-header__mark"><span class="app-header__logo"></span></span>${sidebar ? '<div class="app-header__text"><div class="app-header__brand"><span class="app-header__brand-text">Mandible</span></div><div class="app-header__route">Timeline</div></div>' : ''}</div></header>
      <div class="app-layout${layoutOpenClass}${workClass}"><aside class="app-rail"><nav class="app-rail__nav"><a class="app-rail__item">Navigation</a></nav><nav class="app-rail__footer"><a class="app-rail__item">Settings</a></nav></aside><main class="app-content app-content--view-sidebar"><div class="fixture-split">${sidebarMarkup}<section></section></div></main></div>
      <div class="direct-probe"></div><script>
        const rect = (node) => node ? Object.fromEntries(['left','right','width'].map((key) => [key, node.getBoundingClientRect()[key]])) : null;
        const shell = document.querySelector('.app-shell');
        const header = document.querySelector('.app-header');
        const rail = document.querySelector('.app-rail');
        const sidebar = document.querySelector('.view-sidebar');
        const handle = document.querySelector('.view-sidebar__resize-handle');
        const edge = getComputedStyle(document.querySelector('.app-layout'), '::after');
        const hit = handle ? getComputedStyle(handle, '::before') : null;
        const shadowX = edge.getPropertyValue('--app-boundary-shadow-x').trim();
        const offset = edge.getPropertyValue('--app-boundary-shadow-offset').trim();
        const blur = edge.getPropertyValue('--app-boundary-shadow-blur').trim();
        const spread = edge.getPropertyValue('--app-boundary-shadow-spread').trim();
        const color = edge.getPropertyValue('--app-boundary-shadow-color').trim();
        const resolvedComposition = (-parseFloat(offset)) + 'px 0 ' + blur + ' ' + spread + ' ' + color;
        const tokenComposition = edge.getPropertyValue('--shadow-app-subdivision').trim();
        const directProbe = document.querySelector('.direct-probe');
        directProbe.style.boxShadow = resolvedComposition;
        document.title = btoa(JSON.stringify({
          gutter: parseFloat(getComputedStyle(shell).getPropertyValue('--app-shadow-gutter-width')),
          shellWidth: shell.getBoundingClientRect().width,
          header: rect(header),
          headerGutterWidth: parseFloat(getComputedStyle(header, '::after').width),
          rail: rect(rail), nav: rect(document.querySelector('.app-rail__nav')), footer: rect(document.querySelector('.app-rail__footer')),
          sidebar: rect(sidebar),
          sidebarHeader: rect(document.querySelector('.view-sidebar__header')),
          sidebarBody: rect(document.querySelector('.view-sidebar__body')),
          sidebarFooter: rect(document.querySelector('.view-sidebar__footer')),
          sidebarPaddingRight: sidebar ? parseFloat(getComputedStyle(sidebar).paddingRight) : null,
          handle: rect(handle), handleHitLeft: hit ? parseFloat(hit.left) : null, handleHitWidth: hit ? parseFloat(hit.width) : null,
          edgeLeft: parseFloat(edge.left), edgeWidth: parseFloat(edge.width), edgeShadow: edge.boxShadow, edgeAccent: edge.backgroundColor,
          edgeShadowX: shadowX, resolvedComposition, tokenComposition,
          supportsResolvedComposition: CSS.supports('box-shadow', resolvedComposition),
          supportsTokenComposition: CSS.supports('box-shadow', tokenComposition),
          directProbeShadow: getComputedStyle(directProbe).boxShadow,
          iabHeaderWidth: parseFloat(getComputedStyle(header, '::before').width),
          iabRailWidth: parseFloat(getComputedStyle(rail, '::before').width),
          iabHeaderShadow: getComputedStyle(header, '::before').boxShadow,
          iabRailShadow: getComputedStyle(rail, '::before').boxShadow,
        }));
      </script></div></body></html>`;
  const rendered = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom',
    `--window-size=${viewport},480`, `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium shadow-gutter fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium shadow-gutter fixture did not return measurements.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as GutterGeometry;
}

function expectSidebarGutter(geometry: GutterGeometry, outerWidth: number, railWidth: number): void {
  expect(geometry.gutter).toBe(17);
  expect(geometry.sidebar).toMatchObject({ left: railWidth, width: outerWidth, right: railWidth + outerWidth });
  expect(geometry.sidebarPaddingRight).toBe(geometry.gutter);
  const innerEdge = geometry.sidebar!.right - geometry.gutter;
  expect(geometry.sidebarHeader!.right).toBeLessThanOrEqual(innerEdge);
  expect(geometry.sidebarBody!.right).toBeLessThanOrEqual(innerEdge);
  expect(geometry.sidebarFooter!.right).toBeLessThanOrEqual(innerEdge);
  expect(geometry.handle).toMatchObject({ left: innerEdge, right: innerEdge, width: 0 });
  expect(geometry.handleHitLeft).toBe(-10);
  expect(geometry.handleHitWidth).toBe(10);
  expect(geometry.edgeLeft).toBe(geometry.sidebar!.right);
  expect(geometry.edgeWidth).toBe(1);
  expect(geometry.edgeShadowX).toBe('calc(0px - 8px)');
  expect(geometry.supportsResolvedComposition, geometry.resolvedComposition).toBe(true);
  expect(geometry.supportsTokenComposition, geometry.tokenComposition).toBe(true);
  expect(geometry.directProbeShadow, geometry.resolvedComposition).not.toBe('none');
  expect(geometry.edgeShadow, JSON.stringify(geometry)).not.toBe('none');
  expect(geometry.header.right).toBe(geometry.sidebar!.right);
  expect(geometry.headerGutterWidth).toBe(geometry.gutter);
}

describe('measured app shadow-gutter geometry', () => {
  it('pairs the measured gutter with every sign-directed shadow site', () => {
    expect(tokens).toMatch(/--app-shadow-gutter-width:\s*17px;/);
    expect(base).toMatch(/--shadow-app-subdivision:\s*var\(--app-boundary-shadow-x\)/);
    expect(ruleBody(base, '.app-layout::after')).toContain('--app-boundary-shadow-x: calc(0px - var(--app-boundary-shadow-offset))');
    expect(ruleBody(base, '.app-layout::after')).toContain('box-shadow: var(--shadow-app-subdivision)');
    const mirrors = ruleBody(base, '.app-shell--codex-iab .app-header::before');
    expect(mirrors).toContain('--app-boundary-shadow-x: var(--app-boundary-shadow-offset)');
    expect(mirrors).toContain('width: var(--app-shadow-gutter-width)');
    expect(mirrors).toContain('box-shadow: var(--shadow-app-subdivision)');
  });

  it.each(['dark', 'light'] as const)('reserves the gutter inside a persisted outer sidebar width in %s', (theme) => {
    expectSidebarGutter(renderGeometry({ viewport: 1200, railWidth: 208, outerWidth: 420, sidebar: true, theme }), 420, 208);
  });

  it('keeps Work on its fixed 340px outer boundary and its resize hit strip at the inner edge', () => {
    expectSidebarGutter(renderGeometry({ viewport: 1200, railWidth: 208, outerWidth: 340, sidebar: true, work: true }), 340, 208);
  });

  it('reserves the same strip inside the rail when the view sidebar is hidden', () => {
    const geometry = renderGeometry({ viewport: 1200, railWidth: 208, outerWidth: 0, sidebar: false });
    expect(geometry.gutter).toBe(17);
    expect(geometry.edgeLeft).toBe(geometry.rail.right);
    expect(geometry.nav.right).toBeLessThanOrEqual(geometry.rail.right - geometry.gutter);
    expect(geometry.footer.right).toBeLessThanOrEqual(geometry.rail.right - geometry.gutter);
    expect(geometry.header.right).toBe(geometry.rail.right);
  });

  it('bounds compact mobile geometry without changing the outer-width rule', () => {
    const geometry = renderGeometry({ viewport: 480, railWidth: 56, outerWidth: 424, sidebar: true });
    expectSidebarGutter(geometry, 424, 56);
    expect(geometry.sidebar!.right - geometry.gutter).toBeGreaterThan(geometry.sidebar!.left);
  });

  it('uses the same gutter for both dormant IAB mirrors without moving the active geometry', () => {
    const normal = renderGeometry({ viewport: 1200, railWidth: 208, outerWidth: 420, sidebar: true });
    const mirrored = renderGeometry({ viewport: 1200, railWidth: 208, outerWidth: 420, sidebar: true, codexIab: true });
    expect(mirrored.header).toEqual(normal.header);
    expect(mirrored.rail).toEqual(normal.rail);
    expect(mirrored.sidebar).toEqual(normal.sidebar);
    expect(mirrored.iabHeaderWidth).toBe(mirrored.gutter);
    expect(mirrored.iabRailWidth).toBe(mirrored.gutter);
    expect(mirrored.iabHeaderShadow).not.toBe('none');
    expect(mirrored.iabRailShadow).not.toBe('none');
    expect(mirrored.iabHeaderShadow).toContain('8px');
    expect(mirrored.iabRailShadow).toContain('8px');
  });
});
