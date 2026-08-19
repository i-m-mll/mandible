import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type ShellGeometry = {
  outerOverflow: string;
  outerScrollTop: number;
  outer: { top: number; bottom: number };
  header: { top: number; bottom: number };
  body: { top: number; bottom: number; overflowY: string };
  footer: { top: number; bottom: number };
};

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

function renderTransitionGeometry(): ShellGeometry {
  const chrome = CHROME_CANDIDATES.find(existsSync);
  if (!chrome) throw new Error('A Chromium browser is required for the Briefing shell geometry regression.');

  const detailCss = readFileSync(resolve('ui/src/styles/detail-pane-shell.css'), 'utf8');
  const briefingCss = readFileSync(resolve('ui/src/styles/briefing.css'), 'utf8');
  const html = `<!doctype html>
    <style>${detailCss}\n${briefingCss}</style>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 1120px; height: 900px; margin: 0; overflow: hidden; }
      .feedback-collection-shell { width: 1120px; height: 900px; }
      .fixture-sidebar { flex: none; width: 360px; }
      .feedback-collection-shell__content-inner { position: relative; }
      .fixture-transition-overflow {
        position: absolute;
        width: 1px;
        height: 1785px;
        pointer-events: none;
      }
      .detail-pane-header { height: 109px; }
      .briefing-detail__footer { height: 63px; }
      .briefing-document { height: 1800px; }
    </style>
    <div class="feedback-collection-shell">
      <aside class="fixture-sidebar"></aside>
      <section class="feedback-collection-shell__content">
        <div class="feedback-collection-shell__content-inner">
          <div class="fixture-transition-overflow"></div>
          <section class="detail-pane-shell briefing-detail">
            <header class="detail-pane-shell__header briefing-detail__header">
              <div class="detail-pane-header">Briefing header</div>
            </header>
            <div class="detail-pane-shell__body briefing-detail__body">
              <div class="briefing-document">Briefing document</div>
            </div>
            <footer class="detail-pane-shell__footer briefing-detail__footer">Submit</footer>
          </section>
        </div>
      </section>
    </div>
    <script>
      const outer = document.querySelector('.feedback-collection-shell__content');
      const header = document.querySelector('.detail-pane-shell__header');
      const body = document.querySelector('.detail-pane-shell__body');
      const footer = document.querySelector('.detail-pane-shell__footer');
      const edges = (element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      };

      // Route/load reconciliation can temporarily leave taller outgoing
      // content in the pane. Browser focus and annotation navigation then try
      // to scroll this outer boundary to the selected document region.
      outer.scrollTop = 650;
      document.title = btoa(JSON.stringify({
        outerOverflow: getComputedStyle(outer).overflow,
        outerScrollTop: outer.scrollTop,
        outer: edges(outer),
        header: edges(header),
        body: { ...edges(body), overflowY: getComputedStyle(body).overflowY },
        footer: edges(footer),
      }));
    </script>`;

  const rendered = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--dump-dom',
    '--window-size=1120,900',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (rendered.status !== 0) {
    throw new Error(`Chromium geometry fixture failed: ${rendered.stderr}`);
  }
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium geometry fixture did not return measurements.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ShellGeometry;
}

describe('Briefing detail shell route transition geometry', () => {
  it('keeps the outer pane non-scrollable while the document body remains the scroll owner', () => {
    const geometry = renderTransitionGeometry();

    expect(geometry.outerScrollTop).toBe(0);
    expect(geometry.outerOverflow).toBe('clip');
    expect(geometry.header.top).toBe(geometry.outer.top);
    expect(geometry.body.top).toBe(geometry.header.bottom);
    expect(geometry.body.overflowY).toBe('auto');
    expect(geometry.footer.top).toBe(geometry.body.bottom);
    expect(geometry.footer.bottom).toBe(geometry.outer.bottom);
  });
});
