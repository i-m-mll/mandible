#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Database from '../src/sqlite.ts';
import { acceptedReleaseFilesystemReferences, applicationIdentity, readImmutableAcceptedRelease } from './accepted-release.mjs';
import { acceptedReleaseDatabaseReferences, acceptedReleaseProducerReferences } from './accepted-release-retention.mjs';
import { purgeQuarantinedRelease } from './restored-release-purge.mjs';
import { generatedOwnerIdle } from './generated-scratch.mjs';
import { assertLifecycleLockHeld, withInstallationGatewayLock } from './lifecycle-lock.mjs';
import { inspectRunConsumers, OWNED_RUN_SCHEMA, ownedRunReceipt, saveOwnedMetadata, withOwnedRunLock } from './owned-run.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = /^[a-f0-9]{64}$/;
const historicalRecoverySchema = 'mandible-restored-accepted-release-quarantine@1';
const recoverySchema = 'mandible-restored-accepted-release-quarantine@2';
const generatedDiscardManifestDigest = digest(JSON.stringify([
  { path: 'Mandible.app', kind: 'generated', disposition: 'disposable', manifest: [] },
]));

function statIfPresent(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function ownedDirectory(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || fs.realpathSync(file) !== file || stat.uid !== process.getuid()
      || (stat.mode & 0o077)) throw new Error(`Unrecognized directory custody: ${file}`);
  return stat;
}

function ownedFileStat(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
    throw new Error(`Unrecognized receipt or metadata file: ${file}`);
  }
  return stat;
}

function ownedFile(file) {
  return { stat: ownedFileStat(file), bytes: fs.readFileSync(file) };
}

function onlyApp(outputs) {
  return Array.isArray(outputs) && outputs.length === 1 && outputs[0] === 'Mandible.app';
}

function readDisposition(handle, receipt) {
  const outcome = ownedRunReceipt(handle);
  if (!outcome) return null;
  if (outcome.schema !== OWNED_RUN_SCHEMA || outcome.outcome !== 'abandoned'
      || outcome.disposition !== 'discard' || !['pending', 'completed'].includes(outcome.cleanup)
      || outcome.cleanup === 'completed' && (!Array.isArray(outcome.remaining) || outcome.remaining.length)
      || !outcome.summary?.trim()
      || !Number.isFinite(Date.parse(outcome.finalizedAt)) || !sha256.test(outcome.manifestDigest ?? '')
      || !outcome.instanceId || outcome.project !== receipt.retention.project || outcome.workUnit !== receipt.retention.work_unit
      || !Number.isSafeInteger(outcome.rootIdentity?.dev) || !Number.isSafeInteger(outcome.rootIdentity?.ino)) {
    throw new Error('Recorded discard outcome does not bind this release owner.');
  }
  if (outcome.generatedRecovery && !onlyApp(outcome.generatedRecovery.outputs)) {
    throw new Error('Completed discard outcome covers unexpected outputs.');
  }
  return outcome;
}

function readRestoredOwner(location, outcome, receipt) {
  const file = path.join(location, 'metadata.json');
  const { stat, bytes } = ownedFile(file);
  const metadata = JSON.parse(bytes);
  const run = metadata.ownership;
  if (run?.schema !== OWNED_RUN_SCHEMA || run.root !== receipt.package.handle.root || run.runId !== receipt.package.handle.runId
      || !run.instanceId || run.project !== receipt.retention.project || run.workUnit !== receipt.retention.work_unit
      || !Number.isSafeInteger(run.rootIdentity?.dev) || !Number.isSafeInteger(run.rootIdentity?.ino)
      || outcome && (run.instanceId !== outcome.instanceId
        || run.rootIdentity.dev !== outcome.rootIdentity.dev || run.rootIdentity.ino !== outcome.rootIdentity.ino)) {
    throw new Error('Restored metadata does not name the original release owner and root identity.');
  }
  const output = run.outputs?.length === 1 ? run.outputs[0] : null;
  const creating = run.state === 'creating' && run.disposable === false && run.cleanup?.state === 'pending'
    && (!outcome || stat.mtimeMs < Date.parse(outcome.finalizedAt))
    && output?.kind === 'interactive' && output?.disposition === 'pending';
  const terminal = outcome && run.state === 'terminal' && run.outcome === outcome.outcome && run.receipt === outcome.receipt
    && output?.disposition === 'disposable' && digest(JSON.stringify(run.outputs)) === outcome.manifestDigest;
  if (output?.path !== receipt.package.path || !(creating || terminal)) {
    throw new Error('Release metadata does not match the prior disposition or its creating owner.');
  }
  if (terminal && !outcome.generatedRecovery && (!Array.isArray(output.manifest)
      || !output.manifest.some(entry => entry.path === receipt.package.path && entry.kind === 'directory'))) {
    throw new Error('Inventoried disposition requires its exact terminal output inventory.');
  }
  const producer = metadata.pendingAcceptance;
  if (!outcome && (!producer || !run.processOwner?.identity)) {
    throw new Error('Superseded release must bind its original acceptance producer.');
  }
  if (producer && (producer.runId !== run.runId || producer.recordId !== receipt.acceptance.record_id
      || producer.requestId !== receipt.acceptance.request_id || !path.isAbsolute(producer.scratchRoot ?? ''))) {
    throw new Error('Restored metadata names conflicting acceptance producer custody.');
  }
  return { metadata, metadataDigest: digest(bytes) };
}

function dispositionAuthority(db, reference, receipt, outcome) {
  if (outcome?.generatedRecovery && (!onlyApp(outcome.generatedRecovery.outputs) || outcome.manifestDigest !== generatedDiscardManifestDigest)) {
    throw new Error('Generated outcome does not prove discard of exactly Mandible.app.');
  }
  const locator = reference.slice(reference.lastIndexOf(':'));
  const { record_id, request_id } = receipt.acceptance;
  const legacy = record_id === null && request_id === null;
  if (!legacy && (typeof record_id !== 'string' || !record_id || typeof request_id !== 'string' || !request_id)) {
    throw new Error('Sealed release has incomplete acceptance identity.');
  }
  const rows = db.prepare(`SELECT a.id, a.auth_request_id, a.status, a.pin_sha, a.tree_sha, a.base_sha, a.head_sha,
    json_extract(a.result_json, '$.receipt') AS reference, r.custody_work_unit_id, r.id AS request_exists,
    r.status AS request_status, r.superseded_by_request_id, r.merge_finalized_at
    FROM auth_candidate_acceptances a LEFT JOIN auth_requests r ON r.id = a.auth_request_id
    WHERE a.id = ? OR substr(json_extract(a.result_json, '$.receipt'), -length(?)) = ?`).all(record_id, locator, locator);
  const selections = db.prepare(`SELECT id, state, replacement_action_id, auth_request_id,
    json_extract(payload, '$.payload.acceptanceId') AS acceptance_id, json_extract(payload, '$.payload.reference') AS reference FROM auth_request_actions
    WHERE kind = 'checkpoint_add' AND json_extract(payload, '$.kind') = 'accepted-release'
    AND substr(json_extract(payload, '$.payload.reference'), -length(?)) = ?`).all(locator, locator);
  const row = rows[0];
  if (rows.length === 1 && row.reference === reference && row.status === 'passed' && row.request_exists
      && (!record_id || row.id === record_id) && (!request_id || row.auth_request_id === request_id)
      && (!row.custody_work_unit_id || row.custody_work_unit_id === receipt.retention.work_unit)
      && Object.entries(receipt.candidate).every(([key, value]) => row[key] === value)
      && selections.length && selections.every(selection => selection.reference === reference && selection.acceptance_id === row.id)
      && selections.some(selection => selection.auth_request_id === row.auth_request_id)) {
    if (outcome) return { kind: 'ledger', acceptanceId: row.id, requestId: row.auth_request_id };
    const selection = selections.length === 1 ? selections[0] : null;
    const replacement = selection?.replacement_action_id && db.prepare('SELECT auth_request_id FROM auth_request_actions WHERE id = ?')
      .get(selection.replacement_action_id);
    const startedDelivery = db.prepare('SELECT 1 FROM auth_hook_executions WHERE auth_request_id = ? AND attempts > 0 LIMIT 1').get(row.auth_request_id);
    if (!legacy && row.request_status === 'superseded' && row.superseded_by_request_id && row.merge_finalized_at === null
        && selection?.state === 'vetoed' && replacement?.auth_request_id === row.superseded_by_request_id && !startedDelivery) {
      return { kind: 'superseded', acceptanceId: row.id, requestId: row.auth_request_id, selectionId: selection.id,
        replacementId: row.superseded_by_request_id, replacementActionId: selection.replacement_action_id };
    }
    throw new Error('Release has neither a recorded discard nor an exact supersession of its unpublished selection.');
  }
  if (outcome && legacy && !rows.length && !selections.length) return { kind: 'prior-discard' };
  throw new Error('Exact ledger acceptance and selection could not be established.');
}

function checkReferences(db, home, reference, receipt) {
  const reasons = [...acceptedReleaseFilesystemReferences(home, reference), ...acceptedReleaseDatabaseReferences(db, reference, receipt, home)];
  if (reasons.length) throw new Error(reasons.join('; '));
}

function checkProducers(metadata, outcome) {
  for (const owner of [metadata.ownership, outcome?.generatedRecovery].filter(Boolean)) {
    if ((owner.processOwner || owner.processes?.length) && !generatedOwnerIdle(owner, metadata.ownership.root ?? outcome?.root)) {
      throw new Error('Acceptance producer lifetime is live or uncertain.');
    }
  }
  if (metadata.pendingAcceptance && statIfPresent(metadata.pendingAcceptance.scratchRoot)) {
    const producers = acceptedReleaseProducerReferences(metadata);
    if (producers.length) throw new Error(producers.join('; '));
  }
}

function checkRootEntries(root) {
  const entries = new Set(fs.readdirSync(root));
  if (entries.delete('.DS_Store')) ownedFileStat(path.join(root, '.DS_Store'));
  if (!entries.delete('Mandible.app') || !entries.delete('metadata.json') || entries.size) {
    throw new Error('Restored release has missing or unexpected entries.');
  }
}

function checkQuarantine(directory, volume) {
  if (statIfPresent(directory) && ownedDirectory(directory).dev !== volume) {
    throw new Error('Quarantine must be on the same volume as the restored release.');
  }
}

function dispositionDigest(file, schema) {
  if (!statIfPresent(file)) return null;
  const bytes = ownedFile(file).bytes;
  if (schema === historicalRecoverySchema) return digest(bytes);
  const { cleanup, remaining, reason, unlinkedApparentBytes, physicalRecovery, ...disposition } = JSON.parse(bytes);
  return digest(JSON.stringify(disposition));
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export async function recoverRestoredAcceptedRelease(db, home, runId, { applyToken, purge = false, inspect = inspectRunConsumers } = {}) {
  home = fs.realpathSync(home);
  const storage = path.join(home, 'accepted-releases');
  if (typeof runId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId)) {
    throw new Error('An exact acceptance run UUID is required.');
  }
  if (applyToken !== undefined && !sha256.test(applyToken)) throw new Error('Apply requires the exact token returned by a dry run.');
  const root = path.join(storage, runId);
  const quarantine = path.join(storage, '.restored-quarantine');
  const destination = path.join(quarantine, runId);
  const recoveryReceipt = path.join(quarantine, `${runId}.json`);
  let moved = false;
  const recover = () => {
    const receipts = path.join(storage, '.receipts');
    ownedDirectory(receipts);
    const seal = path.join(receipts, `${runId}-accepted-release.json`);
    const sealDigest = digest(ownedFile(seal).bytes);
    const reference = `accepted-release:${sealDigest}:${Buffer.from(seal).toString('base64url')}`;
    const receipt = readImmutableAcceptedRelease(reference);
    const handle = receipt.package.handle;
    if (handle.root !== root || handle.runId !== runId || !sha256.test(receipt.package.sha256 ?? '')) {
      throw new Error('Sealed release does not bind this exact package and run.');
    }
    const outcomeFile = path.join(receipts, `${runId}.json`);
    const outcome = readDisposition(handle, receipt);
    const storageStat = ownedDirectory(storage);
    checkQuarantine(quarantine, storageStat.dev);
    const existingIntent = statIfPresent(recoveryReceipt) ? ownedFile(recoveryReceipt).bytes : null;
    const schema = existingIntent ? JSON.parse(existingIntent).schema : recoverySchema;
    if (![recoverySchema, historicalRecoverySchema].includes(schema)) throw new Error('Unknown quarantine receipt schema.');
    const outcomeDigest = dispositionDigest(outcomeFile, schema);
    if (purge) {
      checkReferences(db, home, reference, receipt);
      const authority = dispositionAuthority(db, reference, receipt, outcome);
      if (!existingIntent) throw new Error('No exact quarantine receipt is available.');
      const intentBytes = existingIntent;
      const intent = JSON.parse(intentBytes);
      const quarantinePlan = { root, destination, reference, packageSha256: receipt.package.sha256, authority, recoveryReceipt };
      const expectedToken = digest(JSON.stringify([quarantinePlan, intent.rootIdentity?.dev, intent.rootIdentity?.ino, intent.metadataDigest, outcomeDigest]));
      if (Object.entries(quarantinePlan).some(([key, value]) => JSON.stringify(intent[key]) !== JSON.stringify(value))
          || intent.outcomeDigest !== outcomeDigest || intent.applyToken !== expectedToken || !sha256.test(intent.metadataDigest ?? '')) {
        throw new Error('Quarantine intent does not bind the historical release and restored inode.');
      }
      if (statIfPresent(destination)) {
        const stat = ownedDirectory(destination);
        if (stat.dev !== intent.rootIdentity.dev || stat.ino !== intent.rootIdentity.ino) throw new Error('Quarantine destination changed.');
      }
      checkProducers({ ownership: {} }, outcome);
      return purgeQuarantinedRelease({
        root, destination, recoveryReceipt, intentDigest: digest(intentBytes), packageSha256: receipt.package.sha256, applyToken, inspect,
        readOwnedFile: ownedFile, syncDirectory,
        validateNew: () => {
          checkRootEntries(destination);
          const { metadata, metadataDigest } = readRestoredOwner(destination, outcome, receipt);
          if (metadataDigest !== intent.metadataDigest) throw new Error('Quarantine metadata changed.');
          checkProducers(metadata, outcome);
        },
        claim: mark => db.transaction(() => {
          checkReferences(db, home, reference, receipt);
          const freshAuthority = dispositionAuthority(db, reference, receipt, outcome);
          if (JSON.stringify(freshAuthority) !== JSON.stringify(authority)
              || digest(ownedFile(seal).bytes) !== sealDigest || dispositionDigest(outcomeFile, schema) !== outcomeDigest
              || digest(ownedFile(recoveryReceipt).bytes) !== digest(intentBytes)) throw new Error('Quarantine custody changed before purge.');
          assertLifecycleLockHeld();
          mark();
        }).immediate(),
      });
    }
    const alreadyMoved = !!statIfPresent(destination);
    if (alreadyMoved && statIfPresent(root)) throw new Error(`Quarantine destination already exists: ${destination}`);
    const location = alreadyMoved ? destination : root;
    const rootStat = ownedDirectory(location);
    if (rootStat.dev !== storageStat.dev) throw new Error('Restored release root is on another volume.');
    const { metadata, metadataDigest } = readRestoredOwner(location, outcome, receipt);
    checkRootEntries(location);
    checkReferences(db, home, reference, receipt);
    const authority = dispositionAuthority(db, reference, receipt, outcome);
    checkProducers(metadata, outcome);
    if (!alreadyMoved) {
      const consumers = inspect(root);
      if (!consumers.idle) throw new Error(consumers.reason || 'Restored release consumers could not be ruled out.');
    }
    const app = path.join(location, receipt.package.path);
    if (!fs.lstatSync(app).isDirectory() || applicationIdentity(app) !== receipt.package.sha256) {
      throw new Error('Restored application differs from the sealed whole-app digest.');
    }
    const plan = { root, destination, reference, packageSha256: receipt.package.sha256, authority, recoveryReceipt };
    const token = digest(JSON.stringify([plan, rootStat.dev, rootStat.ino, metadataDigest, outcomeDigest]));
    if (applyToken !== undefined && token !== applyToken) throw new Error('Recovery evidence changed since the dry run.');
    const intent = { schema, ...plan, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      metadataDigest, outcomeDigest, applyToken: token };
    const inspectIntent = () => {
      if (!statIfPresent(recoveryReceipt)) return false;
      const prior = JSON.parse(ownedFile(recoveryReceipt).bytes);
      if (JSON.stringify(prior) !== JSON.stringify(intent)) throw new Error('Quarantine receipt conflicts with this recovery.');
      return true;
    };
    if (alreadyMoved) {
      if (!inspectIntent()) throw new Error('Quarantine destination has no matching recovery receipt.');
      moved = true;
      if (applyToken !== undefined) {
        syncDirectory(quarantine);
        syncDirectory(storage);
      }
      return { action: 'quarantined', ...plan };
    }
    inspectIntent();
    if (applyToken === undefined) return { action: 'quarantine', ...plan, applyToken: token };

    db.transaction(() => {
      checkReferences(db, home, reference, receipt);
      const freshAuthority = dispositionAuthority(db, reference, receipt, outcome);
      if (JSON.stringify(freshAuthority) !== JSON.stringify(authority)) throw new Error('Disposition authority changed during recovery.');
      const currentRoot = ownedDirectory(root);
      if (currentRoot.ino !== rootStat.ino || currentRoot.dev !== rootStat.dev
          || digest(ownedFile(seal).bytes) !== sealDigest
          || dispositionDigest(outcomeFile, schema) !== outcomeDigest
          || digest(ownedFile(path.join(root, 'metadata.json')).bytes) !== metadataDigest) {
        throw new Error('Release custody changed during recovery.');
      }
      checkRootEntries(root);
      assertLifecycleLockHeld();
      if (!statIfPresent(quarantine)) fs.mkdirSync(quarantine, { mode: 0o700 });
      checkQuarantine(quarantine, rootStat.dev);
      if (statIfPresent(destination)) throw new Error(`Quarantine destination already exists: ${destination}`);
      syncDirectory(storage);
      if (inspectIntent()) syncDirectory(quarantine);
      else saveOwnedMetadata(recoveryReceipt, intent);
      assertLifecycleLockHeld();
      fs.renameSync(root, destination);
      moved = true;
    }).immediate();
    syncDirectory(quarantine);
    syncDirectory(storage);
    return { action: 'quarantined', ...plan };
  };
  try {
    ownedDirectory(storage);
    if (applyToken === undefined) return db.transaction(recover).deferred();
    return await withInstallationGatewayLock(home, () => withOwnedRunLock(root, recover, { recoverStale: true }));
  } catch (error) {
    return { action: moved ? 'quarantine-unconfirmed' : 'preserve', root, destination, reason: error.message };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    home: { type: 'string' }, apply: { type: 'string' }, purge: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: bun scripts/recover-restored-accepted-release.mjs <run-uuid> [--home <path>] [--purge] [--apply <dry-run-token>]');
  } else {
    if (positionals.length !== 1) throw new Error('Supply exactly one acceptance run UUID. See --help.');
    const home = fs.realpathSync(values.home || process.env.MANDIBLE_HOME || path.join(os.homedir(), '.mandible'));
    const database = values.home ? path.join(home, 'mandible.db') : process.env.MANDIBLE_DB || path.join(home, 'mandible.db');
    const db = new Database(database, { readonly: values.apply === undefined, fileMustExist: true });
    try {
      const result = await recoverRestoredAcceptedRelease(db, home, positionals[0], { applyToken: values.apply, purge: values.purge });
      console.log(JSON.stringify(result));
      if (result.action === 'preserve' || result.action === 'quarantine-unconfirmed' || result.action === 'purge-pending') process.exitCode = 1;
    } finally { db.close(); }
  }
}
