import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativePreviewInitialPath } from './native-preview.mjs';

test('native launch paths preserve local queries and fragments and default to overview', () => {
  assert.equal(nativePreviewInitialPath(), '/#/overview');
  const selected = '/dist/proofs/3434b09/splash.html?reason=rebuilding#/overview?pane=detail';
  assert.equal(nativePreviewInitialPath(selected), selected);
  for (const input of ['https://foreign.invalid/', '//foreign.invalid/', '/\\foreign.invalid/', 'relative', '/\n/foreign.invalid/', '', null]) {
    assert.throws(() => nativePreviewInitialPath(input), /root-relative path/);
  }
});

test('CLI forwards initial-path and rejects foreign navigation before selecting or launching a preview', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./native-preview.mjs', import.meta.url)),
    'launch', '--branch', 'nonexistent-preview', '--project', 'fixture', '--work-unit', 'fixture',
    '--initial-path', '//foreign.invalid/'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(JSON.parse(result.stderr).error, /Native initial path must be a root-relative path/);
});
