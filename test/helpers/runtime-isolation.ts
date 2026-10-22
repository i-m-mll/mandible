/** Install before application imports so captured default paths are private too. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

export const testRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-test-runtime-'));
const home = path.join(testRuntimeRoot, 'home');
fs.mkdirSync(home);

const isolatedValues: Record<string, string | undefined> = {
  HOME: home,
  MANDIBLE_INSTALLATION_ID: 'test-installation',
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  CODEX_HOME: path.join(home, '.codex'),
  // Let normal defaults derive from the private home. Tests of explicit
  // overrides can still set these themselves and restore them afterward.
  MANDIBLE_HOME: undefined,
  MANDIBLE_CONFIG_DIR: undefined,
  MANDIBLE_ARTIFACT_DIR: undefined,
  MANDIBLE_CLIENT_AUTH_DIR: undefined,
  MANDIBLE_USER_PREFERENCES_DIR: undefined,
  MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR: undefined,
  MANDIBLE_CLI_CACHE_DIR: undefined,
  MANDIBLE_FILE_RPC_DIR: path.join(home, '.cache', 'mandible', 'agent-rpc'),
  MANDIBLE_SOCKET: undefined,
  MANDIBLE_DB: undefined,
  // Shell startup files resolve outside HOME through these; unset, zsh and
  // bash read only the private home, so the user's dotfiles never run in tests.
  ZDOTDIR: undefined,
  BASH_ENV: undefined,
  ENV: undefined,
};
// Tests state their own caller: the agent session running the suite must not
// leak its attribution or daemon selection into them.
const ambientCaller = /^(CLAUDE|CODEX_|GEMINI_|MANDIBLE_(MANAGED_|SESSION_|TOKEN$|BASE$|TRANSPORT$|CLI_DIR$))/;
for (const key of Object.keys(process.env)) if (ambientCaller.test(key) && !(key in isolatedValues)) isolatedValues[key] = undefined;
const previous = new Map(Object.keys(isolatedValues).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(isolatedValues)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(testRuntimeRoot, { recursive: true, force: true });
});
