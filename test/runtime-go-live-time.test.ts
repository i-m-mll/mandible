// @vitest-environment node
// The go-live time rule: a clock decides when to look again, never an outcome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { COMMITTED_OBSERVATION_WINDOW_MS, bindingDigest, handoffDirectory, runRuntimeHandoffWorker, workerRunsAgain } from '../scripts/runtime-handoff.mjs';
import { runRuntimeCommand, withRuntimeCommands } from '../scripts/runtime-observation.mjs';
import { validateGatewayConfiguration } from '../scripts/local-front-door.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/**
 * A host where named fixture commands take `durations[binary]()` milliseconds of
 * an injected clock; a command whose duration exceeds its timeout is killed, as
 * spawnSync reports it. Everything else, such as lock identity reads, runs for real.
 */
function slowHost(durations: Record<string, () => number>, alive: Record<number, () => string | null> = {}) {
  const clock = { now: Date.now() };
  const calls: Array<{ binary: string; timeout: number }> = [];
  const spawn = (binary: string, args: string[], options: Record<string, unknown> & { timeout: number }) => {
    if (binary === '/bin/ps' && args[0] === '-p' && alive[Number(args[1])]) {
      const started = alive[Number(args[1])]();
      return started ? { status: 0, stdout: `${started}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    const duration = durations[binary];
    if (!duration) return spawnSync(binary, args, options) as never;
    const ms = duration();
    calls.push({ binary, timeout: options.timeout });
    clock.now += Math.min(ms, options.timeout);
    if (ms > options.timeout) return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error(`spawnSync ${binary} ETIMEDOUT`), { code: 'ETIMEDOUT' }) };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { clock, calls, run: <T>(operation: () => T) => withRuntimeCommands({ spawn, now: () => clock.now }, operation) };
}

function fixture(oldProcess = { pid: 999_999, startedAt: 'gone' }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-go-live-'))); roots.push(home);
  const binding = { home, requestId: 'request-fixture', executionId: 'execution-fixture', root: path.join(home, 'checkout'),
    runtime: { path: '/retained/bun', sha256: 'fixture' }, acceptedRelease: { reference: 'accepted-fixture' },
    nativeApp: path.join(home, 'Mandible.app'), oldProcess, desktopWasRunning: false };
  const dir = handoffDirectory(home, binding.requestId, binding.executionId); fs.mkdirSync(dir, { recursive: true });
  const journal = { schema: 'mandible-runtime-handoff@1', binding, bindingDigest: bindingDigest(binding), phase: 'failed', deadline: 1, bridgeInstalled: true };
  const file = path.join(dir, 'journal.json'); fs.writeFileSync(file, JSON.stringify(journal));
  fs.writeFileSync(path.join(home, 'config/local-sessions/handoff-active.json'), JSON.stringify({ journal: file, bindingDigest: journal.bindingDigest }));
  return { file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const services = { backend: { pid: 42, startedAt: 'backend', runs: 1 }, gateway: { pid: 43, startedAt: 'gateway', runs: 1 } };
function delivery(effects: string[]) {
  const installed = () => effects.includes('replace');
  return {
    verifyPublication: async () => {}, validateGateway: async () => null, validateDaemon: async () => null, desktop: async () => {},
    prepare: async () => { effects.push('prepare'); runRuntimeCommand('/fixture/ditto', []); return { installed: installed(), packageSha256: 'exact' }; },
    install: async () => { effects.push('replace'); return { packageSha256: 'exact' }; },
    control: async (_journal: unknown, command: string) => {
      effects.push(command);
      if (command === 'handoff-start') runRuntimeCommand('/fixture/launchctl', ['bootstrap']);
      return JSON.stringify({ processes: services });
    },
    observe: async (journal: { bindingDigest: string }) => ({ schema: 'mandible-runtime-receipt@2', bindingDigest: journal.bindingDigest, services }),
  };
}

it('keeps a committed attempt running while its services step outlasts each budget, and completes it under the same actor', async () => {
  const f = fixture();
  let slowRuns = 2;
  const host = slowHost({ '/fixture/ditto': () => 1000, '/fixture/launchctl': () => (slowRuns-- > 0 ? 10 * 60_000 : 2000) });
  const effects: string[] = [];
  const actor = { provider: 'fixture' };
  const first = await host.run(() => runRuntimeHandoffWorker(f.file, { ...delivery(effects), actor }));
  expect(first.attempt).toMatchObject({ state: 'running', lastObservation: { code: 'command_unanswered' } });
  const { id, deadline } = first.attempt;
  // launchd runs the helper again with only its journal, well past the pre-drain deadline.
  host.clock.now = deadline + 60_000;
  const second = await host.run(() => runRuntimeHandoffWorker(f.file, delivery(effects)));
  expect(second.attempt).toMatchObject({ id, state: 'running', lastObservation: { code: 'command_unanswered' } });
  const third = await host.run(() => runRuntimeHandoffWorker(f.file, delivery(effects)));
  expect(third).toMatchObject({ phase: 'complete', attempt: { id, actor, state: 'complete', receipt: { attemptId: id, services } } });
  expect(effects.filter(effect => effect === 'handoff-remove')).toHaveLength(1);
  expect(host.calls.filter(call => call.binary === '/fixture/launchctl')).toHaveLength(3);
  expect(fs.existsSync(path.join(path.dirname(f.file), 'attempts'))).toBe(false);
});

it('aborts an attempt whose preparation outlasts its pre-drain budget without draining the serving daemon', async () => {
  const old = { pid: 424_242, startedAt: 'Wed Nov 18 09:00:00 2026' };
  const f = fixture(old);
  const host = slowHost({ '/fixture/ditto': () => 31 * 60_000 }, { [old.pid]: () => old.startedAt });
  const effects: string[] = [];
  const result = await host.run(() => runRuntimeHandoffWorker(f.file, { ...delivery(effects), actor: { provider: 'fixture' } }));
  expect(result).toMatchObject({ phase: 'failed', drainReady: null, attempt: { state: 'failed', lastObservation: { code: 'command_unanswered' } } });
  expect(result.attempt.effects.drain).toBeUndefined();
  expect(effects).toEqual(['prepare']);
  expect(host.calls).toEqual([{ binary: '/fixture/ditto', timeout: result.attempt.deadline - result.attempt.enteredAt }]);
});

const old = { pid: 424_242, startedAt: 'Wed Nov 18 09:00:00 2026' };
/** Each wait of the drain loop passes ten minutes, so the 30-minute budget ends after a few looks. */
const drainWait = (host: ReturnType<typeof slowHost>) => async () => { host.clock.now += 10 * 60_000; };

it('commits an attempt whose daemon exits as the drain wait reaches its deadline', async () => {
  const f = fixture(old);
  let deadline = Infinity;
  const host = slowHost({ '/fixture/ditto': () => 1000, '/fixture/launchctl': () => 1000 }, { [old.pid]: () => (host.clock.now < deadline ? old.startedAt : null) });
  const effects: string[] = [];
  const prepare = delivery(effects).prepare;
  const result = await host.run(() => runRuntimeHandoffWorker(f.file, { ...delivery(effects), actor: { provider: 'fixture' }, wait: drainWait(host),
    prepare: async () => { deadline = f.read().attempt.deadline; return prepare(); } }));
  expect(result.attempt).toMatchObject({ state: 'running', effects: { drain: { exitedAt: expect.any(Number) } } });
  const rerun = await host.run(() => runRuntimeHandoffWorker(f.file, delivery(effects)));
  expect(rerun).toMatchObject({ phase: 'complete', attempt: { id: result.attempt.id, state: 'complete' } });
  expect(effects).toContain('handoff-remove');
});

it('settles a drain-wait failure by whether the old daemon is still serving when the helper runs again', async () => {
  for (const exits of [true, false]) {
    const f = fixture(old);
    let serving = true;
    const host = slowHost({ '/fixture/ditto': () => 1000, '/fixture/launchctl': () => 1000 }, { [old.pid]: () => (serving ? old.startedAt : null) });
    const effects: string[] = [];
    const first = await host.run(() => runRuntimeHandoffWorker(f.file, { ...delivery(effects), actor: { provider: 'fixture' }, wait: drainWait(host) }));
    expect(first.attempt.state).toBe('failed');
    expect(workerRunsAgain(first)).toBe(true);
    serving = !exits;
    const second = await host.run(() => runRuntimeHandoffWorker(f.file, delivery(effects)));
    expect(second.attempt.id).toBe(first.attempt.id);
    if (exits) {
      expect(second).toMatchObject({ phase: 'complete', attempt: { state: 'complete', receipt: { attemptId: first.attempt.id } } });
      expect(effects).toContain('handoff-remove');
    } else {
      expect(second.attempt.state).toBe('failed');
      expect(workerRunsAgain(second)).toBe(false);
      expect(effects).toEqual(['prepare']);
    }
  }
});

it('gives each consecutive pending run of a committed attempt a longer window', async () => {
  const f = fixture();
  const host = slowHost({ '/fixture/ditto': () => 1000, '/fixture/launchctl': () => 1.5 * COMMITTED_OBSERVATION_WINDOW_MS });
  const effects: string[] = [];
  const first = await host.run(() => runRuntimeHandoffWorker(f.file, { ...delivery(effects), actor: { provider: 'fixture' } }));
  expect(first.attempt).toMatchObject({ state: 'running', lastObservation: { code: 'command_unanswered' } });
  const second = await host.run(() => runRuntimeHandoffWorker(f.file, delivery(effects)));
  expect(second).toMatchObject({ phase: 'complete', attempt: { id: first.attempt.id, state: 'complete' } });
});

it('reports Caddy\'s own diagnostic for an invalid configuration and an unanswered validation as pending', () => {
  const diagnostic = 'Error: adapting config using caddyfile: Caddyfile:3: unrecognized directive: bogus';
  const caddy = (status: number | null) => withRuntimeCommands({ spawn: (_binary, args, options) => {
    expect(args).toEqual(['adapt', '--config', '-', '--adapter', 'caddyfile']);
    expect(options.input).toBe('config');
    return status === null ? { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
      : { status, stdout: '{}', stderr: status ? `${diagnostic}\n` : '' };
  } }, () => validateGatewayConfiguration('/staged/mandible-caddy', 'config'));
  expect(() => caddy(1)).toThrow(expect.objectContaining({ outcome: 'failed', message: `Local HTTPS configuration is invalid: ${diagnostic}` }));
  expect(() => caddy(null)).toThrow(expect.objectContaining({ outcome: 'pending', code: 'command_unanswered' }));
  expect(caddy(0)).toMatch(/^[a-f0-9]{64}$/);
});
