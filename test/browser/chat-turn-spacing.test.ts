import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate)).find(existsSync);

type Geometry = {
  innerGap: number;
  turnGap: number;
  firstRowHeight: number;
  firstTurnHeight: number;
  footerPosition: string;
  footerFocused: boolean;
  footerBottom: number;
  firstTurnBottom: number;
  nextEventTop: number;
  secondActionPosition: string;
  secondActionWithinEvent: boolean;
  collapsedHeight: number;
  expandedHeight: number;
  wideHeight: number;
  narrowHeight: number;
};

function decodeGeometry(markup: string): Geometry {
  const encoded = markup.match(/data-geometry="([^"]+)"/)?.[1];
  if (!encoded) throw new Error(`Chromium did not return Chat spacing geometry: ${markup.slice(-2_000)}`);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Geometry;
}

describe('Chat turn geometry', () => {
  it('keeps hidden and focused actions inside one uniformly measured event rhythm', () => {
    if (!chrome) throw new Error('A Chromium browser is required for the Chat spacing contract.');
    const directory = mkdtempSync(join(tmpdir(), 'mandible-chat-spacing-'));
    try {
      const css = [
        readFileSync('ui/src/styles/tokens.css', 'utf8'),
        readFileSync('ui/src/styles/contextual-action.css', 'utf8'),
        readFileSync('ui/src/styles/message-blocks.css', 'utf8'),
        readFileSync('ui/src/styles/console.css', 'utf8'),
      ].join('\n');
      const path = join(directory, 'index.html');
      writeFileSync(path, `<!doctype html><html><head><style>${css}</style><style>
        * { box-sizing: border-box; }
        body { margin: 0; }
        #fixture { margin: 100px; width: 420px; }
        .stream-renderer__virtual-row { position: static; contain: none; }
        .event { min-height: 20px; line-height: 20px; }
        .responsive { overflow-wrap: anywhere; }
        .disclosure[aria-expanded='true'] { height: 70px; }
        .contextual-action-group { opacity: 0; pointer-events: none; transition: none; }
      </style></head><body><div id="fixture">
        <div class="stream-renderer__virtual-row" data-row="first">
          <div class="turn-group contextual-action-owner turn-group--assistant" data-turn="first">
            <div class="turn-group__body contextual-action-scope">
              <div class="message-block-wrapper contextual-action-owner event" data-event="first">First event<div class="message-actions contextual-action-group"><button class="contextual-action">First action</button></div></div>
              <div class="message-block-wrapper contextual-action-owner event disclosure responsive" data-event="second" aria-expanded="false">Second event with enough words to wrap when its measured row becomes narrow<div class="message-actions contextual-action-group" data-second-actions><button class="contextual-action">Second action</button></div></div>
              <div class="group-footer contextual-action-group"><div class="group-footer__row"><button class="group-footer__btn contextual-action" data-footer-action>Copy all</button></div></div>
            </div>
          </div>
        </div>
        <div class="stream-renderer__virtual-row" data-row="next"><div class="turn-group turn-group--system"><div class="turn-group__body"><div class="message-block-wrapper event" data-event="next">Next event</div></div></div></div>
      </div><script>
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const first = rect('[data-event="first"]');
        const second = rect('[data-event="second"]');
        const firstTurn = rect('[data-turn="first"]');
        const firstRow = rect('[data-row="first"]');
        const next = rect('[data-event="next"]');
        const footer = document.querySelector('.group-footer');
        const footerStyle = getComputedStyle(footer);
        const collapsedHeight = firstRow.height;
        document.querySelector('.disclosure').setAttribute('aria-expanded', 'true');
        const expandedHeight = rect('[data-row="first"]').height;
        document.querySelector('.disclosure').setAttribute('aria-expanded', 'false');
        const wideHeight = rect('[data-row="first"]').height;
        document.querySelector('#fixture').style.width = '180px';
        const narrowHeight = rect('[data-row="first"]').height;
        const footerAction = document.querySelector('[data-footer-action]');
        footerAction.focus({ focusVisible: true });
        const footerRect = footer.getBoundingClientRect();
        const secondAction = rect('[data-second-actions]');
        const secondAfterResize = rect('[data-event="second"]');
        document.body.dataset.geometry = btoa(JSON.stringify({
          innerGap: second.top - first.bottom,
          turnGap: next.top - second.bottom,
          firstRowHeight: firstRow.height,
          firstTurnHeight: firstTurn.height,
          footerPosition: footerStyle.position,
          footerFocused: document.activeElement === footerAction,
          footerBottom: footerRect.bottom,
          firstTurnBottom: rect('[data-turn="first"]').bottom,
          nextEventTop: rect('[data-event="next"]').top,
          secondActionPosition: getComputedStyle(document.querySelector('[data-second-actions]')).position,
          secondActionWithinEvent: secondAction.left >= secondAfterResize.left
            && secondAction.right <= secondAfterResize.right
            && secondAction.top >= secondAfterResize.top
            && secondAction.bottom <= secondAfterResize.bottom,
          collapsedHeight,
          expandedHeight,
          wideHeight,
          narrowHeight,
        }));
      </script></body></html>`);

      const rendered = spawnSync(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--dump-dom',
        `file://${path}`,
      ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 20_000_000 });

      expect(rendered.error, rendered.stderr).toBeUndefined();
      expect(rendered.status, rendered.stderr).toBe(0);
      const geometry = decodeGeometry(rendered.stdout);
      expect(geometry.innerGap).toBe(8);
      expect(geometry.turnGap).toBe(8);
      expect(geometry.firstRowHeight).toBe(geometry.firstTurnHeight);
      expect(geometry.footerPosition).toBe('absolute');
      expect(geometry.footerFocused).toBe(true);
      expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.firstTurnBottom);
      expect(geometry.footerBottom).toBeLessThan(geometry.nextEventTop);
      expect(geometry.secondActionPosition).toBe('static');
      expect(geometry.secondActionWithinEvent).toBe(true);
      expect(geometry.expandedHeight).toBeGreaterThan(geometry.collapsedHeight);
      expect(geometry.narrowHeight).toBeGreaterThan(geometry.wideHeight);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
