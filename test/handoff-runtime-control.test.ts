// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let scratch: string;
afterEach(() => { vi.resetModules(); vi.doUnmock('../scripts/accepted-app-install.mjs'); vi.doUnmock('../scripts/bundle-services.mjs'); vi.doUnmock('../scripts/service-definitions.mjs'); vi.doUnmock('node:child_process'); if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

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
  const ownership = { pending: false };
  vi.doMock('../scripts/service-definitions.mjs', async original => ({ ...await original(), inspectServiceDefinitionsSync: () => ownership.pending
    ? { ok: false, refusal: { category: 'starting', message: 'Native execution is starting.' } } : { ok: true, observations: [] } }));
  const jobs = { backend: { loaded: true, pid: 41 as number | null, foreign: false, executable: path.join(app, 'Contents/MacOS/mandible-bun') }, gateway: { loaded: true, pid: 51 as number | null, foreign: false, executable: path.join(app, 'Contents/MacOS/mandible-caddy') } };
  const birth = 'Wed Oct 28 18:08:18 2026';
  let processRead = () => {};
  const commands: string[] = [];
  vi.doMock('node:child_process', async original => ({ ...await original(), spawnSync: (binary, args) => {
    commands.push(`${binary} ${args.join(' ')}`);
    if (binary === '/bin/launchctl') {
      const role = args[1].endsWith('.backend') ? 'backend' : 'gateway';
      if (args[0] === 'kickstart') { jobs[role].pid = role === 'backend' ? 41 : 51; return { status: 0, stdout: '', stderr: '' }; }
      if (!jobs[role].loaded) return { status: 113, stdout: '', stderr: 'Could not find service' };
      return { status: 0, stdout: `service = {\n program identifier = Contents/MacOS/mandible-service (mode: 2)\n parent bundle identifier = ${jobs[role].foreign ? 'foreign.app' : 'bio.mll.fixture'}\n arguments = {\nmandible-service\nforeground\n${role}\n }\n${jobs[role].pid ? ` pid = ${jobs[role].pid}\n` : ''} runs = ${jobs[role].runs ?? 1}\n last exit code = 17\n}`, stderr: '' };
    }
    if (binary === '/bin/ps') {
      const live = Object.values(jobs).filter(job => job.loaded && job.pid);
      if (args.at(-1) === 'lstart=') return { status: live.some(job => String(job.pid) === args[1]) ? 0 : 1, stdout: live.some(job => String(job.pid) === args[1]) ? birth : '', stderr: '' };
      processRead();
      return { status: 0, stdout: live.map(job => `${job.pid} ${job.startedAt ?? birth} ${job.executable}`).join('\n'), stderr: '' };
    }
    throw new Error(`Unexpected process: ${binary}`);
  } }));
  vi.resetModules();
  const api = await import('../scripts/local-runtime.mjs');
  const binding = { home, nativeApp: app, domain: context.domain, backendLabel: context.backendLabel, gatewayLabel: context.gatewayLabel, installationId: 'installation', publicOrigin: main.public_origin, acceptedRelease: { reference: 'approved' }, serviceConfiguration: { configuration: { environment: { MANDIBLE_DB: path.join(home, 'mandible.db') } } }, requestId: 'request', executionId: 'execution', oldProcess: { pid: 999999, startedAt: 'old' }, priorBackend: { launchMode: 'manual' } };
  const journal = { binding, bindingDigest: 'binding', attempt: { id: 'attempt', state: 'running' } };
  const journalFile = path.join(runtimeDir, 'handoff/request-execution/journal.json');
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  fs.writeFileSync(path.join(runtimeDir, 'handoff-active.json'), JSON.stringify({ bindingDigest: journal.bindingDigest, journal: journalFile }));
  const health = { status: 'ok', ready: true, warm: true, startup_epoch: 'epoch', instance: { ...main, db_path: path.join(home, 'mandible.db') } };
  return { api, binding, journal, context, prepared, assertHeld, health, commands, jobs, birth, batch, ownership, setProcessRead: callback => { processRead = callback; } };
}

it('qualifies real role execution chains without restarting live stages and keeps terminal continuity strict', async () => {
  const fx = await fixture();
  fx.ownership.pending = true;
  const { nativeExecutionModel, classifyNativeExecution } = await import('../scripts/native-service-execution.mjs');
  const native = { bun: '../MacOS/mandible-bun', caddy: '../MacOS/mandible-caddy' };
  const model = nativeExecutionModel(fx.context.bundleRoot, { native, serviceExecutables: { backend: 'bun', gateway: 'caddy' } });
  const exe = role => path.join(fx.context.bundleRoot, `Contents/MacOS/mandible-${role}`);
  const stages = [
    ['xpcproxy', 'xpcproxy'], [exe('service'), 'mandible-service'], ['mandible-bun', exe('bun')],
    [exe('bun'), exe('bun')], [exe('bun'), exe('bun')], [exe('bun'), exe('caddy')],
  ];
  const processes = {};
  let stage = 0, finished = false, registered = false;
  fx.batch.mockImplementation((_context, operation, roles) => {
    if (operation === 'register') { if (registered) throw new Error('A live pending stage must not be re-registered'); registered = true; }
    return Object.fromEntries(roles.map(role => [role, { status: 'enabled' }]));
  });
  fx.setProcessRead(() => {
    const current = stages[Math.min(stage++, stages.length - 1)];
    [fx.jobs.backend.executable, fx.jobs.gateway.executable] = current;
    expect(classifyNativeExecution(model, 'backend', current[0])).toBe(current[0] === exe('bun') ? 'executable-qualified' : 'pending');
    expect(classifyNativeExecution(model, 'gateway', current[1])).toBe(current[1] === exe('caddy') ? 'executable-qualified' : 'pending');
    if (stage <= 5) expect(finished).toBe(false);
    if (stage === 5) { expect(processes).toHaveProperty('backend'); expect(processes).not.toHaveProperty('gateway'); }
  });
  const options = { context: fx.context, journal: fx.journal, prepared: fx.prepared, assertHeld: fx.assertHeld,
    until: Date.now() + 1000, processes, initialize: async () => {}, configure: async () => {} };
  await fx.api.startHandoffDefinitions(fx.binding, options); finished = true;
  expect(processes).toMatchObject({ backend: { pid: 41 }, gateway: { pid: 51 } });
  expect(fx.commands.some(command => command.includes('kickstart'))).toBe(false);
  fx.setProcessRead(() => {});
  for (const executable of ['mandible-service', exe('bun')]) {
    fx.jobs.gateway.executable = executable;
    expect(() => fx.api.inspectHandoffProcesses(fx.binding, options)).toThrowError(expect.objectContaining({ code: 'process_changed' }));
  }
  fx.jobs.gateway.executable = path.join(fx.context.bundleRoot, 'Contents/MacOS/other-tool');
  expect(() => fx.api.inspectHandoffProcesses(fx.binding, options)).toThrowError(expect.objectContaining({ code: 'ownership_conflict' }));
  fx.jobs.gateway.executable = exe('caddy'); fx.jobs.gateway.startedAt = 'Wed Oct 28 18:08:19 2026';
  expect(() => fx.api.inspectHandoffProcesses(fx.binding, options)).toThrowError(expect.objectContaining({ code: 'process_changed' }));
  fx.jobs.gateway.startedAt = fx.birth; fx.jobs.gateway.runs = 2;
  expect(() => fx.api.inspectHandoffProcesses(fx.binding, options)).toThrowError(expect.objectContaining({ code: 'process_changed' }));
  fx.jobs.gateway.runs = 1; fx.jobs.gateway.pid = 52; fx.jobs.backend.executable = '/foreign/mandible-bun';
  expect(() => fx.api.inspectHandoffProcesses(fx.binding, options)).toThrowError(expect.objectContaining({ code: 'process_changed' }));
  const legacy = nativeExecutionModel(fx.context.bundleRoot, { native });
  expect(classifyNativeExecution(legacy, 'gateway', exe('bun'))).toBe('executable-qualified');
  expect(classifyNativeExecution(legacy, 'backend', 'mandible-bun')).toBe('pending');
  expect(nativeExecutionModel(fx.context.bundleRoot, { native: { ...native, bun: '../MacOS/other-tool' } }).ok).toBe(false);
  expect(nativeExecutionModel(fx.context.bundleRoot, { native, serviceExecutables: { backend: 'caddy', gateway: 'caddy' } }).ok).toBe(false);
});

it.each(['settling registration', 'owned dormant job', 'permission refusal', 'foreign job', 'other role replacement'])('direct start preserves progress and ownership for %s', async scenario => {
  const fx = await fixture();
  fx.jobs.backend.loaded = scenario === 'owned dormant job'; fx.jobs.backend.pid = null;
  let status = 'enabled';
  fx.batch.mockImplementation((_context, operation, roles) => {
    if (scenario === 'permission refusal') status = 'requires_approval';
    if (operation === 'status' && scenario === 'settling registration') status = status === 'enabled' ? 'not_found' : status;
    if (operation === 'register' && status === 'not_found') { fx.jobs.backend.loaded = true; fx.jobs.backend.pid = 41; status = 'enabled'; }
    if (scenario === 'foreign job') { fx.jobs.backend.loaded = true; fx.jobs.backend.foreign = true; }
    if (operation === 'status' && scenario === 'other role replacement') fx.jobs.gateway.pid = 52;
    return Object.fromEntries(roles.map(role => [role, { status }]));
  });
  const result = fx.api.startHandoffDefinitions(fx.binding, { context: fx.context, journal: fx.journal, prepared: fx.prepared,
    assertHeld: fx.assertHeld, until: Date.now() + 1000, initialize: async () => {}, configure: async () => {} });
  const failure = { 'permission refusal': 'background_permission_required', 'foreign job': 'ownership_conflict', 'other role replacement': 'process_changed' }[scenario];
  if (failure) await expect(result).rejects.toMatchObject({ code: failure });
  else await expect(result).resolves.toMatchObject({ processes: { backend: { pid: 41 }, gateway: { pid: 51 } } });
  if (scenario !== 'owned dormant job') expect(fx.commands.some(command => command.includes('kickstart'))).toBe(false);
});

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
