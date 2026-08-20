import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type Rect = Pick<DOMRect, 'left' | 'right' | 'width'>;
type Mode = 'open' | 'work' | 'hidden' | 'collapsed' | 'timeline';
type Geometry = {
  theme: 'dark' | 'light'; mode: Mode; rowTop: number; gutter: number;
  persistedWidth: string; contentWidth: string; outerWidth: string;
  rail: Rect; nav: Rect; footer: Rect; footerDivider: Rect; header: Rect; identity: Rect; mark: Rect;
  sidebar: Rect | null; sidebarHeader: Rect | null; sidebarBody: Rect | null;
  sidebarFooter: Rect | null; sidebarStrip: Rect | null; search: Rect | null;
  searchBottom: number | null; separator: Rect | null; handle: Rect | null; handleHit: Rect | null;
  main: Rect; edge: Rect; edgeShadow: string;
};
type Pixel = { red: number; green: number; blue: number };

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate)).find(existsSync);
const magick = ['/opt/homebrew/bin/magick', '/usr/local/bin/magick', '/usr/bin/magick'].find(existsSync);
const tokens = readFileSync(resolve('ui/src/styles/tokens.css'), 'utf8');
const base = readFileSync(resolve('ui/src/styles/base.css'), 'utf8');
const work = readFileSync(resolve('ui/src/styles/work.css'), 'utf8');
const search = readFileSync(resolve('ui/src/styles/sidebar-search-filter.css'), 'utf8');

function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.split(',').map((entry) => entry.trim()).includes(selector)) return match[2]!;
  }
  return '';
}

let cache: { geometries: Geometry[]; screenshot: string; cleanup: () => void } | null = null;

function renderNativeSuite(): NonNullable<typeof cache> {
  if (cache) return cache;
  if (!chrome || !magick) throw new Error('Chromium and ImageMagick are required for the native chrome-edge pixel gate.');
  const cases = (['dark', 'light'] as const).flatMap((theme) =>
    (['open', 'work', 'hidden', 'collapsed', 'timeline'] as const).map((mode) => ({ theme, mode })),
  );
  const markup = cases.map(({ theme, mode }, index) => {
    const open = mode === 'open' || mode === 'work' || mode === 'timeline';
    const collapsed = mode === 'collapsed';
    const sidebar = open
      ? '<aside class="view-sidebar work-sidebar"><div class="sidebar-drag-handle view-sidebar__resize-handle"></div><div class="view-sidebar__header"><div class="sidebar-search-filter">Search</div></div><div class="view-sidebar__body">Row</div><div class="view-sidebar__footer">Footer</div></aside>'
      : '';
    return `<div class="fixture" data-fixture="${index}" data-theme="${theme}" data-mode="${mode}"><div class="app-shell${open ? ' app-shell--view-sidebar-open' : ''}${collapsed ? ' app-shell--rail-icons' : ''}" style="--app-view-sidebar-persisted-width:${mode === 'work' ? 340 : 420}px"><header class="app-header${open ? '' : ' app-header--sidebar-hidden'}"><div class="app-header__identity"><span class="app-header__mark"><span class="app-header__logo"></span></span>${open ? '<div class="app-header__text"><div class="app-header__brand"><span class="app-header__brand-text">Mandible</span></div><div class="app-header__route">Tasks</div></div>' : ''}</div></header><div class="app-layout${open ? ' app-layout--view-sidebar-open' : ''}${mode === 'work' ? ' app-layout--route-work' : ''}${mode === 'timeline' ? ' app-layout--bottom-panel-open' : ''}"${mode === 'timeline' ? ' style="--app-bottom-panel-height:45px"' : ''}><aside class="app-rail"><nav class="app-rail__nav"><a class="app-rail__item">Navigation</a></nav><nav class="app-rail__footer"><a class="app-rail__item">Settings</a></nav></aside><main class="app-content app-content--view-sidebar"><div class="fixture-split${mode === 'work' ? ' work-shell' : ''}">${sidebar}<section class="fixture-main"></section></div></main>${mode === 'timeline' ? '<aside class="app-bottom-panel app-bottom-panel--anchored-detail"><div class="app-bottom-panel__content">Timeline inspector</div></aside>' : ''}</div></div></div>`;
  }).join('');
  const html = `<!doctype html><html><head><style>${tokens}\n${base}\n${work}\n${search}
    html,body{margin:0;width:1000px}.fixture{position:relative;width:1000px;height:140px;overflow:hidden}.fixture .app-shell{height:140px}.fixture-split{display:flex;height:100%}.fixture-split.work-shell{display:grid}.fixture .view-sidebar{width:var(--app-view-sidebar-width);flex-shrink:0}.fixture-main{flex:1;min-width:0;background:var(--surface-main)}
    </style></head><body>${markup}<script>
    const rect=(node,pseudo)=>{if(!node)return null;if(pseudo){const style=getComputedStyle(node,pseudo);const own=node.getBoundingClientRect();const left=own.left+parseFloat(style.left||'0');const width=parseFloat(style.width||'0');return{left,right:left+width,width}}const value=node.getBoundingClientRect();return Object.fromEntries(['left','right','width'].map(key=>[key,value[key]]))};
    const rows=[...document.querySelectorAll('.fixture')].map((fixture)=>{const shell=fixture.querySelector('.app-shell');const footer=fixture.querySelector('.app-rail__footer');const sidebar=fixture.querySelector('.view-sidebar');const handle=fixture.querySelector('.view-sidebar__resize-handle');const search=fixture.querySelector('.sidebar-search-filter');return{theme:fixture.dataset.theme,mode:fixture.dataset.mode,rowTop:fixture.getBoundingClientRect().top,gutter:parseFloat(getComputedStyle(shell).getPropertyValue('--app-shadow-gutter-width')),persistedWidth:getComputedStyle(shell).getPropertyValue('--app-view-sidebar-persisted-width').trim(),contentWidth:getComputedStyle(shell).getPropertyValue('--app-view-sidebar-width').trim(),outerWidth:getComputedStyle(shell).getPropertyValue('--app-view-sidebar-outer-width').trim(),rail:rect(fixture.querySelector('.app-rail')),nav:rect(fixture.querySelector('.app-rail__nav')),footer:rect(footer),footerDivider:rect(footer,'::before'),header:rect(fixture.querySelector('.app-header')),identity:rect(fixture.querySelector('.app-header__identity')),mark:rect(fixture.querySelector('.app-header__mark')),sidebar:rect(sidebar),sidebarHeader:rect(fixture.querySelector('.view-sidebar__header')),sidebarBody:rect(fixture.querySelector('.view-sidebar__body')),sidebarFooter:rect(fixture.querySelector('.view-sidebar__footer')),sidebarStrip:null,search:rect(search),searchBottom:search?search.getBoundingClientRect().bottom:null,separator:rect(search,'::after'),handle:rect(handle),handleHit:rect(handle,'::before'),main:rect(fixture.querySelector('.fixture-main')),edge:rect(shell,'::after'),edgeShadow:getComputedStyle(shell,'::after').boxShadow}});document.title=btoa(JSON.stringify(rows));
    </script></body></html>`;
  const directory = mkdtempSync(join(tmpdir(), 'mandible-chrome-edge-'));
  const screenshot = join(directory, 'chrome-edge.png');
  const rendered = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--dump-dom', `--screenshot=${screenshot}`, '--window-size=1000,1400',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 10_000_000, timeout: 20_000 });
  if (rendered.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Chromium chrome-edge fixture failed: ${rendered.stderr}`);
  }
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded || !existsSync(screenshot)) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('Chromium did not emit both geometry and screenshot evidence.');
  }
  cache = {
    geometries: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Geometry[],
    screenshot,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
  return cache;
}

function pixelsAt(screenshot: string, left: number, top: number, width: number): Pixel[] {
  const sampled = spawnSync(magick!, [screenshot, '-crop', `${width}x1+${left}+${top}`, 'txt:-'], {
    encoding: 'utf8', maxBuffer: 1_000_000, timeout: 5_000,
  });
  if (sampled.status !== 0) throw new Error(`ImageMagick pixel sample failed: ${sampled.stderr}`);
  return [...sampled.stdout.matchAll(/^\d+,\d+: \((\d+),(\d+),(\d+)\)/gm)].map((match) => ({
    red: Number(match[1]), green: Number(match[2]), blue: Number(match[3]),
  }));
}

describe('additive app chrome-edge geometry and pixels', () => {
  it('defines stable content widths and one additive physical outer-width token', () => {
    expect(tokens).toMatch(/--app-shadow-gutter-width:\s*9px;/);
    expect(tokens).toMatch(/--app-boundary-shadow-gradient-stops:/);
    expect(base).toMatch(/--app-view-sidebar-width:\s*var\(--app-view-sidebar-persisted-width\);/);
    expect(base).toMatch(/--app-view-sidebar-outer-width:\s*calc\(var\(--app-view-sidebar-width\) \+ var\(--app-shadow-gutter-width\)\);/);
    expect(base).toMatch(/@media \(max-width: 700px\)\s*\{\s*\.app-shell\s*\{\s*--app-view-sidebar-width:\s*calc\(100vw - var\(--app-rail-width\)\);/s);
    expect(ruleBody(base, '.app-layout--view-sidebar-open .view-sidebar')).toContain('margin-right: var(--app-shadow-gutter-width)');
    expect(ruleBody(base, '.app-layout--view-sidebar-open .view-sidebar')).not.toContain('padding-right');
  });

  it('keeps pre-strip child coordinates while moving physical boundaries exactly 9px', () => {
    for (const geometry of renderNativeSuite().geometries) {
      expect(geometry.gutter).toBe(9);
      const railWidth = geometry.mode === 'collapsed' ? 56 : 208;
      expect(geometry.rail).toMatchObject({ left: 0, right: railWidth, width: railWidth });
      expect(geometry.nav.right).toBeLessThanOrEqual(railWidth);
      expect(geometry.footer.right).toBeLessThanOrEqual(railWidth);
      if (geometry.mode === 'open' || geometry.mode === 'work' || geometry.mode === 'timeline') {
        const contentWidth = geometry.mode === 'work' ? 340 : 420;
        const oldEdge = 208 + contentWidth;
        expect(geometry.persistedWidth).toBe(`${contentWidth}px`);
        expect(geometry.contentWidth).toBe(`${contentWidth}px`);
        expect(geometry.outerWidth).toBe(`calc(${contentWidth}px + 9px)`);
        expect(geometry.sidebar).toMatchObject({ left: 208, right: oldEdge, width: contentWidth });
        expect(geometry.sidebarHeader!.right).toBe(oldEdge);
        expect(geometry.sidebarBody!.right).toBe(oldEdge);
        expect(geometry.sidebarFooter!.right).toBe(oldEdge);
        expect(geometry.search!.right).toBe(oldEdge);
        expect(geometry.handle).toMatchObject({ left: oldEdge, right: oldEdge, width: 0 });
        expect(geometry.handleHit).toMatchObject({ left: oldEdge - 10, right: oldEdge, width: 10 });
        expect(geometry.sidebarStrip).toBeNull();
        expect(geometry.separator).toMatchObject({ left: oldEdge, right: oldEdge + 9, width: 9 });
        expect(geometry.main.left).toBe(oldEdge + 9);
        expect(geometry.header.right).toBe(oldEdge + 9);
        expect(geometry.identity.right).toBe(oldEdge);
        expect(geometry.edge.right).toBe(oldEdge + 10);
        expect(geometry.footerDivider).toMatchObject({ left: railWidth, right: oldEdge + 9, width: contentWidth + 9 });
      } else {
        const physicalEdge = railWidth + 9;
        expect(geometry.identity.right).toBe(railWidth);
        expect(geometry.mark).toMatchObject({
          left: geometry.mode === 'collapsed' ? 14 : 90,
          right: geometry.mode === 'collapsed' ? 42 : 118,
          width: 28,
        });
        expect(geometry.main.left).toBe(physicalEdge);
        expect(geometry.header.right).toBe(physicalEdge);
        expect(geometry.edge.right).toBe(physicalEdge + 1);
        expect(geometry.footerDivider).toMatchObject({ left: railWidth, right: physicalEdge, width: 9 });
      }
    }
  }, 20_000);

  it('paints one non-flat 9px falloff and one exact divider through header, body, and Timeline inspector', () => {
    const suite = renderNativeSuite();
    try {
      for (const geometry of suite.geometries) {
        const boundary = Math.round(geometry.main.left);
        const segments = geometry.mode === 'timeline' ? [['header', 24], ['body', 80], ['footer', 120]] as const : [['header', 24], ['body', 96]] as const;
        for (const [segment, y] of segments) {
          const profile = pixelsAt(suite.screenshot, boundary - 9, Math.round(geometry.rowTop + y), 11);
          expect(profile).toHaveLength(11);
          const strip = profile.slice(0, 9).map((pixel) => pixel.red);
          expect(new Set(strip).size, `${geometry.theme}/${geometry.mode}/${segment}: ${strip.join(',')}`).toBeGreaterThan(1);
          expect(strip[0]).toBeGreaterThan(strip[8]!);
          expect(profile[9], `${geometry.theme}/${geometry.mode}/${segment} divider`).toEqual(
            geometry.theme === 'dark'
              ? { red: 67, green: 67, blue: 67 }
              : { red: 215, green: 215, blue: 216 },
          );
          expect(profile[10], `${geometry.theme}/${geometry.mode}/${segment} main`).toEqual(
            geometry.theme === 'dark'
              ? { red: 24, green: 24, blue: 24 }
              : { red: 255, green: 255, blue: 255 },
          );
        }
        if (geometry.searchBottom !== null) {
          const stripBelow = pixelsAt(suite.screenshot, boundary - 1, Math.round(geometry.searchBottom + 5), 1)[0];
          const separatorBand = [-3, -2, -1, 0, 1, 2, 3].map((offset) =>
            pixelsAt(suite.screenshot, boundary - 1, Math.round(geometry.searchBottom + offset), 1)[0],
          );
          expect(
            separatorBand.some((pixel) => JSON.stringify(pixel) !== JSON.stringify(stripBelow)),
            `${geometry.theme}/${geometry.mode} separator outer edge: ${JSON.stringify(separatorBand)}`,
          ).toBe(true);
        }
        expect(geometry.edgeShadow).toBe('none');
      }
    } finally {
      suite.cleanup();
      cache = null;
    }
  });

  it('keeps active and mirrored sites on one shared paint and shadow contract', () => {
    const active = ruleBody(base, '.app-shell::after');
    const mirrors = ruleBody(base, '.app-shell--codex-iab::before');
    for (const owner of [active, mirrors]) {
      expect(owner).toContain('var(--shadow-app-subdivision-paint)');
    }
    expect(mirrors).toContain('box-shadow: var(--shadow-app-subdivision)');
    expect(mirrors).toContain('--app-boundary-shadow-direction: to left');
    expect(base).not.toMatch(/agent_session|19422|user-agent|location\.search/);
    expect(base).not.toMatch(/(?:app-header|app-layout|view-sidebar)::after\s*\{[^}]*shadow-app-subdivision-paint/s);
  });
});
