import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from '../src/sqlite.ts';
import { createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun, withOwnedRunLock, recoverGeneratedReceipt } from '../scripts/owned-run.mjs';
import { processIdentity, withInstallationGatewayLock } from '../scripts/lifecycle-lock.mjs';
import { reconcileGeneratedScratch } from '../scripts/generated-scratch.mjs';
import { createPendingRelease, retainAcceptedRelease, applicationIdentity, assertAcceptedReleaseAvailable, disposeAcceptedRelease, acceptedReleaseFilesystemReferences } from '../scripts/accepted-release.mjs';
import { reconcileAcceptedReleases, acceptedReleaseDatabaseReferences } from '../scripts/accepted-release-retention.mjs';
import { installedFileIdentity } from '../scripts/installed-release.mjs';
import { addAuthRequestAction, updateAuthRequestAction, setAuthRequestActionVeto } from '../src/auth-actions.js';
import { createMigratedDb } from './helpers/ledger-fixtures.js';
import { runSupervisedCommand } from '../scripts/process-group-supervisor.mjs';

const idle = { inspect: () => ({ idle: true }) };
const candidate = { pin_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40), head_sha: 'd'.repeat(40) };
async function deadOwner() {
  const child = spawn('/bin/sleep', ['60']);
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const record = { pid: child.pid, identity: processIdentity(child.pid) };
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
  return record;
}
const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-storage-')));

it('recovers dead disposable scratch and interrupted deletion; live, unknown, and explicitly retained material survives', async () => {
  const parent = temporary();
  const owner = await deadOwner();
  try {
    for (const name of ['orphan', 'live', 'unknown', 'interactive', 'investigation']) {
      const root = path.join(parent, name); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'data'), name);
      if (name === 'unknown') continue;
      const run = createOwnedRun({ root, instanceId: name, project: 'project', workUnit: 'unit', disposable: name !== 'interactive', outputs: [{ path: 'data', kind: name === 'interactive' ? 'interactive' : 'generated' }] });
      if (name !== 'live') run.processOwner = owner;
      const metadata = path.join(root, 'metadata.json'); saveOwnedMetadata(metadata, { ownership: run });
      if (name === 'investigation') {
        finalizeOwnedRun(metadata, { expectedRevision: 1, outcome: 'investigating', summary: 'Reproduction owned by unit', reviewBy: new Date(Date.now() + 60000).toISOString() }, idle);
        const state = JSON.parse(fs.readFileSync(metadata, 'utf8')); state.ownership.investigation.reviewBy = 1; saveOwnedMetadata(metadata, state);
      }
    }
    expect((await reconcileGeneratedScratch(parent, { ...idle, limit: 100 })).find(row => row.root === path.join(parent, 'orphan'))?.action).toBe('delete-owned');
    expect(fs.existsSync(path.join(parent, 'orphan/data'))).toBe(true);
    const remove = fs.rmSync;
    const failure = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (String(file) === path.join(parent, 'orphan/data')) throw new Error('simulated interrupted unlink');
      return remove(file, options);
    });
    try { expect((await reconcileGeneratedScratch(parent, { ...idle, apply: true, limit: 100 })).some(row => row.action === 'cleanup-pending')).toBe(true); }
    finally { failure.mockRestore(); }
    expect(fs.existsSync(path.join(parent, 'orphan/metadata.json'))).toBe(true);
    await reconcileGeneratedScratch(parent, { ...idle, apply: true, limit: 100 });
    expect(fs.existsSync(path.join(parent, 'orphan'))).toBe(false);
    for (const name of ['live', 'unknown', 'interactive', 'investigation']) expect(fs.readFileSync(path.join(parent, name, 'data'), 'utf8')).toBe(name);
    const root = path.join(parent, 'receipt-retry'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'data'), 'generated');
    const run = createOwnedRun({ root, instanceId: 'receipt-retry', processOwned: true, disposable: true, outputs: [{ path: 'data', kind: 'generated' }] }); run.processOwner = owner;
    const metadata = path.join(root, 'metadata.json'); saveOwnedMetadata(metadata, { ownership: run });
    const final = finalizeOwnedRun(metadata, { expectedRevision: 1, outcome: 'failed', summary: 'Measured failure; no replay.' }, idle);
    fs.unlinkSync(metadata);
    await reconcileGeneratedScratch(parent, { ...idle, apply: true, limit: 100 });
    expect(fs.existsSync(root)).toBe(false);
    const receipt = JSON.parse(fs.readFileSync(final.ownership.receipt, 'utf8'));
    expect(receipt).toMatchObject({ outcome: 'failed', cleanup: 'completed', summary: 'Measured failure; no replay.' });
    saveOwnedMetadata(final.ownership.receipt, { ...receipt, cleanup: 'pending' });
    recoverGeneratedReceipt(final.ownership.receipt, { ...idle, apply: true });
    expect(JSON.parse(fs.readFileSync(final.ownership.receipt, 'utf8')).cleanup).toBe('completed');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

async function release(home: string, db: Database, id: string, status: string, producer: Awaited<ReturnType<typeof deadOwner>>) {
  const pending = await createPendingRelease({ storage: path.join(home, 'accepted-releases'), ownership: { runId: id, instanceId: id, project: 'project', workUnit: 'unit' } });
  fs.mkdirSync(pending.resources, { recursive: true });
  const program = path.join(pending.resources, 'program'); fs.writeFileSync(program, 'accepted');
  const shipped = { schema: 'mandible-installed-release@1', version: '1', target: `${process.platform}-${process.arch}`, layout: { kind: 'macos-app', roots: { resources: '.' } }, provenance: { commit: candidate.pin_sha, source_digest: 'e'.repeat(64) }, entrypoints: { daemon: 'program' }, native: {}, files: { program: installedFileIdentity(program) } } as any;
  fs.writeFileSync(path.join(pending.resources, 'release.json'), JSON.stringify(shipped));
  const evidence = path.join(home, `${id}-evidence.json`); fs.writeFileSync(evidence, '{}');
  const accepted = await retainAcceptedRelease({ pending, candidate, shipped, acceptance: { record_id: id, request_id: id }, evidence: { receipt: evidence, sha256: installedFileIdentity(evidence).sha256 }, expectedDigest: applicationIdentity(pending.app) });
  const metadataFile = path.join(pending.root, 'metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); metadata.ownership.processOwner = producer; saveOwnedMetadata(metadataFile, metadata);
  db.prepare("INSERT INTO auth_requests (id, status, merge_candidate_pin_sha, merge_candidate_tree_sha, merge_preflight_base_sha, merge_head_sha, command, title, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'true', 'fixture', 1, 1, 100)").run(id, status, candidate.pin_sha, candidate.tree_sha, candidate.base_sha, candidate.head_sha);
  db.prepare('INSERT INTO auth_candidate_acceptances (id, auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?)').run(id, id, ...Object.values(candidate), 'passed', 1, JSON.stringify({ receipt: accepted.reference }));
  return { ...accepted, metadataFile, evidence };
}

function retentionDb(file: string) {
  return createMigratedDb({ path: file });
}

it('retains operational roots and evidence while reclaiming abandoned payloads idempotently', async () => {
  const home = temporary(); const db = retentionDb(path.join(home, 'db')); const producer = await deadOwner();
  try {
    const packages = new Map<string, Awaited<ReturnType<typeof release>>>();
    for (const [id, status] of [['current', 'completed'], ['pending', 'pending'], ['prior', 'completed'], ['replacement', 'completed'], ['investigation', 'withdrawn'], ['abandoned', 'superseded']]) packages.set(id, await release(home, db, id, status, producer));
    const runtime = path.join(home, 'config/local-sessions'); fs.mkdirSync(path.join(runtime, 'handoff/failed'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'bundle-owner.json'), JSON.stringify({ acceptedRelease: packages.get('current')!.reference }));
    const journal = { schema: 'mandible-runtime-handoff@1', phase: 'failed', binding: { acceptedRelease: { reference: packages.get('replacement')!.reference }, bundleOwner: { acceptedRelease: packages.get('prior')!.reference } } };
    fs.writeFileSync(path.join(runtime, 'handoff/failed/journal.json'), JSON.stringify(journal));
    const investigation = packages.get('investigation')!;
    finalizeOwnedRun(investigation.metadataFile, { expectedRevision: 1, outcome: 'investigating', summary: 'Explicit investigation', reviewBy: new Date(Date.now() + 60000).toISOString() }, idle);
    const selected = packages.get('pending')!;
    for (const operation of ['retain', 'release']) await runSupervisedCommand(process.execPath, [path.resolve('scripts/generated-storage.mjs'), '--apply', `--${operation}`, selected.metadataFile,
      '--reason', 'Selected package investigation', '--review-by', new Date(Date.now() + 60000).toISOString()], { capture: true, timeout: 3000, graceMs: 100 });
    expect(JSON.parse(fs.readFileSync(selected.metadataFile, 'utf8')).ownership.state).toBe('creating');
    assertAcceptedReleaseAvailable(selected.reference);
    const auditBytes = fs.readFileSync(Buffer.from(packages.get('abandoned')!.reference.split(':')[2], 'base64url').toString());
    const plan = await reconcileAcceptedReleases(db, home, { limit: 100 });
    expect(plan.filter(row => row.action === 'dispose')).toHaveLength(1);
    expect(fs.existsSync(packages.get('abandoned')!.root)).toBe(true);
    const beforeInventory = fs.readFileSync(packages.get('abandoned')!.metadataFile);
    const inventory = await runSupervisedCommand(process.execPath, [path.resolve('scripts/generated-storage.mjs'), '--home', home, '--db', db.name, '--cache', path.join(home, 'cache'), '--limit', '100'], { capture: true, timeout: 3000, graceMs: 100 });
    expect(JSON.parse(inventory.stdout).releases.filter((row: { action: string }) => row.action === 'dispose')).toHaveLength(1);
    expect(fs.readFileSync(packages.get('abandoned')!.metadataFile)).toEqual(beforeInventory);
    await reconcileAcceptedReleases(db, home, { apply: true, limit: 100 });
    await reconcileAcceptedReleases(db, home, { apply: true, limit: 100 });
    for (const [id, pkg] of packages) expect(fs.existsSync(pkg.root)).toBe(id !== 'abandoned');
    expect(fs.readFileSync(Buffer.from(packages.get('abandoned')!.reference.split(':')[2], 'base64url').toString())).toEqual(auditBytes);
    expect(fs.existsSync(packages.get('abandoned')!.evidence)).toBe(true);
    const prior = packages.get('prior')!.reference;
    const journalFile = path.join(runtime, 'handoff/failed/journal.json');
    const terminal = { ...journal, bindingDigest: 'binding', attempt: { state: 'complete', fence: { reason: 'receipt-accepted' } } };
    fs.writeFileSync(journalFile, JSON.stringify(terminal));
    expect(acceptedReleaseFilesystemReferences(home, prior)).toHaveLength(1);
    expect(acceptedReleaseFilesystemReferences(home, prior, { file: journalFile, bindingDigest: 'binding' })).toEqual([]);
    expect(acceptedReleaseFilesystemReferences(home, packages.get('replacement')!.reference, { file: journalFile, bindingDigest: 'binding' })).toHaveLength(1);
    const scratch = path.join(home, 'scratch'); fs.mkdirSync(scratch); fs.writeFileSync(path.join(scratch, 'data'), 'generated');
    const scratchOwner = createOwnedRun({ root: scratch, instanceId: 'scratch', project: 'project', workUnit: 'unit', disposable: true, outputs: [{ path: 'data', kind: 'generated' }] }); scratchOwner.processOwner = producer;
    saveOwnedMetadata(path.join(scratch, 'metadata.json'), { ownership: scratchOwner });
    const unsealed = await createPendingRelease({ storage: path.join(home, 'accepted-releases'), ownership: { runId: 'unsealed', instanceId: 'unsealed', project: 'project', workUnit: 'unit' } });
    fs.mkdirSync(unsealed.app); fs.writeFileSync(path.join(unsealed.app, 'program'), 'not yet sealed');
    const unsealedFile = path.join(unsealed.root, 'metadata.json');
    const pendingMetadata = JSON.parse(fs.readFileSync(unsealedFile, 'utf8'));
    pendingMetadata.ownership.processOwner = producer;
    pendingMetadata.pendingAcceptance = { recordId: 'abandoned', requestId: 'abandoned', scratchRoot: scratch, runId: scratchOwner.runId };
    saveOwnedMetadata(unsealedFile, pendingMetadata);
    db.prepare("UPDATE auth_candidate_acceptances SET status = 'failed' WHERE id = 'abandoned'").run();
    const remove = fs.rmSync;
    const interrupted = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (String(file) === unsealed.app) throw new Error('interrupted pending package unlink');
      return remove(file, options);
    });
    try { await reconcileAcceptedReleases(db, home, { apply: true, limit: 100 }); } finally { interrupted.mockRestore(); }
    expect(fs.existsSync(unsealedFile)).toBe(true);
    fs.unlinkSync(unsealedFile);
    await reconcileAcceptedReleases(db, home, { apply: true, limit: 100 });
    expect(fs.existsSync(unsealed.root)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'accepted-releases/.receipts/unsealed.json'), 'utf8')).cleanup).toBe('completed');
    fs.writeFileSync(path.join(runtime, 'handoff-active.json'), '{');
    expect(acceptedReleaseFilesystemReferences(home, 'unreferenced')).toContain('unreadable handoff ownership');
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('serializes reference acquisition with disposal and protects sealed/running and abort-before-drain producers', async () => {
  const home = temporary(); const db = retentionDb(path.join(home, 'db')); const producer = await deadOwner();
  try {
    const pkg = await release(home, db, 'race', 'withdrawn', producer);
    db.prepare("UPDATE auth_candidate_acceptances SET status = 'running', finished_at = NULL, result_json = NULL").run();
    expect(acceptedReleaseDatabaseReferences(db, pkg.reference, pkg.receipt)).toContain('acceptance producer running');
    db.prepare("UPDATE auth_candidate_acceptances SET status = 'failed', finished_at = 2").run();
    const metadata = JSON.parse(fs.readFileSync(pkg.metadataFile, 'utf8')); metadata.ownership.processOwner = { pid: process.pid, identity: processIdentity(process.pid) }; saveOwnedMetadata(pkg.metadataFile, metadata);
    expect((await reconcileAcceptedReleases(db, home, { apply: true, limit: 100 }))[0].action).toBe('retain');
    metadata.ownership.processOwner = producer; saveOwnedMetadata(pkg.metadataFile, metadata);
    let releaseGateway!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = withInstallationGatewayLock(home, async () => { entered(); await new Promise<void>(resolve => { releaseGateway = resolve; }); });
    await ready;
    const denied = await reconcileAcceptedReleases(db, home, { apply: true, limit: 100 });
    expect(denied[0].action).toBe('cleanup-pending');
    db.transaction(() => {
      assertAcceptedReleaseAvailable(pkg.reference);
      db.prepare("UPDATE auth_requests SET status = 'pending'").run();
      db.prepare("UPDATE auth_candidate_acceptances SET status = 'passed', result_json = ?").run(JSON.stringify({ receipt: pkg.reference }));
    }).immediate();
    releaseGateway(); await hold;
    expect((await reconcileAcceptedReleases(db, home, { apply: true, limit: 100 }))[0].action).toBe('retain');
    db.prepare("UPDATE auth_requests SET status = 'withdrawn'").run();
    const disposalRace = reconcileAcceptedReleases(db, home, { apply: true, limit: 100 });
    let carried: { id: string };
    db.transaction(() => {
      db.prepare("INSERT INTO auth_requests (id, status, command, title, created_at, updated_at, expires_at) VALUES ('successor', 'pending', 'true', 'successor', 1, 1, 100)").run();
      carried = addAuthRequestAction(db, { id: 'successor' } as any, { kind: 'checkpoint_add', target_issue_ref: 'issue', payload: { kind: 'accepted-release', payload: { reference: pkg.reference } } }, 1);
    }).immediate();
    expect((await disposalRace)[0]).toMatchObject({ action: 'cleanup-pending', reason: expect.stringContaining('Reference acquired before disposal claim') });
    expect(fs.existsSync(pkg.app)).toBe(true);
    expect(acceptedReleaseDatabaseReferences(db, pkg.reference, pkg.receipt)).toContain('selected by live request successor');
    db.prepare('DELETE FROM auth_request_actions WHERE id = ?').run(carried!.id);
    const claim = (mark: () => void) => db.transaction(() => {
      expect(acceptedReleaseDatabaseReferences(db, pkg.reference, pkg.receipt)).toEqual([]);
      mark();
      expect(() => assertAcceptedReleaseAvailable(pkg.reference)).toThrow('claimed for disposal');
      const action = { kind: 'checkpoint_add', target_issue_ref: 'issue', payload: { kind: 'accepted-release', payload: { reference: pkg.reference } } };
      expect(() => addAuthRequestAction(db, { id: 'race' } as any, action, 1)).toThrow('claimed for disposal');
      db.prepare("INSERT INTO auth_request_actions (id, auth_request_id, kind, state, payload, ordinal, staged_at, updated_at, target_issue_ref) VALUES ('action', 'race', 'checkpoint_add', 'vetoed', ?, 1, 1, 1, 'issue')").run(JSON.stringify(action.payload));
      expect(() => updateAuthRequestAction(db, { id: 'race' } as any, 'action', action, 1)).toThrow('claimed for disposal');
      expect(() => setAuthRequestActionVeto(db, 'race', 'action', false, 1)).toThrow('claimed for disposal');
    }).immediate();
    await disposeAcceptedRelease(pkg.reference, candidate, 'Final operational reference released', { home, claim });
    expect(fs.existsSync(pkg.root)).toBe(false);
    expect(() => assertAcceptedReleaseAvailable(pkg.reference)).toThrow();
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
