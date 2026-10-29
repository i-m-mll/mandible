import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun, withOwnedRunLock } from './owned-run.mjs';
import { spawn } from 'node:child_process';
import { processIdentity, stopNativePreview, cleanupNativePreview } from './native-preview.mjs';

test('native cleanup signals only its owned executable and preserves the selected daemon and compact launch receipt', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-native-owner-')));
  const root = path.join(base, 'native'); fs.mkdirSync(root);
  const executable = path.join(root, 'native-shell');
  fs.copyFileSync('/bin/sleep', executable);
  const daemon = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
  const native = spawn(executable, ['120'], { stdio: 'ignore' });
  try {
    await Promise.all([daemon, native].map(child => new Promise((resolve, reject) => {
      child.once('spawn', resolve); child.once('error', reject);
    })));
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'cookies'), 'private native browser state');
    const metadata = path.join(root, 'metadata.json');
    const ownership = createOwnedRun({ root, instanceId: 'preview-fixture', project: 'fixture', workUnit: 'fixture',
      outputs: [{ path: 'profile', kind: 'interactive' }, { path: 'native-shell', kind: 'generated' }] });
    const receipt = { schema: 'mandible-native-preview@1', ownership, executable, profile, pid: native.pid,
      processIdentity: processIdentity(native.pid), origin: 'https://preview-fixture.mandible.localhost:19421' };
    saveOwnedMetadata(metadata, { ...receipt, pid: daemon.pid });
    await assert.rejects(stopNativePreview(metadata), /identity changed/);
    assert.ok(processIdentity(daemon.pid)); assert.ok(processIdentity(native.pid));
    saveOwnedMetadata(metadata, receipt);
    await assert.rejects(cleanupNativePreview(metadata), /Stop/);
    await stopNativePreview(metadata);
    assert.equal(processIdentity(native.pid), null);
    assert.ok(processIdentity(daemon.pid));
    await assert.rejects(cleanupNativePreview(metadata), /explicitly discard/);
    const cleaned = await cleanupNativePreview(metadata, { disposition: 'discard' });
    assert.equal(fs.existsSync(root), false);
    assert.equal(JSON.parse(fs.readFileSync(cleaned.receipt)).nativePreview.executable, executable);
    assert.ok(processIdentity(daemon.pid));
  } finally {
    for (const child of [daemon, native]) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all([daemon, native].map(child => child.exitCode !== null || child.signalCode !== null ? undefined
      : new Promise(resolve => child.once('exit', resolve))));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

const idle = { inspect: () => ({ idle: true }) };
test('disposable generated scratch preserves unknown entries and waits for consumers', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-generated-run-'));
  const root = path.join(base, 'run'); fs.mkdirSync(root);
  const outside = path.join(base, 'keep'); fs.writeFileSync(outside, 'outside');
  const metadataFile = path.join(root, 'metadata.json');
  const log = path.join(root, 'log'); fs.writeFileSync(log, 'generated');
  const ownership = createOwnedRun({ root, instanceId: 'fixture', project: 'fixture', workUnit: 'fixture', disposable: true, outputs: [{ path: 'log', kind: 'generated' }] });
  saveOwnedMetadata(metadataFile, { ownership });
  const child = spawn(process.execPath, ['--eval', `require('fs').openSync(${JSON.stringify(log)}, 'r'); console.log('ready'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const final = finalizeOwnedRun(metadataFile, { expectedRevision: 1, outcome: 'failed', summary: 'Disposable scratch finished' }, { inspect: () => { throw new Error('Consumer inspection belongs to deletion'); } });
    fs.writeFileSync(path.join(root, 'extra'), 'generated after disposition');
    fs.symlinkSync(outside, path.join(root, 'link'));
    assert.equal(cleanupOwnedRun(metadataFile, { apply: true }).action, 'skip');
    assert.equal(fs.existsSync(log), true);
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    assert.equal(cleanupOwnedRun(metadataFile).action, 'delete-owned');
    assert.equal(fs.existsSync(log), true);
    assert.equal(cleanupOwnedRun(metadataFile, { apply: true }).action, 'delete-owned');
    assert.equal(fs.readFileSync(path.join(root, 'extra'), 'utf8'), 'generated after disposition');
    fs.unlinkSync(path.join(root, 'extra')); fs.unlinkSync(path.join(root, 'link'));
    cleanupOwnedRun(metadataFile, { apply: true });
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    assert.equal(JSON.parse(fs.readFileSync(final.ownership.receipt)).cleanup, 'completed');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); fs.rmSync(base, { recursive: true, force: true }); }
});

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
      assert.throws(() => finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'accepted', converged: true, disposition: 'transferred', destination, transferReference: 'artifact-version:fixture-transfer', summary: 'Accepted documents' }, idle), /not verified/);
      fs.cpSync(path.join(f.root, 'artifacts'), path.join(destination, 'artifacts'), { recursive: true });
      const finalized = finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'accepted', converged: true, disposition: 'transferred', destination, transferReference: 'artifact-version:fixture-transfer', summary: 'Accepted documents' }, idle);
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

test('investigation review deadline never substitutes for explicit release', () => {
  const f = fixture();
  try {
    assert.throws(() => finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'investigating', summary: 'Need reproduction', reviewBy: '2099-01-01' }, idle), /seven days/);
    finalizeOwnedRun(f.metadata, { expectedRevision: 1, outcome: 'investigating', summary: 'Need reproduction', reviewBy: new Date(Date.now() + 60000).toISOString() }, idle);
    assert.match(cleanupOwnedRun(f.metadata, { ...idle, apply: true }).reason, /investigation owned/);
    const metadata = JSON.parse(fs.readFileSync(f.metadata)); metadata.ownership.investigation.reviewBy = Date.now() - 1;
    saveOwnedMetadata(f.metadata, metadata);
    const result = cleanupOwnedRun(f.metadata, { ...idle, apply: true });
    assert.equal(fs.existsSync(path.join(f.root, 'stdout.log')), true);
    assert.equal(fs.readFileSync(path.join(f.root, 'ledger.db'), 'utf8'), 'unique edited ledger');
    assert.equal(result.action, 'skip');
    const latest = JSON.parse(fs.readFileSync(f.metadata));
    finalizeOwnedRun(f.metadata, { expectedRevision: latest.ownership.revision, outcome: 'abandoned', disposition: 'discard', summary: 'Owner explicitly discarded reproduction' }, idle);
    assert.equal(cleanupOwnedRun(f.metadata, { ...idle, apply: true }).remaining.length, 0);
  } finally { f.dispose(); }
});
