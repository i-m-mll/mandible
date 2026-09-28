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
  leftShadowEdgeWidth: string;
};

type HeaderMode = 'open' | 'hidden' | 'collapsed';

type HeaderFixture = {
  width: number;
  route: string;
  theme: 'dark' | 'light';
  leftShadow: boolean;
  scale: number;
  gutterWidth: number;
  mode: HeaderMode;
};

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
const preview = readFileSync(resolve('ui/src/components/shared/PreviewCopyNotice.css'), 'utf8');
const detailPaneShell = readFileSync(resolve('ui/src/styles/detail-pane-shell.css'), 'utf8');
const iconTabList = readFileSync(resolve('ui/src/styles/icon-tab-list.css'), 'utf8');
const tauriConfig = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8')) as {
  app: { windows: Array<{ trafficLightPosition: { y: number } }> };
};
const APPKIT_TRAFFIC_LIGHT_BUTTON_HEIGHT = 14;
const APPKIT_TRAFFIC_LIGHT_BUTTON_BOTTOM_INSET = 9;

type NativeChromeGeometry = {
  leftHeader: DOMRectSnapshot;
  leftIdentity: DOMRectSnapshot;
  leftMark: DOMRectSnapshot;
  leftHeaderPaddingTop: string;
  compactShellHeader: DOMRectSnapshot;
  compactHeader: DOMRectSnapshot;
  compactAction: DOMRectSnapshot;
  rightHeader: DOMRectSnapshot;
  rightTab: DOMRectSnapshot;
  rightToggle: DOMRectSnapshot;
  rightRows: string;
};

function normalizeFixture({
  width,
  route,
  theme,
  leftShadow = false,
  scale = 1,
  gutterWidth = 0,
  mode = 'open',
}: {
  width: number;
  route: string;
  theme: 'dark' | 'light';
  leftShadow?: boolean;
  scale?: number;
  gutterWidth?: number;
  mode?: HeaderMode;
}): HeaderFixture {
  return { width, route, theme, leftShadow, scale, gutterWidth, mode };
}

function fixtureKey(fixture: HeaderFixture): string {
  return JSON.stringify(fixture);
}

function fixtureMarkup({ width, route, theme, leftShadow, gutterWidth, mode }: HeaderFixture): string {
  const open = mode === 'open';

  return `<div class="app-shell${open ? ' app-shell--view-sidebar-open' : ''}${mode === 'collapsed' ? ' app-shell--rail-icons' : ''}${leftShadow ? ' app-shell--left-shadow' : ''}"
    style="--app-shadow-gutter-width: ${gutterWidth}px; --app-view-sidebar-persisted-width: ${Math.max(0, width - 208)}px; --app-view-sidebar-width: ${Math.max(0, width - 208)}px">
    <div class="app-shell__workspace">
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
  </div>`;
}

function renderHeaderSuite(fixtures: HeaderFixture[]): { geometries: Map<string, HeaderGeometry>; launchCount: number } {
  if (!chrome) throw new Error('A Chromium browser is required for the AppHeader geometry regression.');

  const uniqueFixtures = [...new Map(fixtures.map((fixture) => [fixtureKey(fixture), fixture])).values()];
  const geometries = new Map<string, HeaderGeometry>();
  const scales = [...new Set(uniqueFixtures.map(({ scale }) => scale))];

  for (const scale of scales) {
    const cases = uniqueFixtures
      .filter((fixture) => fixture.scale === scale)
      .map((fixture) => ({
        key: fixtureKey(fixture),
        width: fixture.width,
        theme: fixture.theme,
        markup: fixtureMarkup(fixture),
      }));
    const payload = JSON.stringify({ cases, styles: `${tokens}\n${base}\n${preview}` }).replaceAll('<', '\\u003c');
    const html = `<!doctype html><html><body><script>
      const { cases, styles } = ${payload};
      const results = [];
      const snapshot = (doc, selector) => {
        const node = doc.querySelector(selector);
        if (!node) return null;
        const bounds = node.getBoundingClientRect();
        return Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, bounds[key]]));
      };
      const measure = (entry, frame) => {
        const doc = frame.contentDocument;
        const route = doc.querySelector('.app-header__route');
        const logoStyle = getComputedStyle(doc.querySelector('.app-header__logo'));
        const shell = doc.querySelector('.app-shell');
        const workspace = doc.querySelector('.app-shell__workspace');
        const edgeStyle = getComputedStyle(shell, '::before');
        const gutterStyle = getComputedStyle(workspace, '::after');
        results.push([entry.key, {
          devicePixelRatio: frame.contentWindow.devicePixelRatio,
          header: snapshot(doc, '.app-header'),
          identity: snapshot(doc, '.app-header__identity'),
          mark: snapshot(doc, '.app-header__mark'),
          logo: snapshot(doc, '.app-header__logo'),
          brand: snapshot(doc, '.app-header__brand-text'),
          route: snapshot(doc, '.app-header__route'),
          routeText: route?.textContent ?? null,
          routeOverflow: route ? getComputedStyle(route).overflow : null,
          routeTextOverflow: route ? getComputedStyle(route).textOverflow : null,
          routeWhiteSpace: route ? getComputedStyle(route).whiteSpace : null,
          routeScrollWidth: route?.scrollWidth ?? null,
          routeClientWidth: route?.clientWidth ?? null,
          routeAriaLive: route?.getAttribute('aria-live') ?? null,
          logoColor: logoStyle.color,
          navIconColor: getComputedStyle(doc.querySelector('.app-rail__icon')).color,
          brandColor: doc.querySelector('.app-header__brand') ? getComputedStyle(doc.querySelector('.app-header__brand')).color : null,
          logoMaskImage: logoStyle.webkitMaskImage,
          logoMaskPosition: logoStyle.webkitMaskPosition,
          logoMaskRepeat: logoStyle.webkitMaskRepeat,
          logoMaskSize: logoStyle.webkitMaskSize,
          shadowGutterWidth: getComputedStyle(shell).getPropertyValue('--app-shadow-gutter-width').trim(),
          headerGutterWidth: gutterStyle.width,
          headerGutterRight: gutterStyle.right,
          headerGutterZIndex: gutterStyle.zIndex,
          identityZIndex: getComputedStyle(doc.querySelector('.app-header__identity')).zIndex,
          leftShadowEdgeWidth: edgeStyle.width,
        }]);
        if (results.length === cases.length) document.title = btoa(JSON.stringify(results));
      };
      for (const entry of cases) {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'display:block;border:0;width:' + entry.width + 'px;height:240px';
        frame.addEventListener('load', () => measure(entry, frame), { once: true });
        frame.srcdoc = '<!doctype html><html data-theme="' + entry.theme + '"><head><style>' + styles + '</style></head><body>' + entry.markup + '</body></html>';
        document.body.append(frame);
      }
    </script></body></html>`;
    const rendered = spawnSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--force-device-scale-factor=${scale}`,
      '--dump-dom',
      '--window-size=1200,800',
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    ], { encoding: 'utf8', maxBuffer: 10_000_000 });
    if (rendered.status !== 0) throw new Error(`Chromium AppHeader fixture failed: ${rendered.stderr}`);
    const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
    if (!encoded) throw new Error('Chromium AppHeader fixture did not return measurements.');
    for (const [key, geometry] of JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as [string, HeaderGeometry][]) {
      geometries.set(key, geometry);
    }
  }

  return { geometries, launchCount: scales.length };
}

function renderNativeChromeGeometry(): NativeChromeGeometry {
  if (!chrome) throw new Error('A Chromium browser is required for the native header geometry regression.');

  const styles = `${tokens}\n${base}\n${preview}\n${detailPaneShell}\n${iconTabList}`;
  const html = `<!doctype html><html data-theme="light"><head><style>
    html, body { width: 100%; height: 100%; margin: 0; }
    #app { width: 100vw; height: 100vh; }
    ${styles}
  </style></head><body>
      <div id="app" class="tauri-window">
        <div class="app-shell" style="--app-right-sidebar-width: 320px">
          <div class="app-shell__workspace">
            <header class="app-header">
              <div class="app-header__identity">
                <span class="app-header__mark"><span class="app-header__logo"></span></span>
              </div>
            </header>
            <div class="app-layout app-layout--right-sidebar-docked">
              <aside class="app-rail"></aside>
              <main class="app-content app-content--view-sidebar">
                <section class="detail-pane-shell detail-pane-shell--compact">
                  <header class="detail-pane-shell__header">
                    <div class="detail-pane-shell__header-primary">
                      <div class="detail-pane-header detail-pane-header--compact">
                        <div class="detail-pane-header__main">
                          <div class="detail-pane-header__title-row"><h2 class="detail-pane-header__title">Conversation</h2></div>
                          <div class="detail-pane-header__actions" role="group">
                            <button class="app-right-sidebar-toggle" aria-label="Open details">Details</button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </header>
                </section>
              </main>
              <aside class="app-right-sidebar">
                <header class="app-right-sidebar__header">
                  <div class="icon-tab-list app-right-sidebar__tabs"><button aria-selected="true">Graph</button></div>
                  <button class="app-right-sidebar-toggle app-right-sidebar__toggle" aria-label="Hide details">Hide</button>
                </header>
                <div class="app-right-sidebar__body"></div>
              </aside>
            </div>
          </div>
      </div>
    </div>
    <script>
      const snap = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, rect[key]]));
      };
      const geometry = {
        leftHeader: snap('.app-header'),
        leftIdentity: snap('.app-header__identity'),
        leftMark: snap('.app-header__mark'),
        leftHeaderPaddingTop: getComputedStyle(document.querySelector('.app-header')).paddingTop,
        compactShellHeader: snap('.detail-pane-shell__header'),
        compactHeader: snap('.detail-pane-header--compact'),
        compactAction: snap('.detail-pane-header__actions button'),
        rightHeader: snap('.app-right-sidebar__header'),
        rightTab: snap('.app-right-sidebar__tabs > button'),
        rightToggle: snap('.app-right-sidebar__toggle'),
        rightRows: getComputedStyle(document.querySelector('.app-right-sidebar')).gridTemplateRows,
      };
      document.title = btoa(JSON.stringify(geometry));
    </script>
  </body></html>`;
  const rendered = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--dump-dom',
    '--window-size=1200,800',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 2_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium native-header fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium native-header fixture did not return measurements.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as NativeChromeGeometry;
}

const fixtures = [
  ...([1100, 700] as const).flatMap((width) => (['dark', 'light'] as const).map((theme) =>
    normalizeFixture({ width, route: 'Timeline', theme }),
  )),
  ...(['hidden', 'collapsed'] as const).flatMap((mode) => (['dark', 'light'] as const).map((theme) =>
    normalizeFixture({ width: 700, route: 'Timeline', theme, mode }),
  )),
  normalizeFixture({ width: 700, route: 'Issues', theme: 'light' }),
  normalizeFixture({ width: 360, route: 'Operational incidents requiring immediate attention', theme: 'dark' }),
  ...(['dark', 'light'] as const).map((theme) => normalizeFixture({ width: 700, route: 'Spaces', theme })),
  normalizeFixture({ width: 700, route: 'Conversations', theme: 'dark', leftShadow: true, scale: 2 }),
];
const renderedHeaderSuite = renderHeaderSuite(fixtures);

function renderHeader(input: Parameters<typeof normalizeFixture>[0]): HeaderGeometry {
  const fixture = normalizeFixture(input);
  const geometry = renderedHeaderSuite.geometries.get(fixtureKey(fixture));
  if (!geometry) throw new Error(`Missing batched AppHeader fixture: ${fixtureKey(fixture)}`);
  return geometry;
}

function expectSharedGeometry(geometry: HeaderGeometry, width: number, responsiveInset: number): void {
  const physicalWidth = width;
  expect(geometry.header).toMatchObject({ left: 0, top: 0, right: physicalWidth, width: physicalWidth, height: 48 });
  expect(geometry.identity).toMatchObject({ left: 0, right: width, width, height: 28 });
  expect(geometry.mark).toMatchObject({ left: responsiveInset, top: 9.5, width: 28, height: 28 });
  expect(geometry.logo).toMatchObject(geometry.mark);
  expect(geometry.brand!.left).toBe(208 + responsiveInset);
  expect(geometry.headerGutterWidth).toBe('18px');
  expect(Number(geometry.headerGutterZIndex)).toBeGreaterThan(Number(geometry.identityZIndex));
  expect(Math.abs((geometry.route!.left + geometry.route!.right) / 2 - (geometry.brand!.right + width) / 2))
    .toBeLessThanOrEqual(0.5);
}

describe('shared AppHeader rendered geometry', () => {
  it('batches every unique fixture into one Chromium launch per device scale', () => {
    expect(renderedHeaderSuite.launchCount).toBe(2);
    expect(renderedHeaderSuite.geometries.size).toBe(13);
  });

  it.each([
    { width: 1100, theme: 'dark' as const },
    { width: 1100, theme: 'light' as const },
    { width: 700, theme: 'dark' as const },
    { width: 700, theme: 'light' as const },
  ])('keeps the physical edge and content coordinates unshifted at $width px in $theme', ({ width, theme }) => {
    const geometry = renderHeader({ width, route: 'Timeline', theme });

    expect(geometry.shadowGutterWidth).toBe('0px');
    expect(geometry.header).toMatchObject({ left: 0, right: width, width });
    expect(geometry.identity).toMatchObject({ left: 0, right: width, width });
    expect(geometry.mark.width).toBe(28);
    expect(geometry.logo).toMatchObject(geometry.mark);
    expect(geometry.brand!.left).toBe(208 + (width <= 800 ? 10 : 14));
  });

  it.each([
    { mode: 'hidden' as const, theme: 'dark' as const },
    { mode: 'hidden' as const, theme: 'light' as const },
    { mode: 'collapsed' as const, theme: 'dark' as const },
    { mode: 'collapsed' as const, theme: 'light' as const },
  ])('keeps $mode header and identity coordinates fixed with zero reservation in $theme', ({ mode, theme }) => {
    const geometry = renderHeader({ width: 700, route: 'Timeline', theme, mode });
    const railWidth = mode === 'collapsed' ? 56 : 208;

    expect(geometry.shadowGutterWidth).toBe('0px');
    expect(geometry.header).toMatchObject({ left: 0, right: railWidth, width: railWidth });
    expect(geometry.identity).toMatchObject({ left: 0, right: railWidth, width: railWidth });
    expect(geometry.mark.width).toBe(28);
    expect(geometry.logo).toMatchObject(geometry.mark);
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

  it('translates chrome content after the optional left boundary at high DPI', () => {
    const geometry = renderHeader({ width: 700, route: 'Conversations', theme: 'dark', leftShadow: true, scale: 2 });

    expect(geometry.devicePixelRatio).toBe(2);
    expect(geometry.shadowGutterWidth).toBe('0px');
    expect(geometry.headerGutterWidth).toBe('18px');
    expect(geometry.leftShadowEdgeWidth).toBe('17px');
    expect(geometry.header).toMatchObject({ left: 0, right: 717, width: 717 });
    expect(geometry.identity).toMatchObject({ left: 17, right: 717, width: 700 });
    expect(geometry.mark).toMatchObject({ left: 27, right: 55, width: 28 });
    expect(geometry.brand!.left).toBe(235);
    expect(geometry.logo).toMatchObject({ width: 28, height: 28 });
  });

  it('confines the native titlebar inset to left chrome and centers 48px content actions', () => {
    const geometry = renderNativeChromeGeometry();
    const centerY = ({ top, height }: DOMRectSnapshot) => top + height / 2;
    const expectCentered = (action: DOMRectSnapshot, row: DOMRectSnapshot) => {
      expect(Math.abs(centerY(action) - centerY(row))).toBeLessThanOrEqual(0.5);
    };

    const trafficLightBottom = tauriConfig.app.windows[0]!.trafficLightPosition.y
      + APPKIT_TRAFFIC_LIGHT_BUTTON_HEIGHT
      - APPKIT_TRAFFIC_LIGHT_BUTTON_BOTTOM_INSET;
    const priorLogoTop = 44 + (48 - 1 - 28) / 2;
    const priorGap = priorLogoTop - trafficLightBottom;
    const currentGap = geometry.leftMark.top - trafficLightBottom;

    expect(geometry.leftHeader).toMatchObject({ top: 0, height: 78.75 });
    expect(geometry.leftHeaderPaddingTop).toBe('30.75px');
    expect(geometry.leftIdentity.top).toBeCloseTo(40.25);
    expect(geometry.leftMark.top).toBeCloseTo(40.25);
    expect(currentGap).toBeCloseTo(priorGap / 2);

    expect(geometry.compactShellHeader).toMatchObject({ top: 0, height: 48 });
    expect(geometry.compactHeader).toMatchObject({ top: 0, height: 48 });
    expect(geometry.compactAction.height).toBe(34);
    expectCentered(geometry.compactAction, geometry.compactHeader);

    expect(geometry.rightRows.split(' ')[0]).toBe('48px');
    expect(geometry.rightHeader).toMatchObject({ top: 0, height: 48 });
    expect(geometry.rightTab).toMatchObject({ top: 0, height: 48 });
    expect(geometry.rightToggle.height).toBe(34);
    expectCentered(geometry.rightToggle, geometry.rightHeader);
  });
});
