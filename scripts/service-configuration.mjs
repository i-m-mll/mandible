import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { composePath } from './runtime-environment.mjs';

const overrides = new Set(['MANDIBLE_DB', 'MANDIBLE_PID_FILE', 'MANDIBLE_STDERR_LOG_PATH', 'MANDIBLE_SQLITE_LIBRARY', 'MANDIBLE_SQLITE_LIBRARY_ARCHIVE', 'MANDIBLE_SECURITY_BIN', 'NODE_OPTIONS']);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n$`~]/.test(value);

export function validateServiceConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['environment', 'toolDirectories'].includes(key))) throw new Error('Invalid service configuration.');
  const environment = value.environment ?? {};
  const toolDirectories = value.toolDirectories ?? [];
  if (typeof environment !== 'object' || Array.isArray(environment) || environment === null || !Array.isArray(toolDirectories)
    || toolDirectories.some(directory => !absolute(directory) || directory.includes(':'))
    || Object.entries(environment).some(([key, entry]) => !overrides.has(key) || typeof entry !== 'string' || /[\0\r\n$`~]/.test(entry) || key !== 'NODE_OPTIONS' && !absolute(entry))) {
    throw new Error('Service overrides require allowlisted absolute paths and literal options; tool directories must be absolute, nonempty PATH entries.');
  }
  return { environment: Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))), toolDirectories: [...new Set(toolDirectories)] };
}

const SYSTEM_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const defaultToolDirectories = context => [...['.local/bin', '.dotfiles/bin', '.cargo/bin', 'bin'].map(directory => path.join(context.accountHome, directory)),
  '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'];

/**
 * Migration keeps the PATH entries the running service relies on beyond the default
 * composition (the self-contained Node 25.2.1 selected after the 2026-10-02 Homebrew
 * breakage, issue 3378b90), and drops runtime-store and checkout directories, which
 * the composition derives itself. Callers pass the loaded job's environment when the
 * job is loaded, so a plist rewritten on disk by another caller never contributes.
 */
function migratedToolDirectories(context, root, legacyPath = '') {
  const derived = new Set([path.join(root, 'bin'), ...SYSTEM_DIRECTORIES, ...defaultToolDirectories(context)]);
  const runtimeStore = path.join(context.accountHome, '.local/share/mandible/runtimes/bun') + path.sep;
  return legacyPath.split(':').filter(directory => path.isAbsolute(directory) && !/[\0\r\n$`~]/.test(directory)
    && !derived.has(directory) && !directory.startsWith(runtimeStore));
}

export function readServiceConfiguration(context, legacyEnvironment = {}, root) {
  const file = path.join(context.runtimeDir, 'service-config.json');
  if (fs.existsSync(file)) return { file, migrated: false, configuration: validateServiceConfiguration(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  return { file, migrated: true, configuration: validateServiceConfiguration({
    environment: Object.fromEntries(Object.entries(legacyEnvironment).filter(([key]) => overrides.has(key))),
    toolDirectories: root ? migratedToolDirectories(context, root, legacyEnvironment.PATH) : [],
  }) };
}

export function publishServiceConfiguration(file, configuration) {
  const contents = `${JSON.stringify(validateServiceConfiguration(configuration), null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** The shell selector owns the pin, checksum, platform and account runtime store. */
export function installationRuntime(root, context) {
  const result = spawnSync('/bin/sh', [path.join(root, 'scripts/bun-runtime.sh'), '--bun-only'], {
    cwd: root, env: { HOME: context.accountHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !path.isAbsolute(result.stdout.trim())) throw new Error(`Cannot resolve the installation's pinned Bun: ${result.stderr || result.error?.message || 'invalid selector output'}`);
  return result.stdout.trim();
}

export function servicePath(runtime, root, context, configuration) {
  return composePath([path.dirname(runtime), path.join(root, 'bin'), ...SYSTEM_DIRECTORIES, ...configuration.toolDirectories, ...defaultToolDirectories(context)]);
}
