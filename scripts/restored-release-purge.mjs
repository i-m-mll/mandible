import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertLifecycleLockHeld } from './lifecycle-lock.mjs';
import { ownedRunInventory, saveOwnedMetadata } from './owned-run.mjs';
import { applicationIdentity } from './accepted-release.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => !!fs.lstatSync(file, { throwIfNoEntry: false });
const schema = 'mandible-restored-accepted-release-purge@1';
const sha256 = /^[a-f0-9]{64}$/;

function assertInventory(observed, expected) {
  const exact = new Map(expected.map(entry => [entry.path, JSON.stringify(entry)]));
  if (exact.size !== expected.length || observed.some(entry => exact.get(entry.path) !== JSON.stringify(entry))) {
    throw new Error('Quarantine contains bytes or entries outside the verified purge inventory.');
  }
}

export function purgeQuarantinedRelease({
  root, destination, recoveryReceipt, intentDigest, packageSha256, applyToken, inspect, readOwnedFile, syncDirectory,
  validateNew, claim,
}) {
  if (exists(root)) throw new Error('An original release root is present. Quarantine it before purge.');
  const quarantine = path.dirname(destination);
  const purgeReceipt = path.join(quarantine, `${path.basename(destination)}-purge.json`);
  const recorded = exists(purgeReceipt) ? JSON.parse(readOwnedFile(purgeReceipt).bytes) : null;
  if (recorded && (recorded.schema !== schema || recorded.intentDigest !== intentDigest
      || !['pending', 'completed'].includes(recorded.state) || !sha256.test(recorded.inventoryDigest)
      || !Number.isSafeInteger(recorded.entryCount) || recorded.entryCount < 1
      || !Number.isSafeInteger(recorded.apparentBytes) || recorded.apparentBytes < 0
      || (recorded.state === 'pending' && !Array.isArray(recorded.inventory)))) {
    throw new Error('Purge receipt conflicts with the quarantined release.');
  }
  const targetExists = exists(destination);
  if (!recorded && !targetExists) throw new Error('Quarantined release is absent without a purge receipt.');
  if (recorded?.state === 'completed' && targetExists) throw new Error('Completed purge has an unexpected surviving quarantine directory.');
  if (targetExists) {
    const consumers = inspect(destination);
    if (!consumers.idle) throw new Error(consumers.reason || 'Quarantined release consumers could not be ruled out.');
  }
  const observed = targetExists ? ownedRunInventory(quarantine, path.basename(destination)) : [];
  if (!recorded) {
    validateNew();
    if (applicationIdentity(path.join(destination, 'Mandible.app')) !== packageSha256) {
      throw new Error('Quarantined application differs from the sealed whole-app digest.');
    }
  }
  const inventory = recorded?.inventory ?? observed;
  assertInventory(observed, inventory);
  const inventoryDigest = recorded?.state === 'completed' ? recorded.inventoryDigest : digest(JSON.stringify(inventory));
  const token = digest(JSON.stringify([intentDigest, inventoryDigest]));
  const entryCount = recorded?.state === 'completed' ? recorded.entryCount : inventory.length;
  const apparentBytes = recorded?.state === 'completed' ? recorded.apparentBytes
    : inventory.reduce((bytes, entry) => bytes + (entry.size ?? 0), 0);
  if (recorded && (recorded.applyToken !== token || recorded.inventoryDigest !== inventoryDigest
      || recorded.entryCount !== entryCount || recorded.apparentBytes !== apparentBytes)) {
    throw new Error('Purge inventory differs from its recorded token.');
  }
  if (applyToken !== undefined && token !== applyToken) throw new Error('Purge evidence changed since the dry run.');
  const plan = { root, destination, recoveryReceipt, purgeReceipt, packageSha256, apparentBytes };
  if (recorded?.state === 'completed') return { action: 'purged', ...plan };
  if (applyToken === undefined) return { action: 'purge', ...plan, applyToken: token };

  const proof = { schema, intentDigest, inventoryDigest, entryCount, apparentBytes, applyToken: token };
  const pending = { ...proof, inventory, state: 'pending' };
  claim(() => {
    if (exists(root) || exists(destination) !== targetExists) throw new Error('Release custody changed before purge.');
    if (targetExists) {
      const stat = fs.lstatSync(destination);
      const expected = inventory.find(entry => entry.path === path.basename(destination));
      if (!expected || stat.dev !== expected.dev || stat.ino !== expected.ino || !stat.isDirectory()) {
        throw new Error('Quarantine root changed before purge.');
      }
    }
    if (recorded?.state === 'pending') syncDirectory(quarantine);
    else saveOwnedMetadata(purgeReceipt, pending);
  });
  try {
    for (const entry of observed) {
      const file = path.join(quarantine, entry.path);
      assertLifecycleLockHeld();
      const stat = fs.lstatSync(file);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error(`Quarantined entry changed before unlink: ${entry.path}`);
      if (entry.kind === 'directory') fs.rmdirSync(file);
      else fs.unlinkSync(file);
    }
    syncDirectory(quarantine);
    saveOwnedMetadata(purgeReceipt, { ...proof, state: 'completed' });
    return { action: 'purged', ...plan };
  } catch (error) {
    return { action: 'purge-pending', ...plan, reason: error.message };
  }
}
