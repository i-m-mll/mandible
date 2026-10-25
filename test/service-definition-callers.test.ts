// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('renders byte-identical installation definitions under different executables, PATH, HOME and runtime overrides', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-service-callers-'));
  try {
    const selected = spawnSync('/bin/sh', ['scripts/bun-runtime.sh', '--bun-only'], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8', timeout: 30_000 });
    expect(selected.status, selected.stderr).toBe(0);
    const pinned = selected.stdout.trim();
    const other = path.join(scratch, 'other-bun');
    fs.copyFileSync(pinned, other, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(other, 0o700);
    const context = { home: path.join(scratch, 'installation'), accountHome: path.join(scratch, 'account') };
    const configFile = path.join(context.home, 'config/local-sessions/service-config.json');
    const configuration = JSON.stringify({ environment: { MANDIBLE_DB: path.join(scratch, 'configured.db') }, toolDirectories: [path.join(scratch, 'tools'), '/usr/bin'] });
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, configuration);
    const moduleUrl = new URL('../scripts/local-runtime.mjs', import.meta.url).href;
    const inspectorUrl = new URL('../scripts/service-definitions.mjs', import.meta.url).href;
    const script = `import { prepareServicePlists } from ${JSON.stringify(moduleUrl)};
      import { serviceInstallationContext } from ${JSON.stringify(inspectorUrl)};
      const context = serviceInstallationContext(${JSON.stringify(context)});
      const result = prepareServicePlists({ root: ${JSON.stringify(process.cwd())} }, { backendUrl: new URL('http://127.0.0.1:29420') }, 'manual', { context });
      console.log(JSON.stringify(result.definitions));`;
    const prepare = (executable: string, environment: Record<string, string>) => {
      const result = spawnSync(executable, ['--eval', script], { env: environment, encoding: 'utf8', timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const first = prepare(pinned, { HOME: path.join(scratch, 'first-home'), PATH: '/first/bin', MANDIBLE_RUNTIME: '/wrong/bun', MANDIBLE_RUNTIME_STORE: '/wrong/store', MANDIBLE_RUNTIME_ARCHIVE: '/wrong/archive', MANDIBLE_SQLITE_LIBRARY: '/wrong/sqlite', MANDIBLE_SECURITY_BIN: '/wrong/security', MANDIBLE_DB: '/wrong/database' });
    const second = prepare(other, { HOME: path.join(scratch, 'second-home'), PATH: '/second/bin:/usr/local/bin', MANDIBLE_RUNTIME: other });
    expect(first).toBe(second);
    const definitions = JSON.parse(first);
    expect(definitions[0].record.ProgramArguments[0]).toBe(pinned);
    expect(definitions[0].record.EnvironmentVariables.HOME).toBe(context.accountHome);
    const directories = definitions[0].record.EnvironmentVariables.PATH.split(':');
    expect(directories.slice(0, 6)).toEqual([path.dirname(pinned), path.join(process.cwd(), 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    expect(directories).toContain(path.join(context.accountHome, '.local/bin'));
    expect(directories).toContain('/opt/homebrew/bin');
    expect(directories[6]).toBe(path.join(scratch, 'tools'));
    expect(directories.filter((directory: string) => directory === '/usr/bin')).toHaveLength(1);
    expect(definitions[0].record.EnvironmentVariables.MANDIBLE_DB).toBe(path.join(scratch, 'configured.db'));
    expect(definitions[0].record.EnvironmentVariables.MANDIBLE_SQLITE_LIBRARY).toBeUndefined();
    expect(fs.readFileSync(configFile, 'utf8')).toBe(configuration);
    expect(definitions.every((definition: { file: string }) => !fs.existsSync(definition.file))).toBe(true);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('migration keeps the tool directories the running service relies on and drops the ones the composition derives', async () => {
  const { readServiceConfiguration } = await import('../scripts/service-configuration.mjs');
  const accountHome = '/Users/account';
  const context = { accountHome, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-service-migration-')) };
  try {
    // The production PATH after the 2026-10-02 recovery: a self-contained Node ahead of Homebrew.
    const node = `${accountHome}/.local/share/mandible/runtimes/node-v25.2.1-darwin-arm64/bin`;
    const legacyPath = [`${accountHome}/.local/share/mandible/runtimes/bun/old/sha`, '/checkout/bin', '/usr/bin', '/bin',
      `${accountHome}/.cargo/bin`, node, `${accountHome}/.local/bin`, '/opt/homebrew/bin'].join(':');
    const { migrated, configuration } = readServiceConfiguration(context, { PATH: legacyPath, NODE_OPTIONS: '--max-old-space-size=768' }, '/checkout');
    expect(migrated).toBe(true);
    expect(configuration.toolDirectories).toEqual([node]);
    expect(configuration.environment).toEqual({ NODE_OPTIONS: '--max-old-space-size=768' });
  } finally { fs.rmSync(context.runtimeDir, { recursive: true, force: true }); }
});
