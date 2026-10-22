// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

function canonicalCheckoutRoot(): string {
  if (statSync(resolve('.git')).isDirectory()) return process.cwd();
  const gitDirectory = readFileSync(resolve('.git'), 'utf8').trim().replace(/^gitdir:\s*/, '');
  const markerIndex = gitDirectory.lastIndexOf(join('.git', 'worktrees'));
  if (markerIndex < 0) throw new Error(`Cannot resolve canonical checkout from ${gitDirectory}`);
  return gitDirectory.slice(0, markerIndex).replace(/[\\/]$/, '');
}

function bundleFixture(directory: string): string {
  const checkoutRoot = canonicalCheckoutRoot();
  const output = join(directory, 'fixture.js');
  const bundled = spawnSync(join(checkoutRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'), [
    resolve('test/provisioned/fixtures/chat-virtual-mount-fixture.tsx'),
    '--bundle',
    `--outfile=${output}`,
    '--format=iife',
    '--platform=browser',
    '--target=es2020',
    '--jsx=automatic',
    '--jsx-import-source=preact',
    '--alias:react=preact/compat',
    '--alias:react-dom=preact/compat',
    '--alias:react/jsx-runtime=preact/jsx-runtime',
    '--loader:.css=empty',
    '--minify',
    '--log-level=silent',
  ], { encoding: 'utf8', env: { ...process.env, NODE_PATH: join(checkoutRoot, 'node_modules') } });
  if (bundled.status !== 0) throw new Error(`Chat mount fixture bundle failed: ${bundled.stderr || bundled.stdout}`);
  return readFileSync(output, 'utf8');
}

describe('Chat transcript native mount', () => {
  it('settles measured end anchoring without trapping the browser main thread', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mandible-chat-mount-'));
    try {
      const fixture = bundleFixture(directory);
      const path = join(directory, 'index.html');
      writeFileSync(path, `<!doctype html><html><head><style>
        html,body,#root { height: 100%; margin: 0; }
        .detail-pane-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .detail-pane-shell__body,.conv-transcript,.stream-renderer { display: flex; flex: 1; flex-direction: column; min-height: 0; }
        .stream-renderer__scroll { flex: 1; min-height: 0; overflow-y: auto; }
        .stream-renderer__virtual-canvas { position: relative; min-height: 100%; }
        .stream-renderer__virtual-row { position: absolute; left: 0; right: 0; }
        .turn-group { padding: 12px; }
      </style></head><body><div id="root"></div><script>${fixture}</script></body></html>`);

      const rendered = runChromium([
        '--virtual-time-budget=1500',
        '--dump-dom',
        `file://${path}`,
      ], { encoding: 'utf8', maxBuffer: 20_000_000 });

      expect(rendered.error, rendered.stderr).toBeUndefined();
      expect(rendered.status, rendered.stderr).toBe(0);
      expect(rendered.stdout).toContain('data-mount-status="settled"');
      expect(rendered.stdout).toContain('A source-backed assistant response');
      expect(rendered.stdout).toMatch(/data-sidebar-updates="[1-4]"/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
