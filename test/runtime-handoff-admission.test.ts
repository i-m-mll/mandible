// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { admitRuntimeHandoff, bindingDigest, withRuntimeObservation } from '../scripts/runtime-handoff.mjs';
import { fixture, launch, admissionScenario } from './helpers/runtime-handoff-admission.js';

it('serializes single-lease admission, resumes pre-bootstrap publication, and refuses fenced resurrection', () => admissionScenario(2));

it.each(['preparation', 'owner'] as const)('refuses drain after %s failure and does not publish an unowned recovery write', async fault => {
  const f = await fixture(); const producer = launch('producer', f.file); await producer.event('bootstrap');
  producer.send('continue'); await producer.event('waiting');
  const worker = launch('worker', f.file); await worker.event('preparing');
  if (fault === 'preparation') {
    worker.send('fail'); await worker.event('done');
    expect(f.read()).toMatchObject({ phase: 'failed', acknowledgedAt: null, attempt: { state: 'failed' } });
  } else {
    worker.send('continue'); await worker.event('draining'); await producer.event('done');
    const owner = JSON.parse(fs.readFileSync(path.join(f.home, 'config/local-sessions/.gateway.lock/owner.json'), 'utf8'));
    const ownedState = fs.readFileSync(f.file, 'utf8');
    process.kill(owner.guardPid, 'SIGKILL');
    expect(await worker.event('error')).toMatchObject({ code: 'observer_lost' });
    expect(fs.readFileSync(f.file, 'utf8')).toBe(ownedState);
  }
  f.predecessor.send('check'); expect((await f.predecessor.event('drain')).identity).toBeNull();
  expect(worker.events.some(event => event.event === 'effect')).toBe(false);
});

it('rejects another journal scope and an uncoordinated write inside the current epoch', async () => {
  const f = await fixture();
  await withRuntimeObservation(f.journal, async () => {
    const other = { ...f.journal, binding: { ...f.journal.binding, executionId: 'another-execution' } };
    await expect(withRuntimeObservation(other, async () => {})).rejects.toMatchObject({ code: 'observer_lost' });
    fs.writeFileSync(f.file, JSON.stringify({ ...f.read(), foreignWrite: true }));
    const active = { journal: f.file, bindingDigest: f.journal.bindingDigest };
    fs.writeFileSync(f.active, JSON.stringify(active));
    const changed = fs.readFileSync(f.file, 'utf8');
    await expect(admitRuntimeHandoff(f.read(), { verifyPublication: async () => {} })).rejects.toMatchObject({ code: 'observer_busy' });
    expect(fs.readFileSync(f.file, 'utf8')).toBe(changed);
  });
});

it('refuses a fresh source-runner admission before publication or package effects', async () => {
  const f = await fixture();
  const binding = { ...f.journal.binding, bundleOwner: null, priorBackend: { definition: { ProgramArguments: ['/legacy/runner'] } } };
  const journal = { ...f.journal, binding, bindingDigest: bindingDigest(binding) };
  fs.writeFileSync(f.file, JSON.stringify(journal));
  let effects = 0;
  await expect(admitRuntimeHandoff(journal, { verifyPublication: async () => { effects++; }, prepare: async () => { effects++; }, bootstrap: async () => { effects++; } })).rejects.toThrow('currently owned native application');
  expect(effects).toBe(0);
  expect(fs.existsSync(f.active)).toBe(false);
  expect(f.read()).toEqual(journal);
});
