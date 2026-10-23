// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { spawnChromium } from '../helpers/chromium';

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
  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome page load did not complete')), 5000);
      this.events.set('Page.loadEventFired', [() => { clearTimeout(timer); resolve(); }]);
    });
    await Promise.all([loaded, this.send('Page.navigate', { url })]);
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
  const directory = mkdtempSync(join(tmpdir(), 'mandible-breakdown-browser-'));
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
          outer:document.querySelector('#outer-review').scrollTop,item:item.scrollTop,max:item.scrollHeight-item.clientHeight,
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
      const wheel = async (selector: string, distance: number) => {
        const point = await session!.evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+Math.min(40,r.width/2),y:r.top+Math.min(35,r.height/2)}})()`);
        await session!.send('Input.synthesizeScrollGesture', { ...point, yDistance: distance, xDistance: 0, speed: 3000, preventFling: true, gestureSourceType: 'mouse' });
        await frames();
      };
      await wheel('.auth-change-breakdown__items', -180);
      const middle = await measure();
      expect(middle.item).toBeGreaterThan(0);
      expect(middle.outer).toBe(expanded.outer);
      expect(middle.tabs).toEqual(expanded.tabs); expect(middle.columns).toEqual(expanded.columns); expect(middle.header).toEqual(expanded.header);
      await session.evaluate("document.querySelector('.auth-change-breakdown__items').scrollTop=0;true"); await frames();
      await wheel('.auth-change-breakdown__items', 180);
      const top = await measure(); expect(top.item).toBe(0); expect(top.outer).toBe(expanded.outer);
      await session.evaluate("const i=document.querySelector('.auth-change-breakdown__items');i.scrollTop=i.scrollHeight;true"); await frames();
      await wheel('.auth-change-breakdown__items', -180);
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
      expect(directoryAfter.file.fullPath.length).toBeGreaterThan(70);
      expect(directoryAfter.file.title).toContain(directoryAfter.file.fullPath);
      directoryAfter.file.metricRight.forEach((right: number, index: number) => expect(right).toBeCloseTo(directoryAfter.file.headingRight[index], 0));
      if (width === 360) expect(directoryAfter.file.pathScroll).toBeGreaterThan(directoryAfter.file.pathWidth);
      await wheel('.auth-change-breakdown__tabs', -180);
      expect((await measure()).outer, 'wheel outside items still scrolls the outer review').toBeGreaterThan(0);
    }
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
