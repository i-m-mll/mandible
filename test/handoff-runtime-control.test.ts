// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let scratch: string;
afterEach(() => { vi.resetModules(); vi.doUnmock('../scripts/accepted-app-install.mjs'); vi.doUnmock('../scripts/bundle-services.mjs'); vi.doUnmock('node:child_process'); if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

it('imports direct runtime operations in a shipped helper bundle without executing CLI adapters', async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-import-'));
  const { spawnSync } = await import('node:child_process');
  const entry = path.join(scratch, 'entry.mjs');
  const file = path.join(scratch, 'helper.mjs');
  fs.writeFileSync(entry, `import * as runtime from ${JSON.stringify(path.resolve('scripts/local-runtime.mjs'))}; console.log(typeof runtime.probeHandoffRuntime);`);
  const bundled = spawnSync(process.execPath, ['build', entry, '--target', 'bun', '--outfile', file], { encoding: 'utf8', timeout: 5000 });
  expect(bundled.status, bundled.stderr).toBe(0);
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 5000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('function');
});

async function fixture() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-control-'));
  const home = path.join(scratch, 'home'), app = path.join(scratch, 'Mandible.app');
  const resources = path.join(app, 'Contents/Resources');
  const runtimeDir = path.join(home, 'config/local-sessions');
  fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'config/client-auth'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config/client-auth/authority-id'), 'installation');
  fs.mkdirSync(path.join(runtimeDir, 'caddy-storage/pki/authorities/local'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'caddy-storage/pki/authorities/local/root.crt'), 'fixture-ca');
  const context = { home, accountHome: scratch, runtimeDir, domain: 'gui/501', bundleRoot: app, bundleIdentifier: 'bio.mll.fixture', backendLabel: 'bio.mll.fixture.backend', gatewayLabel: 'bio.mll.fixture.gateway', root: scratch };
  const generation = 'a'.repeat(40);
  const main = { instance_id: 'production', role: 'main', installation_id: 'installation', public_origin: 'https://app.mandible.localhost:19420', backend_origin: 'http://127.0.0.1:29420', backend_generation: generation, effect_ceiling_json: '[]', writable_roots_json: '[]' };
  context.storageModule = path.join(scratch, 'storage.cjs');
  fs.writeFileSync(context.storageModule, `exports.default = class { prepare() { return { all: () => [${JSON.stringify(main)}] }; } close() {} };`);
  fs.writeFileSync(path.join(runtimeDir, 'sessions.db'), 'fixture');
  const release = { provenance: { commit: generation }, native: { bun: '../MacOS/mandible-bun', caddy: '../MacOS/mandible-caddy' }, serviceExecutables: { backend: 'bun', gateway: 'caddy' } };
  const prepared = {};
  const assertHeld = vi.fn();
  vi.doMock('../scripts/accepted-app-install.mjs', async original => ({ ...await original(), preparedApplicationContext: (value, binding) => {
    expect(value).toBe(prepared); assertHeld(); return { resources, app, release, installed: true, digest: 'digest' };
  } }));
  const batch = vi.fn((_context, _operation, roles) => Object.fromEntries(roles.map(role => [role, { status: 'enabled' }])));
  vi.doMock('../scripts/bundle-services.mjs', async original => ({ ...await original(), nativeServiceControls: batch, bundleLoginSession: () => 'session' }));
  const jobs = { backend: { pid: 41, executable: path.join(app, 'Contents/MacOS/mandible-bun') }, gateway: { pid: 51, executable: path.join(app, 'Contents/MacOS/mandible-caddy') } };
  const birth = 'Wed Oct 28 18:08:18 2026';
  const commands: string[] = [];
  vi.doMock('node:child_process', async original => ({ ...await original(), spawnSync: (binary, args) => {
    commands.push(`${binary} ${args.join(' ')}`);
    if (binary === '/bin/launchctl') {
      const role = args[1].endsWith('.backend') ? 'backend' : 'gateway';
      return { status: 0, stdout: `service = {\n program identifier = Contents/MacOS/mandible-service (mode: 2)\n parent bundle identifier = bio.mll.fixture\n arguments = {\nmandible-service\nforeground\n${role}\n }\n pid = ${jobs[role].pid}\n runs = 1\n last exit code = 17\n}`, stderr: '' };
    }
    if (binary === '/bin/ps') return { status: 0, stdout: Object.values(jobs).map(job => `${job.pid} ${birth} ${job.executable}`).join('\n'), stderr: '' };
    throw new Error(`Unexpected process: ${binary}`);
  } }));
  vi.resetModules();
  const api = await import('../scripts/local-runtime.mjs');
  const binding = { home, nativeApp: app, domain: context.domain, backendLabel: context.backendLabel, gatewayLabel: context.gatewayLabel, installationId: 'installation', publicOrigin: main.public_origin, acceptedRelease: { reference: 'approved' }, serviceConfiguration: { configuration: { environment: { MANDIBLE_DB: path.join(home, 'mandible.db') } } } };
  const health = { status: 'ok', ready: true, warm: true, startup_epoch: 'epoch', instance: { ...main, db_path: path.join(home, 'mandible.db') } };
  return { api, binding, context, prepared, assertHeld, health, commands, jobs, birth, batch };
}

it('polls only exact database/generation/epoch HTTPS health under explicit ownership', async () => {
  const fx = await fixture();
  const options = { context: fx.context, prepared: fx.prepared, assertHeld: fx.assertHeld, until: Date.now() + 1000, startupEpoch: 'epoch', probe: vi.fn(async () => ({ ok: true, document: fx.health })) };
  for (let count = 0; count < 3; count++) expect(await fx.api.probeHandoffRuntime(fx.binding, options)).toMatchObject({ outcome: 'confirmed', process: { startupEpoch: 'epoch' } });
  await expect(fx.api.probeHandoffRuntime(fx.binding, { ...options, prepared: undefined, generation: 'a'.repeat(40) })).resolves.toMatchObject({ outcome: 'confirmed' });
  expect(fx.commands).toEqual([]); expect(fx.batch).not.toHaveBeenCalled();
  fx.health.ready = false;
  await expect(fx.api.probeHandoffRuntime(fx.binding, options)).rejects.toMatchObject({ code: 'not_ready', outcome: 'pending' });
  fx.health.ready = true; fx.health.instance.db_path = '/other/database';
  await expect(fx.api.probeHandoffRuntime(fx.binding, options)).rejects.toMatchObject({ code: 'wrong_database', outcome: 'failed' });
  fx.health.instance.db_path = fx.binding.serviceConfiguration.configuration.environment.MANDIBLE_DB; fx.health.startup_epoch = 'another';
  await expect(fx.api.probeHandoffRuntime(fx.binding, options)).rejects.toMatchObject({ code: 'process_changed', outcome: 'failed' });
  fx.assertHeld.mockImplementation(() => { throw new Error('lease lost'); });
  await expect(fx.api.probeHandoffRuntime(fx.binding, options)).rejects.toThrow('lease lost');
});

it('does not let a pending native launcher hide another role replacement or foreign executable', async () => {
  const fx = await fixture();
  const options = { context: fx.context, prepared: fx.prepared, assertHeld: fx.assertHeld, until: Date.now() + 1000 };
  const first = fx.api.inspectHandoffProcesses(fx.binding, options);
  expect(first.pending).toBeNull();
  expect(first.processes.backend).toEqual({ pid: 41, startedAt: fx.birth, runs: 1 });
  fx.jobs.gateway.executable = 'xpcproxy';
  expect(fx.api.inspectHandoffProcesses(fx.binding, options).pending).toContain('gateway');
  fx.jobs.backend.pid = 42;
  expect(() => fx.api.inspectHandoffProcesses(fx.binding, { ...options, processes: first.processes })).toThrowError(expect.objectContaining({ code: 'process_changed' }));
  fx.jobs.backend.pid = 41; fx.jobs.gateway.executable = '/foreign/Mandible.app/Contents/MacOS/mandible-caddy';
  expect(() => fx.api.inspectHandoffProcesses(fx.binding, options)).toThrowError(expect.objectContaining({ code: 'ownership_conflict' }));
});
