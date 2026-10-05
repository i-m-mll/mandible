import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun, withOwnedRunLock } from './owned-run.mjs';

const idle = { inspect: () => ({ idle: true }) };
function fixture(disposable = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-owned-run-'));
  const root = path.join(base, 'run'); fs.mkdirSync(root);
  const metadata = path.join(root, 'metadata.json');
  const ownership = createOwnedRun({ root, instanceId: 'preview-fixture', project: 'fixture-project', workUnit: 'fixture-work-unit', disposable,
    outputs: [{ path: 'ledger.db', kind: 'interactive' }, { path: 'artifacts', kind: 'interactive' }, { path: 'stdout.log', kind: 'generated' }] });
  saveOwnedMetadata(metadata, { ownership });
  fs.writeFileSync(path.join(root, 'ledger.db'), 'unique edited ledger');
  fs.mkdirSync(path.join(root, 'artifacts')); fs.writeFileSync(path.join(root, 'artifacts', 'document'), 'unique managed material');
  fs.writeFileSync(path.join(root, 'stdout.log'), 'raw logs');
  return { base, root, metadata, dispose: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('unresolved interactive material survives; transferred bytes and compact receipt survive successful cleanup', async () => {
  const f = fixture();
  try {
    await withOwnedRunLock(f.root, async () => {
      assert.match(cleanupOwnedRun(f.metadata, { ...idle, apply: true }).reason, /unresolved/);
      assert.throws(() => finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'accepted', converged: true, summary: 'Accepted documents' }, idle), /unresolved/);
      const destination = path.join(f.base, 'accepted'); fs.mkdirSync(destination);
      fs.copyFileSync(path.join(f.root, 'ledger.db'), path.join(destination, 'ledger.db'));
      assert.throws(() => finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'accepted', converged: true, disposition: 'transferred', destination, summary: 'Accepted documents' }, idle), /not verified/);
      fs.cpSync(path.join(f.root, 'artifacts'), path.join(destination, 'artifacts'), { recursive: true });
      const finalized = finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'accepted', converged: true, disposition: 'transferred', destination, summary: 'Accepted documents' }, idle);
      const result = cleanupOwnedRun(f.metadata, { ...idle, apply: true });
      assert.equal(result.action, 'delete-owned'); assert.ok(result.reclaimedBytes > 0);
      assert.equal(fs.existsSync(f.root), false);
      assert.equal(JSON.parse(fs.readFileSync(finalized.ownership.receipt)).cleanup, 'completed');
      assert.equal(fs.readFileSync(path.join(destination, 'artifacts', 'document'), 'utf8'), 'unique managed material');
    });
  } finally { f.dispose(); }
});

test('disposable failed run reclaims immediately, preserves unknown entries, retries without disposition transfer', () => {
  const f = fixture(true);
  try {
    finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'failed', summary: 'Startup refused' }, idle);
    fs.writeFileSync(path.join(f.root, 'unknown'), 'user material');
    const result = cleanupOwnedRun(f.metadata, { ...idle, apply: true });
    assert.deepEqual(result.remaining, ['unknown']);
    assert.equal(fs.readFileSync(path.join(f.root, 'unknown'), 'utf8'), 'user material');
    assert.equal(cleanupOwnedRun(f.metadata, { ...idle, apply: true }).reclaimedBytes, 0);
  } finally { f.dispose(); }
});

test('revision drift, consumer uncertainty, changed bytes and symlink replacement refuse deletion', async () => {
  const f = fixture(true);
  try {
    assert.throws(() => finalizeOwnedRun(f.metadata, { expectedRevision: 0, outcome: 'failed', summary: 'Failed' }, idle), /revision/);
    assert.throws(() => finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'failed', summary: 'Failed' }, { inspect: () => ({ idle: false, reason: 'inspection failed' }) }), /inspection failed/);
    finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'failed', summary: 'Failed' }, idle);
    assert.match(cleanupOwnedRun(f.metadata, { apply: true, inspect: () => ({ idle: false, reason: 'open file' }) }).reason, /open file/);
    fs.writeFileSync(path.join(f.root, 'ledger.db'), 'different ledger');
    assert.match(cleanupOwnedRun(f.metadata, { ...idle, apply: true }).reason, /changed/);
    fs.unlinkSync(path.join(f.root, 'stdout.log')); fs.symlinkSync(path.join(f.root, 'ledger.db'), path.join(f.root, 'stdout.log'));
    assert.equal(fs.existsSync(path.join(f.root, 'ledger.db')), true);
    await withOwnedRunLock(f.root, async () => assert.rejects(withOwnedRunLock(f.root, async () => {}), /locked/));
  } finally { f.dispose(); }
});

test('a real disposable create/use/finalize/cleanup run releases files and keeps its receipt', async () => {
  const f = fixture(true);
  try {
    fs.symlinkSync('ledger.db', path.join(f.root, 'current.db'));
    const metadata = JSON.parse(fs.readFileSync(f.metadata));
    metadata.ownership.outputs.push({ path: 'current.db', kind: 'generated', disposition: 'pending' });
    saveOwnedMetadata(f.metadata, metadata);
    await withOwnedRunLock(f.root, async () => {
      const finalized = finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'assessed', summary: 'Fixture interaction and verdict completed' });
      const result = cleanupOwnedRun(f.metadata, { apply: true });
      assert.equal(result.action, 'delete-owned');
      assert.ok(result.reclaimedBytes > 0);
      assert.equal(fs.existsSync(f.root), false);
      assert.equal(JSON.parse(fs.readFileSync(finalized.ownership.receipt)).outcome, 'assessed');
    });
  } finally { f.dispose(); }
});

test('partial deletion retries only remaining bytes and root replacement is blocked', () => {
  const f = fixture(true);
  try {
    finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'failed', summary: 'Disposed failed fixture' }, idle);
    fs.unlinkSync(path.join(f.root, 'stdout.log'));
    const moved = `${f.root}-replaced`; fs.renameSync(f.root, moved); fs.mkdirSync(f.root);
    fs.copyFileSync(path.join(moved, 'metadata.json'), f.metadata);
    assert.match(cleanupOwnedRun(f.metadata, { ...idle, apply: true }).reason, /ownership/);
    fs.rmSync(f.root, { recursive: true }); fs.renameSync(moved, f.root);
    assert.equal(cleanupOwnedRun(f.metadata, { ...idle, apply: true }).action, 'delete-owned');
    assert.equal(fs.existsSync(f.root), false);
  } finally { f.dispose(); }
});
