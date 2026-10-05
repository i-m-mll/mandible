import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCoworkCliCacheDir, materializeCoworkCliCache } from '../src/cowork-cli-cache.js';
import { defaultFileRpcDirForInstance } from '../src/file-rpc-transport.js';
import { getMandibleHome } from '../src/platform-paths.js';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';

describe('test runtime custody', () => {
  it('contains default durable state, CLI cache, RPC spool and inherited subprocess home', () => {
    const home = process.env.HOME!;
    expect(path.relative(testRuntimeRoot, home)).toBe('home');
    expect(getMandibleHome()).toBe(path.join(home, '.mandible'));
    expect(defaultCoworkCliCacheDir()).toBe(path.join(home, '.cache', 'mandible', 'cli'));
    expect(defaultFileRpcDirForInstance()).toBe(path.join(home, '.cache', 'mandible', 'agent-rpc'));
    materializeCoworkCliCache({ sourceRoot: process.cwd() });
    expect(fs.existsSync(path.join(defaultCoworkCliCacheDir(), 'manifest.json'))).toBe(true);
    const inheritedHome = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { encoding: 'utf8' });
    expect(inheritedHome).toBe(home);
  });
});
