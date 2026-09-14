import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Theme = 'dark' | 'light';

type HeaderTitleColors = Record<
  'app' | 'standard' | 'compact' | 'versioned' | 'legacy',
  string
>;

type ThemeTitleColors = Record<Theme, HeaderTitleColors>;

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

const chrome = CHROME_CANDIDATES.find(existsSync);
const styles = [
  'ui/src/styles/tokens.css',
  'ui/src/styles/base.css',
  'ui/src/styles/detail-pane-shell.css',
].map((path) => readFileSync(resolve(path), 'utf8')).join('\n');

function renderTitleColors(): ThemeTitleColors {
  if (!chrome) throw new Error('A Chromium browser is required for the shared header title color regression.');

  const payload = JSON.stringify({ styles, themes: ['dark', 'light'] satisfies Theme[] }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html><body>
    <script>
      const { styles, themes } = ${payload};
      const results = {};
      const markup = '<div class="app-header__route">Timeline</div>'
        + '<div class="detail-pane-header detail-pane-header--standard"><h2 class="detail-pane-header__title">Standard</h2></div>'
        + '<div class="detail-pane-header detail-pane-header--compact"><h2 class="detail-pane-header__title">Compact</h2></div>'
        + '<div class="detail-pane-header detail-pane-header--versioned"><h2 class="detail-pane-header__title">Versioned</h2></div>'
        + '<div class="detail-pane-shell detail-pane-shell--compact"><h2 class="detail-pane-shell__title">Legacy</h2></div>';
      for (const theme of themes) {
        const frame = document.createElement('iframe');
        frame.addEventListener('load', () => {
          const doc = frame.contentDocument;
          const color = (selector) => frame.contentWindow.getComputedStyle(doc.querySelector(selector)).color;
          results[theme] = {
            app: color('.app-header__route'),
            standard: color('.detail-pane-header--standard .detail-pane-header__title'),
            compact: color('.detail-pane-header--compact .detail-pane-header__title'),
            versioned: color('.detail-pane-header--versioned .detail-pane-header__title'),
            legacy: color('.detail-pane-shell__title'),
          };
          if (Object.keys(results).length === themes.length) document.title = btoa(JSON.stringify(results));
        }, { once: true });
        frame.srcdoc = '<!doctype html><html data-theme="' + theme + '"><head><style>' + styles + '</style></head><body>' + markup + '</body></html>';
        document.body.append(frame);
      }
    </script>
  </body></html>`;
  const rendered = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--dump-dom',
    '--window-size=800,600',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium shared header title fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium shared header title fixture did not return computed colors.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ThemeTitleColors;
}

describe('shared header title colors', () => {
  it('resolves every shared title consumer to each exact theme color', () => {
    expect(renderTitleColors()).toEqual({
      dark: {
        app: 'rgb(255, 255, 255)',
        standard: 'rgb(255, 255, 255)',
        compact: 'rgb(255, 255, 255)',
        versioned: 'rgb(255, 255, 255)',
        legacy: 'rgb(255, 255, 255)',
      },
      light: {
        app: 'rgb(0, 0, 0)',
        standard: 'rgb(0, 0, 0)',
        compact: 'rgb(0, 0, 0)',
        versioned: 'rgb(0, 0, 0)',
        legacy: 'rgb(0, 0, 0)',
      },
    });
  });
});
