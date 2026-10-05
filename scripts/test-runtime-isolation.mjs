import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Private roots must exist before the child runtime captures os.homedir(). */
export function createTestRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-test-run-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    CODEX_HOME: path.join(home, '.codex'),
    MANDIBLE_RUNTIME: process.execPath,
    MANDIBLE_TEST_RUNTIME_ROOT: root,
  };
  for (const key of [
    'MANDIBLE_HOME', 'MANDIBLE_CONFIG_DIR', 'MANDIBLE_ARTIFACT_DIR',
    'MANDIBLE_CLIENT_AUTH_DIR', 'MANDIBLE_USER_PREFERENCES_DIR',
    'MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR', 'MANDIBLE_CLI_CACHE_DIR',
    'MANDIBLE_FILE_RPC_DIR', 'MANDIBLE_SOCKET', 'MANDIBLE_DB',
  ]) delete env[key];
  return { env, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
