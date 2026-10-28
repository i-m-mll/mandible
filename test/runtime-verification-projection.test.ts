// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { addAttributionEvidence } from '../src/users/store.js';
import { AuthHookManager } from '../src/auth-hooks.js';
import { AuthQueue } from '../src/auth-queue.js';
import { authHistory } from '../src/ledger-reads/auth-history.js';
import { runtimeHandoffBindingDigest } from '../scripts/runtime-handoff-lock.mjs';
import { createMigratedDb } from './helpers/auth-queue-fixtures.js';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';
import type { SseEvent } from '../src/types.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fixture() {
  const home = fs.mkdtempSync(path.join(testRuntimeRoot, 'verification-projection-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  vi.stubEnv('MANDIBLE_HOME', home);
  const db = createMigratedDb(); cleanups.push(() => db.close());
  const requestId = 'projection-request'; const executionId = 'projection-execution';
  db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, exit_code, repo, created_at, updated_at, expires_at)
    VALUES (?, 'merge', 'mandible auth merge feature/x --into main', 'Self update', 'completed', 0, 'mandible', 1, 1, 9999999999999)`).run(requestId);
  const identity = { home, requestId, executionId, hookId: 'builtin-mandible-rebuild', commandDigest: 'c'.repeat(64) };
  const publication = { schema: 'mandible-runtime-publication@1', ...identity };
  const publicationDigest = createHash('sha256').update(JSON.stringify(publication)).digest('hex');
  const evidence = addAttributionEvidence(db, { evidence_method: 'credential_signature', details: { runtime_publication: publication, runtime_publication_digest: publicationDigest } });
  const binding = { ...identity, publicationEvidence: { evidenceId: evidence.id, digest: publicationDigest } };
  const digest = runtimeHandoffBindingDigest(binding);
  db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, state, attempts, exit_code, output, created_at, updated_at)
    VALUES (?, ?, ?, 'rebuild', ?, 'pending', 1, 75, ?, 1, 1)`).run(executionId, requestId, binding.hookId, binding.commandDigest, `MANDIBLE_RUNTIME_HANDOFF_PENDING:${digest}`);
  const dir = path.join(home, 'config/local-sessions/handoff', `${requestId}-${executionId}`); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'journal.json');
  const journal = { schema: 'mandible-runtime-handoff@1', binding, bindingDigest: digest, phase: 'verification-pending',
    attempts: 1, updatedAt: 1, lastObservation: { outcome: 'pending', code: 'desktop_unconfirmed', reason: 'Quit and reopen the installed Mandible app; verification will resume.', observedAt: 1 } };
  const write = () => fs.writeFileSync(file, JSON.stringify(journal)); write();
  const active = path.join(home, 'config/local-sessions/handoff-active.json');
  fs.writeFileSync(active, JSON.stringify({ journal: file, bindingDigest: digest }));
  const hooks = new AuthHookManager(db);
  const events: SseEvent[] = [];
  const queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, broadcast: event => { events.push(event); },
    executor: async () => { throw new Error('Read projection cannot execute a command.'); } });
  cleanups.push(() => queue.dispose());
  vi.spyOn(hooks, 'reconcileRuntimeHandoffs').mockResolvedValue([]);
  const refresh = () => (queue as unknown as { reconcileRuntimeHandoffs(): Promise<void> }).reconcileRuntimeHandoffs();
  return { home, db, requestId, executionId, binding, digest, dir, file, journal, write, active, hooks, queue, events, refresh };
}

it('shares exact pending evidence across detail, batch and history without mutating hook state', () => {
  const f = fixture();
  const before = f.hooks.getRun(f.requestId, f.binding.hookId);
  const expected = { phase: 'verification-pending', code: 'desktop_unconfirmed', reason: f.journal.lastObservation.reason };
  expect(f.queue.convergenceForRequest(f.requestId).runtime_verification).toEqual(expected);
  expect(f.hooks.convergenceForRequests([f.requestId]).get(f.requestId)?.runtime_verification).toEqual(expected);
  expect(authHistory(f.db, { limit: 50 })[0].request.convergence.runtime_verification).toEqual(expected);
  expect(f.hooks.getRun(f.requestId, f.binding.hookId)).toEqual(before);
});

it('publishes existing auth updates only for meaningful projection changes and clears them', async () => {
  const f = fixture();
  await f.refresh();
  const updates = () => f.events.filter(event => event.event === 'auth:updated');
  expect(updates()).toHaveLength(1);
  f.journal.lastObservation.observedAt = 2; f.journal.updatedAt = 2; f.write();
  await f.refresh(); expect(updates()).toHaveLength(1);
  f.journal.lastObservation.reason = 'The updated desktop is still unconfirmed; reopen it.'; f.write();
  await f.refresh(); expect(updates()).toHaveLength(2);
  expect(updates().at(-1)?.data).toMatchObject({ request: { id: f.requestId, convergence: { runtime_verification: { reason: f.journal.lastObservation.reason } } } });
  f.journal.lastObservation.code = 'observation_deadline'; f.write();
  await f.refresh(); expect(updates()).toHaveLength(3);
  f.journal.phase = 'complete'; f.write();
  await f.refresh(); expect(updates()).toHaveLength(4);
  expect((updates().at(-1)?.data as { request: { convergence: unknown } }).request.convergence).not.toHaveProperty('runtime_verification');
});

it.each(['owner', 'acceptance', 'retirement', 'schema'] as const)('refuses a stale pending instruction after %s changes', change => {
  const f = fixture();
  if (change === 'owner') fs.writeFileSync(f.active, JSON.stringify({ journal: f.file, bindingDigest: '0'.repeat(64) }));
  if (change === 'acceptance') f.db.prepare("UPDATE auth_hook_executions SET state = 'complete' WHERE id = ?").run(f.executionId);
  if (change === 'schema') { f.journal.schema = 'unknown'; f.write(); }
  if (change === 'retirement') fs.writeFileSync(path.join(f.dir, 'retirement.json'), JSON.stringify({ schema: 'mandible-runtime-handoff-retirement@1',
    requestId: f.requestId, executionId: f.executionId, bindingDigest: f.digest, journalSha256: createHash('sha256').update(fs.readFileSync(f.file)).digest('hex') }));
  expect(f.queue.convergenceForRequest(f.requestId)).not.toHaveProperty('runtime_verification');
});

it('clears a failed transition without inferring a current instruction from historical recovery attempts', async () => {
  const f = fixture();
  await f.refresh();
  f.journal.phase = 'failed'; Object.assign(f.journal, { error: 'original failure' }); f.write();
  f.db.prepare("UPDATE auth_hook_executions SET state = 'failed', exit_code = 1 WHERE id = ?").run(f.executionId);
  const directory = path.join(f.dir, 'recovery-attempts'); fs.mkdirSync(directory);
  const attempt = { outcome: 'pending', code: 'desktop_unconfirmed', message: f.journal.lastObservation.reason, failure: { phase: 'failed', error: 'original failure', attempts: 1, updatedAt: 1 } };
  fs.writeFileSync(path.join(directory, '0001.json'), JSON.stringify(attempt));
  const bytes = fs.readFileSync(f.file);
  expect(f.queue.convergenceForRequest(f.requestId)).toMatchObject({ state: 'failed' });
  expect(f.queue.convergenceForRequest(f.requestId)).not.toHaveProperty('runtime_verification');
  await f.refresh();
  const update = f.events.filter(event => event.event === 'auth:updated').at(-1);
  expect((update?.data as { request: { convergence: unknown } }).request.convergence).not.toHaveProperty('runtime_verification');
  expect(fs.readFileSync(f.file)).toEqual(bytes);
  expect(f.hooks.getRun(f.requestId, f.binding.hookId)?.state).toBe('failed');
  fs.writeFileSync(path.join(directory, '0002.json'), JSON.stringify({ ...attempt, outcome: 'failed', message: 'known process exit' }));
  expect(f.queue.convergenceForRequest(f.requestId)).not.toHaveProperty('runtime_verification');
});

it('keeps a durable pending instruction after hook output is replaced', () => {
  const f = fixture();
  f.db.prepare("UPDATE auth_hook_executions SET output = '' WHERE id = ?").run(f.executionId);
  expect(f.queue.convergenceForRequest(f.requestId).runtime_verification?.reason).toBe(f.journal.lastObservation.reason);
});

it('refuses a hook command that differs from its immutable delivery intent', () => {
  const f = fixture();
  f.hooks.getRun(f.requestId, f.binding.hookId);
  f.db.prepare('UPDATE auth_hook_executions SET command_digest = ? WHERE id = ?').run('d'.repeat(64), f.executionId);
  expect(() => f.hooks.getRun(f.requestId, f.binding.hookId)).toThrow('reference no longer matches');
  expect(f.queue.convergenceForRequest(f.requestId)).not.toHaveProperty('runtime_verification');
});
