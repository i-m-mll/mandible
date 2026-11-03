import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildBundleService, stageBundleServices } from './prepare-bundle-services.mjs';

test('service staging uses the built executable from an isolated Cargo target directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-service-artifact-'));
  try {
    const crate = path.join(root, 'src-tauri/service-helper');
    const target = path.join(root, 'owned-build/target');
    const env = { ...process.env, CARGO_TARGET_DIR: target,
      CARGO_BUILD_BUILD_DIR: path.join(root, 'owned-build/intermediates'), CARGO_NET_OFFLINE: 'true' };
    fs.mkdirSync(path.join(crate, 'src'), { recursive: true });
    fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "mandible-service"\nversion = "0.1.0"\nedition = "2021"\n');
    fs.writeFileSync(path.join(crate, 'src/main.rs'), 'fn main() { println!("isolated-service-artifact"); }\n');
    execFileSync('cargo', ['generate-lockfile', '--manifest-path', path.join(crate, 'Cargo.toml')], {
      cwd: root, env, timeout: 10_000, stdio: 'pipe',
    });
    const stale = path.join(crate, 'target/release/mandible-service');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'stale default-target executable');
    const executable = buildBundleService(root, env);
    const contents = path.join(root, 'Mandible.app/Contents');
    stageBundleServices(contents, executable);
    const staged = path.join(contents, 'MacOS/mandible-service');
    assert.ok(path.relative(target, executable).split(path.sep).every(part => part !== '..'));
    assert.deepEqual(fs.readFileSync(staged), fs.readFileSync(executable));
    assert.equal(execFileSync(staged, [], { encoding: 'utf8', timeout: 5000 }).trim(), 'isolated-service-artifact');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
