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

type Edges = { left: number; top: number; height: number };
type Case = { sidebar: Edges; notice: Edges; detail: Edges; content: Edges };

function measure(): Case[] {
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
        return {left: rect.left, top: rect.top, height: rect.height};
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
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Case[];
}

describe('app operational notice layout', () => {
  it('keeps the sidebar full height and places notices above readable main content across widths and hidden state', () => {
    const cases = measure();
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
