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
].filter((candidate): candidate is string => Boolean(candidate)).find(existsSync);

type Surface = { image: string; color: string };
type SidebarMaterial = {
  runtime: 'tauri' | 'browser';
  owner: Surface;
  header: Surface;
  search: Surface;
  body: Surface;
  footer: Surface;
};

function renderSidebarMaterial(): SidebarMaterial[] {
  if (!chrome) throw new Error('Chromium is required for native sidebar material verification.');

  const styles = [
    readFileSync(resolve('ui/src/styles/tokens.css'), 'utf8'),
    readFileSync(resolve('ui/src/styles/base.css'), 'utf8'),
    readFileSync(resolve('ui/src/styles/sidebar-search-filter.css'), 'utf8'),
  ].join('\n');
  const native = `<div id="app" class="tauri-window"><div class="app-shell app-shell--view-sidebar-open" style="height:600px;--app-view-sidebar-width:280px;--app-view-sidebar-persisted-width:280px"><div class="app-layout app-layout--view-sidebar-open" style="height:600px"><aside class="app-rail"></aside><aside class="view-sidebar"><div class="view-sidebar__header"><div class="sidebar-search-filter">Search</div></div><div class="view-sidebar__body">Rows</div><div class="view-sidebar__footer">Footer</div></aside><main class="app-content app-content--view-sidebar"></main></div></div></div>`;
  const browser = native.replace(' id="app" class="tauri-window"', ' id="app"');
  const cases = [
    { runtime: 'tauri', markup: native, nativeGlass: true },
    { runtime: 'browser', markup: browser, nativeGlass: false },
  ];
  const payload = JSON.stringify({ cases, styles }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html><body><script>
    const { cases, styles } = ${payload};
    const results = [];
    const surface = (doc, selector) => {
      const style = getComputedStyle(doc.querySelector(selector));
      return { image: style.backgroundImage, color: style.backgroundColor };
    };
    for (const entry of cases) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'display:block;border:0;width:1000px;height:600px';
      frame.addEventListener('load', () => {
        const doc = frame.contentDocument;
        results.push({
          runtime: entry.runtime,
          owner: surface(doc, '.view-sidebar'),
          header: surface(doc, '.view-sidebar__header'),
          search: surface(doc, '.sidebar-search-filter'),
          body: surface(doc, '.view-sidebar__body'),
          footer: surface(doc, '.view-sidebar__footer'),
        });
        if (results.length === cases.length) document.title = btoa(JSON.stringify(results));
      }, { once: true });
      frame.srcdoc = '<!doctype html><html data-theme="light"'
        + (entry.nativeGlass ? ' data-native-glass="regular"' : '')
        + '><head><style>' + styles + '</style><style>html,body{margin:0;width:100%;height:100%}</style></head><body>'
        + entry.markup + '</body></html>';
      document.body.append(frame);
    }
  </script></body></html>`;

  const rendered = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--dump-dom',
    '--virtual-time-budget=1000',
    '--window-size=1200,800',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium sidebar material fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error(`Chromium sidebar material fixture returned no measurements: ${rendered.stderr}`);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as SidebarMaterial[];
}

describe('native sidebar material ownership', () => {
  it('keeps one native gradient owner and preserves inherited browser surfaces', () => {
    const [native, browser] = renderSidebarMaterial();
    expect(native?.runtime).toBe('tauri');
    expect(native?.owner.image).toContain('linear-gradient(');
    for (const region of [native?.header, native?.search, native?.body, native?.footer]) {
      expect(region?.image).toBe('none');
      expect(region?.color).toBe('rgba(0, 0, 0, 0)');
    }

    expect(browser?.runtime).toBe('browser');
    expect(browser?.owner.image).toBe('none');
    expect(browser?.owner.color).not.toBe('rgba(0, 0, 0, 0)');
    for (const region of [browser?.header, browser?.search, browser?.body, browser?.footer]) {
      expect(region?.image).toBe('none');
      expect(region?.color).toBe(browser?.owner.color);
    }
  });
});
