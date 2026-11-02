// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

it('keeps real content and hidden action rails beside one another while disclosures span the stream', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mandible-chat-spacing-'));
  try {
    const output = join(directory, 'fixture.js');
    const bundled = spawnSync(createRequire(import.meta.url).resolve('esbuild/bin/esbuild'), [
      resolve('test/provisioned/fixtures/chat-event-spacing-fixture.tsx'), '--bundle', `--outfile=${output}`,
      '--format=iife', '--platform=browser', '--target=es2020', '--jsx=automatic', '--jsx-import-source=preact',
      '--alias:react=preact/compat', '--alias:react-dom=preact/compat', '--alias:react/jsx-runtime=preact/jsx-runtime',
      '--loader:.css=empty', '--minify', '--log-level=silent',
    ], { encoding: 'utf8', timeout: 10000 });
    expect(bundled.status, bundled.stderr).toBe(0);
    const styles = ['tokens', 'base', 'console', 'message-blocks', 'contextual-action']
      .map(name => readFileSync(resolve(`ui/src/styles/${name}.css`), 'utf8')).join('\n');
    const file = join(directory, 'fixture.html');
    writeFileSync(file, `<!doctype html><html data-theme="codex"><head><style>${styles}</style></head><body><div id="root"></div><script>${readFileSync(output, 'utf8')}</script></body></html>`);
    const rendered = runChromium(['--virtual-time-budget=1500', '--dump-dom', '--window-size=1200,900', `file://${file}`], { encoding: 'utf8', maxBuffer: 5_000_000 });
    expect(rendered.status, rendered.stderr).toBe(0);
    const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
    expect(encoded, rendered.stdout.slice(-2000)).toBeDefined();
    if (encoded!.startsWith('fixture-error:')) throw new Error(Buffer.from(encoded!.slice(14), 'base64').toString());
    const results = JSON.parse(Buffer.from(encoded!, 'base64').toString());
    for (const result of results) {
      for (const entry of result.entries) {
        expect(entry.rail.top, `${result.width} ${entry.kind}: action rail wrapped below content`).toBeLessThan(entry.content.bottom);
        expect(entry.rail.left, `${result.width} ${entry.kind}: controls overlap text`).toBeGreaterThanOrEqual(entry.content.right);
        expect(entry.rail.right).toBeLessThanOrEqual(entry.wrapper.right + 0.05);
        expect(entry.wrapper.bottom - Math.max(entry.content.bottom, entry.rail.bottom)).toBeLessThanOrEqual(entry.kind === 'tool' ? 3.05 : 0.05);
      }
      expect(result.details.width, `${result.width}: disclosed tool details lost available width`).toBeCloseTo(result.expandedWrapper.width, 1);
      expect(result.details.top).toBeGreaterThanOrEqual(result.header.bottom);
    }
    expect(results[2].entries.find((entry: any) => entry.kind === 'prose').content.height).toBeGreaterThan(results[0].entries.find((entry: any) => entry.kind === 'prose').content.height);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
