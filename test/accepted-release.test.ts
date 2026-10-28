// @vitest-environment node
import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applicationIdentity, createPendingRelease, retainAcceptedRelease, resolveAcceptedRelease, disposeAcceptedRelease, disposePendingRelease } from '../scripts/accepted-release.mjs';
import { installedFileIdentity, verifyInstalledRelease } from '../scripts/installed-release.mjs';
import { createOwnedRun, withOwnedRunLock, saveOwnedMetadata } from '../scripts/owned-run.mjs';
import { CandidateAcceptanceRuns } from '../src/candidate-acceptance.js';
import { diagnosticReplayPackage, finalizeAcceptance, acceptanceOwnedOutputs } from '../scripts/candidate-acceptance.mjs';
import { acceptanceDeadline } from '../scripts/acceptance-deadline.mjs';
import { acceptedReleaseSelection } from '../src/accepted-release-selection.js';
import { createAuthCheckRepo, insertSiblingMergeRequest } from './helpers/auth-queue-fixtures.js';
import { createMigratedDb } from './helpers/ledger-fixtures.js';

it('seals the exercised app in place after scratch disposal and refuses changed selection or bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-release-'));
  try {
    const scratch = path.join(root, 'scratch');
    fs.mkdirSync(scratch);
    const ownership = createOwnedRun({ root: scratch, instanceId: 'proof', project: 'project', workUnit: 'work-unit', disposable: true, outputs: acceptanceOwnedOutputs });
    const pending = await createPendingRelease({ storage: path.join(root, 'retained'), ownership });
    const { resources, app } = pending;
    fs.mkdirSync(resources, { recursive: true });
    const program = path.join(resources, 'program');
    fs.writeFileSync(program, 'accepted program');
    const candidate = { pin_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40), head_sha: 'd'.repeat(40) };
    fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify({ schema: 'mandible-installed-release@1', version: '1',
      target: `${process.platform}-${process.arch}`, layout: { kind: 'macos-app', roots: { resources: '.' } },
      provenance: { commit: candidate.pin_sha, source_digest: 'e'.repeat(64) }, entrypoints: { daemon: 'program' }, native: {}, files: { program: installedFileIdentity(program) } }));
    const evidence = path.join(root, 'evidence.json');
    fs.writeFileSync(evidence, JSON.stringify({ status: 'passed', candidate: candidate.pin_sha }));
    const failedReceipt = path.join(root, 'failed.json');
    const failed = { schema: 'mandible-owned-run@1', acceptance: { schema: 'mandible-candidate-acceptance@1', status: 'failed',
      candidate: candidate.pin_sha, provenance: { marker: { source_digest: 'e'.repeat(64) }, package_sha256: applicationIdentity(app) } } };
    fs.writeFileSync(failedReceipt, JSON.stringify(failed));
    expect(diagnosticReplayPackage(failedReceipt, app).candidate).toBe(candidate.pin_sha);
    failed.acceptance.candidate = 'f'.repeat(40);
    fs.writeFileSync(failedReceipt, JSON.stringify(failed));
    expect(() => diagnosticReplayPackage(failedReceipt, app)).toThrow('exact failed acceptance');
    const inode = fs.statSync(program).ino;
    const shipped = verifyInstalledRelease(resources);
    const digest = applicationIdentity(app);
    expect(fs.existsSync(path.join(root, 'retained', '.receipts', `${pending.runId}-accepted-release.json`))).toBe(false);
    let reference = '';
    await withOwnedRunLock(scratch, async () => {
      const metadata = path.join(scratch, 'metadata.json');
      saveOwnedMetadata(metadata, { ownership });
      await expect(retainAcceptedRelease({ pending, candidate, shipped, acceptance: { record_id: null, request_id: null },
        evidence: { receipt: evidence, sha256: installedFileIdentity(evidence).sha256 }, expectedDigest: '0'.repeat(64) })).rejects.toThrow('changed during acceptance');
      const budget = acceptanceDeadline({});
      fs.mkdirSync(path.join(root, '.receipts'), { recursive: true });
      saveOwnedMetadata(path.join(root, '.receipts', `${ownership.runId}-acceptance.json`), { status: 'passed', provenance: { shipped } });
      const result = await finalizeAcceptance({ metadataFile: metadata, run: scratch, cache: root, ownership, pendingPackage: pending,
        candidateBinding: candidate, testedPackageDigest: digest, deadlineEnv: budget.env,
        result: { status: 'passed', provenance: { shipped }, checks: {}, phases: {}, budget: budget.reading() } });
      expect(result.status).toBe('passed');
      expect(result.checks.cleanup).toMatchObject({ action: 'delete-owned', remaining: [] });
      reference = result.receipt;
    });
    expect(fs.statSync(program).ino).toBe(inode);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(reference.length).toBeLessThanOrEqual(512);
    const database = path.join(root, 'ledger.db');
    const db = createMigratedDb({ path: database, operator: { slug: 'auth-test-operator' }, now: 1 });
    const repo = createAuthCheckRepo();
    let storedReference: string;
    try {
      insertSiblingMergeRequest(db, repo, 'request', 'main');
      const runs = new CandidateAcceptanceRuns(db, async () => ({ status: 'passed', result: { status: 'passed', receipt: reference, diagnostics: 'x'.repeat(70_000) }, error: null }), Date.now, () => {});
      runs.enqueue('request', candidate, () => ({ repoRoot: repo, pinSha: candidate.pin_sha, projectId: 'project', workUnitId: 'work-unit', env: {} }));
      await runs.idle();
      const row = db.prepare('SELECT status, result_json FROM auth_candidate_acceptances WHERE auth_request_id = ?').get('request') as { status: string; result_json: string };
      expect(row.status).toBe('passed');
      expect(row.result_json.length).toBeLessThan(64 * 1024);
      storedReference = JSON.parse(row.result_json).receipt;
      const request = { id: 'request', merge_candidate_pin_sha: candidate.pin_sha, merge_candidate_tree_sha: candidate.tree_sha,
        merge_preflight_base_sha: candidate.base_sha, merge_head_sha: candidate.head_sha };
      const acceptance = db.prepare('SELECT id FROM auth_candidate_acceptances WHERE auth_request_id = ?').get('request') as { id: string };
      const action = { kind: 'checkpoint_add', state: 'staged', payload: { kind: 'accepted-release', payload: { acceptanceId: acceptance.id, reference: storedReference } } };
      expect(acceptedReleaseSelection(db, request, [action]).receipt.candidate).toEqual(candidate);
      for (const actions of [[], [action, action], [{ ...action, state: 'vetoed' }]]) {
        expect(() => acceptedReleaseSelection(db, request, actions)).toThrow('Exactly one non-vetoed');
      }
      expect(() => acceptedReleaseSelection(db, { ...request, id: 'different-request' }, [action])).toThrow('exact request and candidate');
      expect(() => acceptedReleaseSelection(db, { ...request, merge_head_sha: 'f'.repeat(40) }, [action])).toThrow('exact request and candidate');
      db.prepare("UPDATE auth_requests SET status = 'rejected' WHERE id = 'request'").run();
      const runtimeDir = path.join(root, 'home/config/local-sessions');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const owner = path.join(runtimeDir, 'bundle-owner.json');
      const lock = path.join(runtimeDir, 'handoff-active.json');
      const journal = path.join(runtimeDir, 'journal.json');
      const dispose = () => spawnSync(process.execPath, [path.resolve('scripts/dispose-accepted-release.mjs'), 'request', acceptance.id, 'Abandoned fixture'], {
        env: { ...process.env, MANDIBLE_HOME: path.join(root, 'home'), MANDIBLE_DB: database, MANDIBLE_RELEASE_ROOT: '' }, encoding: 'utf8', timeout: 5000,
      });
      fs.writeFileSync(program, 'changed program');
      fs.writeFileSync(owner, JSON.stringify({ acceptedRelease: reference }));
      const installed = dispose();
      expect(installed.status).not.toBe(0);
      expect(installed.stderr).toContain('installed release still owns these bytes');
      expect(fs.existsSync(app)).toBe(true);
      fs.unlinkSync(owner);
      fs.writeFileSync(journal, JSON.stringify({ phase: 'failed', binding: { acceptedRelease: { reference } } }));
      fs.writeFileSync(lock, JSON.stringify({ journal }));
      const unresolved = dispose();
      expect(unresolved.status).not.toBe(0);
      expect(unresolved.stderr).toContain('unresolved handoff still owns these bytes');
      expect(fs.existsSync(app)).toBe(true);
      fs.unlinkSync(lock);
      fs.writeFileSync(program, 'accepted program');
    } finally { db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
    const selected = resolveAcceptedRelease(storedReference!, candidate);
    expect(fs.readFileSync(path.join(selected.resources, 'program'), 'utf8')).toBe('accepted program');
    expect(() => resolveAcceptedRelease(reference, { ...candidate, head_sha: 'f'.repeat(40) })).toThrow('different candidate');
    await expect(disposeAcceptedRelease(reference, { ...candidate, head_sha: 'f'.repeat(40) }, 'Wrong candidate')).rejects.toThrow('different candidate');
    fs.writeFileSync(path.join(selected.resources, 'program'), 'changed program');
    expect(() => resolveAcceptedRelease(reference, candidate)).toThrow('application bytes changed');
    await withOwnedRunLock(selected.receipt.package.handle.root, async () => {
      await expect(disposeAcceptedRelease(reference, candidate, 'Locked fixture')).rejects.toThrow('locked');
    });
    expect(fs.existsSync(app)).toBe(true);
    fs.writeFileSync(path.join(selected.resources, 'program'), 'accepted program');
    const metadataFile = path.join(selected.receipt.package.handle.root, 'metadata.json');
    const metadataBytes = fs.readFileSync(metadataFile);
    const metadata = JSON.parse(metadataBytes.toString());
    metadata.ownership.workUnit = 'different-owner';
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    await expect(disposeAcceptedRelease(reference, candidate, 'Changed custody')).rejects.toThrow('owner changed');
    expect(fs.existsSync(app)).toBe(true);
    fs.writeFileSync(metadataFile, metadataBytes);
    const receiptFile = Buffer.from(reference.split(':')[2], 'base64url').toString('utf8');
    const receiptBytes = fs.readFileSync(receiptFile);
    fs.writeFileSync(receiptFile, '{}');
    expect(() => resolveAcceptedRelease(reference, candidate)).toThrow('receipt bytes changed');
    await expect(disposeAcceptedRelease(reference, candidate, 'Changed receipt')).rejects.toThrow('receipt bytes changed');
    expect(fs.existsSync(app)).toBe(true);
    fs.writeFileSync(receiptFile, receiptBytes);
    fs.writeFileSync(path.join(selected.resources, 'program'), 'discarded software need not match its original bytes');
    const disposed = await disposeAcceptedRelease(reference, candidate, 'Delivery fixture complete');
    expect(disposed.action).toBe('delete-owned');
    expect(disposed.remaining).toEqual([]);
    expect(fs.existsSync(selected.receipt.package.handle.root)).toBe(false);
    expect(fs.readFileSync(receiptFile)).toEqual(receiptBytes);
    expect(fs.existsSync(evidence)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('disposes only the exact pending package and preserves changed or unknown retained material', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-release-'));
  try {
    const pending = await createPendingRelease({ storage: root, ownership: { runId: 'pending', instanceId: 'proof', project: 'project', workUnit: 'unit' } });
    fs.mkdirSync(pending.app);
    const program = path.join(pending.app, 'program');
    fs.writeFileSync(program, 'exercised');
    const digest = applicationIdentity(pending.app);
    fs.writeFileSync(program, 'changed');
    await expect(disposePendingRelease(pending, digest, 'Failed acceptance')).rejects.toThrow('changed');
    expect(fs.existsSync(program)).toBe(true);
    fs.writeFileSync(program, 'exercised');
    fs.writeFileSync(path.join(pending.root, 'unknown'), 'preserve');
    const result = await disposePendingRelease(pending, digest, 'Failed acceptance');
    expect(result.remaining).toEqual(['unknown']);
    expect(fs.readFileSync(path.join(pending.root, 'unknown'), 'utf8')).toBe('preserve');
    const failed = await createPendingRelease({ storage: root, ownership: { runId: 'failed', instanceId: 'proof', project: 'project', workUnit: 'unit' } });
    fs.mkdirSync(failed.app);
    fs.writeFileSync(path.join(failed.app, 'partial-copy'), 'unaccepted');
    expect(await disposePendingRelease(failed, undefined, 'Copy failed')).toMatchObject({ action: 'delete-owned', remaining: [] });
    expect(fs.existsSync(failed.root)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('cleans disposable scratch independently when a failed pending package is disposed or preserved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-package-finalization-'));
  try {
    for (const changed of [false, true]) {
      const scratch = path.join(root, String(changed)); fs.mkdirSync(scratch);
      const ownership = createOwnedRun({ root: scratch, instanceId: 'proof', project: 'project', workUnit: 'unit', disposable: true, outputs: acceptanceOwnedOutputs });
      const pending = await createPendingRelease({ storage: path.join(root, 'packages'), ownership });
      fs.mkdirSync(pending.app);
      const program = path.join(pending.app, 'program'); fs.writeFileSync(program, 'exercised');
      const digest = applicationIdentity(pending.app);
      if (changed) fs.writeFileSync(program, 'changed');
      fs.writeFileSync(path.join(scratch, 'extra-generated'), 'scratch');
      const metadataFile = path.join(scratch, 'metadata.json');
      saveOwnedMetadata(metadataFile, { ownership });
      const budget = acceptanceDeadline({});
      const result = await finalizeAcceptance({ metadataFile, run: scratch, cache: root, ownership, pendingPackage: pending,
        testedPackageDigest: digest, deadlineEnv: budget.env,
        result: { status: 'failed', provenance: {}, checks: {}, phases: {}, budget: budget.reading() } });
      expect(result.status).toBe('failed');
      expect(result.checks.cleanup).toMatchObject({ action: 'delete-owned', remaining: [] });
      expect(fs.existsSync(scratch)).toBe(false);
      expect(fs.existsSync(pending.app)).toBe(changed);
      expect(result.checks.package_cleanup.action).toBe(changed ? 'skip' : 'delete-owned');
      expect(fs.existsSync(path.join(root, 'packages/.receipts', `${pending.runId}-accepted-release.json`))).toBe(false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
