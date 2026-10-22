// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { scratchDir } from './helpers/cli-process.js';
import { SQLITE_RUNTIME_LOCK } from '../src/sqlite-runtime.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(fail = false) {
  const root = scratchDir('parser-runtime'); roots.push(root);
  fs.mkdirSync(path.join(root, 'cli'));
  for (const name of ['api.sh', 'user.sh', 'command-syntax.sh', 'command-syntax.cjs', 'command-syntax.json', 'canonical-origin.sh', 'local-credential-routes.json', 'mandible-identity.jq']) {
    fs.copyFileSync(path.resolve('cli', name), path.join(root, 'cli', name));
  }
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(path.resolve('bin/mandible'), path.join(root, 'bin/mandible'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const log = path.join(root, 'selectors');
  fs.writeFileSync(path.join(root, 'scripts/bun-runtime.sh'), `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(log)}
${fail ? 'exit 19' : `exec ${quote(path.resolve('scripts/bun-runtime.sh'))} "$@"`}
`, { mode: 0o755 });
  return { root, log, syntax: path.join(root, 'cli/command-syntax.sh'), launches: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}

for (const shell of ['bash', 'zsh']) {
  it(`qualifies once across repeated sources and parser substitutions in ${shell}`, () => {
    const f = fixture();
    const result = spawnSync(shell, ['-c', `
source ${quote(f.syntax)}
first=$(mandible_command_syntax user.show)
source ${quote(f.syntax)}
second=$(mandible_command_syntax user.show)
[[ "$first" == "$second" && "$first" == *"user show"* ]]
`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(f.launches()).toEqual(['--bun-only']);
  });

  it(`rejects inherited scalar runtime state and requalifies another source root in ${shell}`, () => {
    const a = fixture(), b = fixture();
    const result = spawnSync(shell, ['-c', `
source ${quote(a.syntax)}
first=$(mandible_command_syntax user.show)
source ${quote(b.syntax)}
second=$(mandible_command_syntax user.show)
[[ "$first" == "$second" && "$first" == *"user show"* ]]
`], { encoding: 'utf8', env: { ...process.env, _MANDIBLE_SYNTAX_RUNTIME: '/bin/false', _MANDIBLE_SYNTAX_SOURCE: path.dirname(a.syntax) } });
    expect(result.status, result.stderr).toBe(0);
    expect(a.launches()).toEqual(['--bun-only']);
    expect(b.launches()).toEqual(['--bun-only']);
  });

  it(`fails before executing the caller when qualification fails before set -e in ${shell}`, () => {
    const f = fixture(true);
    const result = spawnSync(shell, ['-c', `source ${quote(f.syntax)}; set -e; echo caller-executed`], { encoding: 'utf8' });
    expect(result.status).toBe(19);
    expect(result.stdout).toBe('');
    expect(f.launches()).toEqual(['--bun-only']);
  });

  it(`leaves API-only calls unqualified and qualifies only the exec subcommand in ${shell}`, () => {
    const f = fixture();
    const api = spawnSync(shell, ['-c', `source ${quote(path.join(f.root, 'cli/api.sh'))}; api_is_local_socket`], { encoding: 'utf8' });
    expect(api.status, api.stderr).toBe(0);
    expect(f.launches()).toEqual([]);
    const cli = spawnSync(shell, [path.join(f.root, 'bin/mandible'), 'user', '--help'], { encoding: 'utf8', env: { ...process.env, MANDIBLE_SESSION_ID: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' } });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('mandible user');
    expect(f.launches()).toEqual(['--bun-only']);
  });
}

it('does not let exported Bash functions forge the native array qualification guard', () => {
  const f = fixture();
  const result = spawnSync('bash', ['-c', `
typeset() { printf 'declare -a _MANDIBLE_SYNTAX_RUNTIME'; }
mandible_syntax_tool() { echo forged-parser; }
export -f typeset mandible_syntax_tool
export _MANDIBLE_SYNTAX_RUNTIME=/bin/false
export _MANDIBLE_SYNTAX_SOURCE=${quote(path.dirname(f.syntax))}
bash -c ${quote(`source ${quote(f.syntax)}; mandible_command_syntax user.show`)}
`], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('mandible user show');
  expect(result.stdout).not.toContain('forged-parser');
  expect(f.launches()).toEqual(['--bun-only']);
});

it('keeps Bun identity checks for parser-only selection and SQLite checks for the default selector', () => {
  const selector = path.resolve('scripts/bun-runtime.sh');
  for (const args of [[], ['--bun-only']]) {
    const bad = spawnSync(selector, args, { encoding: 'utf8', env: { ...process.env, MANDIBLE_RUNTIME: '/bin/false' } });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('must match the pinned Bun');
  }
  if (process.platform !== 'darwin') return;
  const store = scratchDir('parser-sqlite'); roots.push(store);
  const library = path.join(store, 'sqlite', SQLITE_RUNTIME_LOCK.librarySha256, 'libsqlite3.dylib');
  fs.mkdirSync(path.dirname(library), { recursive: true });
  fs.writeFileSync(library, 'corrupt SQLite bytes');
  const env = { ...process.env, MANDIBLE_RUNTIME: process.execPath, MANDIBLE_RUNTIME_STORE: store };
  const parser = spawnSync(selector, ['--bun-only'], { encoding: 'utf8', env });
  expect(parser.status, parser.stderr).toBe(0);
  expect(parser.stdout.trim()).toBe(process.execPath);
  const database = spawnSync(selector, [], { encoding: 'utf8', env });
  expect(database.status).not.toBe(0);
  expect(database.stderr).toContain('Pinned SQLite library is missing or corrupt');
  const helper = spawnSync('bash', ['-c', `source ${quote(path.resolve('cli/command-syntax.sh'))} --mandible-syntax-definitions-only; mandible_bun_runtime`], { encoding: 'utf8', env });
  expect(helper.status).not.toBe(0);
  expect(helper.stderr).toContain('Pinned SQLite library is missing or corrupt');
});
