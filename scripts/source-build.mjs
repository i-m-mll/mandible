#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeBuildRevision } from './build-revision.mjs';
import { typeScriptCompiler } from './run-tsc.js';
import { daemonBuildOutput } from './desktop-build-layout.mjs';
import { ensureDevDependencies } from './dev-dependencies.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function sourceBuild(directory, mode = 'build', { timeout = 60_000 } = {}) {
  if (!['build', 'typecheck', 'server'].includes(mode)) throw new Error(`Unknown source build mode: ${mode}`);
  const checking = mode === 'typecheck';
  const projects = mode === 'server' ? ['backend'] : ['backend', 'ui'];
  if (!checking) await fs.rm(path.join(directory, daemonBuildOutput), { recursive: true, force: true });
  await fs.mkdir(path.join(directory, '.cache/typescript'), { recursive: true });
  const compiler = typeScriptCompiler(directory);
  const commands = projects.map(project => {
    const config = project === 'backend' ? 'tsconfig.json' : 'ui/tsconfig.json';
    const args = ['--smol', compiler, '-p', config];
    if (checking || project === 'ui') args.push('--noEmit', '--incremental', '--tsBuildInfoFile', `.cache/typescript/${project}-check.tsbuildinfo`);
    return { name: `${project}-${checking || project === 'ui' ? 'check' : 'emit'}`, args };
  });
  if (mode === 'build') commands.push({ name: 'ui-bundle', args: ['ui/esbuild.config.js'] });
  const stages = commands.map(({ name, args }) => ({ name, executable: process.execPath, args: ['--no-install', ...args] }));
  if (!checking && process.platform === 'darwin') {
    stages.push({ name: 'project-folder-helper', executable: '/bin/sh', args: ['scripts/build-project-folder-helper.sh'] });
  }
  const results = await Promise.all(stages.map(({ name, executable, args }) => new Promise(resolve => {
    const started = performance.now();
    console.error(`[source-build] ${name} started`);
    const child = spawn(executable, args, { cwd: directory, stdio: 'inherit', timeout });
    child.once('error', error => {
      console.error(`[source-build] ${name} failed elapsed_ms=${(performance.now() - started).toFixed(1)} error=${error.message}`);
      resolve({ args, error });
    });
    child.once('exit', (code, signal) => {
      console.error(`[source-build] ${name} exited code=${code} signal=${signal ?? 'none'} elapsed_ms=${(performance.now() - started).toFixed(1)}`);
      resolve({ args, code, signal });
    });
  })));
  const failed = results.find(result => result.error || result.code !== 0);
  if (failed) throw new Error(`Source stage ${failed.args.join(' ')} failed: ${failed.error?.message ?? failed.signal ?? failed.code}`);
  if (mode === 'build') writeBuildRevision(directory);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureDevDependencies(root);
  await sourceBuild(root, process.argv[2] ?? 'build');
}
