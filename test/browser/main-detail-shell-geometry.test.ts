import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Edges = { left: number; right: number; top: number; bottom: number; width: number; height: number };

type MainDetailGeometry = {
  width: number;
  rail: Edges;
  sidebar: Edges;
  detail: Edges;
  shell: Edges;
  header: Edges;
  body: Edges;
  footer: Edges;
  bottomPanel: Edges;
  bottomHeader: Edges;
  bottomBody: Edges;
  bottomFooter: Edges;
  slots: Array<string | null>;
  bottomSlots: Array<string | null>;
};

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

function renderGeometry(width: number): MainDetailGeometry {
  const chrome = CHROME_CANDIDATES.find(existsSync);
  if (!chrome) throw new Error('A Chromium browser is required for the main-detail shell geometry regression.');

  const css = [
    'ui/src/styles/base.css',
    'ui/src/styles/chat-history.css',
    'ui/src/styles/conversations.css',
    'ui/src/styles/detail-pane-shell.css',
  ].map((path) => readFileSync(resolve(path), 'utf8')).join('\n');
  const html = `<!doctype html>
    <style>${css}</style>
    <style>
      * { box-sizing: border-box; }
      html, body { width: ${width}px; height: 720px; margin: 0; overflow: clip; }
      .app-shell {
        --app-left-boundary-width: 0px;
        --app-rail-width: 208px;
        --app-rail-outer-width: 208px;
        --app-shadow-gutter-width: 0px;
        --app-view-sidebar-width: 320px;
        --app-view-sidebar-outer-width: 320px;
        --app-bottom-panel-height: 180px;
      }
      .fixture-slot { min-height: 0; }
    </style>
    <div class="app-shell app-shell--view-sidebar-open">
      <div class="app-layout app-layout--view-sidebar-open app-layout--bottom-panel-open">
        <aside class="app-rail"></aside>
        <main class="app-content app-content--console app-content--view-sidebar">
          <div class="app-tab-panel">
            <div class="chat-history-view">
              <aside class="view-sidebar chat-history-sidebar" style="width:var(--app-view-sidebar-width);flex-shrink:0"></aside>
              <div class="chat-history-detail">
                <section class="detail-pane-shell detail-pane-shell--compact">
                  <header class="detail-pane-shell__header" data-detail-pane-slot="header"><div class="detail-pane-header detail-pane-header--compact">Chat</div></header>
                  <div class="detail-pane-shell__body fixture-slot" data-detail-pane-slot="body">Main body</div>
                  <footer class="detail-pane-shell__footer fixture-slot" data-detail-pane-slot="footer">Main footer</footer>
                  <div class="detail-pane-shell__overlay-host" data-detail-pane-slot="overlay-host"></div>
                </section>
              </div>
            </div>
          </div>
        </main>
        <aside class="app-bottom-panel app-bottom-panel--anchored-detail">
          <div class="app-bottom-panel__content">
            <section class="detail-pane-shell">
              <header class="detail-pane-shell__header fixture-slot" data-detail-pane-slot="header">Bottom header</header>
              <div class="detail-pane-shell__body fixture-slot" data-detail-pane-slot="body">Bottom body</div>
              <footer class="detail-pane-shell__footer fixture-slot" data-detail-pane-slot="footer">Bottom footer</footer>
              <div class="detail-pane-shell__overlay-host" data-detail-pane-slot="overlay-host"></div>
            </section>
          </div>
        </aside>
      </div>
    </div>
    <script>
      const edges = (selector) => {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
      };
      const shell = document.querySelector('.chat-history-detail > .detail-pane-shell');
      const bottomShell = document.querySelector('.app-bottom-panel .detail-pane-shell');
      document.title = btoa(JSON.stringify({
        width: ${width},
        rail: edges('.app-rail'),
        sidebar: edges('.chat-history-sidebar'),
        detail: edges('.chat-history-detail'),
        shell: edges('.chat-history-detail > .detail-pane-shell'),
        header: edges('.chat-history-detail > .detail-pane-shell > .detail-pane-shell__header'),
        body: edges('.chat-history-detail > .detail-pane-shell > .detail-pane-shell__body'),
        footer: edges('.chat-history-detail > .detail-pane-shell > .detail-pane-shell__footer'),
        bottomPanel: edges('.app-bottom-panel--anchored-detail'),
        bottomHeader: edges('.app-bottom-panel .detail-pane-shell__header'),
        bottomBody: edges('.app-bottom-panel .detail-pane-shell__body'),
        bottomFooter: edges('.app-bottom-panel .detail-pane-shell__footer'),
        slots: Array.from(shell.children, (child) => child.getAttribute('data-detail-pane-slot')),
        bottomSlots: Array.from(bottomShell.children, (child) => child.getAttribute('data-detail-pane-slot')),
      }));
    </script>`;

  const rendered = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--dump-dom',
    `--window-size=${width},720`,
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium geometry fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium did not emit main-detail shell geometry.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as MainDetailGeometry;
}

function expectSameHorizontalEdges(actual: Edges, expected: Edges): void {
  expect(actual.left).toBe(expected.left);
  expect(actual.right).toBe(expected.right);
  expect(actual.width).toBe(expected.width);
}

describe.each([1280, 835])('main-detail shell geometry at %ipx', (width) => {
  it('keeps every main slot and anchored footer past the rail and ViewSidebar', () => {
    const geometry = renderGeometry(width);
    const detailLeft = geometry.rail.right + geometry.sidebar.width;

    expect(geometry.rail).toMatchObject({ left: 0, right: 208, width: 208 });
    expect(geometry.sidebar).toMatchObject({ left: 208, right: detailLeft, width: 320 });
    expect(geometry.detail).toMatchObject({ left: detailLeft, right: width, width: width - detailLeft });
    expectSameHorizontalEdges(geometry.shell, geometry.detail);
    expectSameHorizontalEdges(geometry.header, geometry.detail);
    expectSameHorizontalEdges(geometry.body, geometry.detail);
    expectSameHorizontalEdges(geometry.footer, geometry.detail);
    expect(geometry.header.top).toBe(geometry.shell.top);
    expect(geometry.body.top).toBe(geometry.header.bottom);
    expect(geometry.footer.top).toBe(geometry.body.bottom);
    expect(geometry.footer.bottom).toBe(geometry.shell.bottom);
    expect(geometry.slots).toEqual(['header', 'body', 'footer', 'overlay-host']);

    expectSameHorizontalEdges(geometry.bottomPanel, geometry.detail);
    expectSameHorizontalEdges(geometry.bottomHeader, geometry.detail);
    expectSameHorizontalEdges(geometry.bottomBody, geometry.detail);
    expectSameHorizontalEdges(geometry.bottomFooter, geometry.detail);
    expect(geometry.bottomSlots).toEqual(['header', 'body', 'footer', 'overlay-host']);
  });
});
