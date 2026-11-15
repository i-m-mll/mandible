import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { applicationIdentity, createPendingRelease, disposeAcceptedRelease, readAcceptedReleaseReceipt, resolveAcceptedRelease, retainAcceptedRelease } from '../scripts/accepted-release.mjs';
import { saveOwnedMetadata } from '../scripts/owned-run.mjs';
import { installedFileIdentity, type InstalledRelease } from '../scripts/installed-release.mjs';
import { recoverRestoredAcceptedRelease } from '../scripts/recover-restored-accepted-release.mjs';
import { runSupervisedCommand } from '../scripts/process-group-supervisor.mjs';
import { createMigratedDb } from './helpers/ledger-fixtures.js';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';

const candidate = { pin_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40), head_sha: 'd'.repeat(40) };
const userDiscard = 'The owner explicitly authorized discard.';

async function restoredFixture({ legacy = false, survivor = false, reason = legacy ? userDiscard : 'Operational references released.' } = {}) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(testRuntimeRoot), 'restored-'));
  const database = path.join(home, 'mandible.db');
  const db = createMigratedDb({ path: database });
  try {
    const runId = randomUUID();
    const requestId = randomUUID();
    const storage = path.join(home, 'accepted-releases');
    const pending = await createPendingRelease({ storage, ownership: { runId, instanceId: 'fixture', project: 'project', workUnit: 'unit' } });
    fs.mkdirSync(pending.resources, { recursive: true });
    const program = path.join(pending.resources, 'program');
    fs.writeFileSync(program, 'accepted program');
    const shipped = { schema: 'mandible-installed-release@1', version: '1', target: `${process.platform}-${process.arch}`,
      layout: { kind: 'macos-app', roots: { resources: '.' } }, provenance: { commit: candidate.pin_sha, source_digest: 'e'.repeat(64),
        summary: '', date: '1970-01-01', bun_revision: '' },
      entrypoints: { daemon: 'program', cli: 'program', controller: 'program', trustSetup: 'program', service: 'program' },
      native: { bun: 'program', sqlite: 'program', caddy: 'program', claude: 'program', trustHelper: 'program', serviceHelper: 'program' },
      signing: {}, files: { program: installedFileIdentity(program) } } satisfies InstalledRelease;
    fs.writeFileSync(path.join(pending.resources, 'release.json'), JSON.stringify(shipped));
    const scratch = path.join(home, 'cache');
    fs.mkdirSync(scratch);
    const evidence = path.join(scratch, 'evidence.json');
    fs.writeFileSync(evidence, '{}');
    const accepted = await retainAcceptedRelease({ pending, candidate, shipped,
      acceptance: { record_id: legacy ? null : runId, request_id: legacy ? null : requestId },
      evidence: Buffer.from('{}'), expectedDigest: applicationIdentity(pending.app) });
    // Simulate the historical seal even when the current writer copies proof into durable custody.
    const sealed = path.join(storage, '.receipts', `${runId}-accepted-release.json`);
    saveOwnedMetadata(sealed, { ...accepted.receipt, evidence: { ...accepted.receipt.evidence, receipt: evidence } });
    const sealDigest = createHash('sha256').update(fs.readFileSync(sealed)).digest('hex');
    const reference = `accepted-release:${sealDigest}:${Buffer.from(sealed).toString('base64url')}`;
    const metadataFile = path.join(pending.root, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    delete metadata.ownership.processOwner;
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));

    if (!legacy) {
      db.prepare("INSERT INTO auth_requests (id, status, command, title, created_at, updated_at, expires_at) VALUES (?, 'completed', 'true', 'fixture', 1, 2, 100)").run(requestId);
      db.prepare("INSERT INTO auth_candidate_acceptances (id, auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, result_json) VALUES (?, ?, ?, ?, ?, ?, 'passed', 1, 2, ?)")
        .run(runId, requestId, ...Object.values(candidate), JSON.stringify({ receipt: reference }));
      db.prepare("INSERT INTO auth_request_actions (id, auth_request_id, ordinal, kind, target_issue_ref, payload, state, staged_at, updated_at) VALUES (?, ?, 1, 'checkpoint_add', 'fixture', ?, 'applied', 1, 2)")
        .run(runId, requestId, JSON.stringify({ kind: 'accepted-release', payload: { acceptanceId: runId, reference } }));
    }

    const restored = path.join(home, 'backup-copy');
    fs.cpSync(pending.root, restored, { recursive: true });
    const copiedMetadata = path.join(restored, 'metadata.json');
    if (!legacy) {
      metadata.pendingAcceptance = { recordId: runId, requestId, scratchRoot: scratch, runId };
      fs.writeFileSync(copiedMetadata, JSON.stringify(metadata));
    }
    fs.utimesSync(copiedMetadata, 1, 1);
    fs.writeFileSync(path.join(restored, '.DS_Store'), 'Finder sidecar');
    await disposeAcceptedRelease(reference, candidate, reason, { home, database, deferCleanup: survivor });
    if (!survivor) {
      expect(fs.existsSync(pending.root)).toBe(false);
      fs.renameSync(restored, pending.root);
    }
    fs.rmSync(scratch, { recursive: true });
    const outcome = path.join(storage, '.receipts', `${runId}.json`);
    return { db, home, requestId, runId, root: pending.root, app: pending.app, program, sealed, outcome, reference,
      recover: (applyToken?: string, inspect?: () => { idle: true } | { idle: false; reason: string }) =>
        recoverRestoredAcceptedRelease(db, home, runId, { applyToken, inspect }) };
  } catch (error) {
    db.close();
    throw error;
  }
}

it('plans without touching the restore, retries an interrupted move, and retains both durable historical receipts', async () => {
  const f = await restoredFixture();
  try {
    const cli = path.resolve('scripts/recover-restored-accepted-release.mjs');
    const run = (args: string[]) => runSupervisedCommand(process.execPath, [cli, f.runId, '--home', f.home, ...args], { capture: true, timeout: 5000, graceMs: 100 });
    const sealed = fs.readFileSync(f.sealed);
    const outcome = fs.readFileSync(f.outcome);
    expect(() => readAcceptedReleaseReceipt(f.reference, candidate)).toThrow();
    expect(() => resolveAcceptedRelease(f.reference, candidate)).toThrow();
    const plan = JSON.parse((await run([])).stdout);
    expect(plan).toMatchObject({ action: 'quarantine', authority: { kind: 'ledger' } });
    expect(fs.existsSync(plan.destination)).toBe(false);
    expect(fs.existsSync(plan.recoveryReceipt)).toBe(false);
    const ino = fs.statSync(f.root).ino;
    const originalRename = fs.renameSync;
    const interrupted = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      if (oldPath === f.root && newPath === plan.destination) throw new Error('interrupted rename');
      originalRename(oldPath, newPath);
    });
    try {
      expect(await f.recover(plan.applyToken)).toMatchObject({ action: 'preserve', reason: 'interrupted rename' });
    } finally { interrupted.mockRestore(); }
    expect(fs.existsSync(f.root)).toBe(true);
    expect(fs.existsSync(plan.recoveryReceipt)).toBe(true);
    const moved = JSON.parse((await run(['--apply', plan.applyToken])).stdout);
    expect(moved.action).toBe('quarantined');
    expect(await f.recover(plan.applyToken)).toEqual(moved);
    expect(fs.existsSync(f.root)).toBe(false);
    expect(fs.statSync(moved.destination).ino).toBe(ino);
    expect(fs.readFileSync(path.join(moved.destination, '.DS_Store'), 'utf8')).toBe('Finder sidecar');
    expect(fs.readFileSync(f.sealed)).toEqual(sealed);
    expect(fs.readFileSync(f.outcome)).toEqual(outcome);
  } finally { f.db.close(); }
});

it('rechecks active ownership and consumers upon apply despite unrelated failed hooks', async () => {
  const f = await restoredFixture();
  try {
    const plan = await f.recover();
    if (plan.action !== 'quarantine') throw new Error(JSON.stringify(plan));
    const ownerFile = path.join(f.home, 'config/local-sessions/bundle-owner.json');
    const alternateDigest = f.reference.replace(/:[a-f0-9]{64}:/, `:${'0'.repeat(64)}:`);
    fs.writeFileSync(ownerFile, JSON.stringify({ acceptedRelease: alternateDigest }));
    expect(await f.recover(plan.applyToken)).toMatchObject({ action: 'preserve', reason: expect.stringContaining('installed release') });
    fs.unlinkSync(ownerFile);
    const selection = f.db.prepare('SELECT payload FROM auth_request_actions WHERE id = ?').get(f.runId) as { payload: string };
    f.db.prepare('UPDATE auth_request_actions SET payload = ? WHERE id = ?')
      .run(selection.payload.replace(f.reference, alternateDigest), f.runId);
    expect(await f.recover(plan.applyToken)).toMatchObject({ action: 'preserve', reason: expect.stringContaining('Exact ledger acceptance') });
    f.db.prepare('UPDATE auth_request_actions SET payload = ? WHERE id = ?').run(selection.payload, f.runId);
    const fd = fs.openSync(f.program);
    try {
      expect(await f.recover(plan.applyToken)).toMatchObject({ action: 'preserve', reason: expect.stringContaining('active consumers') });
    } finally { fs.closeSync(fd); }
    const hold = () => {
      f.db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest,
        state, attempts, max_attempts, exit_code, output, started_at, finished_at, created_at, updated_at)
        VALUES (?, ?, 'required-rebuild', 'fixture', ?, 'failed', 1, 1, 1, '', 1, 2, 1, 2)`)
        .run(randomUUID(), f.requestId, '0'.repeat(64));
      return { idle: true } as const;
    };
    expect(await f.recover(plan.applyToken, hold)).toMatchObject({ action: 'quarantined' });
    expect(fs.existsSync(f.root)).toBe(false);
    expect(fs.existsSync(plan.recoveryReceipt)).toBe(true);
  } finally { f.db.close(); }
});

it('requires completed legacy discard and rejects changed payload or custody', async () => {
  const f = await restoredFixture({ legacy: true });
  const unsupported = await restoredFixture({ legacy: true });
  try {
    const invalidOutcome = JSON.parse(fs.readFileSync(unsupported.outcome, 'utf8'));
    fs.writeFileSync(unsupported.outcome, JSON.stringify({ ...invalidOutcome, disposition: 'transferred' }));
    expect(await unsupported.recover()).toMatchObject({ action: 'preserve', reason: expect.stringContaining('Recorded discard outcome') });
    const plan = await f.recover();
    expect(plan).toMatchObject({ action: 'quarantine', authority: { kind: 'prior-discard' } });
    if (plan.action !== 'quarantine') throw new Error(JSON.stringify(plan));
    fs.mkdirSync(plan.destination, { recursive: true, mode: 0o700 });
    expect(await f.recover(plan.applyToken)).toMatchObject({ action: 'preserve', reason: expect.stringContaining('destination already exists') });
    fs.rmdirSync(plan.destination);
    fs.writeFileSync(f.program, 'unexpected bytes');
    expect(await f.recover(plan.applyToken)).toMatchObject({ action: 'preserve', reason: expect.stringContaining('sealed whole-app digest') });
    expect(fs.existsSync(f.root)).toBe(true);
  } finally { f.db.close(); unsupported.db.close(); }
});

it('purges only matching quarantined bytes and resumes partial or rootless deletion', async () => {
  const f = await restoredFixture();
  try {
    const quarantine = await f.recover();
    if (quarantine.action !== 'quarantine') throw new Error(JSON.stringify(quarantine));
    expect(await f.recover(quarantine.applyToken)).toMatchObject({ action: 'quarantined' });
    const recover = (applyToken?: string) => recoverRestoredAcceptedRelease(f.db, f.home, f.runId, { purge: true, applyToken });
    const plan = await recover();
    if (plan.action !== 'purge') throw new Error(JSON.stringify(plan));
    expect(plan.apparentBytes).toBeGreaterThan(0);
    expect(fs.existsSync(plan.purgeReceipt)).toBe(false);
    const retiredProgram = path.join(plan.destination, path.relative(f.root, f.program));
    const originalUnlink = fs.unlinkSync;
    const interrupted = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (file === retiredProgram) throw new Error('interrupted purge');
      originalUnlink(file);
    });
    try {
      expect(await recover(plan.applyToken)).toMatchObject({ action: 'purge-pending', reason: 'interrupted purge' });
    } finally { interrupted.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(plan.purgeReceipt, 'utf8')).state).toBe('pending');
    const unrelated = path.join(plan.destination, 'unrelated');
    fs.writeFileSync(unrelated, 'preserve');
    expect(await recover(plan.applyToken)).toMatchObject({ action: 'preserve', reason: expect.stringContaining('outside the verified purge inventory') });
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('preserve');
    fs.unlinkSync(unrelated);

    const originalRmdir = fs.rmdirSync;
    const rootless = vi.spyOn(fs, 'rmdirSync').mockImplementation((file, options) => {
      originalRmdir(file, options);
      if (file === plan.destination) throw new Error('interrupted directory sync');
    });
    try {
      expect(await recover(plan.applyToken)).toMatchObject({ action: 'purge-pending', reason: 'interrupted directory sync' });
    } finally { rootless.mockRestore(); }
    expect(fs.existsSync(plan.destination)).toBe(false);
    expect(JSON.parse(fs.readFileSync(plan.purgeReceipt, 'utf8')).state).toBe('pending');
    expect(await recover(plan.applyToken)).toMatchObject({ action: 'purged' });
    const completed = fs.readFileSync(plan.purgeReceipt, 'utf8');
    expect(Buffer.byteLength(completed)).toBeLessThan(1024);
    expect(JSON.parse(completed)).toMatchObject({ state: 'completed', apparentBytes: plan.apparentBytes, applyToken: plan.applyToken });
    expect(JSON.parse(completed)).not.toHaveProperty('inventory');
    expect(await recover(plan.applyToken)).toMatchObject({ action: 'purged' });
    expect(fs.existsSync(f.outcome)).toBe(true);
    expect(fs.existsSync(f.sealed)).toBe(true);
  } finally { f.db.close(); }
});

it('quarantines exact terminal residue on the original inode after a pending discard', async () => {
  const f = await restoredFixture({ survivor: true });
  try {
    const original = JSON.parse(fs.readFileSync(f.outcome, 'utf8'));
    expect(original.cleanup).toBe('pending');
    expect(original.rootIdentity.ino).toBe(fs.statSync(f.root).ino);
    const plan = await f.recover();
    if (plan.action !== 'quarantine') throw new Error(JSON.stringify(plan));
    expect(await f.recover(plan.applyToken)).toMatchObject({ action: 'quarantined' });
    expect(fs.statSync(plan.destination).ino).toBe(original.rootIdentity.ino);
    expect(JSON.parse(fs.readFileSync(f.outcome, 'utf8'))).toEqual(original);
    await disposeAcceptedRelease(f.reference, candidate, 'Resume normal rootless completion.', { home: f.home, database: f.db.name });
    expect(JSON.parse(fs.readFileSync(f.outcome, 'utf8')).cleanup).toBe('completed');
    expect(await recoverRestoredAcceptedRelease(f.db, f.home, f.runId, { purge: true })).toMatchObject({ action: 'purge' });
  } finally { f.db.close(); }
});
