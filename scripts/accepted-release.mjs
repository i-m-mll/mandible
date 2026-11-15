import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applicationIdentity, installedFileIdentity, readInstalledReleaseIdentity } from './installed-release.mjs';
import { createOwnedRun, saveOwnedBytes, saveOwnedMetadata, ownedRunIdentityMatches, finalizeOwnedRun, cleanupOwnedRun, inspectRunConsumers, ownedRunReceipt, recoverOwnedRunDisposition } from './owned-run.mjs';
import { withInstallationGatewayLock } from './lifecycle-lock.mjs';
import { acceptedReleaseHome, releaseRunSchema, retireAcceptedReleaseRunLock, withAcceptedReleaseRunLock } from './accepted-release-lock.mjs';
import { readBundleOwner } from './bundle-services.mjs';
import { generatedOwnerIdle } from './generated-scratch.mjs';
import { readRuntimeHandoffLock, runtimeHandoffSettled } from './runtime-handoff-lock.mjs';
import { LEGACY_ACCEPTED_RELEASE_SCHEMA, ACCEPTANCE_CERTIFICATE_SCHEMA, ACCEPTANCE_CERTIFICATE_LIMIT, ACCEPTANCE_CONTRACT,
  boundedAcceptanceBytes, validateAcceptanceCertificate } from './acceptance-certificate.mjs';
import { isVersionedReleaseStorage } from './accepted-release-storage.mjs';

export const ACCEPTED_RELEASE_SCHEMA = LEGACY_ACCEPTED_RELEASE_SCHEMA;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const candidateKeys = ['pin_sha', 'tree_sha', 'base_sha', 'head_sha'];

export { applicationIdentity } from './installed-release.mjs';

function validateCandidate(candidate) {
  if (!candidateKeys.every(key => /^[a-f0-9]{40}$/.test(candidate?.[key] ?? ''))) throw new Error('Accepted release requires exact pin, tree, base and head.');
}

function referenceFor(file) {
  const reference = `accepted-release:${installedFileIdentity(file).sha256}:${Buffer.from(file).toString('base64url')}`;
  if (reference.length > 512) throw new Error('Accepted release reference exceeds the legacy receipt boundary.');
  return reference;
}

/** Acquisition checks custody without hashing the application in a database write. */
export function assertAcceptedReleaseAvailable(reference) {
  acceptedReleaseOwner(readImmutableAcceptedRelease(reference));
}

export function emptyPreAdmissionHandoff(directory) {
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const stat = fs.lstatSync(directory);
  return new RegExp(`^${uuid}-${uuid}$`).test(path.basename(directory)) && stat.isDirectory() && !stat.isSymbolicLink()
    && fs.readdirSync(directory).length === 0;
}

/**
 * The accepted releases a handoff journal still needs. Its predecessor's release
 * matters only while the journal holds mutation authority. Its own release holds
 * the helper that drives it, so it is needed until that helper is fenced.
 */
export function handoffRetainedReleases(journal) {
  if (journal.cleanup?.state === 'complete' || journal.phase === 'acknowledged') return [];
  const settled = runtimeHandoffSettled(journal);
  return [
    ...(!settled || !journal.helperFencedAt ? [journal.binding?.acceptedRelease?.reference] : []),
    ...(!settled ? [journal.binding?.bundleOwner?.acceptedRelease] : []),
  ].filter(Boolean);
}

export function acceptedReleaseFilesystemReferences(home, reference) {
  const reasons = [];
  const locator = /^accepted-release:[a-f0-9]{64}(:[A-Za-z0-9_-]+)$/.exec(reference)?.[1];
  const retains = binding => binding === reference
    || !!locator && typeof binding === 'string' && binding.startsWith('accepted-release:') && binding.endsWith(locator);
  const installed = readBundleOwner({ runtimeDir: path.join(home, 'config/local-sessions') })?.acceptedRelease;
  if (retains(installed)) reasons.push('The installed release still owns these bytes.');
  else if (installed != null && typeof installed !== 'string') reasons.push('unreadable installed release ownership');
  const directory = path.join(home, 'config/local-sessions/handoff');
  const active = readRuntimeHandoffLock(home);
  if (active && (active.state === 'unreadable' || !active.journalPath || !active.bindingDigest || !active.requestId
      || !active.executionId || active.journalPath !== path.join(directory, path.basename(path.dirname(active.journalPath)), 'journal.json'))) {
    reasons.push('unreadable handoff ownership');
  }
  const handoffs = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!handoffs) return reasons;
  if (!handoffs.isDirectory() || fs.realpathSync(directory) !== path.join(fs.realpathSync(home), 'config/local-sessions/handoff')) {
    return [...reasons, 'unclassified handoff directory'];
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) reasons.push(`unclassified handoff entry ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name, 'journal.json');
    if (!fs.existsSync(file)) {
      if (!emptyPreAdmissionHandoff(path.dirname(file))) reasons.push('unclassified handoff directory');
      continue;
    }
    const bytes = fs.readFileSync(file);
    const journal = JSON.parse(bytes);
    if (journal.schema !== 'mandible-runtime-handoff@1' || !journal.binding || typeof journal.phase !== 'string') { reasons.push(`unclassified handoff journal ${entry.name}`); continue; }
    const retirement = path.join(path.dirname(file), 'retirement.json');
    if (fs.existsSync(retirement)) {
      const retired = JSON.parse(fs.readFileSync(retirement, 'utf8'));
      if (retired.bindingDigest === journal.bindingDigest && retired.journalSha256 === hash(bytes)) continue;
    }
    const references = handoffRetainedReleases(journal);
    if (references.some(reference => typeof reference !== 'string')) reasons.push(`unclassified handoff journal ${entry.name}`);
    else if (references.some(retains)) reasons.push(`unresolved handoff ${entry.name}`);
  }
  return reasons;
}

export function readImmutableAcceptedRelease(reference, expectedCandidate) {
  const match = /^accepted-release:([a-f0-9]{64}):([A-Za-z0-9_-]+)$/.exec(reference ?? '');
  if (!match || reference.length > 512) throw new Error('Invalid accepted release reference.');
  const file = Buffer.from(match[2], 'base64url').toString('utf8');
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('Accepted release receipt bytes changed.');
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== match[1]) throw new Error('Accepted release receipt bytes changed.');
  const receipt = JSON.parse(bytes);
  if (receipt.schema === ACCEPTANCE_CERTIFICATE_SCHEMA) {
    if (bytes.length > ACCEPTANCE_CERTIFICATE_LIMIT) throw new Error('Accepted release certificate exceeds 64 KiB.');
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    validateAcceptanceCertificate(receipt);
  }
  return validateAcceptedReleaseReceipt(receipt, file, expectedCandidate);
}

function validateAcceptedReleaseReceipt(receipt, file, expectedCandidate) {
  validateCandidate(receipt.candidate);
  if (![ACCEPTED_RELEASE_SCHEMA, ACCEPTANCE_CERTIFICATE_SCHEMA].includes(receipt.schema) || receipt.package?.custody !== 'owned-run'
      || receipt.package.path !== 'Mandible.app' || !receipt.acceptance?.run_id
      || !receipt.retention?.project || !receipt.retention?.work_unit) throw new Error('Invalid accepted release receipt.');
  if (expectedCandidate && candidateKeys.some(key => expectedCandidate[key] !== receipt.candidate[key])) throw new Error('Accepted release belongs to a different candidate.');
  const handle = receipt.package.handle;
  if (!handle?.root || file !== path.join(path.dirname(handle.root), '.receipts', `${handle.runId}-accepted-release.json`)
      || receipt.acceptance.run_id !== handle.runId) throw new Error('Accepted release custody locator changed.');
  if (isVersionedReleaseStorage(path.dirname(handle.root)) !== (receipt.schema === ACCEPTANCE_CERTIFICATE_SCHEMA)) {
    throw new Error('Accepted release format does not match its custody namespace.');
  }
  return receipt;
}

function verifyAcceptedReleaseEvidence(evidence) {
  if (installedFileIdentity(evidence.receipt).sha256 !== evidence.sha256) throw new Error('Accepted release evidence bytes changed.');
}

/** Immutable evidence remains readable after intentional payload disposal. */
export function readAcceptedReleaseReceipt(reference, expectedCandidate) {
  const receipt = readImmutableAcceptedRelease(reference, expectedCandidate);
  if (receipt.schema === ACCEPTED_RELEASE_SCHEMA) verifyAcceptedReleaseEvidence(receipt.evidence);
  return receipt;
}

export function acceptedReleaseDisposition(receipt) {
  const outcome = ownedRunReceipt(receipt.package.handle);
  if (outcome && (outcome.schema !== releaseRunSchema(path.dirname(receipt.package.handle.root)) || outcome.outcome !== 'abandoned'
      || outcome.disposition !== 'discard' || !['pending', 'completed'].includes(outcome.cleanup)
      || !/^[a-f0-9]{64}$/.test(outcome.manifestDigest ?? '')
      || outcome.project !== receipt.retention.project || outcome.workUnit !== receipt.retention.work_unit
      || !Number.isSafeInteger(outcome.rootIdentity?.dev) || !Number.isSafeInteger(outcome.rootIdentity?.ino)
      || (outcome.generatedRecovery && (outcome.generatedRecovery.outputs?.length !== 1
        || outcome.generatedRecovery.outputs[0] !== receipt.package.path)))) {
    throw new Error('Accepted release disposition does not match its sealed custody.');
  }
  return outcome;
}

function acceptedReleaseOwner(receipt) {
  const handle = receipt.package.handle;
  if (acceptedReleaseDisposition(receipt)) throw new Error('Accepted payload is disposed or claimed for disposal.');
  const metadata = JSON.parse(fs.readFileSync(path.join(handle.root, 'metadata.json'), 'utf8'));
  if (!ownedRunIdentityMatches(handle.root, metadata.ownership) || metadata.ownership.schema !== releaseRunSchema(path.dirname(handle.root))
      || metadata.ownership.runId !== handle.runId
      || metadata.ownership.project !== receipt.retention.project || metadata.ownership.workUnit !== receipt.retention.work_unit) throw new Error('Accepted release owner changed.');
  if (metadata.ownership.state === 'terminal') throw new Error('Accepted payload is disposed or claimed for disposal.');
  return metadata;
}

export function resolveAcceptedRelease(reference, expectedCandidate) {
  const receipt = readAcceptedReleaseReceipt(reference, expectedCandidate);
  acceptedReleaseOwner(receipt);
  const handle = receipt.package.handle;
  const app = path.join(handle.root, receipt.package.path);
  if (applicationIdentity(app) !== receipt.package.sha256) throw new Error('Accepted application bytes changed.');
  const resources = path.join(app, 'Contents', 'Resources');
  // Acceptance verified the inventory before exercise and revalidated the app
  // before sealing. Its full-app digest binds the payload and manifest together.
  return { receipt, app, resources, release: readAcceptedInstalledRelease(receipt, resources) };
}

export function readAcceptedInstalledRelease(receipt, resources) {
  const { release, sha256 } = readInstalledReleaseIdentity(resources);
  const agrees = receipt.schema === ACCEPTANCE_CERTIFICATE_SCHEMA
    ? sha256 === receipt.manifest_sha256
    : JSON.stringify(release) === JSON.stringify(receipt.shipped);
  if (!agrees || release.target !== receipt.target || release.provenance.commit !== receipt.candidate.pin_sha) {
    throw new Error('Installed manifest differs from the exact accepted release.');
  }
  return release;
}

/** Explicit delivery-owner disposal uses sealed identity and live custody. */
export async function disposeAcceptedRelease(reference, expectedCandidate, reason, { home, assertHeld, claim, database, deferCleanup = false, inspect = inspectRunConsumers } = {}) {
  if (!reason?.trim()) throw new Error('Accepted release disposal requires an owner reason.');
  const receipt = readImmutableAcceptedRelease(reference, expectedCandidate);
  const root = receipt.package.handle.root;
  home ??= acceptedReleaseHome(root);
  const present = () => !!fs.lstatSync(root, { throwIfNoEntry: false });
  const disposition = acceptedReleaseDisposition(receipt);
  if (!present() && disposition?.cleanup === 'completed') {
    await retireAcceptedReleaseRunLock(root);
    return { action: 'delete-owned', reason: 'payload already removed', remaining: [] };
  }
  if (!assertHeld) return withInstallationGatewayLock(home, (_token, held) => disposeAcceptedRelease(reference, expectedCandidate, reason, { home, assertHeld: held, claim, database, deferCleanup, inspect }));
  assertHeld();
  return withAcceptedReleaseRunLock(root, async () => {
    const exact = readImmutableAcceptedRelease(reference, expectedCandidate);
    const outcome = acceptedReleaseDisposition(exact);
    const hasRoot = present();
    const references = acceptedReleaseFilesystemReferences(home, reference);
    if (references.length) throw new Error(`Accepted release is retained: ${references.join(', ')}`);
    if (hasRoot && outcome && !ownedRunIdentityMatches(root, outcome)) throw new Error('Accepted release root identity changed; explicit recovery required.');
    const metadataFile = path.join(root, 'metadata.json');
    const metadataStat = fs.lstatSync(metadataFile, { throwIfNoEntry: false });
    if (metadataStat && !metadataStat.isFile()) throw new Error('Accepted release metadata is not an owned file.');
    const metadata = metadataStat ? JSON.parse(fs.readFileSync(metadataFile, 'utf8')) : null;
    const ownership = metadata?.ownership;
    if (!outcome && (!hasRoot || !ownedRunIdentityMatches(root, ownership) || ownership.schema !== releaseRunSchema(path.dirname(root))
        || ownership.runId !== exact.package.handle.runId
        || ownership.project !== exact.retention.project || ownership.workUnit !== exact.retention.work_unit)) {
      throw new Error('Accepted release owner changed or is absent without a disposition.');
    }
    if (ownership?.state === 'investigating') throw new Error('Explicit investigation retains these bytes until released.');
    if (!outcome && ownership.state === 'terminal') throw new Error('Terminal release lacks its exact disposition.');
    if (hasRoot && outcome && [ownership, outcome.generatedRecovery].some(run => (run?.processOwner || run?.processes?.length) && !generatedOwnerIdle(run))) {
      throw new Error('Accepted release is retained: acceptance producer lifetime live or uncertain');
    }
    if (hasRoot && !outcome && metadata.pendingAcceptance) {
      const { acceptedReleaseProducerReferences, acceptedReleaseProducerReferencesAsync } = await import('./accepted-release-retention.mjs');
      const producers = deferCleanup ? await acceptedReleaseProducerReferencesAsync(metadata) : acceptedReleaseProducerReferences(metadata);
      if (producers.length) throw new Error(`Accepted release is retained: ${producers.join(', ')}`);
    }
    const consumers = hasRoot ? await inspect(root) : { idle: true };
    if (!consumers.idle) throw Object.assign(new Error(consumers.reason), { consumers: consumers.pids ?? [] });
    assertHeld();
    const mark = () => {
      if (outcome) return;
      metadata.ownership = { ...ownership, disposable: true,
        outputs: ownership.outputs.map(output => ({ ...output, kind: 'generated' })) };
      saveOwnedMetadata(metadataFile, metadata);
      finalizeOwnedRun(metadataFile, { expectedRevision: ownership.revision, outcome: 'abandoned', disposition: 'discard', summary: reason });
    };
    if (claim) claim(mark);
    else {
      const [{ default: Database }, { claimAcceptedReleaseDisposal }] = await Promise.all([import('../src/sqlite.ts'), import('./accepted-release-retention.mjs')]);
      const db = new Database(database || process.env.MANDIBLE_DB || path.join(home, 'mandible.db'), { fileMustExist: true });
      try { claimAcceptedReleaseDisposal(db, reference, exact, mark); }
      finally { db.close(); }
    }
    assertHeld();
    if (deferCleanup) return { action: 'cleanup-pending', reason: 'Disposal claimed; ordinary generated-storage maintenance owns cleanup.' };
    const current = acceptedReleaseDisposition(exact);
    if (!current) throw new Error('Disposal claim does not have a durable disposition.');
    const result = recoverOwnedRunDisposition(current.receipt, { apply: true, inspect: () => consumers });
    if (result.action === 'disposed') return { action: 'delete-owned', reason: result.reason, remaining: [] };
    return result;
  }, { mode: 'recover', recoverStale: true, onUnavailable: (state, reason) => {
    if (state === 'completed') return { action: 'delete-owned', reason, remaining: [] };
    throw new Error(reason);
  } });
}

/** Durable custody precedes exercise; only an accepted receipt grants acceptance. */
export async function createPendingRelease({ storage, ownership }) {
  if (!/^[a-zA-Z0-9-]+$/.test(ownership.runId) || !ownership.instanceId || !ownership.project || !ownership.workUnit) throw new Error('Pending release requires an exact owner.');
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  const retained = path.join(fs.realpathSync(storage), ownership.runId);
  return withAcceptedReleaseRunLock(retained, async () => {
    fs.mkdirSync(retained, { mode: 0o700 });
    const owner = createOwnedRun({ root: retained, runId: ownership.runId, instanceId: ownership.instanceId,
      project: ownership.project, workUnit: ownership.workUnit, schema: releaseRunSchema(path.dirname(retained)),
      outputs: [{ path: 'Mandible.app', kind: 'interactive' }] });
    saveOwnedMetadata(path.join(retained, 'metadata.json'), { ownership: owner,
      ...(process.env.MANDIBLE_ACCEPTANCE_ID ? { pendingAcceptance: { recordId: process.env.MANDIBLE_ACCEPTANCE_ID, requestId: process.env.MANDIBLE_ACCEPTANCE_REQUEST,
        scratchRoot: ownership.root, runId: ownership.runId } } : {}) });
    const app = path.join(retained, 'Mandible.app');
    return { root: retained, runId: owner.runId, ownership: owner, app, resources: path.join(app, 'Contents/Resources') };
  }, { mode: 'create' });
}

function pendingOwner(pending) {
  const metadataFile = path.join(pending.root, 'metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (!ownedRunIdentityMatches(pending.root, pending.ownership)
      || JSON.stringify(metadata.ownership) !== JSON.stringify(pending.ownership)
      || pending.runId !== pending.ownership.runId || pending.root !== pending.ownership.root
      || pending.app !== path.join(pending.root, 'Mandible.app')
      || pending.resources !== path.join(pending.app, 'Contents/Resources')) throw new Error('Pending release owner changed.');
  const receiptFile = path.join(path.dirname(pending.root), '.receipts', `${pending.runId}-accepted-release.json`);
  if (fs.existsSync(receiptFile)) throw new Error('Pending release already has an accepted receipt.');
  return { metadataFile, receiptFile, ownership: metadata.ownership };
}

function retainAcceptanceEvidence(bytes, receiptFile, runId) {
  if (bytes.byteLength > ACCEPTANCE_CERTIFICATE_LIMIT) throw new Error('Accepted release evidence exceeds 64 KiB.');
  const directory = path.join(path.dirname(receiptFile), 'evidence');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== directory) throw new Error('Accepted release evidence directory changed.');
  const evidence = { receipt: path.join(directory, `${runId}-acceptance.json`), sha256: hash(bytes) };
  saveOwnedBytes(evidence.receipt, bytes);
  verifyAcceptedReleaseEvidence(evidence);
  return evidence;
}

/** Seal the exercised app in place; the result is valid only for this operation. */
export async function retainAcceptedRelease({ pending, candidate, acceptance, evidence, certification, expectedDigest, shipped }) {
  validateCandidate(candidate);
  return withAcceptedReleaseRunLock(pending.root, async () => {
    const { receiptFile, ownership } = pendingOwner(pending);
    if (isVersionedReleaseStorage(path.dirname(pending.root)) !== Boolean(certification)) {
      throw new Error('Accepted release format does not match its custody namespace.');
    }
    if (fs.readdirSync(pending.root).some(name => !['Mandible.app', 'metadata.json'].includes(name))) throw new Error('Pending release contains unknown entries.');
    const consumers = inspectRunConsumers(pending.root);
    if (!consumers.idle) throw new Error(consumers.reason);
    if (applicationIdentity(pending.app) !== expectedDigest) throw new Error('Application changed during acceptance.');
    const manifest = readInstalledReleaseIdentity(pending.resources);
    if (JSON.stringify(manifest.release) !== JSON.stringify(shipped) || manifest.release.provenance.commit !== candidate.pin_sha) throw new Error('Accepted application provenance changed.');
    const base = { acceptance: { ...acceptance, run_id: ownership.runId }, candidate, target: shipped.target,
      package: { custody: 'owned-run', handle: { root: pending.root, runId: ownership.runId }, path: 'Mandible.app', sha256: expectedDigest },
      retention: { project: ownership.project, work_unit: ownership.workUnit } };
    const receipt = certification
      ? { ...certification, schema: ACCEPTANCE_CERTIFICATE_SCHEMA, ...base, contract: ACCEPTANCE_CONTRACT, manifest_sha256: manifest.sha256 }
      : { schema: ACCEPTED_RELEASE_SCHEMA, ...base, shipped,
        retention: { ...base.retention, policy: 'Explicit owner disposal after delivery or abandonment; not cache material.' },
        evidence: retainAcceptanceEvidence(evidence, receiptFile, ownership.runId) };
    validateAcceptedReleaseReceipt(receipt, receiptFile, candidate);
    if (receipt.schema === ACCEPTANCE_CERTIFICATE_SCHEMA) {
      validateAcceptanceCertificate(receipt);
      const bytes = boundedAcceptanceBytes(receipt);
      fs.mkdirSync(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
      if (fs.realpathSync(path.dirname(receiptFile)) !== path.dirname(receiptFile)) throw new Error('Accepted release receipt directory changed.');
      saveOwnedBytes(receiptFile, bytes);
    } else saveOwnedMetadata(receiptFile, receipt);
    return { reference: referenceFor(receiptFile), receipt, root: pending.root, app: pending.app, resources: pending.resources, digest: expectedDigest };
  });
}

export async function disposePendingRelease(pending, expectedDigest, reason) {
  return withAcceptedReleaseRunLock(pending.root, async () => {
    const { metadataFile, ownership } = pendingOwner(pending);
    if (expectedDigest && applicationIdentity(pending.app) !== expectedDigest) throw new Error('Pending application changed; preserving owned material.');
    finalizeOwnedRun(metadataFile, { expectedRevision: ownership.revision, outcome: 'failed', disposition: 'discard', summary: reason });
    return cleanupOwnedRun(metadataFile, { apply: true });
  });
}
