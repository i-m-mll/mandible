import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Surface = 'chat' | 'graph' | 'timeline' | 'console';
type Result = Record<string, unknown> & { surface: Surface; width: number; theme: string };

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate)).find(existsSync);

const styles = [
  'ui/src/styles/tokens.css', 'ui/src/styles/base.css', 'ui/src/styles/conversations.css',
  'ui/src/styles/session-overview.css', 'ui/src/styles/console.css',
  'ui/src/styles/detail-pane-shell.css', 'ui/src/styles/graph.css', 'ui/src/styles/timeline.css',
].map((path) => readFileSync(resolve(path), 'utf8')).join('\n');

function canonicalCheckoutRoot(): string {
  if (statSync(resolve('.git')).isDirectory()) return process.cwd();
  const gitDirectory = readFileSync(resolve('.git'), 'utf8').trim().replace(/^gitdir:\s*/, '');
  const markerIndex = gitDirectory.lastIndexOf(join('.git', 'worktrees'));
  if (markerIndex < 0) throw new Error(`Cannot resolve canonical checkout from ${gitDirectory}`);
  return gitDirectory.slice(0, markerIndex).replace(/[\\/]$/, '');
}

function bundleFixture(directory: string): string {
  const checkoutRoot = canonicalCheckoutRoot();
  const output = join(directory, 'fixture.js');
  const bundled = spawnSync(join(checkoutRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'), [
    resolve('test/browser/fixtures/app-right-sidebar-native-fixture.tsx'), '--bundle', `--outfile=${output}`,
    '--format=iife', '--platform=browser', '--target=es2020', '--jsx=automatic', '--jsx-import-source=preact',
    '--alias:react=preact/compat', '--alias:react-dom=preact/compat', '--alias:react/jsx-runtime=preact/jsx-runtime',
    '--loader:.css=empty', '--minify', '--log-level=silent',
  ], { encoding: 'utf8', env: { ...process.env, NODE_PATH: join(checkoutRoot, 'node_modules') } });
  if (bundled.status !== 0) throw new Error(`Native sidebar fixture bundle failed: ${bundled.stderr || bundled.stdout}`);
  return readFileSync(output, 'utf8');
}

function renderCase(surface: Surface, width: number, theme: 'light' | 'dark'): Result {
  if (!chrome) throw new Error('A Chromium browser is required for the app right-sidebar geometry gate.');
  const directory = mkdtempSync(join(tmpdir(), 'mandible-right-sidebar-'));
  try {
    const bundle = bundleFixture(directory);
    const measure = `
      const wait = () => new Promise(resolve => setTimeout(resolve, 0));
      const rect = node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
      const waitForRunOptions = async () => {
        for (let attempt=0; attempt<50; attempt+=1) {
          const composer=document.querySelector('.conv-compose');
          if (!composer) return;
          const bounds=rect(composer); const inline=document.querySelector('.conv-compose__run-options-inline'); const trigger=document.querySelector('.conv-compose__run-options-trigger');
          const selects=Array.from(inline.querySelectorAll('select'),rect);
          const collapsed=getComputedStyle(inline).visibility==='hidden' && getComputedStyle(trigger).display==='flex';
          const contained=selects.every(select=>select.left>=bounds.left && select.right<=bounds.right);
          if (collapsed || contained) return;
          await wait();
        }
        const composer=document.querySelector('.conv-compose'); const inline=document.querySelector('.conv-compose__run-options-inline'); const trigger=document.querySelector('.conv-compose__run-options-trigger');
        const actions=document.querySelector('.conv-compose__runtime-actions');
        throw new Error('Run options did not reconcile: '+JSON.stringify({composer:rect(composer),runtime:rect(inline.parentElement),inline:rect(inline),scrollWidth:inline.scrollWidth,visibility:getComputedStyle(inline).visibility,trigger:getComputedStyle(trigger).display,selects:Array.from(inline.querySelectorAll('select'),rect),actions:rect(actions),actionChildren:Array.from(actions.children,rect)}));
      };
      (async () => {
        await wait();
        const root=document.querySelector('.native-fixture');
        const body=document.querySelector('.app-right-sidebar__body');
        const header=document.querySelector('.app-right-sidebar__header');
        const toggles=()=>document.querySelectorAll('.app-right-sidebar-toggle');
        const scrollBefore=body.scrollTop; body.scrollTop=30;
        const initial={toggleCount:toggles().length,pressed:toggles()[0].getAttribute('aria-pressed'),header:rect(header),body:rect(body),scrollMoved:body.scrollTop>scrollBefore,
          bodyOverflow:getComputedStyle(body).overflowY, nestedVerticalScroll:Array.from(body.querySelectorAll('*')).filter(n=>['auto','scroll'].includes(getComputedStyle(n).overflowY)).length,
          mainInert:document.querySelector('main').hasAttribute('inert'),railInert:document.querySelector('.app-rail').hasAttribute('inert')};
        const tabs=Array.from(document.querySelectorAll('[role=tab]'));
        let tabResult=null;
        if(tabs.length){ tabs[0].focus(); tabs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await wait(); tabResult={selected:document.querySelector('[role=tab][aria-selected=true]').getAttribute('aria-label'),focused:document.activeElement.getAttribute('aria-label'),tooltips:tabs.map(n=>n.title),text:tabs.map(n=>n.textContent.trim())}; }
        const separator=document.querySelector('[role=separator]'); separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await wait();
        const keyboardWidth=parseFloat(getComputedStyle(root.querySelector('.app-layout')).getPropertyValue('--app-right-sidebar-width'));
        separator.setPointerCapture=()=>{}; separator.hasPointerCapture=()=>false;
        separator.dispatchEvent(new PointerEvent('pointerdown',{pointerId:7,clientX:500,bubbles:true}));
        separator.dispatchEvent(new PointerEvent('pointermove',{pointerId:7,clientX:550,bubbles:true}));
        separator.dispatchEvent(new PointerEvent('pointerup',{pointerId:7,clientX:550,bubbles:true})); await wait();
        const pointerWidth=parseFloat(getComputedStyle(root.querySelector('.app-layout')).getPropertyValue('--app-right-sidebar-width'));
        const beforeStream=document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label');
        document.querySelector('[data-stream-update]')?.click(); await wait();
        const afterStream=document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label');
        toggles()[0].click(); await wait(); await wait();
        const closedToggle=toggles()[0]; const closedHeader=closedToggle.closest('.detail-pane-header--compact');
        const closed={count:toggles().length,pressed:closedToggle.getAttribute('aria-pressed'),focused:document.activeElement===closedToggle,
          inHeader:Boolean(closedHeader),rightmost:closedHeader?closedHeader.querySelector('.detail-pane-header__main')?.lastElementChild?.contains(closedToggle):false,
          header:closedHeader?rect(closedHeader):null,toggle:rect(closedToggle),mainInert:document.querySelector('main').hasAttribute('inert')};
        toggles()[0].click(); await wait(); await wait(); await waitForRunOptions();
        const reopened={count:toggles().length,pressed:toggles()[0].getAttribute('aria-pressed'),focused:document.activeElement===toggles()[0]};
        const chat=document.querySelector('.chat-detail-frame'); const composer=document.querySelector('.conv-compose'); const transcript=document.querySelector('.conv-transcript');
        const transcriptScroll=document.querySelector('.stream-renderer__scroll'); const finalContent=document.querySelector('[data-transcript-final-content]');
        if(transcriptScroll) transcriptScroll.scrollTop=transcriptScroll.scrollHeight;
        const transcriptScrollState=transcriptScroll?{clientHeight:transcriptScroll.clientHeight,scrollHeight:transcriptScroll.scrollHeight,scrollTop:transcriptScroll.scrollTop}:null;
        const transcriptOuterState=transcript?{clientHeight:transcript.clientHeight,scrollHeight:transcript.scrollHeight,scrollTop:transcript.scrollTop}:null;
        const overlayControl=document.querySelector('.detail-pane-shell__overlay-control');
        const maskStyle=overlayControl?getComputedStyle(overlayControl,'::before'):null; const overlayRect=overlayControl?rect(overlayControl):null; const composerRect=composer?rect(composer):null;
        const mask=maskStyle&&overlayRect?{left:overlayRect.left+parseFloat(maskStyle.left),right:overlayRect.right-parseFloat(maskStyle.right),
          top:overlayRect.top+parseFloat(maskStyle.top),bottom:overlayRect.bottom-parseFloat(maskStyle.bottom),background:maskStyle.backgroundColor,zIndex:maskStyle.zIndex}:null;
        const inline=document.querySelector('.conv-compose__run-options-inline'); const trigger=document.querySelector('.conv-compose__run-options-trigger');
        const selectRects=Array.from(inline?.querySelectorAll('select')||[],rect);
        const runOptions=composer?{containerWidth:composer.clientWidth,inlineDisplay:getComputedStyle(inline).display,inlineVisibility:getComputedStyle(inline).visibility,triggerDisplay:getComputedStyle(trigger).display,
          triggerText:trigger.textContent.trim(),triggerHasSvg:Boolean(trigger.querySelector('svg')),selectRects,composer:composerRect}:null;
        const titleErrors=document.querySelector('[data-title-errors]');
        document.title=btoa(JSON.stringify({surface:'${surface}',width:${width},theme:'${theme}',initial,tabResult,keyboardWidth,pointerWidth,beforeStream,afterStream,closed,reopened,
          productionClass:body.querySelector('.detail-pane-shell')?.className||null,
          chatGeometry:chat?{header:rect(chat.querySelector('.detail-pane-shell__header')),body:rect(chat.querySelector('.detail-pane-shell__body')),overlayControl:rect(chat.querySelector('.detail-pane-shell__overlay-control')),overlayPointerEvents:getComputedStyle(overlayControl).pointerEvents,composer:composerRect,composerPointerEvents:getComputedStyle(composer).pointerEvents,transcript:rect(transcript),transcriptViewport:rect(transcriptScroll),transcriptBottomInset:parseFloat(getComputedStyle(transcriptScroll).paddingBottom),transcriptScrollState,transcriptOuterState,finalContent:rect(finalContent),mask,mainBackground:getComputedStyle(document.querySelector('.app-content')).backgroundColor}:null,
          runOptions,
          stored:localStorage.getItem('mandible_app_right_sidebar:native-${surface}:v1'),
          deterministicRetry:titleErrors?.dataset.deterministicRetry,transientRetry:titleErrors?.dataset.transientRetry,titleCopy:titleErrors?.textContent}));
      })().catch(error=>document.title='fixture-error:'+btoa(String(error?.stack||error)));
    `;
    const html = `<!doctype html><html data-theme="${theme}"><head><style>${styles}</style><style>*{box-sizing:border-box}html,body,.app-shell,.app-layout{margin:0;width:100%;height:520px;overflow:clip}.native-main{padding:24px}.native-fixture .app-content{grid-column:2;grid-row:1;min-width:0}.native-fixture .app-rail{grid-column:1;grid-row:1}.native-fixture .conv-detail{height:100%}[data-title-errors]{display:none}</style></head><body><script>${bundle}</script><script>${measure}</script></body></html>`;
    const path = join(directory, 'fixture.html');
    writeFileSync(path, html);
    const rendered = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=3000', '--dump-dom', `--window-size=${width},600`, `file://${path}?surface=${surface}`], { encoding: 'utf8', maxBuffer: 20_000_000 });
    if (rendered.status !== 0) throw new Error(`Chromium sidebar fixture failed: ${rendered.stderr}`);
    const fixtureError = rendered.stdout.match(/<title>fixture-error:([^<]+)<\/title>/)?.[1];
    if (fixtureError) throw new Error(Buffer.from(fixtureError, 'base64').toString('utf8'));
    const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
    if (!encoded || encoded === 'ready') throw new Error(`Chromium did not emit sidebar results (title=${encoded ?? 'none'}): ${rendered.stderr}\n${rendered.stdout.slice(-3000)}`);
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('production app right sidebar geometry and interaction', () => {
  it('keeps the native shell coherent across all consumers, widths, and themes', () => {
    const results = (['light', 'dark'] as const).flatMap((theme) => [1280, 760].flatMap((width) =>
      (['chat', 'graph', 'timeline', 'console'] as const).map((surface) => renderCase(surface, width, theme))));
    expect(results).toHaveLength(16);
    for (const result of results) {
      const initial = result.initial as Record<string, unknown>;
      expect(initial).toMatchObject({ toggleCount: 1, pressed: 'true', scrollMoved: true, bodyOverflow: 'auto' });
      expect((initial.header as { height: number }).height).toBe(48);
      expect((initial.header as { bottom: number }).bottom).toBe((initial.body as { top: number }).top);
      expect(result.closed, `${result.surface}/${result.width}/${result.theme} closed toggle`).toMatchObject({ count: 1, pressed: 'false', focused: true, mainInert: false });
      expect(result.reopened, `${result.surface}/${result.width}/${result.theme} reopened toggle`).toMatchObject({ count: 1, pressed: 'true', focused: true });
      expect(result.keyboardWidth).toBe(result.width === 760 ? 456 : 720);
      expect(result.pointerWidth).toBeLessThan(result.keyboardWidth as number);
      expect(result.stored).toContain('"width"');
      if (result.width === 760) expect(initial).toMatchObject({ mainInert: true, railInert: true });
      if (result.tabResult) {
        expect(result.tabResult).toMatchObject({ focused: result.surface === 'chat' ? 'Preview' : 'Message Info', selected: result.surface === 'chat' ? 'Preview' : 'Message Info' });
        expect((result.tabResult as { text: string[] }).text).toEqual(result.surface === 'chat' ? ['', '', ''] : ['', '']);
      }
      if (result.surface === 'console') expect(result.afterStream).toBe(result.beforeStream);
      if (result.surface === 'chat') {
        type Rect = { top: number; bottom: number; left: number; right: number };
        const geometry = result.chatGeometry as {
          header: Rect;
          body: Rect;
          overlayControl: Rect;
          overlayPointerEvents: string;
          composer: Rect;
          composerPointerEvents: string;
          transcriptViewport: Rect;
          transcriptBottomInset: number;
          transcriptScrollState: { clientHeight: number; scrollHeight: number; scrollTop: number };
          transcriptOuterState: { clientHeight: number; scrollHeight: number; scrollTop: number };
          finalContent: Rect;
          mask: Rect & { background: string };
          mainBackground: string;
        };
        expect(result.closed).toMatchObject({ inHeader: true, rightmost: true });
        expect(geometry.header.bottom).toBe(geometry.body.top);
        expect(geometry.body.bottom).toBe(geometry.overlayControl.bottom);
        expect(geometry.overlayControl.top).toBeLessThan(geometry.body.bottom);
        expect(geometry.overlayControl.left).toBeCloseTo(geometry.body.left, 0);
        expect(geometry.overlayControl.right).toBeCloseTo(geometry.body.right, 0);
        expect(geometry.overlayPointerEvents).toBe('none');
        expect(geometry.composer.top).toBeGreaterThanOrEqual(geometry.overlayControl.top);
        expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.overlayControl.bottom);
        expect(geometry.composerPointerEvents).toBe('auto');
        expect(geometry.composer.left).toBeGreaterThan(geometry.transcriptViewport.left);
        expect(geometry.composer.right).toBeLessThan(geometry.transcriptViewport.right);
        expect(geometry.transcriptViewport.left).toBeCloseTo(geometry.body.left, 0);
        expect(geometry.transcriptViewport.right).toBeCloseTo(geometry.body.right, 0);
        expect(geometry.transcriptViewport.top).toBeCloseTo(geometry.body.top, 0);
        expect(geometry.transcriptViewport.bottom).toBeCloseTo(geometry.body.bottom, 0);
        const composerHeight = geometry.composer.bottom - geometry.composer.top;
        const composerBottomGap = geometry.transcriptViewport.bottom - geometry.composer.bottom;
        const transcriptMaxScroll = geometry.transcriptScrollState.scrollHeight - geometry.transcriptScrollState.clientHeight;
        expect(geometry.transcriptBottomInset).toBeCloseTo(composerHeight + (2 * composerBottomGap), 5);
        expect(transcriptMaxScroll).toBeGreaterThan(0);
        expect(geometry.transcriptScrollState.scrollTop).toBeCloseTo(transcriptMaxScroll, 5);
        expect(geometry.transcriptOuterState.scrollHeight).toBe(geometry.transcriptOuterState.clientHeight);
        expect(geometry.transcriptOuterState.scrollTop).toBe(0);
        expect(geometry.finalContent.left).toBeCloseTo(geometry.composer.left, 0);
        expect(geometry.finalContent.right).toBeCloseTo(geometry.composer.right, 0);
        expect(geometry.finalContent.bottom).toBeLessThanOrEqual(geometry.composer.top - composerBottomGap + 0.5);
        expect(geometry.mask.left).toBeCloseTo(geometry.body.left, 0);
        expect(geometry.mask.right).toBeCloseTo(geometry.composer.right, 0);
        expect(Math.abs(geometry.mask.top - (geometry.composer.top + ((geometry.composer.bottom - geometry.composer.top) / 2)))).toBeLessThanOrEqual(1);
        expect(geometry.mask.bottom).toBeCloseTo(geometry.overlayControl.bottom, 0);
        const runOptions = result.runOptions as { containerWidth: number; inlineDisplay: string; inlineVisibility: string; triggerDisplay: string; triggerText: string; triggerHasSvg: boolean; selectRects: Array<{ left: number; right: number }>; composer: { left: number; right: number } };
        expect(runOptions.triggerText).toBe('');
        expect(runOptions.triggerHasSvg).toBe(true);
        expect(runOptions.inlineDisplay).toBe('flex');
        expect(runOptions.selectRects).toHaveLength(3);
        expect(new Set(runOptions.selectRects.map((select) => select.right - select.left)).size).toBeGreaterThan(1);
        if (runOptions.inlineVisibility === 'hidden') {
          expect(runOptions.triggerDisplay).toBe('flex');
        } else {
          expect(runOptions.triggerDisplay).toBe('none');
          expect(
            runOptions.selectRects.every((select) => select.left >= runOptions.composer.left && select.right <= runOptions.composer.right),
            `${result.surface}/${result.width}/${result.theme} run options ${JSON.stringify(runOptions)}`,
          ).toBe(true);
        }
        expect(geometry.mask.background).toBe(geometry.mainBackground);
        expect(result).toMatchObject({ deterministicRetry: 'false', transientRetry: 'true' });
        expect(String(result.titleCopy)).not.toContain('provider_metadata_missing');
      }
    }
  }, 60_000);
});
