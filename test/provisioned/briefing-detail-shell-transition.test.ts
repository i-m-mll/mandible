// @provisioned chromium
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

type ShellGeometry = {
  activeElement: string | null;
  shellOverflow: string;
  shellScrollTop: number;
  shell: { top: number; bottom: number };
  header: { top: number; bottom: number };
  subheader: { top: number; bottom: number };
  notice: { top: number; bottom: number };
  body: { top: number; bottom: number; overflowY: string; scrollTop: number };
  footer: { top: number; bottom: number };
  slots: Array<string | null>;
  ancestorScrollTops: number[];
};

function renderTransitionGeometry(): ShellGeometry {
  const detailCss = readFileSync(resolve('ui/src/styles/detail-pane-shell.css'), 'utf8');
  const briefingCss = readFileSync(resolve('ui/src/styles/briefing.css'), 'utf8');
  const html = `<!doctype html>
    <style>${detailCss}\n${briefingCss}</style>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 1120px; height: 900px; margin: 0; overflow: clip; }
      .feedback-collection-shell { position: fixed; inset: 0; width: 1120px; height: 900px; }
      .fixture-sidebar { flex: none; width: 360px; }
      .feedback-collection-shell__content-inner { position: relative; }
      .detail-pane-header { height: 83px; }
      .detail-pane-shell__subheader { height: 26px; }
      .detail-pane-notice { height: 38px; }
      .briefing-detail__footer { height: 63px; }
      .briefing-document__passage { height: 1400px; }
      .fixture-overlay { position: absolute; inset: 0 auto auto 0; }
    </style>
    <div class="feedback-collection-shell">
      <aside class="fixture-sidebar"></aside>
      <section class="feedback-collection-shell__content">
        <div class="feedback-collection-shell__content-inner">
          <section class="detail-pane-shell briefing-detail">
            <header class="detail-pane-shell__header briefing-detail__header" data-detail-pane-slot="header">
              <div class="detail-pane-header">Briefing header</div>
              <div class="detail-pane-shell__subheader">Briefing subheader</div>
            </header>
            <div class="detail-pane-shell__notice" data-detail-pane-slot="notice">
              <div class="detail-pane-notice">Briefing notice</div>
            </div>
            <div class="detail-pane-shell__body briefing-detail__body" data-detail-pane-slot="body">
              <div class="briefing-document">
                <div class="briefing-document__passage">Briefing document</div>
                <fieldset class="briefing-directive__rating" aria-label="Rating">
                  <label><input id="rating-4" type="radio" name="rating" value="4"><span>4</span></label>
                </fieldset>
              </div>
            </div>
            <footer class="detail-pane-shell__footer briefing-detail__footer" data-detail-pane-slot="footer">Submit</footer>
            <div class="fixture-overlay">Overlay</div>
          </section>
        </div>
      </section>
    </div>
    <script>
      const shell = document.querySelector('.detail-pane-shell');
      const header = document.querySelector('.detail-pane-shell__header');
      const subheader = document.querySelector('.detail-pane-shell__subheader');
      const notice = document.querySelector('.detail-pane-shell__notice');
      const body = document.querySelector('.detail-pane-shell__body');
      const footer = document.querySelector('.detail-pane-shell__footer');
      const rating = document.querySelector('#rating-4');
      const edges = (element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      };

      rating.focus();
      document.title = btoa(JSON.stringify({
        activeElement: document.activeElement?.id ?? null,
        shellOverflow: getComputedStyle(shell).overflow,
        shellScrollTop: shell.scrollTop,
        shell: edges(shell),
        header: edges(header),
        subheader: edges(subheader),
        notice: edges(notice),
        body: {
          ...edges(body),
          overflowY: getComputedStyle(body).overflowY,
          scrollTop: body.scrollTop,
        },
        footer: edges(footer),
        slots: Array.from(shell.children, (child) => child.getAttribute('data-detail-pane-slot')),
        ancestorScrollTops: [
          document.scrollingElement.scrollTop,
          document.querySelector('.feedback-collection-shell').scrollTop,
          document.querySelector('.feedback-collection-shell__content').scrollTop,
          document.querySelector('.feedback-collection-shell__content-inner').scrollTop,
        ],
      }));
    </script>`;

  const rendered = runChromium([
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

    expect(geometry.activeElement).toBe('rating-4');
    expect(geometry.shellScrollTop, JSON.stringify(geometry)).toBe(0);
    expect(geometry.shellOverflow).toBe('clip');
    expect(geometry.header.top).toBe(geometry.shell.top);
    expect(geometry.subheader.bottom).toBe(geometry.header.bottom);
    expect(geometry.notice.top).toBe(geometry.header.bottom);
    expect(geometry.body.top).toBe(geometry.notice.bottom);
    expect(geometry.body.overflowY).toBe('auto');
    expect(geometry.body.scrollTop).toBeGreaterThan(0);
    expect(geometry.footer.top).toBe(geometry.body.bottom);
    expect(geometry.footer.bottom).toBe(geometry.shell.bottom);
    expect(geometry.slots).toEqual(['header', 'notice', 'body', 'footer', null]);
    expect(geometry.ancestorScrollTops).toEqual([0, 0, 0, 0]);
  });
});
