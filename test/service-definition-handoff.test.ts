// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { serviceInstallationContext, type ServiceDefinition } from '../scripts/service-definitions.mjs';
import { PRODUCTION_ORIGIN } from '../scripts/canonical-origin.mjs';

let scratch: string;
afterEach(() => { vi.doUnmock('node:child_process'); vi.doUnmock('../scripts/build-revision.mjs'); vi.unstubAllEnvs(); vi.resetModules(); if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

async function fixture() {
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
  const jobs = new Map([backend, gateway].map(record => [record.Label, { record, pid: record === backend ? 41 : 51 }]));
  let oldAlive = true;
  const bootouts: string[] = [];
  const spawnSync = vi.fn((binary: string, args: string[]) => {
    const result = (stdout = '', status = 0, stderr = '') => ({ status, stdout, stderr });
    if (binary === '/usr/bin/plutil') return result(fs.readFileSync(args.at(-1)!, 'utf8'));
    if (binary === '/bin/ps') return result(args[1] === '41' ? oldAlive ? 'old-start' : '' : [...jobs.values()].some(job => String(job.pid) === args[1]) ? 'bridge-start' : '');
    if (binary !== '/bin/launchctl') throw new Error(`Unexpected external command ${binary}`);
    const label = args[1].slice(args[1].lastIndexOf('/') + 1);
    if (args[0] === 'print') {
      const job = jobs.get(label);
      if (!job) return result('', 113, 'Could not find service');
      const record = job.record;
      return result(`service = {\n program = ${record.ProgramArguments[0]}\n arguments = {\n${record.ProgramArguments.join('\n')}\n }\n environment = {\n${Object.entries(record.EnvironmentVariables).map(([key, value]) => `${key} => ${value}`).join('\n')}\n }\n working directory = ${record.WorkingDirectory}\n stdout path = ${record.StandardOutPath}\n stderr path = ${record.StandardErrorPath}\n properties = keepalive\n pid = ${job.pid}\n}`);
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
  const binding = { ...controller.captureRuntimeHandoff(scratch), requestId: 'request', executionId: 'execution', mergeCommit: generation, runtime: { path: '/runtime/bun' } };
  const dir = path.join(context.runtimeDir, 'handoff/request-execution'); fs.mkdirSync(dir, { recursive: true });
  const journal = path.join(dir, 'journal.json');
  fs.writeFileSync(journal, JSON.stringify({ bindingDigest: 'fixture', binding }));
  fs.writeFileSync(path.join(context.runtimeDir, 'handoff-active.json'), JSON.stringify({ bindingDigest: 'fixture', journal }));
  vi.stubEnv('MANDIBLE_RUNTIME_HANDOFF_JOURNAL', journal);
  const drain = () => { oldAlive = false; jobs.set(backend.Label, { record: backend, pid: 42 }); fs.writeFileSync(path.join(dir, 'bridge-process.json'), JSON.stringify({ pid: 42, startedAt: 'bridge-start' })); };
  return { controller, binding, backend, gateway, jobs, files, drain, bootouts, context };
}

it('captures loaded provenance, publishes bound migration before unload, and reloads gateway drift even when disk bytes already contain the candidate', async () => {
  const fixtureState = await fixture();
  const { controller, binding, backend, gateway, files, drain, bootouts } = fixtureState;
  expect(binding.priorBackend.definition).toEqual(backend);
  expect(binding.priorGateway.definition).toEqual(gateway);
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

it('preserves a replacement loaded after capture before publishing migration or unloading', async () => {
  const { controller, binding, backend, jobs, drain, bootouts, context } = await fixture();
  drain();
  jobs.set(backend.Label, { pid: 42, record: { ...backend, EnvironmentVariables: { ...backend.EnvironmentVariables, PATH: '/replacement/tools' } } });
  await expect(controller.removeHandoffDefinitions(binding)).rejects.toThrow('changed during handoff');
  expect(bootouts).toEqual([]);
  expect(fs.existsSync(path.join(context.runtimeDir, 'service-config.json'))).toBe(false);
});
