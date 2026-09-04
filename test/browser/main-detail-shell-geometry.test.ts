import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Edges = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type RailMode = 'expanded' | 'icons';
type SidebarMode = 'shown' | 'hidden';
type ChatState = 'loading' | 'error' | 'not-found' | 'conversation' | 'live-session' | 'no-selection';
type Surface = `chat-${ChatState}` | 'graph' | 'timeline';
type Fixture = { width: 1280 | 835; rail: RailMode; sidebar: SidebarMode; surface: Surface };
type Geometry = Fixture & {
  appHeader: Edges;
  railRect: Edges;
  sidebarRect: Edges | null;
  main: Edges;
  mainShell: Edges | null;
  mainHeader: Edges | null;
  mainBody: Edges | null;
  mainFooter: Edges | null;
  panel: Edges | null;
  panelShell: Edges | null;
  panelHeader: Edges | null;
  panelBody: Edges | null;
  mainSlots: Array<string | null>;
  panelSlots: Array<string | null>;
};

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate)).find(existsSync);

const styles = [
  'ui/src/styles/tokens.css',
  'ui/src/styles/base.css',
  'ui/src/styles/chat-history.css',
  'ui/src/styles/conversations.css',
  'ui/src/styles/detail-pane-shell.css',
  'ui/src/styles/graph.css',
  'ui/src/styles/timeline.css',
].map((path) => readFileSync(resolve(path), 'utf8')).join('\n');

const chatStates: ChatState[] = ['loading', 'error', 'not-found', 'conversation', 'live-session', 'no-selection'];
const fixtures: Fixture[] = ([1280, 835] as const).flatMap((width) =>
  (['expanded', 'icons'] as const).flatMap((rail) =>
    (['shown', 'hidden'] as const).flatMap((sidebar) => [
      ...chatStates.map((state): Fixture => ({ width, rail, sidebar, surface: `chat-${state}` })),
      { width, rail, sidebar, surface: 'graph' },
      { width, rail, sidebar, surface: 'timeline' },
    ]),
  ),
);

function shellMarkup(className: string, footer: boolean): string {
  return `<section class="detail-pane-shell detail-pane-shell--compact ${className}">
    <header class="detail-pane-shell__header" data-detail-pane-slot="header"><div class="detail-pane-header detail-pane-header--compact">Header</div></header>
    <div class="detail-pane-shell__body" data-detail-pane-slot="body">Body</div>
    ${footer ? '<footer class="detail-pane-shell__footer" data-detail-pane-slot="footer">Footer</footer>' : ''}
    <div class="detail-pane-shell__overlay-host" data-detail-pane-slot="overlay-host"></div>
  </section>`;
}

function fixtureMarkup(fixture: Fixture): string {
  const sidebarShown = fixture.sidebar === 'shown';
  const panelSurface = fixture.surface === 'graph' || fixture.surface === 'timeline';
  const shellClass = fixture.surface.startsWith('chat-')
    ? `chat-detail-frame chat-detail-frame--${fixture.surface.slice(5)}`
    : 'fixture-main-shell';
  const mainShell = shellMarkup(shellClass, fixture.surface === 'chat-conversation');
  const panelShell = fixture.surface === 'graph'
    ? shellMarkup('graph-detail-pane', false)
    : fixture.surface === 'timeline'
      ? shellMarkup('timeline-inspector', false)
      : '';
  return `<div class="app-shell${sidebarShown ? ' app-shell--view-sidebar-open' : ''}${fixture.rail === 'icons' ? ' app-shell--rail-icons' : ''}">
    <header class="app-header${sidebarShown ? '' : ' app-header--sidebar-hidden'}"><div class="app-header__identity"></div></header>
    <div class="app-layout${sidebarShown ? ' app-layout--view-sidebar-open' : ''}${fixture.rail === 'icons' ? ' app-layout--rail-icons' : ''}${panelSurface ? ' app-layout--bottom-panel-open' : ''}">
      <aside class="app-rail"></aside>
      <main class="app-content app-content--console app-content--view-sidebar">
        <div class="app-tab-panel"><div class="chat-history-view">
          ${sidebarShown ? '<aside class="view-sidebar chat-history-sidebar" style="width:var(--app-view-sidebar-width);flex-shrink:0"></aside>' : ''}
          <div class="chat-history-detail">${mainShell}</div>
        </div></div>
      </main>
      ${panelSurface ? `<aside class="app-bottom-panel"><div class="app-bottom-panel__content">${panelShell}</div></aside>` : ''}
    </div>
  </div>`;
}

let geometryCache: Geometry[] | null = null;

function renderGeometrySuite(): Geometry[] {
  if (geometryCache) return geometryCache;
  if (!chrome) throw new Error('A Chromium browser is required for the main-detail shell geometry regression.');
  const groups = ([1280, 835] as const).flatMap((width) =>
    (['expanded', 'icons'] as const).flatMap((rail) =>
      (['shown', 'hidden'] as const).map((sidebar) => ({
        width,
        rail,
        sidebar,
        cases: fixtures
          .filter((fixture) => fixture.width === width && fixture.rail === rail && fixture.sidebar === sidebar)
          .map((fixture) => ({ ...fixture, markup: fixtureMarkup(fixture) })),
      })),
    ),
  );
  const payload = JSON.stringify({ groups, styles }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html><body><script>
    const { groups, styles } = ${payload};
    const results = [];
    const rect = (root, selector) => {
      const node = root.querySelector(selector);
      if (!node) return null;
      const bounds = node.getBoundingClientRect();
      return Object.fromEntries(['left', 'right', 'top', 'bottom', 'width', 'height'].map((key) => [key, bounds[key]]));
    };
    const slots = (root, selector) => {
      const node = root.querySelector(selector);
      return node ? Array.from(node.children, (child) => child.getAttribute('data-detail-pane-slot')) : [];
    };
    const measure = (group, frame) => {
      const doc = frame.contentDocument;
      for (const entry of group.cases) {
        const root = doc.querySelector('[data-surface="' + entry.surface + '"]');
        results.push({
          width: entry.width, rail: entry.rail, sidebar: entry.sidebar, surface: entry.surface,
          appHeader: rect(root, '.app-header'), railRect: rect(root, '.app-rail'), sidebarRect: rect(root, '.view-sidebar'),
          main: rect(root, '.chat-history-detail'), mainShell: rect(root, '.chat-history-detail > .detail-pane-shell'),
          mainHeader: rect(root, '.chat-history-detail > .detail-pane-shell > .detail-pane-shell__header'),
          mainBody: rect(root, '.chat-history-detail > .detail-pane-shell > .detail-pane-shell__body'),
          mainFooter: rect(root, '.chat-history-detail > .detail-pane-shell > .detail-pane-shell__footer'),
          panel: rect(root, '.app-bottom-panel'), panelShell: rect(root, '.app-bottom-panel .detail-pane-shell'),
          panelHeader: rect(root, '.app-bottom-panel .detail-pane-shell__header'),
          panelBody: rect(root, '.app-bottom-panel .detail-pane-shell__body'),
          mainSlots: slots(root, '.chat-history-detail > .detail-pane-shell'),
          panelSlots: slots(root, '.app-bottom-panel .detail-pane-shell'),
        });
      }
      if (results.length === ${fixtures.length}) document.title = btoa(JSON.stringify(results));
    };
    for (const group of groups) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'display:block;border:0;width:' + group.width + 'px;height:1px';
      frame.addEventListener('load', () => measure(group, frame), { once: true });
      const markup = group.cases.map((entry) => '<div class="case" data-surface="' + entry.surface + '">' + entry.markup + '</div>').join('');
      frame.srcdoc = '<!doctype html><html><head><style>' + styles + '</style><style>*{box-sizing:border-box}html,body{margin:0;overflow:clip}.case{height:540px}.app-shell{--app-view-sidebar-persisted-width:320px;--app-view-sidebar-width:320px;--app-bottom-panel-height:180px}.app-shell,.app-layout{height:100%}</style></head><body>' + markup + '</body></html>';
      document.body.append(frame);
    }
  </script></body></html>`;
  const rendered = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom', '--window-size=1400,900',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 20_000_000, timeout: 20_000 });
  if (rendered.status !== 0) throw new Error(`Chromium geometry fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium did not emit main-detail shell geometry.');
  geometryCache = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Geometry[];
  return geometryCache;
}

function expectSameHorizontalEdges(actual: Edges | null, expected: Edges): void {
  expect(actual).not.toBeNull();
  expect(actual).toMatchObject({ left: expected.left, right: expected.right, width: expected.width });
}

describe('main-detail shell geometry', () => {
  it('keeps every admitted state and registered panel inside the main column', { timeout: 25_000 }, () => {
    const geometries = renderGeometrySuite();
    expect(geometries).toHaveLength(fixtures.length);

    for (const geometry of geometries) {
      const railWidth = geometry.rail === 'icons' ? 56 : 208;
      const detailLeft = railWidth + (geometry.sidebar === 'shown' ? 320 : 0);
      expect(geometry.railRect).toMatchObject({ left: 0, right: railWidth, width: railWidth });
      expect(geometry.appHeader.right).toBe(detailLeft);
      if (geometry.sidebar === 'shown') {
        expect(geometry.sidebarRect).toMatchObject({ left: railWidth, right: detailLeft, width: 320 });
      } else {
        expect(geometry.sidebarRect).toBeNull();
      }
      expect(geometry.main).toMatchObject({ left: detailLeft, right: geometry.width, width: geometry.width - detailLeft });
      expectSameHorizontalEdges(geometry.mainShell, geometry.main);
      expectSameHorizontalEdges(geometry.mainHeader, geometry.main);
      expectSameHorizontalEdges(geometry.mainBody, geometry.main);
      expect(geometry.mainHeader?.top).toBe(geometry.mainShell?.top);
      expect(geometry.mainBody?.top).toBe(geometry.mainHeader?.bottom);

      if (geometry.surface === 'chat-conversation') {
        expectSameHorizontalEdges(geometry.mainFooter, geometry.main);
        expect(geometry.mainFooter?.bottom).toBe(geometry.mainShell?.bottom);
        expect(geometry.mainSlots).toEqual(['header', 'body', 'footer', 'overlay-host']);
      } else {
        expect(geometry.mainFooter).toBeNull();
        expect(geometry.mainSlots).toEqual(['header', 'body', 'overlay-host']);
      }

      if (geometry.surface === 'graph' || geometry.surface === 'timeline') {
        expectSameHorizontalEdges(geometry.panel, geometry.main);
        expectSameHorizontalEdges(geometry.panelShell, geometry.main);
        expectSameHorizontalEdges(geometry.panelHeader, geometry.main);
        expectSameHorizontalEdges(geometry.panelBody, geometry.main);
        expect(geometry.panelSlots).toEqual(['header', 'body', 'overlay-host']);
      } else {
        expect(geometry.panel).toBeNull();
        expect(geometry.panelShell).toBeNull();
      }
    }
  });
});
