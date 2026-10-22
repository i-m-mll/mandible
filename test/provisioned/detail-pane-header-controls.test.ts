// @provisioned chromium
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

type HeaderCase = {
  variant: 'standard' | 'compact' | 'versioned';
  open: boolean;
  toggle: boolean;
  visibleControlGap: number;
  menuGap: number;
  toggleCenterY: number | null;
};

type Result = {
  native: boolean;
  cases: HeaderCase[];
  edgeInsets: { main: number; rightSidebar: number };
  rightSidebarControlCenterY: number | null;
};

const esbuildCli = createRequire(import.meta.url).resolve('esbuild/bin/esbuild');
const styles = [
  'ui/src/styles/tokens.css',
  'ui/src/styles/base.css',
  'ui/src/styles/detail-pane-shell.css',
  'ui/src/styles/icon-tab-list.css',
  'ui/src/styles/conversations.css',
  'ui/src/styles/ledger.css',
  'ui/src/styles/issues.css',
  'ui/src/styles/auth.css',
  'ui/src/styles/briefing.css',
].map((path) => readFileSync(resolve(path), 'utf8')).join('\n');

let fixtureBundle: string | undefined;

function bundleFixture(directory: string): string {
  const output = join(directory, 'detail-pane-header-controls.js');
  const bundled = spawnSync(esbuildCli, [
    resolve('test/provisioned/fixtures/detail-pane-header-controls-fixture.tsx'),
    '--bundle',
    `--outfile=${output}`,
    '--format=iife',
    '--platform=browser',
    '--target=es2020',
    '--jsx=automatic',
    '--jsx-import-source=preact',
    '--alias:react=preact/compat',
    '--alias:react-dom=preact/compat',
    '--alias:react/jsx-runtime=preact/jsx-runtime',
    '--loader:.css=empty',
    '--minify',
    '--log-level=silent',
  ], { encoding: 'utf8' });
  if (bundled.status !== 0) throw new Error(`Header fixture bundle failed: ${bundled.stderr || bundled.stdout}`);
  return readFileSync(output, 'utf8');
}

function renderCase(native: boolean): Result {
  const directory = mkdtempSync(join(tmpdir(), 'mandible-detail-header-'));
  try {
    const bundle = fixtureBundle ??= bundleFixture(directory);
    const measure = `
      (() => {
        const rect = node => { const value=node.getBoundingClientRect(); return {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}; };
        const cases = Array.from(document.querySelectorAll('.header-case')).map(shell => {
          const header=shell.querySelector('.detail-pane-header'); const variant=shell.dataset.variant; const open=shell.dataset.open==='true';
          const paddingRight=parseFloat(getComputedStyle(header).paddingRight); const contentRight=rect(header).right-paddingRight;
          const trigger=header.querySelector('.detail-pane-menu-trigger'); const toggle=header.querySelector('.app-right-sidebar-toggle');
          const visibleControl=variant==='compact' ? (open ? trigger : toggle) : (open ? header.querySelector('[data-header-control]') : toggle);
          const visibleGlyph=visibleControl?.classList.contains('app-right-sidebar-toggle') ? visibleControl.querySelector('svg') : visibleControl;
          const toggleGlyph=toggle?.querySelector('svg');
          const toggleCenterY=toggleGlyph ? (rect(toggleGlyph).top+rect(toggleGlyph).bottom)/2-rect(header).top : null;
          return {variant,open,toggle:Boolean(toggle),visibleControlGap:contentRight-rect(visibleGlyph).right,menuGap:contentRight-rect(trigger).right,toggleCenterY};
        });
        const mainHeader=document.querySelector('.header-case[data-variant="compact"][data-open="false"] .detail-pane-header');
        const mainToggle=mainHeader?.querySelector('.app-right-sidebar-toggle');
        const rightHeader=document.querySelector('.app-right-sidebar__header');
        const rightToggle=rightHeader?.querySelector('.app-right-sidebar__toggle');
        const mainGlyph=mainToggle?.querySelector('svg');
        const rightGlyph=rightToggle?.querySelector('svg');
        const edgeInsets={main:rect(mainHeader).right-rect(mainGlyph).right,rightSidebar:rect(rightHeader).right-rect(rightGlyph).right};
        const rightSidebarControlCenterY=rightGlyph ? (rect(rightGlyph).top+rect(rightGlyph).bottom)/2-rect(rightHeader).top : null;
        document.title=btoa(JSON.stringify({native:${native},cases,edgeInsets,rightSidebarControlCenterY}));
      })();
    `;
    const path = join(directory, 'fixture.html');
    writeFileSync(path, `<!doctype html><html data-theme="dark"><head><style>${styles}</style><style>
      *{box-sizing:border-box}html,body{margin:0;padding:0;width:820px;min-height:900px;overflow:visible}
      .header-controls-fixture{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:820px}
      .header-case{flex:none;width:760px;height:132px}
      .header-controls-sidebar{flex:none;width:360px;height:132px}
      .tauri-window{--header-fixture-native:1}
    </style></head><body${native ? ' class="tauri-window"' : ''}><script>${bundle}</script><script>${measure}</script></body></html>`);
    const rendered = runChromium([
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=1000', '--dump-dom', '--window-size=900,1100', `file://${path}`,
    ], { encoding: 'utf8', maxBuffer: 10_000_000, timeout: 20_000 });
    if (rendered.status !== 0) throw new Error(`Chromium header fixture failed: ${rendered.stderr}`);
    const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
    if (!encoded || encoded === 'ready') throw new Error(`Chromium did not emit header results (title=${encoded ?? 'none'}): ${rendered.stdout.slice(-2500)}`);
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('shared detail header controls', () => {
  it('keeps visible header controls trailing when the sidebar toggle moves', () => {
    const browser = renderCase(false);
    const native = renderCase(true);

    for (const result of [browser, native]) {
      expect(result.cases).toHaveLength(6);
      for (const header of result.cases) {
        expect(header.visibleControlGap, `${result.native ? 'native' : 'browser'} ${header.variant} open=${header.open} trailing alignment`).toBeGreaterThanOrEqual(-1);
        expect(header.visibleControlGap, `${result.native ? 'native' : 'browser'} ${header.variant} open=${header.open} trailing alignment`).toBeLessThanOrEqual(1);
        if (header.variant !== 'compact' || header.open) {
          expect(header.menuGap, `${result.native ? 'native' : 'browser'} ${header.variant} menu trailing alignment`).toBeGreaterThanOrEqual(-1);
          expect(header.menuGap, `${result.native ? 'native' : 'browser'} ${header.variant} menu trailing alignment`).toBeLessThanOrEqual(1);
        } else {
          expect(header.menuGap, `${result.native ? 'native' : 'browser'} compact menu precedes the closed sidebar toggle`).toBeGreaterThan(0);
        }
        expect(header.toggle).toBe(!header.open);
      }
      expect(Math.abs(result.edgeInsets.main - result.edgeInsets.rightSidebar), `${result.native ? 'native' : 'browser'} main and right-sidebar control edge padding`).toBeLessThanOrEqual(1);
      const toggleCenters = [
        ...result.cases.filter((header) => header.toggle).map((header) => header.toggleCenterY),
        result.rightSidebarControlCenterY,
      ].filter((center): center is number => center !== null);
      expect(Math.max(...toggleCenters) - Math.min(...toggleCenters), `${result.native ? 'native' : 'browser'} toggle vertical alignment across headers`).toBeLessThanOrEqual(1);
    }

    expect(native.cases).toEqual(browser.cases);
  });
});
