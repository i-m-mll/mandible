import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveAppSigning } from './app-signing.mjs';
import { tauriCompileArguments, tauriBundleArguments } from './tauri-build-commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('compile projection preserves the complete context while package flags retain ordered overrides', () => {
  const override = JSON.stringify({ identifier: 'bio.mll.mandible.fixture', app: { security: { csp: "default-src 'self'" } },
    bundle: { resources: { 'candidate-specific/': './' }, macOS: { minimumSystemVersion: '15.1' } } });
  const options = ['--runner', 'cargo', '-d', '--target=aarch64-apple-darwin', '--features', 'custom-protocol',
    '-c', override, '--config={"productName":"Configured"}', '--ci'];
  const compile = tauriCompileArguments(options, ['--', '--locked']);
  const configs = [override, '{"productName":"Configured"}'];
  const packageConfig = resolveAppSigning(root, configs, {}).config;
  const compiledConfig = resolveAppSigning(root, [...configs, compile[compile.indexOf('--no-bundle') + 2]], {}).config;
  const { resources, externalBin, ...bundleContext } = packageConfig.bundle;
  const { files, frameworks, ...macContext } = bundleContext.macOS;
  assert.deepEqual(compiledConfig, { ...packageConfig, bundle: { ...bundleContext, macOS: macContext } });
  assert.ok(resources && externalBin && files && frameworks);
  assert.deepEqual(compile.slice(-2), ['--', '--locked']);
  assert.deepEqual(tauriBundleArguments(options), ['bundle', '-d', '--target=aarch64-apple-darwin', '--features',
    'custom-protocol', '-c', override, '--config={"productName":"Configured"}', '--ci', '--bundles', 'app', '--no-sign']);
  assert.deepEqual(tauriBundleArguments(['-t', 'aarch64-apple-darwin', '--debug', '--features=custom-protocol', '-vv']),
    ['bundle', '-t', 'aarch64-apple-darwin', '--debug', '--features=custom-protocol', '-vv', '--bundles', 'app', '--no-sign']);
});

test('bootstrap preparation preserves unchanged native inputs and updates changed or missing assets', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-bootstrap-build-'));
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.mkdirSync(path.join(fixture, 'src-tauri/bootstrap'), { recursive: true });
    const runtime = path.join(fixture, 'runtime');
    fs.writeFileSync(runtime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fixture, 'scripts/bun-runtime.sh'), `#!/bin/sh\nprintf '%s\\n' '${runtime}'\n`, { mode: 0o755 });
    const files = ['index.html', 'bootstrap.css', 'bootstrap.js', 'canonical-origin.js'];
    for (const file of files) fs.writeFileSync(path.join(fixture, 'src-tauri/bootstrap', file), file);
    const prepare = () => {
      const result = spawnSync('/bin/sh', [path.join(root, 'scripts/make-dist.sh')], { cwd: fixture, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
    };
    prepare();
    for (const file of files) fs.utimesSync(path.join(fixture, 'src-tauri/dist', file), 100, 100);
    prepare();
    for (const file of files) assert.equal(fs.statSync(path.join(fixture, 'src-tauri/dist', file)).mtimeMs, 100_000);
    fs.writeFileSync(path.join(fixture, 'src-tauri/bootstrap/bootstrap.js'), 'changed bootstrap');
    fs.unlinkSync(path.join(fixture, 'src-tauri/dist/index.html'));
    prepare();
    assert.equal(fs.readFileSync(path.join(fixture, 'src-tauri/dist/bootstrap.js'), 'utf8'), 'changed bootstrap');
    assert.equal(fs.readFileSync(path.join(fixture, 'src-tauri/dist/index.html'), 'utf8'), 'index.html');
    assert.equal(fs.statSync(path.join(fixture, 'src-tauri/dist/bootstrap.css')).mtimeMs, 100_000);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
