#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installPinnedCaddy } from './pinned-caddy.mjs';
import { stageCoworkRuntime } from './stage-cowork-runtime.mjs';
import { RELEASE_SCHEMA } from './installed-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000 }).trim();
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const copy = (source, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(source, target, { recursive: true, dereference: true }); };

export function inventoryRelease(resources, release) {
  const files = {};
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Release contains a symlink: ${relative}`);
      if (stat.isDirectory()) visit(file, relative);
      else if (stat.isFile() && relative !== 'release.json') files[relative] = { sha256: hash(file), size: stat.size };
    }
  };
  visit(resources);
  for (const relative of Object.values(release.native)) {
    const file = path.resolve(resources, relative);
    files[relative] = { sha256: hash(file), size: fs.statSync(file).size };
  }
  return { ...release, files };
}

function copyProductionDependencies(resources) {
  const pending = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies).map(name => ({ name, from: root }));
  const visited = new Set();
  while (pending.length) {
    const { name, from, optional = false } = pending.pop();
    let directory = from;
    let found;
    while (directory.startsWith(root)) {
      const candidate = path.join(directory, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) { found = candidate; break; }
      directory = path.dirname(directory);
    }
    if (!found) {
      if (optional) continue;
      throw new Error(`Missing production dependency ${name} from ${from}`);
    }
    if (visited.has(found)) continue;
    visited.add(found);
    const target = path.join(resources, path.relative(root, found));
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(found)) if (entry !== 'node_modules') copy(path.join(found, entry), path.join(target, entry));
    const manifest = JSON.parse(fs.readFileSync(path.join(found, 'package.json'), 'utf8'));
    const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) if (!optionalNames.has(dependency)) pending.push({ name: dependency, from: found });
    for (const dependency of [...optionalNames, ...Object.keys(manifest.peerDependencies ?? {})]) pending.push({ name: dependency, from: found, optional: true });
  }
  return visited.size;
}

export async function stageAppPayload(contents) {
  if (`${process.platform}-${process.arch}` !== 'darwin-arm64') throw new Error('Only darwin-arm64 is qualified for installed payloads.');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  for (const relative of ['dist', 'ui/dist', 'cli', 'bin', 'config', '.bun-version', 'package.json', 'docs/cli-reference.md', 'hooks/git/reference-transaction', 'ui/index.html', 'ui/manifest.json', 'ui/sw.js', 'ui/icon.svg', 'ui/header-logo.svg', 'ui/icon-192.png', 'ui/icon-512.png']) copy(path.join(root, relative), path.join(resources, relative));
  const packageCount = copyProductionDependencies(resources);
  stageCoworkRuntime(root, resources);
  const scripts = new Set(['local-runtime.mjs', 'local-front-door.mjs', 'local-session-production-runner.mjs', 'runtime-handoff.mjs', 'installed-release.mjs', 'conversation-cutover-proof.mjs', 'project-db-snapshot.mjs', 'preview-custody.mjs', 'installed-command.mjs']);
  for (const name of scripts) {
    const source = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"]\.\/([^'"]+\.mjs)['"]/g)) scripts.add(match[1]);
    const compiled = source.replaceAll('../src/', '../dist/').replace(/(\.\.\/dist\/[^'"\s]+)\.ts/g, '$1.js');
    const target = path.join(resources, 'scripts', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, compiled);
  }
  const runtime = run('/bin/sh', [path.join(root, 'scripts/bun-runtime.sh')]);
  const sqlite = run(runtime, [path.join(root, 'scripts/sqlite-runtime-install.mjs')]);
  const caddy = installPinnedCaddy(path.join(os.homedir(), '.cache/mandible/package-tools'));
  const native = { bun: '../MacOS/mandible-bun', caddy: '../MacOS/mandible-caddy',
    claude: '../MacOS/mandible-claude', trustHelper: '../MacOS/mandible-trust-helper', sqlite: '../Frameworks/libsqlite3.dylib' };
  const sdkNative = path.join(resources, `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  for (const [name, source] of Object.entries({ bun: runtime, caddy, sqlite, claude: sdkNative, trustHelper: path.join(root, 'src-tauri/resources/local-ca-trust-helper') })) {
    copy(source, path.resolve(resources, native[name]));
  }
  fs.rmSync(sdkNative);
  fs.writeFileSync(path.join(resources, 'scripts/bun-runtime.sh'), `#!/bin/sh
set -eu
MANDIBLE_RELEASE_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export MANDIBLE_RELEASE_ROOT
runtime="$MANDIBLE_RELEASE_ROOT/${native.bun}"
if [ ! -x "$runtime" ] || [ ! -f "$MANDIBLE_RELEASE_ROOT/release.json" ]; then echo 'Incomplete Mandible installation' >&2; exit 1; fi
case "\${1:-}" in
  --exec) shift; exec "$runtime" "$@" ;;
  ''|--bun-only) printf '%s\\n' "$runtime" ;;
  *) echo 'Installed runtime selector supports --exec and --bun-only only' >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const provenance = JSON.parse(fs.readFileSync(path.join(resources, 'dist/build-revision.json'), 'utf8'));
  const commitInfo = run('git', ['show', '-s', '--format=%s%n%cI', provenance.commit]).split('\n');
  const release = { schema: RELEASE_SCHEMA, version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    layout: { kind: 'macos-app', roots: { resources: '.', executables: '../MacOS', libraries: '../Frameworks' } },
    target: `${process.platform}-${process.arch}`, provenance: { ...provenance, summary: commitInfo[0], date: commitInfo[1], bun_revision: run(runtime, ['--revision']) },
    qualification: { bun_sha256: hash(runtime), sqlite_sha256: hash(sqlite), caddy_sha256: hash(caddy) },
    entrypoints: { daemon: 'dist/index.js', cli: 'bin/mandible', channel: 'dist/channel-server/index.js', controller: 'scripts/local-runtime.mjs', trustSetup: 'scripts/local-ca-trust.mjs' }, native };
  fs.writeFileSync(path.join(resources, 'release.json'), `${JSON.stringify(inventoryRelease(resources, release), null, 2)}\n`);
  return { resources, packageCount, release };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const contents = path.resolve(process.argv[2] ?? path.join(root, 'src-tauri/resources/app-payload/Contents'));
  fs.rmSync(contents, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(await stageAppPayload(contents))}\n`);
}
