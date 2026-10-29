// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { serviceInstallationContext, type ServiceDefinition } from '../scripts/service-definitions.mjs';
import { PRODUCTION_ORIGIN } from '../scripts/canonical-origin.mjs';

let scratch: string;
afterEach(() => { vi.doUnmock('node:child_process'); vi.doUnmock('../scripts/build-revision.mjs'); vi.unstubAllEnvs(); vi.resetModules(); if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

it.each(['bio.mll.mandible', 'bio.mll.mandible.fixture.private'])('qualifies expected bundle %s through native startup and refuses foreign ownership', async identifier => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-launch-transition-')));
  const bundleRoot = path.join(scratch, 'Mandible.app');
  fs.mkdirSync(path.join(bundleRoot, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>`);
  fs.mkdirSync(path.join(bundleRoot, 'Contents/Resources'), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, 'Contents/Resources/release.json'), JSON.stringify({ native: { bun: '../MacOS/mandible-bun', caddy: '../MacOS/mandible-caddy' } }));
  const context = serviceInstallationContext({ home: path.join(scratch, 'home'), accountHome: scratch, bundleRoot });
  const agents = path.join(bundleRoot, 'Contents/Library/LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  for (const service of ['backend', 'gateway'] as const) fs.writeFileSync(path.join(agents, `${context[`${service}Label`]}.plist`), JSON.stringify({
    Label: context[`${service}Label`], BundleProgram: 'Contents/MacOS/mandible-service', ProgramArguments: ['mandible-service', 'foreground', service],
  }));
  let executable = 'xpcproxy';
  let parentIdentifier = identifier;
  let gatewayExecutable: string | null = null;
  const observedTimeouts: number[] = [];
  vi.doMock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawnSync: (binary: string, args: string[], options: { timeout?: number } = {}) => {
    if (options.timeout !== undefined) observedTimeouts.push(options.timeout);
    if (binary === '/usr/bin/plutil') {
      const bytes = fs.readFileSync(args.at(-1)!, 'utf8');
      return { status: 0, stdout: args.includes('-extract') ? bytes.match(/<string>([^<]+)<\/string>/)![1] : bytes, stderr: '' };
    }
    if (binary === '/bin/ps') return { status: 0, stdout: args.at(-1) === 'lstart=' ? 'launch-start'
      : args[args.indexOf('-p') + 1] === '52' ? gatewayExecutable ?? executable : executable, stderr: '' };
    if (binary === '/bin/launchctl') {
      const service = args[1].endsWith(context.backendLabel) ? 'backend' : 'gateway';
      return { status: 0, stdout: `service = {\n program identifier = Contents/MacOS/mandible-service (mode: 2)\n parent bundle identifier = ${parentIdentifier}\n arguments = {\nmandible-service\nforeground\n${service}\n }\n pid = ${service === 'backend' ? 42 : 52}\n}`, stderr: '' };
    }
    throw new Error(`Unexpected command ${binary}`);
  } }));
  vi.resetModules();
  const { inspectServiceDefinitionsSync } = await import('../scripts/service-definitions.mjs');
  for (executable of ['xpcproxy', '/usr/libexec/xpcproxy', 'mandible-service', path.join(bundleRoot, 'Contents/MacOS/mandible-service'), 'mandible-bun']) {
    const pending = inspectServiceDefinitionsSync(context);
    expect(pending).toMatchObject({ ok: false, refusal: { category: 'starting', evidence: { pid: 42, executable,
      service: 'backend', label: context.backendLabel, bundleProgram: 'Contents/MacOS/mandible-service', parentBundleIdentifier: identifier } } });
    if (!pending.ok) expect(pending.refusal.message).toContain(`PID 42 is still starting (${executable})`);
  }
  executable = path.join(bundleRoot, 'Contents/MacOS/mandible-bun');
  expect(inspectServiceDefinitionsSync(context).ok).toBe(true);
  fs.writeFileSync(path.join(bundleRoot, 'Contents/Resources/release.json'), JSON.stringify({ native: { bun: '../MacOS/mandible-bun', caddy: '../MacOS/mandible-caddy' }, serviceExecutables: { backend: 'bun', gateway: 'caddy' } }));
  expect(inspectServiceDefinitionsSync(context)).toMatchObject({ ok: false, refusal: { service: 'gateway', category: 'starting' } });
  gatewayExecutable = path.join(bundleRoot, 'Contents/MacOS/mandible-caddy');
  expect(inspectServiceDefinitionsSync(context).ok).toBe(true);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const before = observedTimeouts.length;
    expect(inspectServiceDefinitionsSync(context, { until: 1040 }).ok).toBe(true);
    expect(observedTimeouts.slice(before).length).toBeGreaterThan(0);
    expect(observedTimeouts.slice(before).every(timeout => timeout > 0 && timeout <= 40)).toBe(true);
    const beforeExpired = observedTimeouts.length;
    expect(inspectServiceDefinitionsSync(context, { until: 999 })).toMatchObject({ ok: false, refusal: { category: 'unreadable_state' } });
    expect(observedTimeouts).toHaveLength(beforeExpired);
  } finally { clock.mockRestore(); }
  parentIdentifier = 'bio.mll.foreign';
  expect(inspectServiceDefinitionsSync(context)).toMatchObject({ ok: false, refusal: { category: 'ownership_conflict' } });
  parentIdentifier = identifier;
  executable = '/another/Mandible.app/Contents/MacOS/mandible-bun';
  expect(inspectServiceDefinitionsSync(context)).toMatchObject({ ok: false, refusal: { category: 'ownership_conflict' } });
  gatewayExecutable = executable;
  executable = 'xpcproxy';
  expect(inspectServiceDefinitionsSync(context)).toMatchObject({ ok: false, refusal: { service: 'gateway', category: 'ownership_conflict' } });
});

async function fixture({ absentGateway = false, stoppedBackend = false } = {}) {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-definition-handoff-')));
  const home = path.join(scratch, 'installation');
  const context = serviceInstallationContext({ home, accountHome: path.join(scratch, 'account') });
  fs.mkdirSync(context.privateServiceDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'config/client-auth'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config/client-auth/authority-id'), 'fixture-installation');
  fs.writeFileSync(path.join(context.runtimeDir, 'sessions.db'), 'fixture');
  fs.writeFileSync(path.join(scratch, 'package.json'), '{}');
  const generation = 'a'.repeat(40);
  const storage = path.join(scratch, 'storage.cjs');
  fs.writeFileSync(storage, `exports.default = class { prepare() { return { all: () => [${JSON.stringify({ instance_id: 'production', installation_id: 'fixture-installation', public_origin: PRODUCTION_ORIGIN, backend_origin: 'http://127.0.0.1:29420', backend_generation: generation, effect_ceiling_json: '[]', writable_roots_json: '[]' })}] }; } close() {} };`);
  vi.stubEnv('MANDIBLE_HOME', home);
  vi.stubEnv('MANDIBLE_SERVICE_ACCOUNT_HOME', context.accountHome);
  vi.stubEnv('MANDIBLE_RUNTIME_HANDOFF_STORAGE', storage);
  const backend: ServiceDefinition = { Label: context.backendLabel, ProgramArguments: ['/runtime/bun', path.join(context.runtimeDir, 'production-runner.mjs'), 'run'],
    EnvironmentVariables: { MANDIBLE_HOME: home, MANDIBLE_PRODUCTION_ROOT: scratch, MANDIBLE_LAUNCH_MODE: 'manual', PATH: '/loaded/tools:/usr/bin', NODE_OPTIONS: '--max-old-space-size=768' },
    WorkingDirectory: context.runtimeDir, StandardOutPath: path.join(scratch, 'stdout.log'), StandardErrorPath: path.join(scratch, 'loaded-stderr.log'), KeepAlive: true };
  fs.writeFileSync(backend.ProgramArguments[1], '// managed runner');
  const gateway = { ...backend, Label: context.gatewayLabel, ProgramArguments: [path.join(home, 'runtime/caddy/old/caddy'), 'run', '--config', path.join(context.runtimeDir, 'Caddyfile'), '--adapter', 'caddyfile'] };
  const files = new Map([backend, gateway].map(record => [record.Label, path.join(context.privateServiceDir, `${record.Label}.plist`)]));
  for (const record of [backend, gateway]) fs.writeFileSync(files.get(record.Label)!, JSON.stringify({ ...record,
    StandardErrorPath: path.join(scratch, 'disk-stderr.log'), EnvironmentVariables: { ...record.EnvironmentVariables, MANDIBLE_LAUNCH_MODE: 'on_demand', PATH: '/disk/tools', NODE_OPTIONS: '--max-old-space-size=900' } }));
  const jobs = new Map<string, { record: ServiceDefinition; pid: number; lastExit?: string }>([backend, gateway].map(record => [record.Label, { record, pid: record === backend ? 41 : 51, lastExit: '(never exited)' }]));
  if (absentGateway) { jobs.delete(gateway.Label); fs.unlinkSync(files.get(gateway.Label)!); }
  if (stoppedBackend) jobs.delete(backend.Label);
  let oldAlive = true;
  let nativeStartingGateway = false;
  const bootouts: string[] = [];
  const spawnSync = vi.fn((binary: string, args: string[]) => {
    const result = (stdout = '', status = 0, stderr = '') => ({ status, stdout, stderr });
    if (binary === '/usr/bin/plutil') return result(fs.readFileSync(args.at(-1)!, 'utf8'));
    if (binary === '/usr/sbin/lsof') return result(`n${backend.StandardErrorPath}\n`);
    if (binary === '/bin/ps') return result(args.includes('comm=') && nativeStartingGateway ? 'xpcproxy'
      : args[1] === '41' ? oldAlive ? 'old-start' : '' : [...jobs.values()].some(job => String(job.pid) === args[1]) ? 'bridge-start' : '');
    if (binary !== '/bin/launchctl') throw new Error(`Unexpected external command ${binary}`);
    const label = args[1].slice(args[1].lastIndexOf('/') + 1);
    if (args[0] === 'print') {
      const job = jobs.get(label);
      if (!job) return result('', 113, 'Could not find service');
      if (nativeStartingGateway && label === gateway.Label) return result(`service = {\n program identifier = Contents/MacOS/mandible-service (mode: 2)\n parent bundle identifier = bio.mll.mandible\n arguments = {\nmandible-service\nforeground\ngateway\n }\n pid = 51\n}`);
      const record = job.record;
      return result(`service = {\n program = ${record.ProgramArguments[0]}\n arguments = {\n${record.ProgramArguments.join('\n')}\n }\n environment = {\n${Object.entries(record.EnvironmentVariables).map(([key, value]) => `${key} => ${value}`).join('\n')}\n }\n working directory = ${record.WorkingDirectory}\n stdout path = ${record.StandardOutPath}\n stderr path = ${record.StandardErrorPath}\n properties = keepalive\n runs = 1\n last exit code = ${job.lastExit ?? '(never exited)'}\n pid = ${job.pid}\n}`);
    }
    if (args[0] === 'bootout') {
      // The migration must be durable before launchd loses its loaded source.
      expect(JSON.parse(fs.readFileSync(path.join(context.runtimeDir, 'service-config.json'), 'utf8'))).toEqual({ environment: { NODE_OPTIONS: '--max-old-space-size=768' }, toolDirectories: ['/loaded/tools'] });
      bootouts.push(label); jobs.delete(label); return result();
    }
    if (args[0] === 'bootstrap') {
      const record = JSON.parse(fs.readFileSync(args[2], 'utf8'));
      jobs.set(record.Label, { record, pid: 61 }); return result();
    }
    if (['enable', 'kickstart'].includes(args[0])) return result();
    throw new Error(`Unexpected launchctl operation ${args[0]}`);
  });
  vi.doMock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawnSync }));
  vi.doMock('../scripts/build-revision.mjs', () => ({ readBuildRevision: () => generation }));
  vi.resetModules();
  const controller = await import('../scripts/local-runtime.mjs');
  const binding = { ...controller.captureRuntimeHandoff(scratch, { context, storageModule: storage }), requestId: 'request', executionId: 'execution', mergeCommit: generation, runtime: { path: '/runtime/bun' } };
  const dir = path.join(context.runtimeDir, 'handoff/request-execution'); fs.mkdirSync(dir, { recursive: true });
  const journal = path.join(dir, 'journal.json');
  fs.writeFileSync(journal, JSON.stringify({ bindingDigest: 'fixture', binding }));
  fs.writeFileSync(path.join(context.runtimeDir, 'handoff-active.json'), JSON.stringify({ bindingDigest: 'fixture', journal }));
  vi.stubEnv('MANDIBLE_RUNTIME_HANDOFF_JOURNAL', journal);
  const drain = () => { oldAlive = false; jobs.set(backend.Label, { record: backend, pid: 42 }); fs.writeFileSync(path.join(dir, 'bridge-process.json'), JSON.stringify({ pid: 42, startedAt: 'bridge-start' })); };
  return { controller, binding, backend, gateway, jobs, files, drain, bootouts, context, makeGatewayStarting: () => { nativeStartingGateway = true; } };
}

it('checks every bound role for absence before inspecting the remaining service ownership', async () => {
  const { controller, binding, backend, jobs, makeGatewayStarting } = await fixture();
  jobs.delete(backend.Label);
  makeGatewayStarting();
  expect(() => controller.inspectHandoffEvidence(binding, { backend: { pid: 41, startedAt: 'old-start', runs: 1 } }))
    .toThrowError(expect.objectContaining({ code: 'process_changed' }));
});

it('qualifies a live owned process despite historical exit status and refuses its later replacement or exit', async () => {
  const { controller, binding, backend, gateway, jobs, files } = await fixture();
  for (const record of [backend, gateway]) fs.writeFileSync(files.get(record.Label)!, JSON.stringify(record));
  fs.writeFileSync(backend.StandardErrorPath, '');
  jobs.get(backend.Label)!.lastExit = '0';
  const evidence = controller.inspectHandoffEvidence(binding);
  expect(evidence.processes.backend).toMatchObject({ pid: 41, startedAt: 'old-start', runs: 1 });
  jobs.set(backend.Label, { record: backend, pid: 42, lastExit: '0' });
  expect(() => controller.inspectHandoffEvidence(binding, evidence.processes)).toThrowError(expect.objectContaining({ code: 'process_changed' }));
  jobs.delete(backend.Label);
  expect(() => controller.inspectHandoffEvidence(binding, evidence.processes)).toThrowError(expect.objectContaining({ code: 'process_changed' }));
});

it('returns strictly qualified process evidence when health remains pending', async () => {
  const { controller, binding, backend, gateway, files } = await fixture();
  for (const record of [backend, gateway]) fs.writeFileSync(files.get(record.Label)!, JSON.stringify(record));
  fs.writeFileSync(backend.StandardErrorPath, '');
  await expect(controller.verifyHandoffDefinitions(binding, { awaitReady: true, until: 0,
    inspect: async () => ({ status: { dashboard_ready: false, state: 'starting' }, main: { backend_generation: binding.mergeCommit },
      backendJob: { loaded: true, pid: 41, runs: 1 }, gatewayJob: { loaded: true, pid: 51, runs: 1 } }),
  })).rejects.toMatchObject({ outcome: 'pending', evidence: { processes: { backend: { pid: 41, startedAt: 'old-start' }, gateway: { pid: 51, startedAt: 'bridge-start' } } } });
});

it('retains the first qualified process observation across readiness', async () => {
  const { controller, binding, backend, gateway, jobs, files } = await fixture();
  for (const record of [backend, gateway]) fs.writeFileSync(files.get(record.Label)!, JSON.stringify(record));
  fs.writeFileSync(backend.StandardErrorPath, '');
  await expect(controller.verifyHandoffDefinitions(binding, { awaitReady: true, until: Date.now() + 1000,
    inspect: async () => {
      jobs.set(backend.Label, { record: backend, pid: 42 });
      return { status: { dashboard_ready: true, state: 'running' }, main: { backend_generation: binding.mergeCommit },
        backendJob: { loaded: true, pid: 42, runs: 1 }, gatewayJob: { loaded: true, pid: 51, runs: 1 },
        backend: { document: {} }, gateway: { document: {} } };
    },
  })).rejects.toMatchObject({ code: 'startup_failed', message: expect.stringContaining('process 41 exited and launchd started 42') });
});

it('captures loaded provenance, publishes bound migration before unload, and reloads gateway drift even when disk bytes already contain the candidate', async () => {
  const fixtureState = await fixture();
  const { controller, binding, backend, gateway, files, drain, bootouts } = fixtureState;
  expect(binding.priorBackend.definition).toEqual(backend);
  expect(binding.priorGateway.definition).toEqual(gateway);
  for (const prior of [binding.priorBackend, binding.priorGateway]) {
    expect(prior.file).toBe(files.get(prior.definition.Label));
    expect(prior.sha256).toBe(createHash('sha256').update(fs.readFileSync(prior.file)).digest('hex'));
    expect(prior.installed[0]).toMatchObject({ file: prior.file, sha256: prior.sha256 });
    expect(JSON.parse(fs.readFileSync(prior.file, 'utf8'))).not.toEqual(prior.definition);
  }
  expect(binding.priorBackend.launchMode).toBe('manual');
  expect(binding.daemonLog).toBe(backend.StandardErrorPath);
  drain();
  await controller.removeHandoffDefinitions(binding);
  expect(bootouts).toEqual([backend.Label]);
  // Treat the on-disk definitions as the already-published candidate. Gateway
  // launchd still holds the captured old environment with identical argv.
  await controller.startHandoffDefinitions(binding);
  expect(bootouts).toEqual([backend.Label, gateway.Label]);
  expect(fixtureState.jobs.get(gateway.Label)?.record).toEqual(JSON.parse(fs.readFileSync(files.get(gateway.Label)!, 'utf8')));
});

it('captures an absent gateway and starts its newly published definition after drain', async () => {
  const { controller, binding, gateway, files, drain, jobs, bootouts } = await fixture({ absentGateway: true });
  expect(binding.priorGateway).toMatchObject({ file: null, sha256: null, installed: [], argv: [], loaded: false, definition: null });
  drain();
  await controller.removeHandoffDefinitions(binding);
  fs.writeFileSync(files.get(gateway.Label)!, JSON.stringify(gateway));
  await controller.startHandoffDefinitions(binding);
  expect(jobs.get(gateway.Label)?.record).toEqual(gateway);
  expect(bootouts).toEqual([binding.backendLabel]);
});

it('refuses capture of a stopped backend with the readiness message', async () => {
  await expect(fixture({ stoppedBackend: true })).rejects.toThrow('The production backend is not running, so its update cannot start yet.');
});

it('preserves a replacement loaded after capture before publishing migration or unloading', async () => {
  const { controller, binding, backend, jobs, drain, bootouts, context } = await fixture();
  drain();
  jobs.set(backend.Label, { pid: 42, record: { ...backend, EnvironmentVariables: { ...backend.EnvironmentVariables, PATH: '/replacement/tools' } } });
  await expect(controller.removeHandoffDefinitions(binding)).rejects.toThrow('changed during handoff');
  expect(bootouts).toEqual([]);
  expect(fs.existsSync(path.join(context.runtimeDir, 'service-config.json'))).toBe(false);
});
