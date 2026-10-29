import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createMigratedDb } from './helpers/ledger-fixtures.js';
import { createPendingRelease, retainAcceptedRelease, applicationIdentity, assertAcceptedReleaseAvailable } from '../scripts/accepted-release.mjs';
import { installedFileIdentity } from '../scripts/installed-release.mjs';
import { saveOwnedMetadata } from '../scripts/owned-run.mjs';
import { reconcileAcceptedReleases } from '../scripts/accepted-release-retention.mjs';
import { retireFailedDelivery } from '../src/failed-delivery-retirement.js';
import { appendAuthLifecycleEvent, listAuthLifecycleEvents } from '../src/auth-lifecycle.js';
import { authRequestSnapshot } from '../src/auth-request-snapshot.js';
import { AuthHookManager } from '../src/auth-hooks.js';
import { systemAction } from '../src/identity/resolver.js';
import { addAttributionEvidence, createUser, addCredential } from '../src/users/store.js';
import { migrate } from '../src/db-migrations.js';
import { AuthQueue } from '../src/auth-queue.js';
import { acceptedReleaseProducerReferencesAsync } from '../scripts/accepted-release-retention.mjs';
import { AUTH_HOOK_EXECUTIONS_TABLE_SQL, AUTH_HOOK_EXECUTIONS_INDEX_SQL } from '../src/auth-hook-schema.js';
import type { AuthRequest, AuthLifecycleActor } from '../src/types.js';

const candidate = { pin_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40), head_sha: 'd'.repeat(40) };
const actor: AuthLifecycleActor = { ...systemAction(), authority_path: 'system' };
async function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'failed-retirement-')));
  const db = createMigratedDb();
  const id = randomUUID(); const execution = randomUUID(); const record = randomUUID();
  const owner = createUser(db, { slug: 'retirement-owner', display_name: 'Retirement owner', kind: 'agent' });
  const credential = addCredential(db, owner.id, { type: 'api_token', fingerprint: 'retirement-held' });
  const currentActor: AuthLifecycleActor = { user_id: owner.id, credential_id: credential.id, evidence_method: 'api_token', authority_path: 'custodian' };
  db.prepare("INSERT INTO work_units (id, issue_id, repo_id, kind, state, auth_request_id, owner_user_id, owner_credential_id, custody_generation, created_at) VALUES ('unit', 'fixture', 'fixture', 'solo', 'committed', ?, ?, ?, 3, 1)")
    .run(id, owner.id, credential.id);
  const pending = await createPendingRelease({ storage: path.join(home, 'accepted-releases'), ownership: { runId: record, instanceId: 'fixture', project: 'project', workUnit: 'unit' } });
  fs.mkdirSync(pending.resources, { recursive: true });
  const program = path.join(pending.resources, 'program'); fs.writeFileSync(program, 'accepted program');
  const shipped = { schema: 'mandible-installed-release@1', version: '1', target: `${process.platform}-${process.arch}`, layout: { kind: 'macos-app', roots: { resources: '.' } },
    provenance: { commit: candidate.pin_sha, source_digest: 'e'.repeat(64) }, entrypoints: { daemon: 'program' }, native: {}, files: { program: installedFileIdentity(program) } } as any;
  fs.writeFileSync(path.join(pending.resources, 'release.json'), JSON.stringify(shipped));
  const evidence = path.join(home, 'evidence.json'); fs.writeFileSync(evidence, '{}');
  const accepted = await retainAcceptedRelease({ pending, candidate, shipped, expectedDigest: applicationIdentity(pending.app),
    acceptance: { record_id: record, request_id: id }, evidence: { receipt: evidence, sha256: installedFileIdentity(evidence).sha256 } });
  const metadataFile = path.join(pending.root, 'metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); delete metadata.ownership.processOwner; saveOwnedMetadata(metadataFile, metadata);
  db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, exit_code, merge_candidate_pin_sha, merge_candidate_tree_sha,
    merge_preflight_base_sha, merge_head_sha, merge_finalized_at, created_at, updated_at, expires_at, custody_work_unit_id, approved_by_user_id)
    VALUES (?, 'merge', 'mandible auth merge feature/x --into main', 'failed delivery', 'executing', 0, ?, ?, ?, ?, NULL, 1, 1, 100, 'unit', ?)`).run(id, ...Object.values(candidate), owner.id);
  db.prepare('UPDATE auth_requests SET depends_on_ids = ? WHERE id = ?').run(JSON.stringify([randomUUID(), randomUUID()]), id);
  db.prepare("INSERT INTO auth_candidate_acceptances (id, auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, result_json) VALUES (?, ?, ?, ?, ?, ?, 'passed', 1, 2, ?)")
    .run(record, id, ...Object.values(candidate), JSON.stringify({ receipt: accepted.reference }));
  db.prepare("INSERT INTO auth_request_actions (id, auth_request_id, ordinal, kind, target_issue_ref, payload, state, staged_at, updated_at) VALUES ('selection', ?, 1, 'checkpoint_add', 'fixture', ?, 'staged', 1, 1)")
    .run(id, JSON.stringify({ kind: 'accepted-release', payload: { acceptanceId: record, reference: accepted.reference } }));
  appendAuthLifecycleEvent(db, { requestId: id, eventType: 'executing', priorStatus: 'approved', nextStatus: 'executing', actor, occurredAt: 2 });
  db.prepare("UPDATE auth_requests SET status = 'completed' WHERE id = ?").run(id);
  const command = 'retained snapshotted rebuild'; const digest = createHash('sha256').update(command).digest('hex');
  db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, state, attempts, max_attempts,
    exit_code, output, attempt_history, started_at, finished_at, created_at, updated_at)
    VALUES (?, ?, 'builtin-mandible-rebuild', ?, ?, 'failed', 3, 3, 1, 'original failure', ?, 1, 3, 1, 3)`).run(execution, id, command, digest,
      JSON.stringify([1, 2, 3].map(attempt => ({ attempt, outcome: 'failed', exit_code: 1, started_at: 1, finished_at: 3, duration_ms: 2 }))));
  appendAuthLifecycleEvent(db, { requestId: id, eventType: 'completed', priorStatus: 'executing', nextStatus: 'completed', actor, occurredAt: 3 });
  db.prepare("UPDATE auth_request_actions SET state = 'applied', applied_at = 4, outcome_detail = 'checkpoint applied' WHERE auth_request_id = ?").run(id);
  db.prepare("UPDATE auth_requests SET merge_finalized_at = 4, merge_finalizer_state = '{\"done\":true}', output = 'post-completion hook retries', updated_at = 4 WHERE id = ?").run(id);
  const read = () => db.prepare('SELECT * FROM auth_requests WHERE id = ?').get(id) as AuthRequest;
  let expected = listAuthLifecycleEvents(db, id).at(-1)!.revision;
  let observed = authRequestSnapshot(db, id);
  const authorize = () => {
    const latest = listAuthLifecycleEvents(db, id).at(-1)!;
    if (latest.revision !== expected || observed !== authRequestSnapshot(db, id) || createHash('sha256').update(latest.snapshot_json).digest('hex') !== latest.snapshot_sha256) throw new Error('custody or lifecycle changed');
    return read();
  };
  const run = (options: { inspect?: () => Promise<{ idle: boolean; reason?: string }> } = {}) => retireFailedDelivery(db, read(), 'New delivery replaced failed pre-install attempt', currentActor, { home, authorize, ...options });
  return { db, home, id, execution, accepted, metadataFile, read, run, owner, credential, currentActor,
    refresh: () => { expected = listAuthLifecycleEvents(db, id).at(-1)!.revision; observed = authRequestSnapshot(db, id); },
    hook: () => db.prepare('SELECT * FROM auth_hook_executions WHERE id = ?').get(execution) as Record<string, any>,
    journal: path.join(home, 'config/local-sessions/handoff', `${id}-${execution}`),
    close: () => { db.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}

it('retires once without rewriting failure, then ordinary cleanup resumes interrupted legacy disposal', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(f.journal, { recursive: true });
    const failure = f.hook();
    const receiptFile = Buffer.from(f.accepted.reference.split(':')[2], 'base64url').toString();
    const receiptBytes = fs.readFileSync(receiptFile);
    expect(await f.run()).toMatchObject({ state: 'retired', cleanup: 'pending' });
    expect(f.hook()).toEqual({ ...failure, state: 'retired' });
    expect(fs.existsSync(f.accepted.app)).toBe(true);
    const hooks = new AuthHookManager(f.db);
    expect(hooks.convergence(f.id)).toMatchObject({ state: 'failed', hooks: [{ state: 'retired', failure: 'original failure', attempts: 3 }] });
    expect(() => hooks.grantRetry(f.id)).toThrow('cannot be retried');
    const queue = new AuthQueue({ db: f.db, backgroundMaintenance: false, hookManager: hooks, broadcast: () => {} });
    try {
      await expect(queue.retryHookConvergence(f.id)).rejects.toThrow('cannot be retried');
      expect(queue.isRebuilding).toBe(false);
      expect(f.hook()).toEqual({ ...failure, state: 'retired' });
    } finally { await queue.dispose(); }
    expect(await hooks.runPending(f.read())).toEqual([]);
    expect(() => assertAcceptedReleaseAvailable(f.accepted.reference)).toThrow('claimed for disposal');
    const events = listAuthLifecycleEvents(f.db, f.id);
    expect(events.at(-1)!.reason).toContain(f.execution);
    expect(events.at(-1)!.reason).toContain(f.accepted.reference);
    f.refresh();
    expect(await f.run()).toMatchObject({ state: 'retired', cleanup: 'pending' });
    expect(listAuthLifecycleEvents(f.db, f.id)).toHaveLength(events.length);
    const remove = fs.rmSync;
    const interrupted = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (String(file) === f.accepted.app) throw new Error('interrupted unlink');
      return remove(file, options);
    });
    try { expect((await reconcileAcceptedReleases(f.db, f.home, { apply: true, limit: 100 })).some(x => x.action === 'cleanup-pending')).toBe(true); }
    finally { interrupted.mockRestore(); }
    fs.unlinkSync(f.metadataFile);
    await reconcileAcceptedReleases(f.db, f.home, { apply: true, limit: 100 });
    expect(fs.existsSync(f.accepted.root)).toBe(false);
    expect(await f.run()).toMatchObject({ state: 'retired', cleanup: 'completed' });
    expect(f.hook()).toEqual({ ...failure, state: 'retired' });
    expect(fs.readFileSync(receiptFile)).toEqual(receiptBytes);
    expect(listAuthLifecycleEvents(f.db, f.id)).toHaveLength(events.length);
  } finally { f.close(); }
});

it('refuses admission, investigation, installed, unknown material and live references without changing failed history', async () => {
  const f = await fixture();
  try {
    const original = f.hook(); const count = listAuthLifecycleEvents(f.db, f.id).length;
    const runtime = path.join(f.home, 'config/local-sessions'); fs.mkdirSync(f.journal, { recursive: true });
    const unknown = path.join(f.journal, 'unknown'); fs.writeFileSync(unknown, 'preserve');
    await expect(f.run()).rejects.toThrow('handoff material'); fs.unlinkSync(unknown);
    fs.writeFileSync(path.join(runtime, 'bundle-owner.json'), JSON.stringify({ acceptedRelease: f.accepted.reference }));
    await expect(f.run()).rejects.toThrow('installed release'); fs.unlinkSync(path.join(runtime, 'bundle-owner.json'));
    const metadata = JSON.parse(fs.readFileSync(f.metadataFile, 'utf8'));
    saveOwnedMetadata(f.metadataFile, { ...metadata, ownership: { ...metadata.ownership, state: 'investigating' } });
    await expect(f.run()).rejects.toThrow('investigation'); saveOwnedMetadata(f.metadataFile, metadata);
    await expect(f.run({ inspect: async () => ({ idle: false, reason: 'live consumer' }) })).rejects.toThrow('live consumer');
    const attempts = JSON.parse(original.attempt_history);
    attempts[0].outcome = 'timeout'; attempts[0].exit_code = null;
    f.db.prepare('UPDATE auth_hook_executions SET attempt_history = ? WHERE id = ?').run(JSON.stringify(attempts), f.execution);
    await expect(f.run()).rejects.toThrow('settlement is uncertain');
    attempts[0].outcome = 'interrupted';
    f.db.prepare('UPDATE auth_hook_executions SET attempt_history = ? WHERE id = ?').run(JSON.stringify(attempts), f.execution);
    await expect(f.run()).rejects.toThrow('settlement is uncertain');
    f.db.prepare('UPDATE auth_hook_executions SET attempt_history = ? WHERE id = ?').run(original.attempt_history, f.execution);
    f.db.prepare("INSERT INTO auth_requests (id, command, title, status, created_at, updated_at, expires_at) VALUES ('other', 'true', 'other', 'pending', 1, 1, 100)").run();
    f.db.prepare("INSERT INTO auth_request_actions (id, auth_request_id, ordinal, kind, target_issue_ref, payload, state, staged_at, updated_at) VALUES ('other-selection', 'other', 1, 'checkpoint_add', 'fixture', ?, 'staged', 1, 1)")
      .run(JSON.stringify({ kind: 'accepted-release', payload: { reference: f.accepted.reference } }));
    await expect(f.run()).rejects.toThrow('operational references remain');
    f.db.prepare("DELETE FROM auth_request_actions WHERE id = 'other-selection'").run();
    const publication = { schema: 'mandible-runtime-publication@1', requestId: f.id, executionId: f.execution, hookId: 'builtin-mandible-rebuild', commandDigest: f.hook().command_digest };
    addAttributionEvidence(f.db, { evidence_method: 'credential_signature', details: { runtime_publication: publication, runtime_publication_digest: createHash('sha256').update(JSON.stringify(publication)).digest('hex') } });
    await expect(f.run()).rejects.toThrow('publication was admitted');
    expect(f.hook()).toEqual(original);
    expect(listAuthLifecycleEvents(f.db, f.id)).toHaveLength(count);
    expect(fs.existsSync(f.accepted.app)).toBe(true);
  } finally { f.close(); }
});

it('does not block the event loop during consumer observation and rejects concurrent retry/custody changes', async () => {
  const f = await fixture();
  try {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const run = f.run({ inspect: async () => { entered.resolve(); await release.promise; return { idle: true }; } });
    await entered.promise;
    let progressed = false; await new Promise<void>(resolve => setImmediate(() => { progressed = true; resolve(); }));
    expect(progressed).toBe(true);
    new AuthHookManager(f.db).grantRetry(f.id);
    release.resolve();
    await expect(run).rejects.toThrow('failed terminal builtin');
    expect(f.hook().state).toBe('pending');
    expect(listAuthLifecycleEvents(f.db, f.id)).toHaveLength(2);
    expect(fs.existsSync(f.accepted.app)).toBe(true);
    f.db.prepare("UPDATE auth_hook_executions SET state = 'failed', finished_at = 3 WHERE id = ?").run(f.execution);
    await expect(f.run({ inspect: async () => {
      appendAuthLifecycleEvent(f.db, { requestId: f.id, eventType: 'revised', priorStatus: 'completed', nextStatus: 'completed', actor, reason: 'Concurrent custody decision', occurredAt: 4 });
      return { idle: true };
    } })).rejects.toThrow('custody or lifecycle changed');
    expect(f.hook().state).toBe('failed');
    let settled = false;
    const observation = acceptedReleaseProducerReferencesAsync({ pendingAcceptance: { scratchRoot: f.accepted.root, runId: f.accepted.receipt.acceptance.run_id },
      ownership: { processOwner: { pid: process.pid, identity: 'uncertain prior lifetime' } } }).finally(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    await expect(observation).resolves.toContain('acceptance consumers live or uncertain');
  } finally { f.close(); }
});

it('migrates failed hook evidence unchanged and admits retirement in the shared fresh and upgraded schema', async () => {
  const f = await fixture();
  try {
    const original = f.hook();
    const snapshot = authRequestSnapshot(f.db, f.id);
    const history = listAuthLifecycleEvents(f.db, f.id);
    f.db.exec(`DROP INDEX idx_auth_hook_executions_runnable;
      ALTER TABLE auth_hook_executions RENAME TO hooks_new;
      ${AUTH_HOOK_EXECUTIONS_TABLE_SQL.replace(",'retired'", '')};
      INSERT INTO auth_hook_executions SELECT * FROM hooks_new;
      DROP TABLE hooks_new;
      ${AUTH_HOOK_EXECUTIONS_INDEX_SQL};
      UPDATE meta SET value = '221' WHERE key = 'schema_version';`);
    expect(f.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '221' });
    migrate(f.db);
    expect(f.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '222' });
    expect(f.hook()).toEqual(original);
    expect(authRequestSnapshot(f.db, f.id)).toBe(snapshot);
    expect(listAuthLifecycleEvents(f.db, f.id)).toEqual(history);
    expect(await f.run()).toMatchObject({ state: 'retired', cleanup: 'pending' });
    expect(f.read().depends_on_ids).toBe(JSON.stringify(JSON.parse(snapshot).request.depends_on_ids));
  } finally { f.close(); }
});

it('enforces real request custody and generation at the AuthQueue retirement entrypoint before marking custody', async () => {
  const f = await fixture();
  const other = addCredential(f.db, f.owner.id, { type: 'api_token', fingerprint: 'retirement-other' });
  const currentActor = f.currentActor;
  const event = listAuthLifecycleEvents(f.db, f.id).at(-1)!;
  const commit = 'f'.repeat(40);
  const evidence = addAttributionEvidence(f.db, { evidence_method: 'credential_signature', details: { publication_verified: true, verified: true, commit_sha: commit, signer_user_id: f.owner.id } });
  f.db.prepare('UPDATE auth_requests SET execution_evidence_id = ?, output = ? WHERE id = ?').run(evidence.id, `MANDIBLE_MERGE_RESULT ${JSON.stringify({ merge_sha: commit })}\npost-completion hook retries`, f.id);
  const queue = new AuthQueue({ db: f.db, backgroundMaintenance: false, broadcast: () => {} });
  try {
    await expect(queue.retireFailedDelivery(f.id, 'Retire obsolete attempt', { ...currentActor, credential_id: other.id }, event.revision, 3))
      .rejects.toThrow('current delivery-work-unit credential');
    await expect(queue.retireFailedDelivery(f.id, 'Retire obsolete attempt', currentActor, event.revision, 4))
      .rejects.toThrow('lifecycle or work-unit custody changed');
    expect(f.hook().state).toBe('failed');
    expect(listAuthLifecycleEvents(f.db, f.id)).toHaveLength(2);
    expect(() => assertAcceptedReleaseAvailable(f.accepted.reference)).not.toThrow();
    expect(queue.isRebuilding).toBe(false);
    expect(authRequestSnapshot(f.db, f.id)).not.toBe(event.snapshot_json);
    expect(await queue.retireFailedDelivery(f.id, 'Retire settled obsolete attempt', currentActor, event.revision, 3)).toMatchObject({ state: 'retired', cleanup: 'pending' });
    expect(f.hook().state).toBe('retired');
    const snapshot = authRequestSnapshot(f.db, f.id);
    const revision = listAuthLifecycleEvents(f.db, f.id).at(-1)!.revision + 1;
    f.db.prepare("INSERT INTO auth_request_lifecycle_events (id, auth_request_id, revision, event_type, next_status, snapshot_json, snapshot_sha256, occurred_at) VALUES (?, ?, ?, 'revised', 'completed', ?, ?, 6)")
      .run(randomUUID(), f.id, revision, snapshot, '0'.repeat(64));
    await expect(queue.retireFailedDelivery(f.id, 'Replay with corrupt event', currentActor, revision, 3)).rejects.toThrow('lifecycle or work-unit custody changed');
    expect(f.hook().state).toBe('retired');
  } finally { await queue.dispose(); f.close(); }
});
