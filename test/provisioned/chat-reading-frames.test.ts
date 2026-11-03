// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { spawnChromium } from '../helpers/chromium';

it('keeps consecutive mounted events adjacent in every resize frame and preserves reader, tail and native input ownership', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mandible-chat-frames-'));
  let child: ReturnType<typeof spawnChromium> | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  try {
    const output = join(directory, 'fixture.js');
    const bundled = spawnSync(createRequire(import.meta.url).resolve('esbuild/bin/esbuild'), [
      resolve('test/provisioned/fixtures/chat-reading-frame-fixture.tsx'), '--bundle', `--outfile=${output}`,
      '--format=iife', '--platform=browser', '--target=es2020', '--jsx=automatic', '--jsx-import-source=preact',
      '--alias:react=preact/compat', '--alias:react-dom=preact/compat', '--alias:react/jsx-runtime=preact/jsx-runtime',
      '--loader:.css=empty', '--minify', '--log-level=silent',
    ], { encoding: 'utf8', timeout: 10000 });
    expect(bundled.status, bundled.stderr).toBe(0);
    const styles = ['tokens', 'base', 'contextual-action', 'message-blocks', 'console']
      .map(name => readFileSync(resolve(`ui/src/styles/${name}.css`), 'utf8')).join('\n');
    const file = join(directory, 'fixture.html');
    writeFileSync(file, `<!doctype html><html data-theme="codex"><head><style>${styles}
      html,body { margin:0; } #root {width:500.203125px;height:700px} .stream-renderer {height:100%}
    </style></head><body><div id="root"></div><script>${readFileSync(output, 'utf8')}</script></body></html>`);
    child = spawnChromium(['--remote-debugging-port=0', `--user-data-dir=${join(directory, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const address = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome startup: ' + output.slice(-1000))), 10000);
      child!.stderr!.on('data', chunk => { output += String(chunk); const match = output.match(/DevTools listening on (ws:\/\/[^\r\n]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child!.once('error', error => { clearTimeout(timer); reject(error); });
    });
    socket = new WebSocket(address);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', () => reject(new Error('Chrome socket failed')), { once: true }); });
    let sequence = 0; let sessionId: string | undefined;
    socket.addEventListener('message', event => { const message = JSON.parse(String(event.data)); const command = pending.get(message.id); if (!command) return; pending.delete(message.id); if (message.error) command.reject(new Error(JSON.stringify(message.error))); else command.resolve(message.result); });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    const run = async (mode: boolean | 'cap') => {
      await send('Page.navigate', { url: pathToFileURL(file).href + (mode === 'cap' ? '?cap' : mode ? '?absolute' : '') });
      const result = await send('Runtime.evaluate', { expression: `new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Fixture stalled at '+document.body?.dataset.framePhase)),15000);
        const check=()=>{const title=document.title;if(title&&title!=='frame-start'&&title!=='about:blank'){clearTimeout(timer);observer.disconnect();resolve(title)}};
        const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true,characterData:true});check();
      })`, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      const encoded = result.result.value as string;
      if (encoded.startsWith('fixture-error:')) throw new Error(Buffer.from(encoded.slice(14), 'base64').toString());
      return JSON.parse(Buffer.from(encoded, 'base64').toString());
    };
    for (const mode of [false, 'cap'] as const) {
      const result = await run(mode);
      expect(result.fadeGeometry).toMatchObject({ fadeAtStart: false, fadeOverPadding: false, fadeWithContent: true, rangeUnchanged: true, top: 0, pointerEvents: 'none' });
      expect(result.fadeGeometry.width).toBe(result.fadeGeometry.scrollerWidth);
      expect(result.fadeGeometry.background).toContain('linear-gradient');
      expect(result.unrestricted.width).toBe(result.unrestricted.measuredWidth);
      expect(Number.isInteger(result.unrestricted.width)).toBe(false);
      expect(result.unrestricted.left).toBe(result.unrestricted.right);
      expect(result.unrestricted.left - result.unrestricted.padding).toBe(8);
      if (mode === 'cap') {
        expect(result.limited.width).toBe(400);
        expect(result.limited.measuredWidth).toBe(400);
        expect(Math.abs(result.limited.left - result.limited.right), 'automatic margins differ by at most one browser layout unit').toBeLessThanOrEqual(1 / 64);
        expect(result.oversized.width).toBe(result.unrestricted.width);
      }
      const gaps = result.samples.flatMap((sample: any) => sample.adjacency.map((pair: any) => Math.abs(pair.gap)));
      expect(Math.max(...gaps), 'a previously painted frame separated or overlapped consecutive mounted events').toBeLessThanOrEqual(0.05);
      const readers = result.samples.filter((sample: any) => sample.phase === 'reader');
      expect(new Set(readers.map((sample: any) => sample.rowHeight)).size, 'one-pixel widths never reflowed the prose').toBeGreaterThan(1);
      const disclosure = result.samples.filter((sample: any) => sample.phase === 'disclosure');
      expect(disclosure.some((sample: any) => sample.count === 77)).toBe(true); expect(disclosure.some((sample: any) => sample.count === 80)).toBe(true);
      expect(Math.max(...disclosure.map((sample: any) => Math.abs(sample.header - sample.desiredHeader - ((sample.write?.wanted ?? 0) - (sample.write?.actual ?? 0)))))).toBeLessThanOrEqual(0.05);
      expect(readers.some((sample: any) => sample.protected)).toBe(true);
      expect(readers.some((sample: any) => sample.pending)).toBe(true);
      expect(readers.at(-1).pending).toBe(false);
      const drift = readers.map((sample: any) => sample.glyph - sample.desired);
      const residual = readers.map((sample: any) => (sample.glyph - sample.desired) - ((sample.write?.wanted ?? 0) - (sample.write?.actual ?? 0)));
      expect(Math.max(...residual.map(Math.abs)), `mode=${mode}; bad frames=${JSON.stringify(readers.filter((sample: any, index: number) => Math.abs(residual[index]) > 1).map(({ adjacency, ...sample }: any) => sample))}`).toBeLessThanOrEqual(0.05);
      expect(result.afterNative).toBe(result.nativeTop);
      expect(result.tailNativeAfter).toBe(result.tailNativeTop);
      expect(Math.abs(result.tailIntentDrift), 'wheel-away intent alone repositioned the provisional tail strip').toBeLessThanOrEqual(0.05);
      expect(Math.max(...result.samples.filter((sample: any) => sample.phase === 'tail').map((sample: any) => Math.abs(sample.endGap)))).toBeLessThanOrEqual(0.5);
      expect(Math.max(...result.samples.filter((sample: any) => sample.phase === 'tail').map((sample: any) => Math.abs(sample.tailGap)))).toBeLessThanOrEqual(0.5);
      if (process.env.MANDIBLE_CHAT_FRAME_PROOF) console.info(JSON.stringify({ mode, unrestricted: result.unrestricted, limited: result.limited, oversized: result.oversized, fade: result.fadeGeometry, frames: result.samples.length, maxAdjacencyError: Math.max(...gaps), maxGlyphDrift: Math.max(...drift.map(Math.abs)), maxNativeRoundingResidual: Math.max(...residual.map(Math.abs)), maxTailContentGap: Math.max(...result.samples.filter((sample: any) => sample.phase === 'tail').map((sample: any) => Math.abs(sample.tailGap))) }));
    }
    const baseline = await run(true);
    expect(Math.max(...baseline.samples.filter((sample: any) => sample.phase !== 'disclosure').flatMap((sample: any) => sample.adjacency.map((pair: any) => Math.abs(pair.gap))))).toBeGreaterThan(1);
  } finally {
    socket?.close(); child?.kill('SIGKILL');
    if (child && child.exitCode === null) await new Promise<void>(resolve => child!.once('exit', () => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
