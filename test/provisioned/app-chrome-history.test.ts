// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

it('keeps real browser traversal, reload, Auth origin state and shared chrome interactions coherent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mandible-chrome-history-'));
  try {
    const bundle = buildSync({ entryPoints: [resolve('test/provisioned/fixtures/app-chrome-history-fixture.tsx')], bundle: true, write: false,
      format: 'iife', platform: 'browser', jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'empty' } }).outputFiles[0]!.text;
    const styles = ['tokens.css', 'base.css', 'app-frame.css', 'app-hover-tips.css'].map(name => readFileSync(resolve('ui/src/styles', name), 'utf8')).join('\n');
    const file = join(directory, 'index.html');
    writeFileSync(file, `<!doctype html><style>${styles}html,body,#root{margin:0;width:600px;height:400px}.app-shell{height:100%;--app-rail-width:46px}.app-frame__main-header button{margin-left:auto}.proof-main{padding:20px}</style><div id="root"></div><script>${bundle.replaceAll('</script', '<\\/script')}</script>`);
    const result = runChromium(['--run-all-compositor-stages-before-draw', '--virtual-time-budget=10000', '--dump-dom', '--window-size=600,500', 'file://' + file], { encoding: 'utf8', maxBuffer: 2_000_000 });
    expect(result.status, result.stderr).toBe(0);
    const title = /<title>([^<]+)<\/title>/.exec(result.stdout)?.[1];
    if (title?.startsWith('proof-error:')) throw new Error(Buffer.from(title.slice(12), 'base64').toString());
    expect(title, result.stdout.slice(-1500)).toBeTruthy();
    expect(JSON.parse(Buffer.from(title!, 'base64').toString())).toMatchObject({ ok: true, reload: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
