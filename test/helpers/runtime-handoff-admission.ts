import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, expect } from 'vitest';
import { bindingDigest, handoffDirectory } from '../../scripts/runtime-handoff.mjs';
import { inspectLifecycleLock } from '../../scripts/lifecycle-lock.mjs';
import { waitUntil } from './wait-until.js';

const runtime = execFileSync('/bin/sh', ['scripts/bun-runtime.sh'], { encoding: 'utf8', timeout: 5000 }).trim();
const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 'fixture process exit');
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
export function launch(mode: string, file: string, predecessorReader?: string) {
  const child = spawn(runtime, ['test/helpers/runtime-handoff-admission-process.mjs', mode, file], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MANDIBLE_TEST_V1_READER: predecessorReader },
  });
  children.push(child);
  const events: Array<Record<string, any>> = [];
  let pending = '', stderr = '';
  child.stdout!.on('data', chunk => { pending += chunk; for (;;) { const i = pending.indexOf('\n'); if (i < 0) break; events.push(JSON.parse(pending.slice(0, i))); pending = pending.slice(i + 1); } });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  return { child, events, send: (message: string) => child.stdin!.write(message + '\n'),
    event: (name: string) => waitUntil(() => {
      const found = events.find(event => event.event === name);
      if (found) return found;
      const error = events.find(event => event.event === 'error');
      if (error) throw new Error(JSON.stringify(error));
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture ${mode} stopped: ${stderr}`);
      return null;
    }, `${mode} ${name}`) };
}
export async function fixture(protocol = 2, predecessorReader?: string) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-admission-'))); roots.push(home);
  const binding = { home, requestId: 'request-fixture', executionId: 'execution-fixture', nativeApp: path.join(home, 'Mandible.app'),
    acceptedRelease: { reference: 'fixture' }, bundleOwner: { bundleRoot: path.join(home, 'Mandible.app') },
    priorBackend: { definition: { BundleProgram: 'Contents/MacOS/mandible-service' } }, runtime: { path: runtime },
    predecessorHandoffProtocol: protocol,
    updater: { helper: path.resolve('test/helpers/runtime-handoff-admission-process.mjs') }, domain: `gui/${process.getuid!()}` };
  const dir = handoffDirectory(home, binding.requestId, binding.executionId); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'journal.json');
  const predecessor = launch(protocol === 1 ? 'predecessor-v1' : 'predecessor', file, predecessorReader);
  const oldProcess = await predecessor.event('ready');
  const fullBinding = { ...binding, oldProcess: { pid: oldProcess.pid, startedAt: oldProcess.startedAt } };
  const journal = { schema: 'mandible-runtime-handoff@1', binding: fullBinding, bindingDigest: bindingDigest(fullBinding), phase: 'preparing',
    deadline: Date.now() + 30_000, environment: {}, helperLabel: 'bio.mll.mandible.fixture.admission',
    helperPlist: path.join(home, 'config/local-sessions/launch-agents/bio.mll.mandible.fixture.admission.plist') };
  fs.writeFileSync(file, JSON.stringify(journal));
  return { home, file, dir, journal, predecessor, read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    active: path.join(home, 'config/local-sessions/handoff-active.json') };
}

export async function admissionScenario(protocol: number, predecessorReader?: string) {
  const f = await fixture(protocol, predecessorReader);
  const interrupted = launch('producer', f.file); await interrupted.event('bootstrap');
  const armed = f.read();
  expect(armed.bridgeInstalled).toBe(true); expect(armed.acknowledgedAt).toBeNull();
  interrupted.send('crash');
  await waitUntil(() => interrupted.child.exitCode === 17, 'producer interruption');
  await waitUntil(async () => (await inspectLifecycleLock(path.join(f.home, 'config/local-sessions/gateway'))).state === 'stale', 'interrupted producer guard release');
  const producer = launch('producer', f.file); await producer.event('bootstrap');
  expect(f.read().attempt.id).toBe(armed.attempt.id); expect(f.read().attempt.deadline).toBe(armed.attempt.deadline);
  const worker = launch('worker', f.file); await worker.event('contended');
  producer.send('continue'); await producer.event('waiting'); await worker.event('preparing');
  const baseline = fs.readFileSync(f.file, 'utf8');
  f.predecessor.send('check'); expect((await f.predecessor.event('drain')).identity).toBeNull();
  expect(fs.readFileSync(f.file, 'utf8')).toBe(baseline);
  const gateway = JSON.parse(fs.readFileSync(path.join(f.home, 'config/local-sessions/.gateway.lock/owner.json'), 'utf8'));
  expect(gateway.pid).toBe(worker.child.pid);
  worker.send('continue'); await worker.event('draining'); await producer.event('done');
  f.predecessor.events.length = 0; f.predecessor.send('check');
  expect((await f.predecessor.event('drain')).identity).toContain(armed.attempt.id);
  f.predecessor.send('exit'); await worker.event('done');
  expect(fs.existsSync(path.join(f.dir, '.verification.lock'))).toBe(false);
  expect(f.read().attempt.state).toBe('complete');
  const closer = launch('close', f.file); expect(await closer.event('closed')).toMatchObject({ outcome: 'released' });
  expect(fs.existsSync(f.active)).toBe(false);
  const replay = launch('producer', f.file); await replay.event('done');
  expect(replay.events.some(event => event.event === 'bootstrap')).toBe(false);
  expect(fs.existsSync(f.active)).toBe(false);
}
