import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCoworkCliCacheDir, materializeCoworkCliCache } from '../src/cowork-cli-cache.js';
import { defaultFileRpcDirForInstance } from '../src/file-rpc-transport.js';
import { getMandibleHome } from '../src/platform-paths.js';
import { sqliteRuntimePaths } from '../src/sqlite-runtime.js';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';

describe('test runtime custody', () => {
  it('contains default durable state, CLI cache, RPC spool and inherited subprocess home', () => {
    const home = process.env.HOME!;
    expect(path.relative(testRuntimeRoot, home)).toBe('home');
    expect(process.env.XDG_DATA_HOME).toBe(path.join(home, '.local', 'share'));
    const childDataRoot = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.XDG_DATA_HOME)'], { encoding: 'utf8' });
    expect(childDataRoot).toBe(process.env.XDG_DATA_HOME);
    expect(getMandibleHome()).toBe(path.join(home, '.mandible'));
    expect(defaultCoworkCliCacheDir()).toBe(path.join(home, '.cache', 'mandible', 'cli'));
    expect(defaultFileRpcDirForInstance()).toBe(path.join(home, '.cache', 'mandible', 'agent-rpc'));
    materializeCoworkCliCache({ sourceRoot: process.cwd() });
    expect(fs.existsSync(path.join(defaultCoworkCliCacheDir(), 'manifest.json'))).toBe(true);
    const inheritedHome = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { encoding: 'utf8' });
    expect(inheritedHome).toBe(home);
  });

  it('isolated homes reuse the account runtime store instead of installing copies', () => {
    const { MANDIBLE_RUNTIME: _runtime, MANDIBLE_RUNTIME_STORE: _store, ...env } = process.env;
    const runtime = execFileSync('/bin/sh', ['scripts/bun-runtime.sh'], { env, encoding: 'utf8' }).trim();
    expect(path.relative(testRuntimeRoot, runtime).startsWith('..')).toBe(true);
    expect(path.relative(testRuntimeRoot, sqliteRuntimePaths().library).startsWith('..')).toBe(true);
    expect(fs.existsSync(path.join(process.env.XDG_DATA_HOME!, 'mandible', 'runtimes'))).toBe(false);
  });
});
