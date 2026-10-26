// @provisioned chromium
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { spawnChromium } from '../helpers/chromium';
import { testRuntimeRoot } from '../helpers/runtime-isolation';

it('keeps actual Settings navigation aligned through movement, filtering and layout changes', async () => {
  const directory = mkdtempSync(join(testRuntimeRoot, 'settings-navigation-'));
  const bundle = buildSync({ entryPoints: [resolve('test/provisioned/fixtures/settings-navigation-fixture.tsx')],
    outdir: directory, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
    jsx: 'automatic', jsxImportSource: 'preact' });
  const styles = buildSync({ entryPoints: [resolve('ui/src/style.css')], bundle: true, write: false }).outputFiles[0]!.text;
  const html = join(directory, 'index.html');
  writeFileSync(html, `<!doctype html><style>${styles.replace(/@import[^;]+;/g, '')}
    html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}
    .settings-view{height:100%;overflow:auto}
  </style><div id="root"></div><script>${bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text.replaceAll('</script', '<\\/script')}</script>`);
  const child = spawnChromium(['--remote-debugging-port=0', `--user-data-dir=${join(directory, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  try {
    const address = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome did not start: ' + output.slice(-2000))), 15000);
      child.stderr!.on('data', chunk => {
        output += String(chunk);
        const match = output.match(/DevTools listening on (ws:\/\/[^\r\n]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited before ready: ${code}`)); });
    });
    socket = new WebSocket(address);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome socket did not open')), 5000);
      socket!.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket!.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome socket failed')); }, { once: true });
    });
    let sequence = 0;
    let sessionId: string | undefined;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id); clearTimeout(command.timer);
      if (message.error) command.reject(new Error(JSON.stringify(message.error)));
      else command.resolve(message.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    };
    const target = await send('Target.createTarget', { url: 'about:blank' });
    sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: pathToFileURL(html).href });
    const proof = await send('Runtime.evaluate', { expression: `new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture not loaded')), 5000);
      const run = () => {
        if (window.runSettingsNavigationProof) { clearTimeout(timer); window.runSettingsNavigationProof().then(resolve, reject); }
        else requestAnimationFrame(run);
      };
      run();
    })`, awaitPromise: true, returnByValue: true });
    expect(proof.exceptionDetails, JSON.stringify(proof.exceptionDetails)).toBeUndefined();
    expect(proof.result.value).toEqual([
      'formerly-misordered-sections', 'async-height-and-manual-scroll', 'short-trailing-section',
      'rapid-navigation', 'filter-empty-unfilter-refresh-and-resize',
    ]);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reduced = await send('Runtime.evaluate', { expression: `(async () => {
      const root = document.querySelector('.settings-view');
      root.querySelector('[aria-controls="settings-conversations"]').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const target = root.querySelector('#settings-conversations');
      return Math.abs(target.getBoundingClientRect().top - root.getBoundingClientRect().top
        - parseFloat(getComputedStyle(target).scrollMarginTop)) < 2
        && root.querySelector('[aria-current=location]').getAttribute('aria-controls') === target.id;
    })()`, awaitPromise: true, returnByValue: true });
    expect(reduced.exceptionDetails, JSON.stringify(reduced.exceptionDetails)).toBeUndefined();
    expect(reduced.result.value).toBe(true);
  } finally {
    for (const command of pending.values()) { clearTimeout(command.timer); command.reject(new Error('Chrome closed')); }
    socket?.close();
    child.kill('SIGKILL');
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});
