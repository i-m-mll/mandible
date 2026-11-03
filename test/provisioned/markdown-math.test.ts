// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

it('measures the shared visible math row only after its local fonts are ready', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mandible-math-'));
  try {
    const output = join(directory, 'fixture.js');
    const bundled = spawnSync(createRequire(import.meta.url).resolve('esbuild/bin/esbuild'), [
      resolve('test/provisioned/fixtures/markdown-math-fixture.tsx'), '--bundle', `--outfile=${output}`,
      '--format=iife', '--platform=browser', '--target=es2020', '--jsx=automatic', '--jsx-import-source=preact',
      '--alias:react=preact/compat', '--alias:react-dom=preact/compat', '--alias:react/jsx-runtime=preact/jsx-runtime',
      '--loader:.woff2=file', '--loader:.woff=file', '--loader:.ttf=file', '--minify', '--log-level=silent',
    ], { encoding: 'utf8', timeout: 10000 });
    expect(bundled.status, bundled.stderr).toBe(0);
    const file = join(directory, 'fixture.html');
    writeFileSync(file, `<!doctype html><html data-theme="codex"><head><style>${readFileSync(join(directory, 'fixture.css'), 'utf8')}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    const rendered = runChromium(['--virtual-time-budget=2000', '--dump-dom', '--window-size=1200,900', `file://${file}`], { encoding: 'utf8', maxBuffer: 2_000_000 });
    expect(rendered.status, rendered.stderr).toBe(0);
    const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
    expect(encoded, rendered.stdout.slice(-2000)).toBeDefined();
    if (encoded!.startsWith('fixture-error:')) throw new Error(Buffer.from(encoded!.slice(14), 'base64').toString());
    const result = JSON.parse(Buffer.from(encoded!, 'base64').toString());
    expect(result.overflow.length).toBeGreaterThan(0);
    for (const box of result.overflow) { expect(box.startReachable).toBe(true); expect(box.endReachable).toBe(true); }
    expect(result.visibleHeight).toBe(result.measuredHeight);
    expect(result.fontsReady).toBe(true);
    expect(result.loadedAtGeometry.length).toBeGreaterThan(0);
    expect(result.localFonts.length).toBeGreaterThan(0);
    expect(result.localFonts.every((url: string) => url.startsWith(`file://${directory}/`))).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
