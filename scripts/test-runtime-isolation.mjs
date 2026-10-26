import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pinned;
/** Test children run on the pinned Bun whatever Bun launched the runner. */
function pinnedRuntime() {
  if (!pinned) {
    const selector = fileURLToPath(new URL('./bun-runtime.sh', import.meta.url));
    const result = spawnSync('/bin/sh', [selector], {
      env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 30_000,
    });
    pinned = result.status === 0 ? result.stdout.trim() : '';
    if (!pinned) {
      throw new Error('Cannot select the pinned Bun runtime; fix the scripts/bun-runtime.sh error above, then rerun the tests.');
    }
  }
  return pinned;
}

let sqliteArchive;
function verifiedSqliteArchive() {
  if (process.platform !== 'darwin') return process.env.MANDIBLE_SQLITE_LIBRARY_ARCHIVE;
  if (!sqliteArchive) {
    const installer = fileURLToPath(new URL('./sqlite-runtime-install.mjs', import.meta.url));
    sqliteArchive = execFileSync(pinnedRuntime(), [installer, '--archive'], {
      env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 30_000,
    }).trim();
    if (!sqliteArchive) throw new Error('SQLite installer returned no verified archive');
  }
  return sqliteArchive;
}

function selectedTestGit() {
  if (process.platform !== 'darwin') return null;
  const selected = (process.env.PATH ?? '').split(path.delimiter)
    .map(directory => path.resolve(directory || '.', 'git'))
    .find(candidate => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return true; }
      catch { return false; }
    });
  if (selected !== '/usr/bin/git') return null;
  // Apple's launcher resolves this same executable on every Git invocation.
  // Resolve once; a private Git-only entry leaves all other tools in PATH order.
  const executable = fs.realpathSync(execFileSync('/usr/bin/xcrun', ['--find', 'git'], {
    encoding: 'utf8', timeout: 10_000,
  }).trim());
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  return { launcher: selected, executable, version };
}

/**
 * Private roots must exist before the child runtime captures os.homedir().
 * Spawn test children with `env.MANDIBLE_RUNTIME`, the verified pinned Bun.
 */
export function createTestRuntime() {
  const bun = pinnedRuntime();
  const archive = verifiedSqliteArchive();
  const git = selectedTestGit();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-test-run-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const tools = path.join(root, 'bin');
  if (git) {
    fs.mkdirSync(tools);
    const quoted = `'${git.executable.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(path.join(tools, 'git'), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o700 });
  }
  const env = {
    ...process.env,
    HOME: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    CODEX_HOME: path.join(home, '.codex'),
    MANDIBLE_RUNTIME: bun,
    ...(archive ? { MANDIBLE_SQLITE_LIBRARY_ARCHIVE: archive } : {}),
    MANDIBLE_TEST_RUNTIME_ROOT: root,
    PATH: git ? `${tools}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH,
  };
  for (const key of [
    'MANDIBLE_HOME', 'MANDIBLE_CONFIG_DIR', 'MANDIBLE_ARTIFACT_DIR',
    'MANDIBLE_CLIENT_AUTH_DIR', 'MANDIBLE_USER_PREFERENCES_DIR',
    'MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR', 'MANDIBLE_CLI_CACHE_DIR',
    'MANDIBLE_FILE_RPC_DIR', 'MANDIBLE_SOCKET', 'MANDIBLE_DB',
  ]) delete env[key];
  return { env, toolchain: { git }, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
