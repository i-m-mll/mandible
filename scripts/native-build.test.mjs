import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeCandidate, verifyNativeBundle, verifyNativeSelection, stageNativeBuild, runNativeBuildPhase } from './native-build.mjs';
import { trackedSourceDigest } from './build-revision.mjs';
import { createOwnedRun, saveOwnedMetadata, processIdentity } from './owned-run.mjs';
import { stopNativePreview, cleanupNativePreview } from './native-preview.mjs';
import { acquirePreviewConsumer, reacquirePreviewConsumer, publishPreviewConsumer } from './preview-custody.mjs';

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-contract-')));
  const runId = randomUUID();
  const root = path.join(base, `native-${runId}`); fs.mkdirSync(root);
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const file = path.join(root, 'metadata.json');
  const ownership = createOwnedRun({ root, runId, instanceId: 'fixture', project: 'fixture', workUnit: 'fixture',
    outputs: [{ path: 'profile', kind: 'interactive' }, { path: 'build', kind: 'generated' }, { path: 'build.log', kind: 'generated' }] });
  const receipt = { schema: 'mandible-native-preview@1', ownership, receipt: file, profile, executable: path.join(root, 'app/native') };
  const save = () => saveOwnedMetadata(file, receipt); save();
  return { base, root, file, receipt, save, dispose: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}

test('native bundle must match current selected backend source bytes and exact commit', () => {
  const f = fixture();
  try {
    git(f.root, 'init', '-q');
    fs.writeFileSync(path.join(f.root, 'package.json'), '{}');
    git(f.root, 'add', 'package.json');
    git(f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const candidate = { commit: git(f.root, 'rev-parse', 'HEAD'), source_digest: trackedSourceDigest(f.root) };
    fs.mkdirSync(path.join(f.root, 'dist')); fs.writeFileSync(path.join(f.root, 'dist/build-revision.json'), JSON.stringify(candidate));
    assert.deepEqual(nativeCandidate(f.root), candidate);
    assert.throws(() => verifyNativeSelection({ instanceEnv: { MANDIBLE_BACKEND_GENERATION: candidate.commit },
      ownership: { source: { ...candidate, source_digest: 'f'.repeat(64) } } }, candidate), /generation.source identity/);
    const bundle = path.join(f.root, 'fixture.app'); fs.mkdirSync(path.join(bundle, 'Contents/Resources'), { recursive: true });
    const marker = path.join(bundle, 'Contents/Resources/build-revision.json');
    fs.writeFileSync(marker, JSON.stringify({ ...candidate, commit: 'a'.repeat(40) }));
    assert.throws(() => verifyNativeBundle(bundle, candidate), /differs/);
    fs.writeFileSync(marker, JSON.stringify(candidate));
    assert.deepEqual(verifyNativeBundle(bundle, candidate), candidate);
    fs.writeFileSync(path.join(f.root, 'package.json'), '{"changed":true}');
    assert.throws(() => nativeCandidate(f.root), /sources differ/);
  } finally { f.dispose(); }
});

test('failed build has exact owned residue, retry succeeds, and repeated cleanup preserves borrowed paths', async () => {
  const f = fixture();
  try {
    const borrowed = path.join(f.base, 'borrowed-cache'); fs.mkdirSync(borrowed); fs.writeFileSync(path.join(borrowed, 'archive'), 'keep');
    const phase = args => runNativeBuildPhase({ command: '/bin/sh', args: ['-c', args], cwd: f.root, env: process.env,
      log: path.join(f.root, 'build.log'), budgetMs: 5000, receipt: f.receipt, save: f.save, identity: processIdentity });
    await assert.rejects(phase('mkdir -p build; echo failed > build/partial; exit 7'), /failed \(7\)/);
    assert.equal(processIdentity(f.receipt.buildProcess.pid), null);
    await phase('echo retry > build/complete');
    assert.equal(fs.readFileSync(path.join(f.root, 'build/complete'), 'utf8'), 'retry\n');
    await stopNativePreview(f.file);
    const result = await cleanupNativePreview(f.file, { disposition: 'discard' });
    assert.equal(fs.existsSync(f.root), false);
    await stopNativePreview(f.file); await cleanupNativePreview(f.file, { disposition: 'discard' });
    assert.equal(JSON.parse(fs.readFileSync(result.receipt)).cleanup, 'completed');
    assert.equal(fs.readFileSync(path.join(borrowed, 'archive'), 'utf8'), 'keep');
    fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, 'foreign'), 'replacement');
    await assert.rejects(cleanupNativePreview(f.file, { disposition: 'discard' }), /identity changed/);
    assert.equal(fs.readFileSync(path.join(f.root, 'foreign'), 'utf8'), 'replacement');
  } finally { f.dispose(); }
});

test('build deadline stops its real child group and leaves a reclaimable failure receipt', async () => {
  const f = fixture();
  try {
    await assert.rejects(runNativeBuildPhase({ command: '/bin/sh', args: ['-c', 'sleep 120 & wait'], cwd: f.root, env: process.env,
      log: path.join(f.root, 'build.log'), budgetMs: 50, receipt: f.receipt, save: f.save, identity: processIdentity }), /exceeded/);
    assert.equal(processIdentity(f.receipt.buildProcess.pid), null);
    await cleanupNativePreview(f.file, { disposition: 'discard' });
    assert.equal(fs.existsSync(f.root), false);
  } finally { f.dispose(); }
});

test('pending native build is retained through stop and blocks attachment after teardown begins', async () => {
  const f = fixture();
  try {
    const parentRoot = path.join(f.base, 'backend'); fs.mkdirSync(parentRoot);
    const ownership = createOwnedRun({ root: parentRoot, instanceId: 'fixture', project: 'fixture', workUnit: 'fixture', outputs: [] });
    ownership.state = 'active'; ownership.lifecycle = { phase: 'ready' }; ownership.source = { commit: 'a'.repeat(40), source_digest: 'b'.repeat(64) };
    const parent = { root: parentRoot, runId: ownership.runId };
    const metadata = { ownership, instanceEnv: { MANDIBLE_BACKEND_GENERATION: ownership.source.commit } };
    const parentFile = path.join(parentRoot, 'metadata.json'); saveOwnedMetadata(parentFile, metadata);
    f.receipt.parent = parent; f.save();
    const reservation = await acquirePreviewConsumer(parent, { consumerId: f.receipt.ownership.runId, runId: f.receipt.ownership.runId,
      root: f.root, rootIdentity: f.receipt.ownership.rootIdentity, metadataFile: f.file, borrowedBackend: true,
      expectedGeneration: ownership.source.commit, expectedSource: ownership.source });
    f.receipt.reservation = reservation; f.save();
    await stopNativePreview(f.file);
    const stopped = JSON.parse(fs.readFileSync(parentFile));
    assert.equal(stopped.ownership.consumers[0].state, 'pending');
    stopped.ownership.lifecycle.teardown = true; saveOwnedMetadata(parentFile, stopped);
    await assert.rejects(publishPreviewConsumer(reservation, {}), /reservation or generation changed/);
    await cleanupNativePreview(f.file, { disposition: 'discard' });
    assert.equal(JSON.parse(fs.readFileSync(parentFile)).ownership.consumers[0].state, 'released');
    assert.equal(fs.existsSync(parentRoot), true);
  } finally { f.dispose(); }
});


test('stopped native run reacquires the refreshed candidate while preserving profile and warm target', async () => {
  const f = fixture();
  try {
    const parentRoot = path.join(f.base, 'backend'); fs.mkdirSync(parentRoot);
    const ownership = createOwnedRun({ root: parentRoot, instanceId: 'fixture', project: 'fixture', workUnit: 'fixture', outputs: [] });
    ownership.state = 'active'; ownership.lifecycle = { phase: 'ready' }; ownership.source = { commit: 'a'.repeat(40), source_digest: 'b'.repeat(64) };
    const original = { ...ownership.source };
    const parent = { root: parentRoot, runId: ownership.runId };
    const metadata = { ownership, instanceEnv: { MANDIBLE_BACKEND_GENERATION: original.commit } };
    const parentFile = path.join(parentRoot, 'metadata.json'); saveOwnedMetadata(parentFile, metadata);
    const child = { consumerId: f.receipt.ownership.runId, runId: f.receipt.ownership.runId, root: f.root,
      rootIdentity: f.receipt.ownership.rootIdentity, metadataFile: f.file, borrowedBackend: true,
      expectedGeneration: original.commit, expectedSource: original };
    const reservation = await acquirePreviewConsumer(parent, child);
    f.receipt.parent = parent; f.receipt.build = original; f.receipt.status = 'stopped'; f.save();
    await publishPreviewConsumer(reservation, { build: original });
    const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const staged = stageNativeBuild({ worktree, root: f.root, candidate: original });
    fs.mkdirSync(staged.env.CARGO_TARGET_DIR, { recursive: true });
    const warm = path.join(staged.env.CARGO_TARGET_DIR, 'warm'); fs.writeFileSync(warm, 'compiled dependency');
    const stale = path.join(staged.crate, 'removed-source.rs'); fs.writeFileSync(stale, 'stale');
    const profileFile = path.join(f.receipt.profile, 'cookies'); fs.writeFileSync(profileFile, 'keep user state');
    const refreshed = JSON.parse(fs.readFileSync(parentFile));
    const candidate = { commit: 'c'.repeat(40), source_digest: 'd'.repeat(64) };
    refreshed.ownership.source = candidate; refreshed.instanceEnv.MANDIBLE_BACKEND_GENERATION = candidate.commit;
    saveOwnedMetadata(parentFile, refreshed);
    const request = { ...child, expectedGeneration: candidate.commit, expectedSource: candidate,
      expectedPriorGeneration: original.commit, expectedPriorSource: original };
    f.receipt.pid = process.pid; f.save();
    await assert.rejects(reacquirePreviewConsumer(parent, request), /live process/);
    delete f.receipt.pid; f.save();
    const reacquired = await reacquirePreviewConsumer(parent, request);
    assert.equal(reacquired.state, 'pending');
    stageNativeBuild({ worktree, root: f.root, candidate });
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.readFileSync(warm, 'utf8'), 'compiled dependency');
    assert.equal(fs.readFileSync(profileFile, 'utf8'), 'keep user state');
    f.receipt.reservation = reacquired; f.save();
    await cleanupNativePreview(f.file, { disposition: 'discard' });
    assert.equal(JSON.parse(fs.readFileSync(parentFile)).ownership.consumers[0].state, 'released');
  } finally { f.dispose(); }
});
