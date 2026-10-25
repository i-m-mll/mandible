// @vitest-environment node
import { expect, it } from 'vitest';
import { assessServiceObservation, loadedServiceDefinition, matchingServiceDefinitions, serviceInstallationContext, serviceOwnershipReady, runtimeHandoffReadiness,
  type ServiceDefinition, type InstalledServiceDefinition, type LoadedService } from '../scripts/service-definitions.mjs';

const context = serviceInstallationContext({ home: '/private/fixture/mandible', accountHome: '/private/fixture/account' });
const backend: ServiceDefinition = { Label: context.backendLabel,
  ProgramArguments: ['/runtime/bun', `${context.runtimeDir}/production-runner.mjs`, 'run'],
  EnvironmentVariables: { MANDIBLE_HOME: context.home, MANDIBLE_PRODUCTION_ROOT: '/checkout', PATH: '/loaded/tools:/usr/bin', NODE_OPTIONS: '--max-old-space-size=768' },
  WorkingDirectory: context.runtimeDir, StandardOutPath: '/logs/backend.out', StandardErrorPath: '/logs/backend.err', KeepAlive: true };
const job: LoadedService = { loaded: true, pid: 42, program: backend.ProgramArguments[0], argv: backend.ProgramArguments,
  environment: backend.EnvironmentVariables, workingDirectory: backend.WorkingDirectory,
  stdoutPath: backend.StandardOutPath, stderrPath: backend.StandardErrorPath, keepAlive: true };
const installed = (record: ServiceDefinition, file = '/fixture/service.plist'): InstalledServiceDefinition => ({ file, record, bytesBase64: Buffer.from(JSON.stringify(record)).toString('base64'), sha256: 'fixture-digest' });

it('admits owned drift while retaining separate installed, loaded and desired facts and strict convergence', () => {
  const desired = { ...backend, EnvironmentVariables: { ...backend.EnvironmentVariables, PATH: '/desired/tools:/usr/bin' } };
  const result = assessServiceObservation(context, 'backend', [installed(desired)], job, { desired });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.refusal.message);
  const inspection = { ok: true as const, observations: [result.observation] };
  expect(serviceOwnershipReady(inspection)).toBe(true);
  expect(result.observation.loadedDefinition).toEqual(backend);
  expect(result.observation.installed[0].record).toEqual(desired);
  expect(result.observation.desired).toEqual(desired);
  expect(result.observation.differences[0].fields).toEqual(['EnvironmentVariables']);
  expect(result.observation.desiredDifferences).toEqual(['EnvironmentVariables']);
  expect(matchingServiceDefinitions(inspection)).toMatchObject({ ok: false, refusal: { category: 'definition_mismatch' } });
  const reconciled = assessServiceObservation(context, 'backend', [installed(backend)], job);
  if (!reconciled.ok) throw new Error(reconciled.refusal.message);
  expect(matchingServiceDefinitions({ ok: true, observations: [reconciled.observation] }).ok).toBe(true);
});

it('admits a missing gateway but requires a running backend before publication or capture', () => {
  const gateway = assessServiceObservation(context, 'gateway', [], { loaded: false, pid: null });
  if (!gateway.ok) throw new Error(gateway.refusal.message);
  for (const backendJob of [job, { loaded: false, pid: null }, { ...job, pid: null }]) {
    const result = assessServiceObservation(context, 'backend', [], backendJob);
    if (!result.ok) throw new Error(result.refusal.message);
    const readiness = runtimeHandoffReadiness({ ok: true, observations: [result.observation, gateway.observation] });
    if (backendJob.loaded && backendJob.pid) expect(readiness.ok).toBe(true);
    else expect(readiness).toMatchObject({ ok: false, refusal: { service: 'backend', message: 'The production backend is not running, so its update cannot start yet.' } });
  }
});

it('admits owned duplicates and missing generated plists, but requires one installed file for convergence', () => {
  for (const files of [[], [installed(backend), installed(backend, '/fixture/duplicate.plist')]]) {
    const result = assessServiceObservation(context, 'backend', files, job);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.refusal.message);
    expect(matchingServiceDefinitions({ ok: true, observations: [result.observation] }).ok).toBe(false);
  }
  expect(assessServiceObservation(context, 'backend', [installed(backend)], { loaded: false, pid: null }).ok).toBe(true);
  const absent = assessServiceObservation(context, 'backend', [], { loaded: false, pid: null });
  expect(absent.ok).toBe(true);
  if (!absent.ok) throw new Error(absent.refusal.message);
  const inspection = { ok: true as const, observations: [absent.observation] };
  expect(serviceOwnershipReady(inspection)).toBe(true);
  expect(matchingServiceDefinitions(inspection)).toMatchObject({ ok: false, refusal: { category: 'missing_definition' } });
});

it('refuses foreign executables, installation identities, and incomplete loaded evidence despite a matching label or comment', () => {
  const marked = { ...backend, Comment: 'Mandible runtime agent mandible-launch-agent@1' };
  const foreignGateway = { ...marked, Label: context.gatewayLabel, ProgramArguments: ['/bin/sleep', '600'] };
  expect(assessServiceObservation(context, 'gateway', [installed(foreignGateway)], { loaded: false, pid: null })).toMatchObject({ ok: false, refusal: { category: 'ownership_conflict' } });
  expect(assessServiceObservation(context, 'backend', [installed({ ...marked, Program: '/bin/sleep' })], job)).toMatchObject({ ok: false, refusal: { category: 'ownership_conflict' } });
  for (const foreign of [
    { ...job, argv: ['/bin/sleep', backend.ProgramArguments[1], 'run'], program: '/bin/sleep' },
    { ...job, environment: { ...job.environment, MANDIBLE_HOME: '/another/installation' } },
  ]) expect(assessServiceObservation(context, 'backend', [installed(marked)], foreign)).toMatchObject({ ok: false, refusal: { category: 'ownership_conflict' } });
  expect(assessServiceObservation(context, 'backend', [installed(marked)], { ...job, stderrPath: undefined })).toMatchObject({ ok: false, refusal: { category: 'unreadable_state' } });
});

it('recognises the exact managed Caddy configuration and legacy interpreter contract', () => {
  const gateway = { ...backend, Label: context.gatewayLabel, ProgramArguments: [`${context.home}/runtime/caddy/old/caddy`, 'run', '--config', `${context.runtimeDir}/Caddyfile`, '--adapter', 'caddyfile'] };
  expect(assessServiceObservation(context, 'gateway', [installed(gateway)], { loaded: false, pid: null }).ok).toBe(true);
  const legacy = { ...gateway, ProgramArguments: ['/runtime/node', '/checkout/scripts/local-front-door.mjs', 'serve'],
    EnvironmentVariables: { ...backend.EnvironmentVariables, MANDIBLE_RUNTIME_SUPERVISED: '1' } };
  expect(assessServiceObservation(context, 'gateway', [installed(legacy)], { loaded: false, pid: null }).ok).toBe(true);
  expect(loadedServiceDefinition(context.backendLabel, job)).toEqual(backend);
});
