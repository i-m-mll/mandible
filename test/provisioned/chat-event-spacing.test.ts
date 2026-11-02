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
    for (const boundary of results[0].childBoundaries) {
      const pitch = boundary.fontSize === 14 ? 24.95 : 26;
      expect(boundary.parentToFirst).toBe(0); expect(boundary.internalParentToFirst).toBe(0);
      expect(boundary.lastPitch).toBeCloseTo(pitch, 1); expect(boundary.internalLastPitch).toBeCloseTo(pitch, 1);
      expect(boundary.outerLeading).toBe(8); expect(boundary.outerTrailing).toBe(8);
      expect(boundary.standaloneHeight).toBe(boundary.fontSize === 14 ? 22 : 25);
      expect(boundary.headerHeights[0]).toBe(boundary.standaloneHeight);
      for (const height of boundary.headerHeights.slice(1)) expect(height).toBeCloseTo(pitch, 1);
      expect(boundary.nestedInset.above).toBeCloseTo(boundary.nestedInset.below, 1);
      expect(boundary.nestedInset.above).toBeCloseTo(boundary.standaloneInset.above * 1.5, 1);
      expect(boundary.nestedBody).toEqual(boundary.standaloneBody);
      expect(boundary.normalHeights).toEqual(boundary.measuredHeights);
      if (boundary.expanded) { expect(boundary.bodyGap).toBe(0); expect(boundary.internalBodyGap).toBe(0); }
      else { expect(boundary.firstToSecond).toBeCloseTo(pitch, 1); expect(boundary.internalFirstToSecond).toBeCloseTo(pitch, 1); }
    }
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
      const outerGaps = [[0, 0], [0, 0], [0, 1], [1, 1], [1, 1], [1, 0], [0, 1]];
      for (const [index, child] of result.nested.entries()) {
        expect(child.header.top - child.frame.top, `${result.width}: wrong outer leading separation`).toBeCloseTo(outerGaps[index][0] * result.spacing, 1);
        expect(child.frame.bottom - child.header.bottom, `${result.width}: wrong outer trailing separation`).toBeCloseTo(outerGaps[index][1] * result.spacing, 1);
      }
      expect(result.final.footer.top).toBeGreaterThanOrEqual(result.final.message.bottom);
      expect(result.final.opacity).toBe('1'); expect(result.final.pointerEvents).toBe('auto');
      expect(result.calls['final-copy']).toBe(results.indexOf(result) + 1); expect(result.calls['final-open']).toBe(results.indexOf(result) + 1);
    }
    expect(results[2].entries.find((entry: any) => entry.kind === 'prose').content.height).toBeGreaterThan(results[0].entries.find((entry: any) => entry.kind === 'prose').content.height);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
