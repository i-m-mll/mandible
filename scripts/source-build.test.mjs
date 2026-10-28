import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceBuild } from './source-build.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-source-build-'));
  roots.push(root);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
  write('package.json', '{"type":"module"}');
  const config = (rootDir, outDir, noEmit = false) => JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', types: [], strict: true, declaration: true, rootDir, outDir, noEmit }, include: [rootDir] });
  write('tsconfig.json', config('src', 'dist'));
  write('channel-server/tsconfig.json', config('src', '../dist/channel-server'));
  write('ui/tsconfig.json', config('src', 'dist', true));
  write('src/index.ts', 'export const value: number = 1;');
  write('src/obsolete.ts', 'export const obsolete = true;');
  write('channel-server/src/index.ts', 'export const channel = true;');
  write('ui/src/index.ts', 'export const ui = true;');
  write('ui/esbuild.config.js', "import {build} from 'esbuild'; await build({entryPoints:['ui/src/index.ts'],outdir:'ui/dist'});");
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return { root, write, read: file => fs.readFileSync(path.join(root, file), 'utf8') };
}

test('analysis caches preserve fresh complete emitted outputs through edits and deletions', async () => {
  const { root, write, read } = fixture();
  await sourceBuild(root, 'typecheck');
  expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
  await sourceBuild(root);
  expect(read('dist/index.js')).toContain('value = 1');
  expect(read('dist/index.d.ts')).toContain('value: number');
  expect(read('dist/channel-server/index.js')).toContain('channel = true');
  expect(read('ui/dist/index.js')).toContain('ui = true');
  write('src/index.ts', 'export const value: number = 2;');
  fs.rmSync(path.join(root, 'src/obsolete.ts'));
  const removed = spawnSync('git', ['rm', '--cached', 'src/obsolete.ts'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (removed.status !== 0) throw new Error(removed.stderr);
  fs.rmSync(path.join(root, 'dist/channel-server/index.js'));
  await sourceBuild(root);
  expect(read('dist/index.js')).toContain('value = 2');
  expect(fs.existsSync(path.join(root, 'dist/obsolete.js'))).toBe(false);
  expect(read('dist/channel-server/index.js')).toContain('channel = true');
  write('ui/src/index.ts', 'export const ui: number = "invalid";');
  await expect(sourceBuild(root)).rejects.toThrow('failed');
  expect(fs.existsSync(path.join(root, 'dist/build-revision.json'))).toBe(false);
});

test('a source stage deadline joins the compiler process before returning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-compiler-deadline-'));
  roots.push(root);
  const compiler = path.join(root, 'node_modules/typescript/lib/tsc.js');
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(new URL('./run-tsc.js', import.meta.url), path.join(root, 'scripts/run-tsc.js'));
  fs.writeFileSync(compiler, `
    require('node:fs').writeFileSync('compiler.pid', String(process.pid));
    setInterval(() => require('node:fs').appendFileSync('output', 'emitting'), 10);
  `);
  await expect(sourceBuild(root, 'channel', { timeout: 1_000 })).rejects.toThrow('SIGTERM');
  const pid = Number(fs.readFileSync(path.join(root, 'compiler.pid'), 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    alive = false;
  }
  if (alive) process.kill(pid, 'SIGKILL');
  expect(alive).toBe(false);
  expect(fs.existsSync(path.join(root, 'output'))).toBe(true);
});
