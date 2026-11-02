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
    const styles = ['tokens', 'base', 'contextual-action', 'message-blocks', 'console']
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
        expect(entry.rail.width, `${result.width} ${entry.kind}: regular event reserved an action margin`).toBe(0);
        expect(entry.rail.height).toBe(0);
        expect(entry.content.width, `${result.width} ${entry.kind}: content collapsed`).toBeGreaterThan(0);
        expect(entry.wrapper.bottom - entry.content.bottom).toBeLessThanOrEqual(entry.kind === 'tool' ? 3.05 : 0.05);
      }
      expect(result.details.width, `${result.width}: disclosed tool details lost available width`).toBeCloseTo(result.expandedWrapper.width, 1);
      expect(result.details.top).toBeGreaterThanOrEqual(result.header.bottom);
      for (const name of ['copy', 'open', 'link', 'info', 'local-copy', 'shift-select']) expect(result.calls[name]).toBe(results.indexOf(result) + 1);
      for (const child of result.nested) expect(child.frame.height, `${result.width}: a collapsed nested activity acquired spacer lines`).toBeCloseTo(Math.max(child.header.height, child.rail.height), 1);
      for (let index = 1; index < result.nested.length; index++) expect(result.nested[index].header.top - result.nested[index - 1].header.top).toBeCloseTo(result.nested[index - 1].frame.height, 1);
      expect(result.final.footer.top).toBeGreaterThanOrEqual(result.final.message.bottom);
      expect(result.final.opacity).toBe('1'); expect(result.final.pointerEvents).toBe('auto');
      expect(result.calls['final-copy']).toBe(results.indexOf(result) + 1); expect(result.calls['final-open']).toBe(results.indexOf(result) + 1);
    }
    expect(results[2].entries.find((entry: any) => entry.kind === 'prose').content.height).toBeGreaterThan(results[0].entries.find((entry: any) => entry.kind === 'prose').content.height);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
