#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOwnedRun, saveOwnedMetadata, finalizeOwnedRun } from './owned-run.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts', 'iab-preview.mjs');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-preview-cleanup-')));
let held;
try {
  const edited = path.join(root, 'edited'); fs.mkdirSync(edited);
  const db = path.join(edited, 'mandible-20261004-100000.db');
  const older = path.join(edited, 'mandible-20261003-100000.db');
  for (const [file, content] of [[db, 'edited ledger'], [`${db}-wal`, 'unique WAL'], [older, 'older edits']]) fs.writeFileSync(file, content);
  fs.mkdirSync(path.join(edited, 'artifacts')); fs.writeFileSync(path.join(edited, 'artifacts', 'document'), 'managed edits');
  fs.symlinkSync(db, path.join(edited, 'current.db'));
  fs.writeFileSync(path.join(edited, 'metadata.json'), JSON.stringify({ db }));
  const active = path.join(root, 'active'); fs.mkdirSync(active);
  fs.writeFileSync(path.join(active, 'mandible.pid'), String(process.pid));
  fs.writeFileSync(path.join(active, 'metadata.json'), JSON.stringify({ pidFile: path.join(active, 'mandible.pid') }));
  fs.writeFileSync(path.join(active, 'mandible-20261003-100000.db'), 'superseded writable database');
  held = fs.openSync(path.join(active, 'mandible-20261003-100000.db'), 'r');
  const orphan = path.join(root, 'mandible-20261002-100000.db'); fs.writeFileSync(orphan, 'unknown ownership');
  const generated = path.join(root, 'fixture'); fs.mkdirSync(generated);
  const file = path.join(generated, 'metadata.json');
  const ownership = createOwnedRun({ root: generated, instanceId: 'preview-fixture', project: 'fixture-project', workUnit: 'fixture-work-unit', disposable: true,
    outputs: [{ path: 'db', kind: 'interactive' }, { path: 'stdout.log', kind: 'generated' }] });
  saveOwnedMetadata(file, { ownership });
  fs.writeFileSync(path.join(generated, 'db'), 'disposable fixture ledger'); fs.writeFileSync(path.join(generated, 'stdout.log'), 'raw fixture logs');
  const finalized = finalizeOwnedRun(file, { expectedRevision: 1, outcome: 'assessed', summary: 'Disposable preview fixture completed' });
  const dry = cleanup(false);
  assert.ok(dry.reclaimableBytes > 0); assert.equal(fs.existsSync(path.join(generated, 'db')), true);
  const applied = cleanup(true);
  assert.ok(applied.reclaimedBytes > 0);
  assert.equal(fs.existsSync(generated), false); assert.equal(fs.existsSync(finalized.ownership.receipt), true);
  assert.equal(fs.readFileSync(`${db}-wal`, 'utf8'), 'unique WAL');
  assert.equal(fs.readFileSync(older, 'utf8'), 'older edits');
  assert.equal(fs.readFileSync(path.join(edited, 'artifacts', 'document'), 'utf8'), 'managed edits');
  assert.equal(fs.readFileSync(path.join(active, 'mandible-20261003-100000.db'), 'utf8'), 'superseded writable database');
  assert.equal(fs.readFileSync(orphan, 'utf8'), 'unknown ownership');
  assert.equal(cleanup(true).reclaimedBytes, 0);
  console.log('iab-preview cleanup preservation and disposable reclamation checks passed');
} finally {
  if (held !== undefined) fs.closeSync(held);
  fs.rmSync(root, { recursive: true, force: true });
}

function cleanup(apply) {
  const result = spawnSync(process.execPath, [scriptPath, 'cleanup', '--preview-base-dir', root, '--json', ...(apply ? ['--apply'] : [])], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, MANDIBLE_HOME: path.join(root, 'mandible-home'), MANDIBLE_PREVIEW_BASE_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
