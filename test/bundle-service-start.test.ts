import { expect, it } from 'vitest';
import { reconcileBundleServiceStart } from '../scripts/bundle-service-start.mjs';
import { assessServiceObservation, serviceInstallationContext } from '../scripts/service-definitions.mjs';

const context = serviceInstallationContext({ home: '/fixture/state', accountHome: '/fixture/account', bundleRoot: '/fixture/Mandible.app', bundleIdentifier: 'bio.mll.mandible' });
const argv = ['mandible-service', 'foreground', 'backend'];
const program = `${context.bundleRoot}/Contents/MacOS/mandible-service`;
const process = () => ({ pid: 42, startedAt: 'owned-start', runs: 1 });
function inspection(loaded = false, pid: number | null = null, executable = program, arguments_ = argv, run = { runs: 0, lastExit: null as string | null }) {
  const record = { Label: context.backendLabel, BundleProgram: 'Contents/MacOS/mandible-service', bundleRoot: context.bundleRoot,
    ProgramArguments: argv, EnvironmentVariables: {}, WorkingDirectory: context.runtimeDir, StandardOutPath: '/fixture/out', StandardErrorPath: '/fixture/err', KeepAlive: false };
  const result = assessServiceObservation(context, 'backend', [{ file: '/fixture/backend.plist', bytesBase64: '', sha256: '', record }], {
    ...run, loaded, pid, argv: arguments_, program: loaded ? executable : undefined, parentBundleIdentifier: 'bio.mll.mandible', bundleProgram: record.BundleProgram,
  });
  return result.ok ? { ok: true as const, observations: [result.observation] } : result;
}
function clock() {
  let time = 0;
  return { now: () => time, wait: async (ms: number) => { time += ms; }, tick: () => Math.floor(time / 1000) };
}

it('reconciles the measured enabled/missing → not-found/missing → enabled/owned sequence without kickstarting absence', async () => {
  const time = clock(); const actions: string[] = [];
  const result = await reconcileBundleServiceStart(context, 'backend', { ...time, until: 3000, readProcess: process,
    control: (_context, operation, role) => {
      if (operation === 'register') actions.push(`register:${time.now()}`);
      return { service: role, label: context.backendLabel, status: operation === 'register' || time.tick() === 2 ? 'enabled' : time.tick() === 1 ? 'not_found' : 'enabled', registration_changed: operation === 'register' };
    },
    observe: () => inspection(time.tick() === 2, time.tick() === 2 ? 42 : null),
    start: () => { actions.push('kickstart'); return { operation: 'kickstart', outcome: 'acknowledged', code: null, status: 0, signal: null, message: null }; },
  });
  expect(result.ok).toBe(true); expect(actions).toEqual(['register:1000']); expect(time.now()).toBe(2000);
});

it.each([
  { states: ['enabled'], registrations: 0 },
  { states: ['not_found'], registrations: 1 },
  { states: ['not_found', 'not_found', 'not_registered', 'not_registered', 'not_found'], registrations: 3 },
] as const)('bounds inconsistent native/job state and registers only per transition: $states', async ({ states, registrations }) => {
  const time = clock(); const actions: string[] = [];
  const result = await reconcileBundleServiceStart(context, 'backend', { ...time, until: 4500, readProcess: process,
    control: (_context, operation, role) => {
      if (operation === 'register') actions.push(operation);
      return { service: role, label: context.backendLabel, status: states[Math.min(time.tick(), states.length - 1)], registration_changed: false };
    }, observe: () => inspection(), start: () => { throw new Error('Cannot kickstart an absent job'); },
  });
  expect(actions).toHaveLength(registrations); expect(time.now()).toBe(4500);
  expect(result).toMatchObject({ ok: false, error: { code: 'registration_inconsistent', outcome: 'pending', evidence: {
    until: 4500, observations: expect.arrayContaining([expect.objectContaining({ native: expect.objectContaining({ status: states[0] }), job: expect.objectContaining({ loaded: false, pid: null }) })]),
  } } });
});

it.each(['permission', 'foreign', 'mismatched', 'permission-foreign', 'permission-mismatched'] as const)('refuses %s evidence without registration or start', async kind => {
  const time = clock();
  const result = await reconcileBundleServiceStart(context, 'backend', { ...time, until: 3000, readProcess: process,
    control: (_context, operation, role) => {
      expect(operation).toBe('status');
      return { service: role, label: context.backendLabel, status: kind.startsWith('permission') ? 'requires_approval' : 'enabled', registration_changed: false };
    }, observe: () => kind.endsWith('foreign') ? inspection(true, 42, '/foreign/Mandible.app/Contents/MacOS/mandible-service')
      : kind.endsWith('mismatched') ? inspection(true, 42, program, ['mandible-service', 'foreground', 'gateway']) : inspection(),
    start: () => { throw new Error('Refused state cannot start'); },
  });
  expect(result).toMatchObject({ ok: false, error: { code: kind === 'permission' ? 'background_permission_required' : 'ownership_conflict' } });
  expect(time.now()).toBe(0);
});

it('does not admit a job whose observation finishes after the original deadline', async () => {
  let time = 0;
  const result = await reconcileBundleServiceStart(context, 'backend', { until: 5, now: () => time, readProcess: process,
    control: (_context, operation, role) => { expect(operation).toBe('status'); time = 6; return { service: role, label: context.backendLabel, status: 'enabled', registration_changed: false }; },
    observe: () => inspection(true, 42), start: () => { throw new Error('No action after deadline'); },
    wait: async () => { throw new Error('No wait after deadline'); },
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'registration_inconsistent', outcome: 'pending' } });
});

it.each(['acknowledged', 'indeterminate'] as const)('qualifies a dormant clean run after one %s demand, never from its ACK', async outcome => {
  const time = clock(); let starts = 0, statuses = 0;
  const result = await reconcileBundleServiceStart(context, 'backend', { ...time, until: 3000, readProcess: process,
    control: (_context, operation, role) => { statuses++; expect(operation).toBe('status'); return { service: role, label: context.backendLabel, status: 'enabled', registration_changed: false }; },
    observe: () => inspection(true, time.tick() >= 2 ? 42 : null, program, argv, { runs: 1, lastExit: '0' }),
    start: () => { starts++; return { operation: 'kickstart', outcome, code: outcome === 'indeterminate' ? 'ETIMEDOUT' : null, status: outcome === 'indeterminate' ? null : 0, signal: null, message: null }; },
  });
  expect(result).toMatchObject({ ok: true, processes: { backend: process() } });
  expect(starts).toBe(1); expect(statuses).toBe(1); expect(time.now()).toBe(2000);
});

it.each(['78', '0'])('waits for RunAtLoad and reports its completed exit %s without kickstart', async exit => {
  const time = clock(); const actions: string[] = [];
  const result = await reconcileBundleServiceStart(context, 'backend', { ...time, until: 3000, readProcess: process,
    control: (_context, operation, role) => { actions.push(operation); return { service: role, label: context.backendLabel, status: operation === 'register' ? 'enabled' : 'not_registered', registration_changed: operation === 'register' }; },
    observe: () => inspection(time.tick() > 0, null, program, argv, { runs: time.tick() >= 2 ? 1 : 0, lastExit: time.tick() >= 2 ? exit : null }),
    start: () => { throw new Error('RunAtLoad must not be kickstarted'); },
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'service_exited', outcome: 'failed' } });
  expect(actions).toEqual(['status', 'register']); expect(time.now()).toBe(2000);
});

it('leaves an acknowledged dormant start pending at the original deadline without a repeated demand', async () => {
  const time = clock(); let starts = 0;
  const result = await reconcileBundleServiceStart(context, 'backend', { ...time, until: 1500, readProcess: process,
    control: (_context, _operation, role) => ({ service: role, label: context.backendLabel, status: 'enabled', registration_changed: false }),
    observe: () => inspection(true, null, program, argv, { runs: 1, lastExit: '0' }),
    start: () => { starts++; return { operation: 'kickstart', outcome: 'acknowledged', code: null, status: 0, signal: null, message: null }; },
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'registration_inconsistent', outcome: 'pending' } });
  expect(starts).toBe(1); expect(time.now()).toBe(1500);
});

it('keeps unqualified launcher changes diagnostic, then carries only strict qualified identity', async () => {
  const time = clock(); const processes = {};
  const result = await reconcileBundleServiceStart(context, 'backend', { ...time, until: 3000, processes, readProcess: process,
    control: (_context, _operation, role) => ({ service: role, label: context.backendLabel, status: 'enabled', registration_changed: false }),
    observe: () => time.tick() < 2 ? { ok: false, refusal: { service: 'backend', label: context.backendLabel, category: 'starting', fields: [], message: 'Launching',
      evidence: { service: 'backend', label: context.backendLabel, executable: 'xpcproxy', pid: 10 + time.tick(), startedAt: 'unqualified', runs: 1, bundleProgram: 'Contents/MacOS/mandible-service', parentBundleIdentifier: 'bio.mll.mandible' } } } : inspection(true, 42),
  });
  expect(result).toMatchObject({ ok: true, processes: { backend: { pid: 42, startedAt: 'owned-start', runs: 1 } } });
  expect(processes).toEqual({ backend: process() });
});

it.each(['replacement', 'disappearance', 'runs'] as const)('does not hide qualified %s while another role is pending', async change => {
  const time = clock();
  const result = await reconcileBundleServiceStart(context, 'gateway', { ...time, until: 3000, processes: { backend: process() },
    readProcess: () => change === 'disappearance' ? null : { ...process(), ...(change === 'replacement' ? { pid: 43 } : { runs: 2 }) },
    control: () => { throw new Error('Continuity refusal must precede registration'); },
    observe: () => { throw new Error('Sibling pending must not mask continuity'); },
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'process_changed', evidence: { processes: { backend: { pid: 42 } } } } });
});

it('retains qualified identities in a pending result and never resets the original budget', async () => {
  const time = clock();
  const result = await reconcileBundleServiceStart(context, 'gateway', { ...time, until: 2500, processes: { backend: process() }, readProcess: process,
    control: (_context, operation) => { expect(operation).toBe('status'); return { service: 'gateway', label: context.gatewayLabel, status: 'enabled', registration_changed: false }; },
    observe: () => ({ ok: false, refusal: { service: 'gateway', label: context.gatewayLabel, category: 'starting', fields: [], message: 'Launching' } }),
  });
  expect(result).toMatchObject({ ok: false, error: { outcome: 'pending', evidence: { until: 2500, processes: { backend: { pid: 42 } } } } });
  expect(time.now()).toBe(2500);
});
