// @provisioned chromium
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  APP_FRAME_CONTROLS_OFFSET,
  RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH,
  VIEW_SIDEBAR_AUTO_COLLAPSE_WIDTH,
} from '../../ui/src/app-shell';
import { runChromium } from '../helpers/chromium';
import type { ChromeShadowParameters } from '../../ui/src/chrome-shadow';

type Surface = 'chat' | 'graph' | 'timeline' | 'console';
type Result = Record<string, unknown> & { surface: Surface; width: number; theme: string };

const logoImage = `url("data:image/svg+xml;base64,${Buffer.from(readFileSync(resolve('ui/header-logo.svg'))).toString('base64')}")`;
const styles = [
  'ui/src/styles/tokens.css', 'ui/src/styles/base.css', 'ui/src/styles/app-frame.css', 'ui/src/styles/icon-tab-list.css', 'ui/src/styles/conversations.css',
  'ui/src/styles/session-overview.css', 'ui/src/styles/console.css',
  'ui/src/styles/detail-pane-shell.css', 'ui/src/styles/graph.css', 'ui/src/styles/timeline.css',
].map((path) => readFileSync(resolve(path), 'utf8')).join('\n') + `\n.app-header__logo { mask-image: ${logoImage}; -webkit-mask-image: ${logoImage}; }`;

function bundleFixture(directory: string): string {
  const output = join(directory, 'fixture.js');
  const bundled = spawnSync(createRequire(import.meta.url).resolve('esbuild/bin/esbuild'), [
    resolve('test/provisioned/fixtures/app-right-sidebar-native-fixture.tsx'), '--bundle', `--outfile=${output}`,
    '--format=iife', '--platform=browser', '--target=es2020', '--jsx=automatic', '--jsx-import-source=preact',
    '--alias:react=preact/compat', '--alias:react-dom=preact/compat', '--alias:react/jsx-runtime=preact/jsx-runtime',
    '--loader:.css=empty', '--minify', '--log-level=silent',
  ], { encoding: 'utf8', timeout: 10000 });
  if (bundled.status !== 0) throw new Error(`Native sidebar fixture bundle failed: ${bundled.stderr || bundled.stdout}`);
  return readFileSync(output, 'utf8');
}

let fixtureBundle: string | undefined;

function renderCase(surface: Surface, width: number, theme: 'light' | 'dark', native = false, fullRail = false, scale = 1, paint: { disableShadow?: boolean; screenshotPath?: string; shadow?: ChromeShadowParameters } = {}): Result {
  const directory = mkdtempSync(join(tmpdir(), 'mandible-right-sidebar-'));
  try {
    const bundle = fixtureBundle ??= bundleFixture(directory);
    const measure = `
      const wait = () => new Promise(resolve => setTimeout(resolve, 0));
      const rect = node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
      const getPaintSurface=()=>{
        const frame=document.querySelector('.app-frame'); const shadow=getComputedStyle(frame,'::after'); const dock=document.querySelector('.app-right-sidebar');
        return {workspace:rect(document.querySelector('.app-layout')),main:rect(document.querySelector('.chat-detail-frame')||document.querySelector('main')),dock:rect(dock),radius:parseFloat(getComputedStyle(document.querySelector('.app-layout')).borderTopLeftRadius),
          frameBackground:getComputedStyle(frame).backgroundColor,barBackground:getComputedStyle(document.querySelector('.app-frame__bar')).backgroundColor,railBackground:getComputedStyle(document.querySelector('.app-rail')).backgroundColor,
          shadow:{width:shadow.width,height:shadow.height,zIndex:shadow.zIndex,pointerEvents:shadow.pointerEvents,backgroundImage:shadow.backgroundImage,backgroundSize:shadow.backgroundSize},dockZIndex:getComputedStyle(dock).zIndex};
      };
      const edgeTarget = node => { const r=rect(node); return document.elementFromPoint(r.left+0.5,(r.top+r.bottom)/2); };
      const edgeClick = node => { const target=edgeTarget(node); if (!node.contains(target)) throw new Error('Control edge is unreachable: '+node.getAttribute('aria-label')); target.closest('button').click(); };
      const paint = node => {
        const hit=rect(node); const glyph=rect(node.querySelector('svg')); const decoration=getComputedStyle(node,'::before');
        return {kind:node.classList.contains('app-frame__history-button')?'history':node.classList.contains('detail-pane-menu-trigger')?'menu':'toggle',hit,glyph,
          decoration:{width:parseFloat(decoration.width),height:parseFloat(decoration.height),background:decoration.backgroundColor,pointerEvents:decoration.pointerEvents},
          buttonBackground:getComputedStyle(node).backgroundColor,edgeReachable:node.contains(edgeTarget(node))};
      };
      const historyActions={back:0,forward:0};
      window.history.back=()=>historyActions.back++;
      window.history.forward=()=>historyActions.forward++;
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
        await wait(); await wait();
        const root=document.querySelector('.native-fixture');
        if (${Boolean(paint.screenshotPath)}) {
          document.querySelector('[data-paint-probe-content]').style.visibility='hidden';
          for (const child of document.querySelector('.app-frame__bar').children) child.style.visibility='hidden';
          await waitForRunOptions();
          document.title=btoa(JSON.stringify({surface:'${surface}',width:${width},theme:'${theme}',paintSurface:getPaintSurface()}));
          return;
        }
        const toggles=()=>document.querySelectorAll('.app-right-sidebar-toggle');
        const sidebar=document.querySelector('.app-right-sidebar');
        const autoCollapsed={right:sidebar.hidden,rightDisplay:getComputedStyle(sidebar).display,view:!root.querySelector('.app-frame').classList.contains('app-frame--left-open')};
        if(sidebar.hidden){ toggles()[0].click(); await wait(); await wait(); }
        if(!root.querySelector('.app-frame').classList.contains('app-frame--left-open')){ root.querySelector('.app-frame__navigation button:last-child').click(); await wait(); }
        let menuInteraction=null;
        const menuTrigger=document.querySelector('.app-frame__bar .detail-pane-menu-trigger');
        if(menuTrigger){
          edgeClick(menuTrigger); await wait();
          const menu=document.querySelector('[role=menu]'); const menuBounds=rect(menu);
          const expandedPaint=paint(menuTrigger);
          const item=menu.querySelector('button'); item.focus(); item.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait();
          menuInteraction={menuBounds,anchor:rect(menuTrigger),expandedPaint,closed:!document.querySelector('[role=menu]'),focused:document.activeElement===menuTrigger};
        }
        const frameStates=[];
        const frameGeometry=()=>{
          const bar=document.querySelector('.app-frame__bar'); const main=document.querySelector('.app-frame__main-header');
          const right=document.querySelector('.app-frame__right'); const left=document.querySelector('.view-sidebar');
          const buttons=Array.from(document.querySelectorAll('.app-frame__navigation button,.app-frame__main-header .detail-pane-menu-trigger,.app-frame__right .app-right-sidebar-toggle'),rect);
          const glyphs=Array.from(bar.querySelectorAll('svg,.detail-pane-header__title,.detail-pane-header__supporting-metadata'),rect);
          const logo=document.querySelector('.app-header__logo'); const rail=document.querySelector('.app-rail');
          const railButton=rail.querySelector('.app-rail__item'); const workspace=document.querySelector('.app-layout');
          const back=document.querySelector('[aria-label=Back]');
          const hit=node=>{const r=rect(node);return node.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2));};
          return {logo:rect(logo),rail:rect(rail),railButton:rect(railButton),workspace:rect(workspace),backReachable:hit(back),railReachable:hit(railButton),reservation:parseFloat(getComputedStyle(root).getPropertyValue('--app-native-controls-reservation')),leftOpen:Boolean(left),rightOpen:!sidebar.hidden,leftSeam:left?rect(left).right:null,main:rect(main),right:rect(right),dock:rect(sidebar),bar:rect(bar),buttons,glyphs};
        };
        if(root.classList.contains('native-fixture--chat')){
          frameStates.push(frameGeometry());
          const leftToggle=root.querySelector('.app-frame__navigation button:last-child');
          leftToggle.click(); await wait(); frameStates.push(frameGeometry());
          toggles()[0].click(); await wait(); frameStates.push(frameGeometry());
          leftToggle.click(); await wait(); frameStates.push(frameGeometry());
          toggles()[0].click(); await wait();
          const leftResize=document.querySelector('.view-sidebar [role=separator]'); leftResize.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await wait(); frameStates.push(frameGeometry());
        }
        let fullscreen=null;
        if ('${native}' === 'true' && root.classList.contains('native-fixture--chat')) {
          const back=document.querySelector('[aria-label=Back]'); const logo=document.querySelector('.app-header__logo');
          const before=frameGeometry();
          window.dispatchEvent(new CustomEvent('fixture-native-reservation',{detail:0})); await wait(); const during=frameGeometry();
          window.dispatchEvent(new CustomEvent('fixture-native-reservation',{detail:88})); await wait(); const after=frameGeometry();
          fullscreen={before,during,after,retained:back===document.querySelector('[aria-label=Back]')&&logo===document.querySelector('.app-header__logo')};
        }
        const controls=Array.from(document.querySelectorAll('.app-frame__bar .app-frame__button,.app-frame__bar .app-right-sidebar-toggle,.app-frame__bar .detail-pane-menu-trigger'));
        edgeClick(document.querySelector('[aria-label=Back]'));
        edgeClick(document.querySelector('[aria-label=Forward]'));
        for (const toggle of controls.filter(node=>node.hasAttribute('aria-pressed'))) { edgeClick(toggle); await wait(); edgeClick(toggle); await wait(); }
        const body=document.querySelector('.app-right-sidebar__body');
        const header=document.querySelector('.app-frame__bar');
        const reopenedLayout={right:!sidebar.hidden,view:root.querySelector('.app-frame').classList.contains('app-frame--left-open'),mainWidth:rect(document.querySelector('main')).width,
          presentation:sidebar.dataset.presentation,mainInert:document.querySelector('main').hasAttribute('inert'),railInert:document.querySelector('.app-rail').hasAttribute('inert')};
        const scrollOwner=root.classList.contains('native-fixture--chat')?(body.querySelector('.detail-pane-shell__body')||body):body;
        const scrollBefore=scrollOwner.scrollTop; scrollOwner.scrollTop=30;
        const initial={toggleCount:toggles().length,pressed:toggles()[0].getAttribute('aria-pressed'),sidebar:rect(sidebar),header:rect(header),body:rect(body),scrollMoved:scrollOwner.scrollTop>scrollBefore,
          bodyOverflow:getComputedStyle(body).overflowY, nestedVerticalScroll:Array.from(body.querySelectorAll('*')).filter(n=>['auto','scroll'].includes(getComputedStyle(n).overflowY)).length,
          presentation:sidebar.dataset.presentation,mainInert:document.querySelector('main').hasAttribute('inert'),railInert:document.querySelector('.app-rail').hasAttribute('inert')};
        const overviewPanel=document.querySelector('#app-right-sidebar-panel-overview');
        const overviewContent=overviewPanel?.querySelector('.chat-right-sidebar__empty');
        const overviewScrollTop=scrollOwner.scrollTop;
        const tabs=Array.from(document.querySelectorAll('[role=tab]'));
        let tabResult=null;
        if(tabs.length){ tabs[0].focus(); tabs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await wait(); const switched={selected:document.querySelector('[role=tab][aria-selected=true]').getAttribute('aria-label'),focused:document.activeElement.getAttribute('aria-label')}; const contentRetainedWhileHidden=overviewContent===document.querySelector('#app-right-sidebar-panel-overview .chat-right-sidebar__empty'); tabs[0].click(); await wait(); const overviewScrollPreserved=overviewScrollTop===scrollOwner.scrollTop; const overviewContentRetained=contentRetainedWhileHidden&&overviewContent===document.querySelector('#app-right-sidebar-panel-overview .chat-right-sidebar__empty'); tabs[1].click(); await wait(); tabResult={...switched,accessibleNames:tabs.map(n=>n.getAttribute('aria-label')),tooltips:tabs.map(n=>n.title),text:tabs.map(n=>n.textContent.trim()),titleRows:document.querySelectorAll('.chat-right-sidebar__detail .detail-pane-shell__header').length,overviewContentRetained,overviewScrollPreserved}; }
        const separator=document.querySelector('.app-right-sidebar__resize'); separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await wait();
        const keyboardWidth=parseFloat(getComputedStyle(root.querySelector('.app-layout')).getPropertyValue('--app-right-sidebar-width'));
        separator.setPointerCapture=()=>{}; separator.hasPointerCapture=()=>false;
        separator.dispatchEvent(new PointerEvent('pointerdown',{pointerId:7,clientX:500,bubbles:true}));
        separator.dispatchEvent(new PointerEvent('pointermove',{pointerId:7,clientX:550,bubbles:true}));
        separator.dispatchEvent(new PointerEvent('pointerup',{pointerId:7,clientX:550,bubbles:true})); await wait();
        const pointerWidth=parseFloat(getComputedStyle(root.querySelector('.app-layout')).getPropertyValue('--app-right-sidebar-width'));
        const beforeStream=document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label');
        document.querySelector('[data-stream-update]')?.click(); await wait();
        const afterStream=document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label');
        const preservedScrollOwner=root.classList.contains('native-fixture--chat')?(document.querySelector('.app-right-sidebar__body .detail-pane-shell__body')||document.querySelector('.app-right-sidebar__body')):document.querySelector('.app-right-sidebar__body');
        preservedScrollOwner.scrollTop=31;
        const preservedScrollTop=preservedScrollOwner.scrollTop;
        separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait(); await wait();
        const closedToggle=toggles()[0]; const closedHeader=closedToggle.closest('.app-frame__bar');
        const closed={count:toggles().length,pressed:closedToggle.getAttribute('aria-pressed'),focused:document.activeElement===closedToggle,
          inHeader:Boolean(closedHeader),rightmost:closedHeader?closedHeader.querySelector('.app-frame__right')?.lastElementChild===closedToggle:false,
          header:closedHeader?rect(closedHeader):null,toggle:rect(closedToggle),sidebar:rect(sidebar),display:getComputedStyle(sidebar).display,
          mainInert:document.querySelector('main').hasAttribute('inert')};
        toggles()[0].click(); await wait(); await wait(); await waitForRunOptions();
        const reopenedScrollOwner=root.classList.contains('native-fixture--chat')?(document.querySelector('.app-right-sidebar__body .detail-pane-shell__body')||document.querySelector('.app-right-sidebar__body')):document.querySelector('.app-right-sidebar__body');
        const reopened={count:toggles().length,pressed:toggles()[0].getAttribute('aria-pressed'),focused:document.activeElement===toggles()[0],scrollTop:reopenedScrollOwner.scrollTop};
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
        const submit=document.querySelector('.conv-compose__send'); const submitVisual=submit?getComputedStyle(submit,'::before'):null; const submitIcon=submit?.querySelector('svg');
        const jump=document.querySelector('.stream-renderer__scroll-btn'); const jumpVisual=jump?getComputedStyle(jump,'::before'):null; const jumpIcon=jump?.querySelector('svg');
        const runOptions=composer?{containerWidth:composer.clientWidth,inlineDisplay:getComputedStyle(inline).display,inlineVisibility:getComputedStyle(inline).visibility,triggerDisplay:getComputedStyle(trigger).display,
          triggerText:trigger.textContent.trim(),triggerHasSvg:Boolean(trigger.querySelector('svg')),selectRects,composer:composerRect,
          submit:rect(submit),submitVisual:{width:parseFloat(submitVisual.width),height:parseFloat(submitVisual.height)},submitIcon:rect(submitIcon),submitLabel:submit.getAttribute('aria-label')}:null;
        const jumpControl=jump?{hit:rect(jump),visual:{width:parseFloat(jumpVisual.width),height:parseFloat(jumpVisual.height)},icon:rect(jumpIcon),label:jump.getAttribute('aria-label'),title:jump.getAttribute('title')}:null;
        const titleErrors=document.querySelector('[data-title-errors]');
        const controlPaint=controls.map(node=>{node.focus({preventScroll:true});return paint(node);});
        document.querySelector('[aria-label=Back]').focus({preventScroll:true});
        const paintSurface=getPaintSurface();
        document.title=btoa(JSON.stringify({surface:'${surface}',width:${width},theme:'${theme}',autoCollapsed,reopenedLayout,initial,tabResult,keyboardWidth,pointerWidth,beforeStream,afterStream,closed,reopened,frameStates,fullscreen,menuInteraction,controlPaint,historyActions,paintSurface,
          productionClass:body.querySelector('.detail-pane-shell')?.className||null,
          chatGeometry:chat?{header:rect(document.querySelector('.app-frame__bar')),body:rect(chat.querySelector('.detail-pane-shell__body')),overlayControl:rect(chat.querySelector('.detail-pane-shell__overlay-control')),overlayPointerEvents:getComputedStyle(overlayControl).pointerEvents,composer:composerRect,composerPointerEvents:getComputedStyle(composer).pointerEvents,transcript:rect(transcript),transcriptViewport:rect(transcriptScroll),transcriptBottomInset:parseFloat(getComputedStyle(transcriptScroll).paddingBottom),transcriptScrollState,transcriptOuterState,finalContent:rect(finalContent),mask,mainBackground:getComputedStyle(document.querySelector('.app-content')).backgroundColor}:null,
          runOptions,jumpControl,preservedScrollTop,
          stored:localStorage.getItem('mandible_app_right_sidebar:native-${surface}:v1'),
          deterministicRetry:titleErrors?.dataset.deterministicRetry,transientRetry:titleErrors?.dataset.transientRetry,titleCopy:titleErrors?.textContent}));
      })().catch(error=>document.title='fixture-error:'+btoa(String(error?.stack||error)));
    `;
    const html = `<!doctype html><html data-theme="${theme}" data-frame-presentation="${native ? 'macos-overlay' : 'system'}"><head><style>${styles}</style><style>*{box-sizing:border-box}html,body,.app-shell{margin:0;width:100%;height:520px;overflow:clip}.native-main{padding:24px}.native-fixture .app-content{min-width:0;padding:0}.fixture-split{display:flex;min-width:0;height:100%}.fixture-split>.conv-detail{flex:1;min-width:0}.native-fixture .conv-detail{height:100%}.native-fixture--chat .chat-right-sidebar__content::after{content:'';display:block;height:900px}[data-title-errors]{display:none}</style></head><body><script>${bundle}</script><script>${measure}</script></body></html>`;
    const evidenceDirectory = paint.screenshotPath ? undefined : process.env.MANDIBLE_GEOMETRY_EVIDENCE_DIR;
    const evidenceName = `${surface}-${width}-${theme}-${native ? 'native' : 'browser'}-${fullRail ? 'expanded' : 'icons'}-${scale}`;
    if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true });
    const screenshotPath = paint.screenshotPath ?? (evidenceDirectory ? join(evidenceDirectory, evidenceName + '.png') : null);
    const screenshotArgs = screenshotPath ? [`--screenshot=${screenshotPath}`] : [];
    const path = join(directory, 'fixture.html');
    writeFileSync(path, paint.disableShadow ? html.replace('</head>', '<style>.app-frame::after{background-image:none}</style></head>') : html);
    const rendered = runChromium([...screenshotArgs, '--run-all-compositor-stages-before-draw', '--virtual-time-budget=3000', '--dump-dom', `--force-device-scale-factor=${scale}`, `--window-size=${width},600`, `file://${path}?surface=${surface}${fullRail ? '&fullRail' : ''}${paint.shadow ? '&shadow=' + encodeURIComponent(JSON.stringify(paint.shadow)) : ''}`], { encoding: 'utf8', maxBuffer: 20_000_000 });
    if (rendered.status !== 0) throw new Error(`Chromium sidebar fixture failed: ${rendered.stderr}`);
    const fixtureError = rendered.stdout.match(/<title>fixture-error:([^<]+)<\/title>/)?.[1];
    if (fixtureError) throw new Error(Buffer.from(fixtureError, 'base64').toString('utf8'));
    const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
    if (!encoded || encoded === 'ready') throw new Error(`Chromium did not emit sidebar results (title=${encoded ?? 'none'}): ${rendered.stderr}\n${rendered.stdout.slice(-3000)}`);
    const result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Result;
    if (evidenceDirectory) writeFileSync(join(evidenceDirectory, evidenceName + '.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type PixelProbe = { distance: number; x: number; y: number };
type PixelSample = { distance: number; baseline: number[]; painted: number[]; delta: number };

function compareShadowPixels(directory: string, painted: string, baseline: string, viewportWidth: number, probes: Record<string, PixelProbe[]>): Record<string, PixelSample[]> {
  const page = join(directory, 'compare.html');
  writeFileSync(page, `<!doctype html><script>
    const load=src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=src;});
    Promise.all(${JSON.stringify([painted, baseline].map(path => pathToFileURL(path).href))}.map(load)).then(images=>{
      const contexts=images.map(image=>{const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);return context;});
      const scale=images[0].width/${viewportWidth};
      const pixel=(context,point)=>Array.from(context.getImageData(Math.floor(point.x*scale),Math.floor(point.y*scale),1,1).data).slice(0,3);
      const profiles=Object.fromEntries(Object.entries(${JSON.stringify(probes)}).map(([name,points])=>[name,points.map(point=>{
        const painted=pixel(contexts[0],point),baseline=pixel(contexts[1],point);
        return {distance:point.distance,painted,baseline,delta:baseline.reduce((sum,value,i)=>sum+value-painted[i],0)/3};
      })]));
      document.title=btoa(JSON.stringify(profiles));
    }).catch(error=>document.title='fixture-error:'+btoa(String(error?.stack||error)));
  </script>`);
  const rendered = runChromium(['--allow-file-access-from-files', '--virtual-time-budget=1000', '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', maxBuffer: 20_000_000 });
  if (rendered.status !== 0) throw new Error(`Shadow pixel comparison failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded || encoded.startsWith('fixture-error:')) throw new Error(`Shadow pixel comparison did not complete: ${encoded ?? rendered.stderr}`);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, PixelSample[]>;
}

describe('rendered workspace shadow', () => {
  it.each([{ widthPx: 5, profile: 0 }, { widthPx: 5, profile: 1 }, { widthPx: 16, profile: 1 }])('renders profile $profile at width $widthPx outward with an unchanged interior', parameters => {
    const directory = mkdtempSync(join(tmpdir(), 'mandible-shadow-profile-'));
    try {
      const shadow = { ...parameters, maxDarkness: 0.4 };
      const painted = join(directory, 'painted.png');
      const baseline = join(directory, 'baseline.png');
      const result = renderCase('chat', 1280, 'light', false, false, 1, { shadow, screenshotPath: painted });
      renderCase('chat', 1280, 'light', false, false, 1, { shadow, disableShadow: true, screenshotPath: baseline });
      const { workspace, radius } = result.paintSurface as { workspace: { left: number; top: number }; radius: number };
      const distances = parameters.profile === 0 ? [0.5, 1.5, 4.5, 6] : [1.5, parameters.widthPx / 2, parameters.widthPx - 0.5, parameters.widthPx + 1];
      const profiles = compareShadowPixels(directory, painted, baseline, result.width, {
        top: distances.map(distance => ({ distance, x: workspace.left + 100, y: workspace.top - distance })),
        left: distances.map(distance => ({ distance, x: workspace.left - distance, y: workspace.top + 100 })),
        corner: distances.map(distance => ({ distance, x: workspace.left + radius - (radius + distance) * 3 / Math.sqrt(13), y: workspace.top + radius - (radius + distance) * 2 / Math.sqrt(13) })),
        interior: [2, 5, 10].flatMap(distance => [
          { distance, x: workspace.left + 100, y: workspace.top + distance },
          { distance, x: workspace.left + distance, y: workspace.top + 100 },
          { distance, x: workspace.left + radius - (radius - distance) / Math.SQRT2, y: workspace.top + radius - (radius - distance) / Math.SQRT2 },
        ]),
      });
      for (const name of ['top', 'left', 'corner']) {
        const samples = profiles[name]!;
        expect(samples[0]!.delta, name + ' contact paint').toBeGreaterThan(10);
        expect(samples.at(-1)!.delta, name + ' extent').toBe(0);
        if (parameters.profile === 0) expect(samples[1]!.delta, name + ' hard contact edge').toBe(0);
        else {
          expect(samples[1]!.delta, name + ' linear falloff').toBeGreaterThan(20);
          expect(samples[1]!.delta).toBeLessThan(samples[0]!.delta);
        }
      }
      for (const sample of profiles.interior!) expect(sample.delta).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['light', 'dark'] as const)('applies the selected shadow strength to %s chrome without interior shading', theme => {
    const evidenceDirectory = process.env.MANDIBLE_GEOMETRY_EVIDENCE_DIR;
    const directory = evidenceDirectory ?? mkdtempSync(join(tmpdir(), 'mandible-shadow-pixels-'));
    mkdirSync(directory, { recursive: true });
    try {
      const painted = join(directory, `shadow-${theme}-on.png`);
      const baseline = join(directory, `shadow-${theme}-off.png`);
      const result = renderCase('chat', 1280, theme, false, false, theme === 'dark' ? 1.25 : 1, { screenshotPath: painted });
      renderCase('chat', 1280, theme, false, false, theme === 'dark' ? 1.25 : 1, { disableShadow: true, screenshotPath: baseline });
      type Rect = { left: number; right: number; top: number; bottom: number };
      const surface = result.paintSurface as { workspace: Rect; main: Rect; dock: Rect; radius: number; shadow: { width: string; height: string } };
      const { workspace, main, dock, radius } = surface;
      expect(parseFloat(surface.shadow.width) - (workspace.right - workspace.left)).toBeCloseTo(5, 1);
      expect(parseFloat(surface.shadow.height) - (workspace.bottom - workspace.top)).toBeCloseTo(5, 1);
      const distances = [1.5, 2, 3, 4, 4.5, 6];
      const profiles = compareShadowPixels(directory, painted, baseline, result.width, {
        topSidebar: distances.map(distance => ({ distance, x: workspace.left + 96, y: workspace.top - distance })),
        topMain: distances.map(distance => ({ distance, x: (main.left + main.right) / 2, y: workspace.top - distance })),
        topDock: distances.map(distance => ({ distance, x: (dock.left + dock.right) / 2, y: workspace.top - distance })),
        left: distances.map(distance => ({ distance, x: workspace.left - distance, y: workspace.top + 100 })),
        corner: distances.map(distance => ({ distance, x: workspace.left + radius - (radius + distance) / Math.SQRT2, y: workspace.top + radius - (radius + distance) / Math.SQRT2 })),
        tangentTop: [1.5, 3, 4.5].flatMap(distance => [-1, 1].map(offset => ({ distance, x: workspace.left + radius + offset, y: workspace.top - distance }))),
        tangentLeft: [1.5, 3, 4.5].flatMap(distance => [-1, 1].map(offset => ({ distance, x: workspace.left - distance, y: workspace.top + radius + offset }))),
        interior: distances.flatMap(distance => [
          { distance, x: workspace.left + 96, y: workspace.top + distance },
          { distance, x: (main.left + main.right) / 2, y: workspace.top + distance },
          { distance, x: (dock.left + dock.right) / 2, y: workspace.top + distance },
          { distance, x: workspace.left + distance, y: workspace.top + 100 },
          { distance, x: workspace.left + radius - (radius - distance) / Math.SQRT2, y: workspace.top + radius - (radius - distance) / Math.SQRT2 },
        ]),
        line: [workspace.left + 96, (main.left + main.right) / 2, (dock.left + dock.right) / 2].map(x => ({ distance: 0, x, y: workspace.top + 0.5 })),
        outside: [
          { distance: 0, x: workspace.left - 6, y: workspace.top + 100 },
          { distance: 0, x: workspace.left + 96, y: workspace.top - 6 },
          { distance: 0, x: workspace.right - 2, y: workspace.top + 100 },
          { distance: 0, x: (main.left + main.right) / 2, y: workspace.bottom - 2 },
        ],
      });
      if (evidenceDirectory) writeFileSync(join(directory, `shadow-${theme}-pixels.json`), JSON.stringify({ theme, probeSetup: 'Initial mounted production frame; the fixture corner label and top-bar foreground are hidden to expose uninterrupted material while retaining layout. Baseline disables only the shadow background.', surface: result.paintSurface, profiles }, null, 2));
      if (theme === 'dark') expect(readFileSync(painted).equals(readFileSync(baseline)), 'dark shadow on/off screenshots must be identical').toBe(true);
      for (const [name, samples] of Object.entries(profiles)) {
        if (theme === 'dark' || name === 'outside' || name === 'interior') { for (const sample of samples) expect(sample.delta).toBe(0); continue; }
        if (name.startsWith('tangent')) {
          for (let i=0;i<samples.length;i+=2) expect(Math.abs(samples[i]!.delta - samples[i+1]!.delta), `${theme} ${name} joins continuously`).toBeLessThanOrEqual(2);
          continue;
        }
        if (name === 'line') { for (const sample of samples) expect(Math.abs(sample.delta), `${theme} contour remains independent of shadow`).toBeLessThanOrEqual(3); continue; }
        expect(samples[0]!.delta, `${theme} ${name} rendered contrast`).toBeGreaterThanOrEqual(2);
        for (let i=1;i<samples.length;i++) expect(samples[i]!.delta, `${theme} ${name} monotone falloff`).toBeLessThanOrEqual(samples[i-1]!.delta + 1);
        expect(samples.at(-1)!.delta, `${theme} ${name} paint extent`).toBeLessThanOrEqual(1);
      }
    } finally {
      if (!evidenceDirectory) rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('production app right sidebar geometry and interaction', () => {
  const cases: Array<{ surface: Surface; width: number; theme: 'light' | 'dark'; native?: boolean; fullRail?: boolean; scale?: number }> = [
    { surface: 'chat', width: 1280, theme: 'light' },
    { surface: 'chat', width: 962, theme: 'dark' },
    { surface: 'chat', width: 600, theme: 'light' },
    { surface: 'graph', width: 1280, theme: 'dark' },
    { surface: 'timeline', width: 962, theme: 'light' },
    { surface: 'console', width: 600, theme: 'dark' },
    { surface: 'chat', width: 600, theme: 'dark', fullRail: true },
    { surface: 'chat', width: 600, theme: 'dark', native: true },
    { surface: 'chat', width: 1280, theme: 'light', native: true, fullRail: true },
    { surface: 'chat', width: 1280, theme: 'dark', fullRail: true, scale: 1.25 },
  ];
  it.each(cases)('preserves the $surface sidebar at $width px in $theme', ({ surface, width, theme, native, fullRail, scale }) => {
    const result = renderCase(surface, width, theme, native, fullRail, scale);
    expect(result.historyActions).toEqual({ back: 1, forward: 1 });
    for (const control of result.controlPaint as Array<{ kind: string; hit: {width:number;height:number}; glyph:{width:number;height:number}; decoration:{width:number;height:number;background:string;pointerEvents:string}; buttonBackground:string;edgeReachable:boolean }>) {
      expect(control.edgeReachable).toBe(true);
      expect(control.decoration.pointerEvents).toBe('none');
      expect(control.buttonBackground).toBe('rgba(0, 0, 0, 0)');
      expect(control.decoration.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(control.hit.width).toBe(control.kind === 'menu' ? 24 : 34);
      expect(control.hit.height).toBe(control.hit.width);
      expect(control.decoration.width).toBeCloseTo((control.hit.width + control.glyph.width) / 2, 2);
      expect(control.decoration.height).toBeCloseTo((control.hit.height + control.glyph.height) / 2, 2);
    }
    expect(result.autoCollapsed).toEqual({
      right: result.width < RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH,
      rightDisplay: result.width < RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH ? 'none' : 'grid',
      view: result.width < VIEW_SIDEBAR_AUTO_COLLAPSE_WIDTH,
    });
    expect(result.reopenedLayout).toMatchObject({
      right: true,
      view: true,
      presentation: 'dock',
      mainInert: false,
      railInert: false,
    });
    expect((result.reopenedLayout as { mainWidth: number }).mainWidth).toBeGreaterThan(0);
    const initial = result.initial as Record<string, unknown>;
    expect(initial, `${result.surface}/${result.width}/${result.theme} initial sidebar`).toMatchObject({ toggleCount: 1, pressed: 'true', scrollMoved: true });
    expect(initial.bodyOverflow).toBe(result.surface === 'chat' ? 'hidden' : 'auto');
    expect(initial.presentation).toBe('dock');
    const sidebarRect = initial.sidebar as { left: number; right: number; width: number };
    expect(sidebarRect.left, `${result.surface}/${result.width}/${result.theme} sidebar visible`).toBeGreaterThanOrEqual(0);
    expect((initial.header as { bottom: number }).bottom).toBe((initial.body as { top: number }).top);
    expect(result.closed, `${result.surface}/${result.width}/${result.theme} closed toggle`).toMatchObject({
      count: 1,
      pressed: 'false',
      focused: true,
      display: 'none',
      sidebar: { width: 0 },
      mainInert: false,
    });
    expect(result.reopened, `${result.surface}/${result.width}/${result.theme} reopened toggle`).toMatchObject({ count: 1, pressed: 'true', focused: true });
    expect((result.reopened as { scrollTop: number }).scrollTop, `${result.surface}/${result.width}/${result.theme} preserved scroll`)
      .toBe(result.preservedScrollTop);
    expect(result.keyboardWidth).toBeLessThan(result.width);
    expect(result.pointerWidth).toBeLessThanOrEqual(result.keyboardWidth as number);
    expect(result.stored).toContain('"width"');
    expect(initial).toMatchObject({ mainInert: false, railInert: false });
    if (result.tabResult) {
      expect(result.tabResult).toMatchObject({ focused: result.surface === 'chat' ? 'Preview' : 'Message Info', selected: result.surface === 'chat' ? 'Preview' : 'Message Info' });
      expect((result.tabResult as { text: string[] }).text).toEqual(result.surface === 'chat' ? ['', '', ''] : ['', '']);
      if (result.surface === 'chat') {
        expect(result.tabResult).toMatchObject({
          accessibleNames: ['Session Overview', 'Preview', 'Activity'],
          tooltips: ['Session Overview', 'Preview', 'Activity'],
          titleRows: 0,
          overviewContentRetained: true,
          overviewScrollPreserved: true,
        });
      }
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
      expect(geometry.header.bottom).toBeCloseTo(geometry.body.top, 2);
      expect(result.menuInteraction).toMatchObject({ closed: true, focused: true });
      const menu = result.menuInteraction as { menuBounds: Rect; anchor: Rect };
      expect(menu.menuBounds.top).toBeGreaterThanOrEqual(menu.anchor.bottom);
      type FrameGeometry = { logo: Rect; rail: Rect; railButton: Rect; workspace: Rect; backReachable: boolean; railReachable: boolean; reservation: number; leftOpen: boolean; rightOpen: boolean; leftSeam: number | null; main: Rect; right: Rect; dock: Rect; bar: Rect; buttons: Rect[]; glyphs: Rect[] };
      for (const state of result.frameStates as FrameGeometry[]) {
        expect(state.backReachable).toBe(true);
        expect(state.railReachable).toBe(true);
        expect(state.rail.top).toBeCloseTo(state.bar.bottom, 2);
        expect(state.workspace.top).toBeCloseTo(state.bar.bottom, 2);
        expect(state.workspace.left).toBeCloseTo(state.rail.right, 1);
        expect(state.railButton.top).toBeGreaterThan(state.bar.bottom);
        expect(state.logo.right).toBeLessThan(state.buttons[0].left);
        const logoCenter = (state.logo.left + state.logo.right) / 2;
        const backCenter = (state.buttons[0].left + state.buttons[0].right) / 2;
        const historySpacing = state.buttons[1].left - state.buttons[0].left;
        expect(backCenter - logoCenter).toBeCloseTo(historySpacing + APP_FRAME_CONTROLS_OFFSET, 2);
        expect((state.logo.top + state.logo.bottom) / 2).toBeCloseTo((state.bar.top + state.bar.bottom) / 2, 1);
        if (native && state.reservation > 0) expect(state.logo.left).toBeCloseTo(state.reservation, 1);
        else expect((state.logo.left + state.logo.right) / 2).toBeCloseTo((state.rail.left + state.rail.right) / 2, 1);
        if (state.leftOpen) expect(state.main.left).toBeCloseTo(state.leftSeam!, 0);
        else expect(state.main.left - state.buttons[2].right).toBeLessThan(state.buttons[0].right - state.buttons[0].left);
        if (state.rightOpen) expect(state.right.left).toBeCloseTo(state.dock.left, 0);
        expect(state.buttons.at(-1)!.right).toBeLessThanOrEqual(state.bar.right);
        for (let i=1; i<state.buttons.length; i++) expect(state.buttons[i].left).toBeGreaterThanOrEqual(state.buttons[i-1].right);
        for (const glyph of state.glyphs) expect((glyph.top + glyph.bottom) / 2).toBeCloseTo((state.bar.top + state.bar.bottom) / 2, 0);
        for (const button of state.buttons) expect((button.top + button.bottom) / 2).toBeCloseTo((state.bar.top + state.bar.bottom) / 2, 0);
      }
      if (result.fullscreen) {
        const fullscreen = result.fullscreen as { before: FrameGeometry; during: FrameGeometry; after: FrameGeometry; retained: boolean };
        expect(fullscreen.retained).toBe(true);
        const fullscreenLogoCenter = (fullscreen.during.logo.left + fullscreen.during.logo.right) / 2;
        const railItemCenter = (fullscreen.during.railButton.left + fullscreen.during.railButton.right) / 2;
        expect(fullscreen.during.reservation).toBe(0);
        expect(Math.abs(fullscreenLogoCenter - railItemCenter)).toBeLessThanOrEqual(1);
        expect(fullscreenLogoCenter).toBeCloseTo((fullscreen.during.rail.left + fullscreen.during.rail.right) / 2, 1);
        const backCenter = (fullscreen.during.buttons[0].left + fullscreen.during.buttons[0].right) / 2;
        expect(backCenter - fullscreenLogoCenter).toBeCloseTo(fullscreen.during.buttons[1].left - fullscreen.during.buttons[0].left + APP_FRAME_CONTROLS_OFFSET, 2);
        expect(fullscreen.during.backReachable).toBe(true);
        expect(fullscreen.after.logo).toEqual(fullscreen.before.logo);
        expect(fullscreen.during.railButton).toEqual(fullscreen.before.railButton);
        expect(fullscreen.during.workspace).toEqual(fullscreen.before.workspace);
      }
      expect(geometry.body.bottom).toBeCloseTo(geometry.overlayControl.bottom, 2);
      expect(geometry.overlayControl.top).toBeLessThan(geometry.body.bottom);
      expect(geometry.overlayControl.left).toBeCloseTo(geometry.body.left, 0);
      expect(geometry.overlayControl.right).toBeCloseTo(geometry.body.right, 0);
      expect(geometry.overlayPointerEvents).toBe('none');
      expect(geometry.composer.top).toBeGreaterThanOrEqual(geometry.overlayControl.top);
      expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.overlayControl.bottom);
      expect(geometry.composerPointerEvents).toBe('auto');
      if (result.width >= RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH) {
        expect(geometry.composer.left).toBeGreaterThan(geometry.transcriptViewport.left);
        expect(geometry.composer.right).toBeLessThan(geometry.transcriptViewport.right);
        expect(geometry.transcriptViewport.left).toBeCloseTo(geometry.body.left, 0);
        expect(geometry.transcriptViewport.right).toBeCloseTo(geometry.body.right, 0);
      }
      expect(geometry.transcriptViewport.top).toBeCloseTo(geometry.body.top, 0);
      expect(geometry.transcriptViewport.bottom).toBeCloseTo(geometry.body.bottom, 0);
      const composerHeight = geometry.composer.bottom - geometry.composer.top;
      const composerBottomGap = geometry.transcriptViewport.bottom - geometry.composer.bottom;
      const transcriptMaxScroll = geometry.transcriptScrollState.scrollHeight - geometry.transcriptScrollState.clientHeight;
      expect(geometry.transcriptBottomInset).toBeCloseTo(composerHeight + (2 * composerBottomGap), 5);
      expect(transcriptMaxScroll).toBeGreaterThan(0);
      expect(Math.abs(geometry.transcriptScrollState.scrollTop - transcriptMaxScroll)).toBeLessThanOrEqual(1);
      expect(geometry.transcriptOuterState.scrollHeight).toBe(geometry.transcriptOuterState.clientHeight);
      expect(geometry.transcriptOuterState.scrollTop).toBe(0);
      if (result.width >= RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH) {
        expect(geometry.finalContent.left).toBeCloseTo(geometry.composer.left, 0);
        expect(geometry.finalContent.right).toBeCloseTo(geometry.composer.right, 0);
        expect(geometry.mask.left).toBeCloseTo(geometry.body.left, 0);
        expect(geometry.mask.right).toBeCloseTo(geometry.composer.right, 0);
      }
      expect(geometry.finalContent.bottom).toBeLessThanOrEqual(geometry.composer.top - composerBottomGap + 0.5);
      expect(Math.abs(geometry.mask.top - (geometry.composer.top + ((geometry.composer.bottom - geometry.composer.top) / 2)))).toBeLessThanOrEqual(1);
      expect(geometry.mask.bottom).toBeCloseTo(geometry.overlayControl.bottom, 0);
      const runOptions = result.runOptions as { containerWidth: number; inlineDisplay: string; inlineVisibility: string; triggerDisplay: string; triggerText: string; triggerHasSvg: boolean; selectRects: Array<{ left: number; right: number }>; composer: { left: number; right: number }; submit: Rect; submitVisual: { width: number; height: number }; submitIcon: Rect; submitLabel: string };
      expect(runOptions.inlineDisplay).toBe('flex');
      expect(runOptions.selectRects).toHaveLength(3);
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
  });
});
