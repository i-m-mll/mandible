// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { spawnChromium } from '../helpers/chromium';
import { testRuntimeRoot } from '../helpers/runtime-isolation';

class ChromeSession {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private events = new Map<string, Array<() => void>>();
  sessionId?: string;
  constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      const response = JSON.parse(String(event.data));
      if (!response.id) {
        for (const resolve of this.events.get(response.method) ?? []) resolve();
        this.events.delete(response.method);
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(JSON.stringify(response.error)));
      else pending.resolve(response.result);
    });
  }
  send(method: string, params: Record<string, unknown> = {}, attach = true): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(attach && this.sessionId ? { sessionId: this.sessionId } : {}) }));
    });
  }
  async navigate(url: string, reload = false): Promise<void> {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome page load did not complete: ${url} reload=${reload}`)), 5000);
      this.events.set('Page.loadEventFired', [() => { clearTimeout(timer); resolve(); }]);
    });
    await Promise.all([loaded, reload ? this.send('Page.reload') : this.send('Page.navigate', { url })]);
  }
  async evaluate<T = any>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value as T;
  }
  close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Chrome session closed')); }
    this.pending.clear(); this.socket.close();
  }
}

it('keeps controls fixed, files on one line and native wheel input inside the item viewport at both widths', async () => {
  const directory = mkdtempSync(join(testRuntimeRoot, 'mandible-breakdown-browser-'));
  const bundled = buildSync({ entryPoints: [resolve('test/provisioned/fixtures/auth-breakdown-layout-fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic', jsxImportSource: 'preact' });
  const styles = ['tokens.css', 'collapsible-panel.css', 'disclosure-chevron.css', 'auth.css']
    .map(file => readFileSync(resolve('ui/src/styles', file), 'utf8')).join('\n');
  const html = join(directory, 'index.html');
  writeFileSync(html, `<!doctype html><style>${styles}
    *{box-sizing:border-box}html,body,#root{height:100%;margin:0}
    .auth-detail-pane{height:100%}.auth-detail__body{height:100%;overflow:auto}
    .auth-detail__body>*{flex:none}.additional-context{height:1100px}
  </style><div id="root"></div><script>${bundled.outputFiles[0]!.text.replaceAll('</script', '<\\/script')}</script>`);
  const navigationBundle = buildSync({ entryPoints: [resolve('test/provisioned/fixtures/auth-file-navigation-fixture.tsx')], outdir: join(directory, 'navigation-assets'),
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic', jsxImportSource: 'preact' });
  const navigationStyles = buildSync({ entryPoints: [resolve('ui/src/style.css')], bundle: true, write: false }).outputFiles[0]!.text.replace(/@import[^;]+;/g, '');
  const navigationHtml = join(directory, 'navigation.html');
  writeFileSync(navigationHtml, `<!doctype html><style>${navigationStyles}${navigationBundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')}
    html,body,#root,.auth-sidebar-layout{height:100%;margin:0}#root{display:flex;flex-direction:column}
  </style><div id="root"></div><script>${navigationBundle.outputFiles.find(file => file.path.endsWith('.js'))!.text.replaceAll('</script', '<\\/script')}</script>`);
  const child = spawnChromium(['--remote-debugging-port=0', `--user-data-dir=${join(directory, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let session: ChromeSession | undefined;
  try {
    const address = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome did not publish its owned debugging endpoint: ' + output.slice(-4000))), 15000);
      child.stderr!.on('data', chunk => {
        output += String(chunk);
        const match = output.match(/DevTools listening on (ws:\/\/[^\r\n]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited before ready: ${code}`)); });
    });
    const socket = new WebSocket(address);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome WebSocket did not open')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome WebSocket failed')); }, { once: true });
    });
    session = new ChromeSession(socket);
    const target = await session.send('Target.createTarget', { url: 'about:blank' }, false);
    session.sessionId = (await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
    await session.send('Page.enable'); await session.send('Runtime.enable');
    const frames = () => session!.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    for (const width of [1200, 360]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height: 1128, deviceScaleFactor: 1, mobile: false });
      const rightEdges: number[] = [];
      for (const completed of [false, true]) {
        await session.navigate(pathToFileURL(navigationHtml).href + `?action-layout=1${completed ? '&completed=1' : ''}`);
        await session.evaluate(`new Promise((resolve, reject) => {
          const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Issue titles did not resolve'))},2500);
          const ready=()=>{if(document.querySelectorAll('.auth-action-row .issue-pill__title').length===2){clearTimeout(timer);observer.disconnect();resolve(true)}};
          const observer=new MutationObserver(ready);observer.observe(document,{subtree:true,childList:true});ready();})`);
        await frames();
        const layout = await session.evaluate(`(() => {
          const rect=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right,left:r.left,height:r.height}};
          const sidebar=document.querySelector('.auth-sidebar-item');
          const meta=sidebar?.querySelector('.auth-sidebar-item__metadata');
          return {rows:[...document.querySelectorAll('.auth-action-row')].map(row=>{
            const title=row.querySelector('.issue-pill__title'),control=row.querySelector('.auth-action-row__veto')??row.querySelector('.auth-action-row__state');
            return {identity:rect(row.querySelector('.auth-action-row__top')),control:rect(control),row:rect(row),
              overflow:row.scrollWidth>row.clientWidth,titleWidth:title.clientWidth,titleScroll:title.scrollWidth,
              fullTitle:title.parentElement.title,text:control.textContent};}),
            sidebar:sidebar?{title:rect(sidebar.querySelector('.auth-sidebar-item__title')),dot:rect(sidebar.querySelector('.auth-sidebar-item__dot')),
              meta:[...meta.children].map(rect),project:meta.firstElementChild.title,
              projectWidth:meta.firstElementChild.clientWidth,projectScroll:meta.firstElementChild.scrollWidth,
              overflow:sidebar.scrollWidth>sidebar.clientWidth,selected:sidebar.getAttribute('aria-current')}:null,
            detailBranches:document.querySelector('.auth-detail-pane').textContent.includes('feature/navigation')};})()`);
        for (const row of layout.rows) {
          expect(row.overflow, `action overflow at ${width}`).toBe(false);
          expect(row.control.top).toBeLessThan(row.identity.bottom);
          expect(row.control.bottom).toBeGreaterThan(row.identity.top);
          expect(row.titleWidth, `visible action title at ${width}`).toBeGreaterThan(0);
          expect(row.row.right).toBeLessThanOrEqual(width);
          expect(row.titleScroll).toBeGreaterThan(row.titleWidth);
          expect(row.fullTitle).toContain('A complete long issue title');
          rightEdges.push(row.control.right);
        }
        expect(layout.rows.map((row: any) => row.text)).toEqual(completed ? ['Done', 'Done'] : ['Veto', 'Restore']);
        if (!completed) {
          const sidebar = layout.sidebar;
          expect(sidebar.overflow).toBe(false);
          expect(sidebar.selected).toBe('true');
          expect(sidebar.project).toContain('a-long-project-name');
          expect(sidebar.projectScroll).toBeGreaterThan(sidebar.projectWidth);
          expect(sidebar.title.top).toBeLessThan(sidebar.meta[0].top);
          expect(sidebar.dot.top).toBeLessThan(sidebar.title.bottom);
          expect(sidebar.meta[0].right).toBeLessThan(sidebar.meta[1].left);
          expect(sidebar.meta[1].right).toBeLessThan(sidebar.meta[2].left);
          expect(Math.max(...sidebar.meta.map((r: any) => r.top))).toBeLessThan(Math.min(...sidebar.meta.map((r: any) => r.bottom)));
        }
        expect(layout.detailBranches).toBe(true);
      }
      expect(Math.max(...rightEdges) - Math.min(...rightEdges), `Veto/Restore/Done right alignment at ${width}`).toBeLessThan(1);
    }
    for (const [width, height] of [[877, 1128], [360, 720]]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await session.navigate(pathToFileURL(html).href + `?width=${width}`);
      await session.evaluate(`new Promise(resolve => {
        const ready = () => { if(document.querySelector('.auth-change-group__row')) { observer.disconnect(); resolve(true); } };
        const observer = new MutationObserver(ready); observer.observe(document,{subtree:true,childList:true}); ready();
      })`);
      await frames();
      const measure = () => session!.evaluate(`(() => {
        const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,height:r.height,left:r.left,right:r.right}; };
        const item=document.querySelector('.auth-change-breakdown__items');
        const file=document.querySelector('.auth-change-file');
        return {header:rect('.auth-change-breakdown>.collapsible-panel__header'),tabs:rect('.auth-change-breakdown__tabs'),columns:rect('.auth-change-columns-header'),
          breadcrumbs:document.querySelector('.auth-change-directory__breadcrumbs')?rect('.auth-change-directory__breadcrumbs'):null,
          outer:document.querySelector('#outer-review').scrollTop,item:item?.scrollTop??0,max:item?item.scrollHeight-item.clientHeight:0,
          file:file?{height:file.getBoundingClientRect().height,pathHeight:file.querySelector('code').getBoundingClientRect().height,
          lineHeight:parseFloat(getComputedStyle(file.querySelector('code')).lineHeight),fullPath:file.querySelector('code').textContent,title:file.querySelector('code').title,
          pathWidth:file.querySelector('code').clientWidth,pathScroll:file.querySelector('code').scrollWidth,metrics:rect('.auth-change-file__metrics'),
          headingRight:[...document.querySelector('.auth-change-columns-header').children].slice(-3).map(node=>node.getBoundingClientRect().right),
          metricRight:[...file.querySelector('.auth-change-file__metrics').children].map(node=>node.getBoundingClientRect().right)}:null};})()`);
      const collapsed = await measure();
      await session.evaluate("document.querySelector('.auth-change-group__row').click();true"); await frames();
      const expanded = await measure();
      expect(expanded.tabs, `tabs stable after expansion at${width}`).toEqual(collapsed.tabs);
      expect(expanded.columns).toEqual(collapsed.columns);
      expect(expanded.header).toEqual(collapsed.header);
      const itemViewports = () => session!.evaluate("[...document.querySelectorAll('.auth-change-breakdown__items')].map(node=>({height:node.clientHeight,content:node.scrollHeight,outer:document.querySelector('#outer-review').clientHeight}))");
      const firstViewport = (await itemViewports())[0];
      expect(firstViewport.height).toBeGreaterThan(0);
      expect(firstViewport.height).toBeLessThanOrEqual(firstViewport.outer);
      expect(firstViewport.content).toBeGreaterThan(firstViewport.height);
      await session.evaluate("document.querySelectorAll('.auth-change-group__row')[1].click();true"); await frames();
      for (const viewport of await itemViewports()) {
        expect(viewport.height).toBeGreaterThan(0);
        expect(viewport.height).toBeLessThanOrEqual(viewport.outer);
        expect(viewport.content).toBeGreaterThan(viewport.height);
      }
      const groupHeadings = () => session!.evaluate("[...document.querySelectorAll('.auth-change-group__row--outside')].map(node=>node.getBoundingClientRect().top)");
      const headingsBefore = await groupHeadings();
      const wheel = async (selector: string, distance: number) => {
        const point = await session!.evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+Math.min(40,r.width/2),y:r.top+Math.min(35,r.height/2)}})()`);
        await session!.send('Input.synthesizeScrollGesture', { ...point, yDistance: distance, xDistance: 0, speed: 3000, preventFling: true, gestureSourceType: 'mouse' });
        await frames();
      };
      await wheel('.auth-change-breakdown__items', -180);
      const middle = await measure();
      expect(middle.item).toBeGreaterThan(0);
      expect(middle.outer).toBe(expanded.outer);
      expect(await groupHeadings()).toEqual(headingsBefore);
      expect(await session.evaluate("document.querySelectorAll('.auth-change-breakdown__items')[1].scrollTop")).toBe(0);
      await wheel('.auth-change-group:nth-child(2) .auth-change-breakdown__items', -120);
      expect(await session.evaluate("document.querySelectorAll('.auth-change-breakdown__items')[1].scrollTop")).toBeGreaterThan(0);
      expect((await measure()).item).toBe(middle.item);
      expect(await groupHeadings()).toEqual(headingsBefore);
      expect(middle.tabs).toEqual(expanded.tabs); expect(middle.columns).toEqual(expanded.columns); expect(middle.header).toEqual(expanded.header);
      await session.evaluate("document.querySelector('.auth-change-breakdown__items').scrollTop=0;true"); await frames();
      await wheel('.auth-change-breakdown__items', 180);
      const top = await measure(); expect(top.item).toBe(0); expect(top.outer).toBe(expanded.outer);
      await session.evaluate("const i=document.querySelector('.auth-change-breakdown__items');i.scrollTop=i.scrollHeight;true"); await frames();
      await wheel('.auth-change-breakdown__items', -180);
      await session.evaluate(`new Promise((resolve,reject)=>{
        const deadline=performance.now()+1000;
        const check=()=>{const node=document.querySelector('.auth-change-breakdown__items');
          if(Math.abs(node.scrollTop-(node.scrollHeight-node.clientHeight))<1){resolve(true);return;}
          if(performance.now()>deadline){reject(new Error('Native bottom-boundary scrolling did not settle'));return;}
          requestAnimationFrame(check);};check();})`);
      const bottom = await measure(); expect(bottom.item).toBe(bottom.max); expect(bottom.outer).toBe(expanded.outer);
      await session.evaluate("document.querySelector('[role=tab][id$=directory]').click();true"); await frames();
      await session.evaluate("document.querySelector('.auth-change-group__row').click();true"); await frames();
      await session.evaluate("document.querySelector('.auth-change-group__row').click();true"); await frames();
      const directoryBefore = await measure();
      await wheel('.auth-change-breakdown__items', -180);
      const directoryAfter = await measure();
      expect(directoryAfter.item).toBeGreaterThan(0);
      expect(directoryAfter.tabs).toEqual(directoryBefore.tabs); expect(directoryAfter.columns).toEqual(directoryBefore.columns);
      expect(directoryAfter.breadcrumbs).toEqual(directoryBefore.breadcrumbs); expect(directoryAfter.header).toEqual(directoryBefore.header);
      expect(directoryAfter.file.pathHeight).toBeLessThanOrEqual(directoryAfter.file.lineHeight + 1);
      expect(directoryAfter.file.title).toContain(directoryAfter.file.fullPath);
      directoryAfter.file.metricRight.forEach((right: number, index: number) => expect(right).toBeCloseTo(directoryAfter.file.headingRight[index], 0));
      if (width === 360) expect(directoryAfter.file.pathScroll).toBeGreaterThan(directoryAfter.file.pathWidth);
      await wheel('.auth-change-breakdown__tabs', -180);
      expect((await measure()).outer, 'wheel outside items still scrolls the outer review').toBeGreaterThan(0);
      await session.evaluate("document.querySelector('[role=tab][id$=flags]').click();true"); await frames();
      await session.evaluate("[...document.querySelectorAll('.auth-change-group__row')].find(node=>node.textContent.trim().startsWith('Generated')).click();true"); await frames();
      const generatedViewport = (await itemViewports())[0];
      expect(generatedViewport.height).toBeGreaterThan(0);
      expect(generatedViewport.height).toBeLessThanOrEqual(generatedViewport.outer);
    }
    for (const [width, height] of [[877, 1128], [360, 720]]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await session.navigate(pathToFileURL(navigationHtml).href + `?width=${width}`);
      const waitFor = (expression: string) => session!.evaluate(`new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Missing browser state: '+${JSON.stringify(expression)}))},2500);
        const ready=()=>{if(${expression}){clearTimeout(timer);observer.disconnect();resolve(true)}};
        const observer=new MutationObserver(ready);observer.observe(document,{subtree:true,childList:true,attributes:true});ready();})`);
      await waitFor("document.querySelector('#auth-detail-panel-abstract .auth-change-group__row')"); await frames();
      await session.evaluate("document.querySelectorAll('.auth-change-group__row')[0].click();true"); await frames();
      await session.evaluate("document.querySelectorAll('.auth-change-group__row')[1].click();true"); await frames();
      await session.evaluate(`document.querySelector('[aria-controls=auth-action-detail-navigation-action]').click();
        document.querySelectorAll('.auth-change-breakdown__items')[0].scrollTop=184;
        document.querySelectorAll('.auth-change-breakdown__items')[1].scrollTop=72;
        document.querySelector('.auth-detail__body').scrollTop=220;true`); await frames();
      const origin = await session.evaluate(`(() => {
        const link=document.querySelectorAll('.auth-change-breakdown__items')[0].querySelectorAll('a')[8];
        link.focus({preventScroll:true});
        return {href:link.getAttribute('href'),outer:document.querySelector('.auth-detail__body').scrollTop,
          items:[...document.querySelectorAll('.auth-change-breakdown__items')].map(node=>node.scrollTop),
          disclosures:[...document.querySelectorAll('#auth-detail-panel-abstract button[aria-expanded]')].map(node=>[node.textContent,node.getAttribute('aria-expanded')])};})()`);
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await waitFor("document.querySelector('#auth-detail-panel-diff .diff-viewer__file-header')"); await frames();
      const destination = await session.evaluate('window.location.href');
      const alignment = () => session!.evaluate(`(() => {
        const params=new URLSearchParams(location.hash.split('?')[1]);const path=params.get('diff_new')??params.get('diff_old');
        const title=[...document.querySelectorAll('.diff-viewer__file-path')].find(node=>node.title===path);
        const heading=title.closest('button'),body=document.querySelector('.auth-detail__body'),header=document.querySelector('.detail-pane-shell__header');
        return {visible:heading.getBoundingClientRect().top>=body.getBoundingClientRect().top-1
            &&heading.getBoundingClientRect().bottom<=body.getBoundingClientRect().bottom+1,expanded:heading.getAttribute('aria-expanded'),
          anchored:header.getBoundingClientRect().bottom<=body.getBoundingClientRect().top+1,outer:body.scrollTop,
          sidebar:params.get('sidebar'),agent:params.get('agent_session'),state:history.state.fixtureState};})()`);
      const aligned = await alignment();
      expect(aligned.visible, `target file visible below anchored header at ${width}`).toBe(true);
      expect(aligned.expanded).toBe('true'); expect(aligned.anchored).toBe(true);
      expect(aligned.outer).toBeGreaterThan(0); expect(aligned.sidebar).toBe('hidden'); expect(aligned.agent).toBe('fixture-agent');
      expect(aligned.state).toBe('preserved');
      await session.evaluate('history.back();true');
      await waitFor("document.querySelector('#auth-detail-panel-abstract .auth-change-breakdown__items')"); await frames();
      const restored = await session.evaluate(`({outer:document.querySelector('.auth-detail__body').scrollTop,
        items:[...document.querySelectorAll('.auth-change-breakdown__items')].map(node=>node.scrollTop),
        disclosures:[...document.querySelectorAll('#auth-detail-panel-abstract button[aria-expanded]')].map(node=>[node.textContent,node.getAttribute('aria-expanded')])})`);
      expect(restored.outer).toBe(origin.outer); expect(restored.items).toEqual(origin.items); expect(restored.disclosures).toEqual(origin.disclosures);
      await session.evaluate('history.forward();true');
      await waitFor("document.querySelector('#auth-detail-panel-diff .diff-viewer__file-header')"); await frames();
      expect(await alignment()).toMatchObject({ visible: true, anchored: true, expanded: 'true' });
      await session.evaluate(`localStorage.setItem('auth-review-tab:file-navigation-request',JSON.stringify('console'));true`);
      await session.navigate(destination, true); await waitFor("document.querySelector('#auth-detail-panel-diff .diff-viewer__file-header')"); await frames();
      expect(await alignment()).toMatchObject({ visible: true, anchored: true, expanded: 'true' });
    }
    await session.send('Emulation.setDeviceMetricsOverride', { width: 877, height: 1128, deviceScaleFactor: 1, mobile: false });
    const deferredUrl = pathToFileURL(navigationHtml).href + '?diagnostic=1';
    const scrollState = () => session!.evaluate(`(() => { const node=document.querySelector('.auth-detail__body');
      return {top:node?.scrollTop,saved:localStorage.getItem('auth-review-scroll:'+window.scrollDiagnostic.requestId+':diff'),
        detailCalls:window.scrollDiagnostic.detailCalls};})()`);
    await session.navigate(deferredUrl); await frames();
    const pending = await scrollState();
    expect(pending.top).toBe(0); expect(Number(pending.saved)).toBe(6758.5);
    await session.evaluate('window.scrollDiagnostic.hydrate();true'); await frames();
    const hydrated = await scrollState();
    expect(Math.abs(hydrated.top - 6758.5)).toBeLessThanOrEqual(1);
    expect(Number(hydrated.saved)).toBe(hydrated.top);
    await session.navigate(deferredUrl, true); await frames();
    await session.evaluate('window.scrollDiagnostic.hydrate();true'); await frames();
    const reloaded = await scrollState();
    expect(reloaded.top).toBe(hydrated.top); expect(Number(reloaded.saved)).toBe(hydrated.top);
    await session.evaluate('window.scrollDiagnostic.unmount();true'); await frames();
    await session.evaluate('window.scrollDiagnostic.summary();true'); await frames();
    await session.evaluate('window.scrollDiagnostic.hydrate();true'); await frames();
    const remounted = await scrollState();
    expect(remounted.top).toBe(hydrated.top); expect(Number(remounted.saved)).toBe(hydrated.top);
    await session.navigate(pathToFileURL(navigationHtml).href + '?partial=1&small=1'); await frames();
    await session.evaluate("document.querySelector('.auth-change-group__row').click();true"); await frames();
    const partialOrigin = await session.evaluate(`(() => {
      const body=document.querySelector('.auth-detail__body'); body.scrollTop=601.5;
      const link=document.querySelector('.auth-change-breakdown__items a');link.focus({preventScroll:true});
      return {top:body.scrollTop,href:link.getAttribute('href')};})()`);
    expect(partialOrigin.top).toBeGreaterThan(0);
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await frames();
    await session.evaluate(`new Promise(resolve => {
      const ready=()=>{if(document.querySelector('[role=status][data-severity=warning]')){observer.disconnect();resolve(true)}};
      const observer=new MutationObserver(ready);observer.observe(document,{subtree:true,childList:true});ready();})`);
    const missing = await session.evaluate(`(() => {
      const notice=document.querySelector('[role=status][data-severity=warning]');const body=document.querySelector('.auth-detail__body');
      const header=document.querySelector('.detail-pane-shell__header');const rect=notice.getBoundingClientRect();
      return {hash:location.hash,visible:rect.height>0&&rect.top>=header.getBoundingClientRect().bottom-1
        &&rect.bottom<=body.getBoundingClientRect().top+1&&rect.bottom<=innerHeight};})()`);
    expect(missing.hash).toBe(partialOrigin.href);
    expect(missing.visible).toBe(true);
    await session.evaluate('history.back();true'); await frames();
    expect(await session.evaluate("document.querySelector('.auth-detail__body').scrollTop")).toBe(partialOrigin.top);
    await session.navigate(pathToFileURL(navigationHtml).href + '?canonical=1&small=1'); await frames();
    await session.evaluate('window.scrollDiagnostic.resolveDetail();true'); await frames();
    const canonical = await scrollState();
    expect(Math.abs(canonical.top - 6758.5)).toBeLessThanOrEqual(1);
    expect(canonical.detailCalls).toBe(1);
    expect(Number(canonical.saved)).toBe(canonical.top);
  } finally {
    session?.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
