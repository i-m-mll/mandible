#!/usr/bin/env bun
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { finalizeAppPayload } from './finalize-app-payload.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(argument => argument !== '--');
const bundles = args.indexOf('--bundles');
if (bundles >= 0 && args[bundles + 1] !== 'app') throw new Error('Build and finalize the app before creating a distribution container. Only --bundles app is supported here.');
if (bundles < 0) args.push('--bundles', 'app');
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...args],
  { cwd: root, env: process.env, stdio: 'inherit', timeout: 600_000 });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const target = args.indexOf('--target');
const targetDirectory = process.env.CARGO_TARGET_DIR ?? path.join(root, 'src-tauri/target');
const profile = args.includes('--debug') ? 'debug' : 'release';
const app = path.join(targetDirectory, ...(target >= 0 ? [args[target + 1]] : []), profile, 'bundle/macos/Mandible.app');
finalizeAppPayload(app);
process.stdout.write(`Finalized installed app: ${app}\n`);
