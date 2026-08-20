import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type HeaderGeometry = {
  devicePixelRatio: number;
  header: DOMRectSnapshot;
  identity: DOMRectSnapshot;
  mark: DOMRectSnapshot;
  logo: DOMRectSnapshot;
  brand: DOMRectSnapshot | null;
  route: DOMRectSnapshot | null;
  routeText: string | null;
  routeOverflow: string | null;
  routeTextOverflow: string | null;
  routeWhiteSpace: string | null;
  routeScrollWidth: number | null;
  routeClientWidth: number | null;
  routeAriaLive: string | null;
  logoColor: string;
  navIconColor: string;
  brandColor: string | null;
  logoMaskImage: string;
  logoMaskPosition: string;
  logoMaskRepeat: string;
  logoMaskSize: string;
  shadowGutterWidth: string;
  headerGutterWidth: string;
  headerGutterRight: string;
  headerGutterZIndex: string;
  identityZIndex: string;
  iabEdgeWidth: string;
};

type HeaderMode = 'open' | 'hidden' | 'collapsed';

type DOMRectSnapshot = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;

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

function renderHeader({
  width,
  route,
  theme,
  codexIab = false,
  scale = 1,
  gutterWidth = 17,
  mode = 'open',
}: {
  width: number;
  route: string;
  theme: 'dark' | 'light';
  codexIab?: boolean;
  scale?: number;
  gutterWidth?: number;
  mode?: HeaderMode;
}): HeaderGeometry {
  if (!chrome) throw new Error('A Chromium browser is required for the AppHeader geometry regression.');

  const open = mode === 'open';

  const html = `<!doctype html>
    <html data-theme="${theme}">
      <head><style>${tokens}\n${base}</style></head>
      <body>
        <div class="app-shell${open ? ' app-shell--view-sidebar-open' : ''}${mode === 'collapsed' ? ' app-shell--rail-icons' : ''}${codexIab ? ' app-shell--codex-iab' : ''}"
          style="--app-shadow-gutter-width: ${gutterWidth}px; --app-view-sidebar-persisted-width: ${Math.max(0, width - 208)}px; --app-view-sidebar-width: ${Math.max(0, width - 208)}px">
          <header class="app-header${open ? '' : ' app-header--sidebar-hidden'}" data-app-surface="chrome">
            <div class="app-header__identity">
              <span class="app-header__mark" aria-hidden="true">
                <span class="app-header__logo" style="--app-header-logo-image: url('/header-logo.svg')" aria-hidden="true"></span>
              </span>
              ${open ? `<div class="app-header__text">
                <div class="app-header__brand"><span class="app-header__brand-text">Mandible</span></div>
                <div class="app-header__route" aria-live="polite">${route}</div>
              </div>` : ''}
            </div>
          </header>
          <aside class="app-rail">
            <a class="app-rail__item"><span class="app-rail__icon">N</span></a>
          </aside>
        </div>
        <script>
          const snapshot = (selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const bounds = node.getBoundingClientRect();
            return Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, bounds[key]]));
          };
          const route = document.querySelector('.app-header__route');
          const logoStyle = getComputedStyle(document.querySelector('.app-header__logo'));
          const header = document.querySelector('.app-header');
          const edgeStyle = getComputedStyle(header, '::before');
          const gutterStyle = getComputedStyle(header, '::after');
          document.title = btoa(JSON.stringify({
            devicePixelRatio,
            header: snapshot('.app-header'),
            identity: snapshot('.app-header__identity'),
            mark: snapshot('.app-header__mark'),
            logo: snapshot('.app-header__logo'),
            brand: snapshot('.app-header__brand-text'),
            route: snapshot('.app-header__route'),
            routeText: route?.textContent ?? null,
            routeOverflow: route ? getComputedStyle(route).overflow : null,
            routeTextOverflow: route ? getComputedStyle(route).textOverflow : null,
            routeWhiteSpace: route ? getComputedStyle(route).whiteSpace : null,
            routeScrollWidth: route?.scrollWidth ?? null,
            routeClientWidth: route?.clientWidth ?? null,
            routeAriaLive: route?.getAttribute('aria-live') ?? null,
            logoColor: logoStyle.color,
            navIconColor: getComputedStyle(document.querySelector('.app-rail__icon')).color,
            brandColor: document.querySelector('.app-header__brand') ? getComputedStyle(document.querySelector('.app-header__brand')).color : null,
            logoMaskImage: logoStyle.webkitMaskImage,
            logoMaskPosition: logoStyle.webkitMaskPosition,
            logoMaskRepeat: logoStyle.webkitMaskRepeat,
            logoMaskSize: logoStyle.webkitMaskSize,
            shadowGutterWidth: getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--app-shadow-gutter-width').trim(),
            headerGutterWidth: gutterStyle.width,
            headerGutterRight: gutterStyle.right,
            headerGutterZIndex: gutterStyle.zIndex,
            identityZIndex: getComputedStyle(document.querySelector('.app-header__identity')).zIndex,
            iabEdgeWidth: edgeStyle.width,
          }));
        </script>
      </body>
    </html>`;
  const rendered = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--force-device-scale-factor=${scale}`,
    '--dump-dom',
    `--window-size=${width},240`,
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium AppHeader fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium AppHeader fixture did not return measurements.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as HeaderGeometry;
}

function expectSharedGeometry(geometry: HeaderGeometry, width: number, responsiveInset: number): void {
  const physicalWidth = width + 17;
  expect(geometry.header).toMatchObject({ left: 0, top: 0, right: physicalWidth, width: physicalWidth, height: 48 });
  expect(geometry.identity).toMatchObject({ left: 0, right: width, width, height: 28 });
  expect(geometry.mark).toMatchObject({ left: responsiveInset, top: 9.5, width: 28, height: 28 });
  expect(geometry.logo).toMatchObject(geometry.mark);
  expect(geometry.brand!.left).toBe(208 + responsiveInset);
  expect(geometry.headerGutterWidth).toBe('18px');
  expect(geometry.headerGutterRight).toBe('-1px');
  expect(Number(geometry.headerGutterZIndex)).toBeGreaterThan(Number(geometry.identityZIndex));
  expect(Math.abs((geometry.route!.left + geometry.route!.right) / 2 - (geometry.brand!.right + width) / 2))
    .toBeLessThanOrEqual(0.5);
}

function expectRectInvariant(before: DOMRectSnapshot, after: DOMRectSnapshot): void {
  for (const coordinate of ['left', 'top', 'right', 'bottom', 'width', 'height'] as const) {
    expect(Math.abs(after[coordinate] - before[coordinate]), coordinate).toBeLessThanOrEqual(0.01);
  }
}

describe('shared AppHeader rendered geometry', () => {
  it.each([
    { width: 1100, theme: 'dark' as const },
    { width: 1100, theme: 'light' as const },
    { width: 700, theme: 'dark' as const },
    { width: 700, theme: 'light' as const },
  ])('moves only the physical right edge when adding the 17px strip at $width px in $theme', ({ width, theme }) => {
    const baseline = renderHeader({ width, route: 'Timeline', theme, gutterWidth: 0 });
    const additive = renderHeader({ width, route: 'Timeline', theme });

    expect(additive.header.right - baseline.header.right).toBe(17);
    expect(additive.header.width - baseline.header.width).toBe(17);
    expectRectInvariant(
      { ...baseline.header, right: additive.header.right, width: additive.header.width },
      additive.header,
    );
    for (const rect of ['identity', 'mark', 'logo', 'brand', 'route'] as const) {
      expectRectInvariant(baseline[rect]!, additive[rect]!);
    }
  });

  it.each([
    { mode: 'hidden' as const, theme: 'dark' as const },
    { mode: 'hidden' as const, theme: 'light' as const },
    { mode: 'collapsed' as const, theme: 'dark' as const },
    { mode: 'collapsed' as const, theme: 'light' as const },
  ])('keeps $mode identity coordinates fixed when adding the strip in $theme', ({ mode, theme }) => {
    const baseline = renderHeader({ width: 700, route: 'Timeline', theme, gutterWidth: 0, mode });
    const additive = renderHeader({ width: 700, route: 'Timeline', theme, mode });

    expect(additive.header.right - baseline.header.right).toBe(17);
    expect(additive.header.width - baseline.header.width).toBe(17);
    expectRectInvariant(
      { ...baseline.header, right: additive.header.right, width: additive.header.width },
      additive.header,
    );
    for (const rect of ['identity', 'mark', 'logo'] as const) {
      expectRectInvariant(baseline[rect], additive[rect]);
    }
  });

  it.each([
    { width: 1100, route: 'Timeline', theme: 'dark' as const, inset: 14 },
    { width: 700, route: 'Issues', theme: 'light' as const, inset: 10 },
  ])('centers $route between the wordmark endpoint and header edge at $width px', ({ width, route, theme, inset }) => {
    const geometry = renderHeader({ width, route, theme });

    expectSharedGeometry(geometry, width, inset);
    expect(geometry.routeText).toBe(route);
    expect(geometry.routeAriaLive).toBe('polite');
    expect(geometry.routeOverflow).toBe('hidden');
    expect(geometry.routeTextOverflow).toBe('ellipsis');
    expect(geometry.routeWhiteSpace).toBe('nowrap');
  });

  it('keeps the full accessible route name while truncating it at a narrow responsive width', () => {
    const route = 'Operational incidents requiring immediate attention';
    const geometry = renderHeader({ width: 360, route, theme: 'dark' });

    expectSharedGeometry(geometry, 360, 10);
    expect(geometry.routeText).toBe(route);
    expect(geometry.routeAriaLive).toBe('polite');
    expect(geometry.routeScrollWidth).toBeGreaterThan(geometry.routeClientWidth);
  });

  it.each(['dark', 'light'] as const)('uses the default navigation icon foreground in the %s theme', (theme) => {
    const geometry = renderHeader({ width: 700, route: 'Spaces', theme });

    expect(geometry.logoColor).toBe(geometry.navIconColor);
    expect(geometry.logoMaskImage).toContain('header-logo.svg');
    expect(geometry.logoMaskPosition).toBe('50% 50%');
    expect(geometry.logoMaskRepeat).toBe('no-repeat');
    expect(geometry.logoMaskSize).toBe('contain');
    expect(geometry.logo).toMatchObject({ width: 28, height: 28 });
  });

  it.each([
    ['dark', 'rgb(116, 116, 116)'],
    ['light', 'rgb(168, 169, 169)'],
  ] as const)('uses the independent AppHeader app-name color in the %s theme', (theme, expected) => {
    const geometry = renderHeader({ width: 700, route: 'Spaces', theme });

    expect(geometry.brandColor).toBe(expected);
  });

  it('keeps all coordinates and the midpoint invariant with the non-participating IAB edge at high DPI', () => {
    const geometry = renderHeader({ width: 700, route: 'Conversations', theme: 'dark', codexIab: true, scale: 2 });

    expectSharedGeometry(geometry, 700, 10);
    expect(geometry.devicePixelRatio).toBe(2);
    expect(geometry.shadowGutterWidth).toBe('17px');
    expect(geometry.headerGutterWidth).toBe('18px');
    expect(geometry.iabEdgeWidth).toBe('17px');
    expect(geometry.logo).toMatchObject({ width: 28, height: 28 });
  });
});
