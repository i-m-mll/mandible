// @provisioned chromium
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { spawnChromium } from '../helpers/chromium';

it('keeps real browser traversal, reload, Auth origin state and shared chrome interactions coherent', async () => {
  const bundle = buildSync({ entryPoints: [resolve('test/provisioned/fixtures/app-chrome-history-fixture.tsx')], bundle: true, write: false,
    format: 'iife', platform: 'browser', jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'empty' } }).outputFiles[0]!.text;
  const styles = ['tokens.css', 'base.css', 'app-frame.css', 'app-hover-tips.css'].map(name => readFileSync(resolve('ui/src/styles', name), 'utf8')).join('\n');
  const page = `<!doctype html><style>${styles}html,body,#root{margin:0;width:600px;height:400px}.app-shell{height:100%;--app-rail-width:46px}.app-frame__main-header button{margin-left:auto}.proof-main{padding:20px}</style><div id="root"></div><script>${bundle.replaceAll('</script', '<\\/script')}</script>`;
  // Every app path serves the same document, as the daemon does.
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(page); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as AddressInfo;
    const browser = spawnChromium(['--run-all-compositor-stages-before-draw', '--virtual-time-budget=10000', '--dump-dom', '--window-size=600,500', `http://127.0.0.1:${port}/a`]);
    let stdout = ''; let stderr = '';
    browser.stdout!.on('data', chunk => { stdout += chunk; });
    browser.stderr!.on('data', chunk => { stderr += chunk; });
    const status = await new Promise<number | null>(done => browser.on('close', done));
    expect(status, stderr).toBe(0);
    const title = /<title>([^<]+)<\/title>/.exec(stdout)?.[1];
    if (title?.startsWith('proof-error:')) throw new Error(Buffer.from(title.slice(12), 'base64').toString());
    expect(title, stdout.slice(-1500)).toBeTruthy();
    expect(JSON.parse(Buffer.from(title!, 'base64').toString())).toMatchObject({ ok: true, reload: true });
  } finally { server.close(); }
});
