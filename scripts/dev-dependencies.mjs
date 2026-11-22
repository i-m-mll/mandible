import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dependencyInputs = ['package.json', 'bun.lock', 'bunfig.toml', '.bun-version', 'scripts/bun-runtime-lock.tsv'];

function identity(directory, revision) {
  const digest = createHash('sha256').update(revision);
  for (const input of dependencyInputs) digest.update(input).update('\0').update(fs.readFileSync(path.join(directory, input))).update('\0');
  return digest.digest('hex');
}

/** Called through bun-runtime.sh. Retains no receipt for an incomplete install. */
export function ensureDevDependencies(directory) {
  const modules = path.join(directory, 'node_modules');
  const receipt = path.join(modules, '.mandible-lock-identity');
  if (fs.lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing dependency installation through shared node_modules: ${modules}`);
  }
  const expected = identity(directory, Bun.revision);
  if (fs.existsSync(receipt) && fs.readFileSync(receipt, 'utf8') === expected) return;

  const backend = process.platform === 'darwin' ? 'clonefile' : 'copyfile';
  const result = spawnSync(process.execPath, ['install', '--frozen-lockfile', '--backend', backend], {
    cwd: directory, stdio: 'inherit', timeout: 60_000,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Frozen development dependency install failed: ${result.signal ?? result.status}`);
  if (identity(directory, Bun.revision) !== expected) throw new Error('Dependency inputs changed during installation');
  const staging = `${receipt}.${process.pid}`;
  try {
    fs.writeFileSync(staging, expected, { flag: 'wx' });
    fs.renameSync(staging, receipt);
  } finally { fs.rmSync(staging, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureDevDependencies(root);
