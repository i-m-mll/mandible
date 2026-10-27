// @vitest-environment node
import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applicationIdentity, retainAcceptedRelease, resolveAcceptedRelease, disposeAcceptedRelease } from '../scripts/accepted-release.mjs';
import { installedFileIdentity } from '../scripts/installed-release.mjs';
import { createOwnedRun, withOwnedRunLock, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun } from '../scripts/owned-run.mjs';
import { CandidateAcceptanceRuns } from '../src/candidate-acceptance.js';
import { acceptedReleaseSelection } from '../src/accepted-release-selection.js';
import { createAuthCheckRepo, createMigratedDb, insertSiblingMergeRequest } from './helpers/auth-queue-fixtures.js';

it('retains the app that ran after scratch disposal and refuses changed selection or bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-release-'));
  try {
    const scratch = path.join(root, 'scratch');
    const resources = path.join(scratch, 'Mandible.app/Contents/Resources');
    fs.mkdirSync(resources, { recursive: true });
    const program = path.join(resources, 'program');
    fs.writeFileSync(program, 'accepted program');
    const candidate = { pin_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40), head_sha: 'd'.repeat(40) };
    fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify({ schema: 'mandible-installed-release@1', version: '1',
      target: `${process.platform}-${process.arch}`, layout: { kind: 'macos-app', roots: { resources: '.' } },
      provenance: { commit: candidate.pin_sha, source_digest: 'e'.repeat(64) }, entrypoints: { daemon: 'program' }, native: {}, files: { program: installedFileIdentity(program) } }));
    const evidence = path.join(root, 'evidence.json');
    fs.writeFileSync(evidence, JSON.stringify({ status: 'passed', candidate: candidate.pin_sha }));
    let reference = '';
    await withOwnedRunLock(scratch, async () => {
      const ownership = createOwnedRun({ root: scratch, instanceId: 'proof', project: 'project', workUnit: 'work-unit', disposable: true,
        outputs: [{ path: 'Mandible.app', kind: 'generated' }] });
      const metadata = path.join(scratch, 'metadata.json');
      saveOwnedMetadata(metadata, { ownership });
      const input = { app: path.join(scratch, 'Mandible.app'), storage: path.join(root, 'retained'), ownership, candidate,
        acceptance: { record_id: null, request_id: null }, evidence: { receipt: evidence, sha256: installedFileIdentity(evidence).sha256 },
        expectedDigest: applicationIdentity(path.join(scratch, 'Mandible.app')) };
      await expect(retainAcceptedRelease({ ...input, expectedDigest: '0'.repeat(64) })).rejects.toThrow('changed during acceptance');
      reference = await retainAcceptedRelease(input);
      finalizeOwnedRun(metadata, { expectedRevision: 1, outcome: 'assessed', summary: 'proof' }, { inspect: () => ({ idle: true }) });
      expect(cleanupOwnedRun(metadata, { apply: true, inspect: () => ({ idle: true }) }).remaining).toEqual([]);
    });
    expect(fs.existsSync(scratch)).toBe(false);
    expect(reference.length).toBeLessThanOrEqual(512);
    const db = createMigratedDb();
    const repo = createAuthCheckRepo();
    let storedReference: string;
    try {
      insertSiblingMergeRequest(db, repo, 'request', 'main');
      const runs = new CandidateAcceptanceRuns(db, async () => ({ status: 'passed', result: { status: 'passed', receipt: reference, diagnostics: 'x'.repeat(70_000) }, error: null }), Date.now, () => {}, () => false);
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
    } finally { db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
    const selected = resolveAcceptedRelease(storedReference!, candidate);
    expect(fs.readFileSync(path.join(selected.resources, 'program'), 'utf8')).toBe('accepted program');
    expect(() => resolveAcceptedRelease(reference, { ...candidate, head_sha: 'f'.repeat(40) })).toThrow('different candidate');
    fs.writeFileSync(path.join(selected.resources, 'program'), 'changed program');
    expect(() => resolveAcceptedRelease(reference, candidate)).toThrow('application bytes changed');
    fs.writeFileSync(path.join(selected.resources, 'program'), 'accepted program');
    const receiptFile = Buffer.from(reference.split(':')[2], 'base64url').toString('utf8');
    const receiptBytes = fs.readFileSync(receiptFile);
    fs.writeFileSync(receiptFile, '{}');
    expect(() => resolveAcceptedRelease(reference, candidate)).toThrow('receipt bytes changed');
    fs.writeFileSync(receiptFile, receiptBytes);
    const disposed = await disposeAcceptedRelease(reference, candidate, 'Delivery fixture complete');
    expect(disposed.action).toBe('delete-owned');
    expect(disposed.remaining).toEqual([]);
    expect(fs.existsSync(selected.receipt.package.handle.root)).toBe(false);
    expect(fs.readFileSync(receiptFile)).toEqual(receiptBytes);
    expect(fs.existsSync(evidence)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
