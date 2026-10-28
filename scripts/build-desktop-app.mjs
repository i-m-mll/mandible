#!/usr/bin/env bun
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppSigning } from './app-signing.mjs';
import { finishAppPackage } from './finish-app-package.mjs';
import { assembleDesktopApplication } from './tauri-build-commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supplied = process.argv.slice(2);
if (supplied[0] === '--') supplied.shift();
const separator = supplied.indexOf('--');
const options = separator < 0 ? supplied : supplied.slice(0, separator);
const cargoArguments = separator < 0 ? [] : supplied.slice(separator);
const args = [];
const configs = [];
let selectedBundles;
let archive = false;
for (let index = 0; index < options.length; index++) {
  const option = options[index];
  if (['--no-sign', '--no-bundle', '--skip-stapling'].includes(option)) throw new Error(`${option} bypasses the finished-package contract. This command assembles unsigned bytes internally, then signs and waits for requested notarization/stapling.`);
  if (option === '--archive') { archive = true; continue; }
  if (option === '--bundles' || option === '-b' || option.startsWith('--bundles=')) {
    selectedBundles = option.includes('=') ? option.split('=')[1].split(',') : [];
    while (index + 1 < options.length && !options[index + 1].startsWith('-')) selectedBundles.push(...options[++index].split(','));
    continue;
  }
  if (option === '--config' || option === '-c') {
    const value = options[++index];
    if (!value) throw new Error('Missing Tauri configuration argument.');
    configs.push(value); args.push(option, value); continue;
  }
  if (option.startsWith('--config=')) configs.push(option.slice('--config='.length));
  args.push(option);
}
const plan = resolveAppSigning(root, configs);
const bundles = selectedBundles ?? plan.config.bundle?.targets ?? ['app'];
if (!Array.isArray(bundles) || bundles.some(bundle => !['app', 'dmg'].includes(bundle))) throw new Error('Mac package targets must be app and/or dmg.');
await assembleDesktopApplication(root, args, cargoArguments);
const target = options.findIndex(option => ['--target', '-t'].includes(option) || option.startsWith('--target='));
const targetTriple = target < 0 ? null : options[target].startsWith('--target=') ? options[target].slice('--target='.length) : options[target + 1];
const targetDirectory = process.env.CARGO_TARGET_DIR ?? path.join(root, 'src-tauri/target');
const profile = args.some(option => ['--debug', '-d'].includes(option)) ? 'debug' : 'release';
const app = path.join(targetDirectory, ...(targetTriple ? [targetTriple] : []), profile, 'bundle/macos', `${plan.config.productName ?? 'Mandible'}.app`);
const receipt = finishAppPackage(app, plan, { dmg: bundles.includes('dmg'), archive });
process.stdout.write(`Finished app package (${receipt.notarization}): ${app}\n`);
