/**
 * The one way tests and test scripts start Chrome.
 *
 * Tests run under a private HOME with no login keychain. Chrome started there
 * without `--use-mock-keychain` asks macOS for its "Chrome Safe Storage" item,
 * and macOS answers with a modal "Keychain not found" dialog on the operator's
 * screen for every launch. Every launch therefore goes through here, which
 * always passes the mock keychain and the basic password store.
 */
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const ISOLATION_FLAGS = [
  '--headless=new',
  '--use-mock-keychain',
  '--password-store=basic',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--no-sandbox',
];

export function chromiumBinary(): string {
  const binary = CANDIDATES.find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate!));
  if (!binary) {
    throw new Error(`A Chromium browser is required; set CHROME_BIN or install one of: ${CANDIDATES.slice(1).join(', ')}`);
  }
  return binary;
}

export function chromiumArgs(args: readonly string[]): string[] {
  return [...ISOLATION_FLAGS, ...args.filter((arg) => !ISOLATION_FLAGS.includes(arg))];
}

/**
 * A hang guard, kept under the 60 s per-test guard so a stuck browser is named.
 * A loaded machine makes a render slower, not red.
 */
const RENDER_DEADLINE_MS = 45_000;

export function runChromium(args: readonly string[], options: Omit<SpawnSyncOptions, 'timeout'> & { encoding: BufferEncoding }) {
  return spawnSync(chromiumBinary(), chromiumArgs(args), { ...options, timeout: RENDER_DEADLINE_MS });
}

export function spawnChromium(args: readonly string[], options: SpawnOptions = {}) {
  return spawn(chromiumBinary(), chromiumArgs(args), options);
}
