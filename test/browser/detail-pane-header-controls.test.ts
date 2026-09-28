import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type HeaderCase = {
  variant: 'standard' | 'compact' | 'versioned';
  open: boolean;
  slot: boolean;
  toggle: boolean;
  visibleControlGap: number;
  menuGap: number;
};

type Result = {
  native: boolean;
  cases: HeaderCase[];
  closedTriggerSignatures: string[];
  activeTriggerSignatures: string[];
  triggerLabels: string[];
};

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate)).find(existsSync);

const esbuildCli = createRequire(import.meta.url).resolve('esbuild/bin/esbuild');
const styles = [
  'ui/src/styles/tokens.css',
  'ui/src/styles/base.css',
  'ui/src/styles/detail-pane-shell.css',
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
    resolve('test/browser/fixtures/detail-pane-header-controls-fixture.tsx'),
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
  if (!chrome) throw new Error('A Chromium browser is required for the detail header controls gate.');
  const directory = mkdtempSync(join(tmpdir(), 'mandible-detail-header-'));
  try {
    const bundle = fixtureBundle ??= bundleFixture(directory);
    const measure = `
      (() => {
        const rect = node => { const value=node.getBoundingClientRect(); return {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}; };
        const signature = button => {
          const style=getComputedStyle(button); const icon=button.querySelector('svg'); const iconStyle=getComputedStyle(icon);
          return JSON.stringify({width:style.width,height:style.height,borderRadius:style.borderRadius,border:style.borderTopWidth,background:style.backgroundColor,color:style.color,iconWidth:iconStyle.width,iconHeight:iconStyle.height,iconFill:iconStyle.fill});
        };
        const cases = Array.from(document.querySelectorAll('.header-case')).map(shell => {
          const header=shell.querySelector('.detail-pane-header'); const variant=shell.dataset.variant; const open=shell.dataset.open==='true';
          const paddingRight=parseFloat(getComputedStyle(header).paddingRight); const contentRight=rect(header).right-paddingRight;
          const trigger=header.querySelector('.detail-pane-menu-trigger'); const toggle=header.querySelector('.app-right-sidebar-toggle');
          const visibleControl=variant==='compact' ? (open ? trigger : toggle) : (open ? header.querySelector('[data-header-control]') : toggle);
          return {variant,open,slot:Boolean(header.querySelector('.detail-pane-header__right-sidebar-action-slot')),toggle:Boolean(toggle),visibleControlGap:contentRight-rect(visibleControl).right,menuGap:contentRight-rect(trigger).right};
        });
        const samples = expanded => Array.from(document.querySelector('.trigger-samples[data-expanded="'+expanded+'"]').querySelectorAll('.detail-pane-menu-trigger'), button => signature(button));
        const closedSamples=document.querySelector('.trigger-samples[data-expanded="false"]');
        const triggerLabels=Array.from(closedSamples.querySelectorAll('.detail-pane-menu-trigger'), button => button.getAttribute('aria-label')+'|'+button.title+'|'+button.getAttribute('aria-haspopup')+'|'+button.getAttribute('aria-expanded'));
        document.title=btoa(JSON.stringify({native:${native},cases,closedTriggerSignatures:samples(false),activeTriggerSignatures:samples(true),triggerLabels}));
      })();
    `;
    const path = join(directory, 'fixture.html');
    writeFileSync(path, `<!doctype html><html data-theme="dark"><head><style>${styles}</style><style>
      *{box-sizing:border-box}html,body{margin:0;padding:0;width:820px;min-height:900px;overflow:visible}
      .header-controls-fixture{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:820px}
      .header-case{flex:none;width:760px;height:132px}
      .trigger-samples{display:flex;gap:8px;padding:8px}
      .tauri-window{--header-fixture-native:1}
    </style></head><body${native ? ' class="tauri-window"' : ''}><script>${bundle}</script><script>${measure}</script></body></html>`);
    const rendered = spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--run-all-compositor-stages-before-draw',
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
  it('aligns visible controls in all header variants and shares one menu trigger visual in browser and native classes', () => {
    const browser = renderCase(false);
    const native = renderCase(true);

    for (const result of [browser, native]) {
      expect(result.cases).toHaveLength(6);
      for (const header of result.cases) {
        expect(header.slot, `${result.native ? 'native' : 'browser'} ${header.variant} open=${header.open} spacer`).toBe(false);
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
      expect(new Set(result.closedTriggerSignatures).size).toBe(1);
      expect(new Set(result.activeTriggerSignatures).size).toBe(1);
      expect(result.triggerLabels).toEqual([
        'Conversation actions|Conversation actions|menu|false',
        'Issue actions|Issue actions|menu|false',
        'Artifact actions|Artifact actions|menu|false',
        'Approval actions|Approval actions|menu|false',
        'Briefing actions|Briefing actions|menu|false',
      ]);
    }

    expect(native.cases).toEqual(browser.cases);
    expect(native.closedTriggerSignatures).toEqual(browser.closedTriggerSignatures);
    expect(native.activeTriggerSignatures).toEqual(browser.activeTriggerSignatures);
  });
});
