import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((value): value is string => Boolean(value)).find(existsSync);

type Edges = { left: number; top: number; width: number; height: number; right: number; bottom: number };
type ShellCase = {
  variant: 'standard' | 'compact' | 'versioned' | 'none';
  sidebar: Edges | null;
  rightSidebar: Edges | null;
  shell: Edges;
  header: Edges | null;
  notice: Edges;
  body: Edges;
  hiddenShell: Edges;
};
type FallbackCase = { sidebar: Edges; notice: Edges; detail: Edges; content: Edges };

function measureShells(): ShellCase[] {
  if (!chrome) throw new Error('Chromium is required for operational notice layout verification.');
  const css = [
    readFileSync(resolve('ui/src/styles/base.css'), 'utf8'),
    readFileSync(resolve('ui/src/styles/detail-pane-shell.css'), 'utf8'),
  ].join('\n');
  const html = `<!doctype html><html><head><style>${css}</style><style>
    body { margin: 0; }
    .app-content { display: flex; width: 900px; height: 500px; padding: 0; }
    .fixture-layout { display: flex; flex: 1; min-width: 0; height: 100%; }
    .fixture-view-sidebar { flex: none; height: 100%; }
    .fixture-detail { display: flex; flex: 1; min-width: 0; height: 100%; }
    .fixture-right-sidebar { flex: none; width: 220px; height: 100%; }
    .detail-pane-shell { height: 100%; }
    .detail-pane-shell__header { flex: none; }
    .fixture-header { height: var(--fixture-header-height); }
    .detail-pane-shell__notice { flex: none; height: 44px; box-sizing: border-box; }
    .detail-pane-shell__body { flex: 1; min-height: 0; }
    .fixture-content { height: 100px; }
    .app-operational-notices { height: 44px; }
    .detail-pane-shell--hidden-fixture { display: none; }
  </style></head><body><script>
    const cases = [];
    const definitions = [
      {variant:'standard', height:76, sidebarWidth:240, sidebarHidden:false, right:true},
      {variant:'compact', height:42, sidebarWidth:320, sidebarHidden:false, right:false},
      {variant:'versioned', height:92, sidebarWidth:320, sidebarHidden:true, right:false},
      {variant:'none', height:0, sidebarWidth:0, sidebarHidden:true, right:false},
    ];
    for (const item of definitions) {
      const appContent = document.createElement('main');
      appContent.className = 'app-content';
      appContent.style.setProperty('--app-operational-notice-height', '0px');
      appContent.innerHTML = '<div class="app-operational-notices" data-app-operational-notice-fallback></div>'
        + '<section class="app-tab-panel"><div class="fixture-layout">'
        + (item.sidebarWidth ? '<aside class="fixture-view-sidebar view-sidebar" style="width:' + item.sidebarWidth + 'px;' + (item.sidebarHidden ? 'display:none;' : '') + '"></aside>' : '')
        + '<div class="fixture-detail"><section class="detail-pane-shell" data-detail-pane-presentation="main">'
        + (item.variant === 'none' ? '' : '<header class="detail-pane-shell__header" data-detail-pane-slot="header"><div class="detail-pane-shell__header-primary"><div class="fixture-header detail-pane-header detail-pane-header--' + item.variant + '" style="--fixture-header-height:' + item.height + 'px"></div></div></header>')
        + '<div class="detail-pane-shell__notice" data-detail-pane-slot="notice"><div class="detail-pane-notice">Failure</div></div>'
        + '<div class="detail-pane-shell__body" data-detail-pane-slot="body"><div class="fixture-content">Retained content</div></div>'
        + '</section></div>'
        + (item.right ? '<aside class="fixture-right-sidebar"></aside>' : '')
        + '</div></section>';
      const hiddenShell = document.createElement('section');
      hiddenShell.className = 'app-tab-panel';
      hiddenShell.hidden = true;
      hiddenShell.innerHTML = '<section class="detail-pane-shell"><div class="detail-pane-shell__notice"><div class="detail-pane-notice">Hidden failure</div></div></section>';
      appContent.append(hiddenShell);
      document.body.append(appContent);
      const edge = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom};
      };
      const shell = appContent.querySelector('[data-detail-pane-presentation="main"]');
      const header = shell.querySelector('[data-detail-pane-slot="header"]');
      const notice = shell.querySelector('[data-detail-pane-slot="notice"]');
      const body = shell.querySelector('[data-detail-pane-slot="body"]');
      cases.push({
        variant: item.variant,
        sidebar: edge(appContent.querySelector('.fixture-view-sidebar')),
        rightSidebar: edge(appContent.querySelector('.fixture-right-sidebar')),
        shell: edge(shell),
        header: edge(header),
        notice: edge(notice),
        body: edge(body),
        hiddenShell: edge(hiddenShell.querySelector('.detail-pane-shell')),
      });
      appContent.remove();
    }
    document.title = btoa(JSON.stringify(cases));
  </script></body></html>`;
  const result = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom',
    '--virtual-time-budget=1000', '--window-size=1000,700',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 20_000_000 });
  if (result.status !== 0) throw new Error(`Chromium notice fixture failed: ${result.stderr}`);
  const encoded = result.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error(`Chromium notice fixture did not return geometry: ${result.stderr}`);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ShellCase[];
}

function measureFallback(): FallbackCase[] {
  if (!chrome) throw new Error('Chromium is required for operational notice layout verification.');
  const css = readFileSync(resolve('ui/src/styles/base.css'), 'utf8');
  const html = `<!doctype html><html><head><style>${css}</style><style>
    body { margin: 0; }
    .app-content { width: 900px; height: 500px; padding: 0; }
    .fixture-layout { display: flex; height: 100%; }
    .fixture-detail { flex: 1; height: 100%; }
    .fixture-content { height: 100px; }
    .app-operational-notices { height: 44px; }
  </style></head><body><script>
    const cases = [];
    for (const item of [{width:240,hidden:false},{width:320,hidden:false},{width:320,hidden:true}]) {
      const shell = document.createElement('div');
      shell.className = 'app-shell' + (item.hidden ? '' : ' app-shell--view-sidebar-open');
      shell.style.setProperty('--app-view-sidebar-width', item.width + 'px');
      shell.innerHTML = '<div class="app-content app-content--view-sidebar" style="--app-operational-notice-height:44px">'
        + '<div class="app-operational-notices"><div role="alert">Failure</div></div>'
        + '<section class="app-tab-panel"><div class="nested"><div class="fixture-layout">'
        + '<aside class="view-sidebar" style="width:' + item.width + 'px;' + (item.hidden ? 'display:none' : '') + '">Sidebar</aside>'
        + '<main class="fixture-detail"><div class="fixture-content">Retained content</div></main>'
        + '</div></div></section></div>';
      document.body.append(shell);
      const edge = (selector) => {
        const rect = shell.querySelector(selector).getBoundingClientRect();
        return {left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom};
      };
      cases.push({sidebar:edge('.view-sidebar'), notice:edge('.app-operational-notices'),
        detail:edge('.fixture-detail'), content:edge('.fixture-content')});
      shell.remove();
    }
    document.title = btoa(JSON.stringify(cases));
  </script></body></html>`;
  const result = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom',
    '--virtual-time-budget=1000', '--window-size=1000,700',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 20_000_000 });
  if (result.status !== 0) throw new Error(`Chromium notice fixture failed: ${result.stderr}`);
  const encoded = result.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error(`Chromium notice fixture did not return geometry: ${result.stderr}`);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as FallbackCase[];
}

describe('app operational notice layout', () => {
  it('keeps the main header at the top and places the notice between it and one scrolling body', () => {
    const cases = measureShells();
    for (const row of cases) {
      expect(row.shell.top).toBe(0);
      expect(row.notice.top).toBe(row.header?.top === 0 ? row.header.bottom : row.shell.top);
      expect(row.body.top).toBe(row.notice.bottom);
      expect(row.hiddenShell.width).toBe(0);
      if (row.sidebar && row.sidebar.width > 0) {
        expect(row.sidebar.top).toBe(0);
        expect(row.sidebar.height).toBe(500);
        expect(row.shell.left).toBe(row.sidebar.left + row.sidebar.width);
      } else {
        expect(row.shell.left).toBe(0);
      }
      if (row.rightSidebar) expect(row.notice.right).toBeLessThanOrEqual(row.rightSidebar.left);
    }
    expect(cases.map((row) => row.variant)).toEqual(['standard', 'compact', 'versioned', 'none']);
  });

  it('keeps the no-main-shell fallback within the detail area without shrinking the sidebar', () => {
    const cases = measureFallback();
    for (const row of cases) {
      expect(row.sidebar.top).toBe(0);
      expect(row.notice.top).toBe(0);
      expect(row.content.top).toBeGreaterThanOrEqual(row.notice.top + row.notice.height);
    }
    expect(cases[0].notice.left).toBe(cases[0].detail.left);
    expect(cases[1].notice.left).toBe(cases[1].detail.left);
    expect(cases[1].notice.left - cases[0].notice.left).toBe(80);
    expect(cases[2].notice.left).toBe(0);
  });
});
