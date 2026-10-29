import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installedFileIdentity, readInstalledRelease } from './installed-release.mjs';
import { createOwnedRun, saveOwnedMetadata, withOwnedRunLock, ownedRunIdentityMatches, finalizeOwnedRun, cleanupOwnedRun, inspectRunConsumers } from './owned-run.mjs';
import { withInstallationGatewayLock } from './lifecycle-lock.mjs';
import { readBundleOwner } from './bundle-services.mjs';
import { readRuntimeHandoffLock } from './runtime-handoff-lock.mjs';

export const ACCEPTED_RELEASE_SCHEMA = 'mandible-accepted-release@1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const candidateKeys = ['pin_sha', 'tree_sha', 'base_sha', 'head_sha'];

/** Bind the entire signed app, including links, modes, and files outside the payload inventory. */
export function applicationIdentity(app) {
  const entries = [];
  const visit = relative => {
    const file = path.join(app, relative);
    const stat = fs.lstatSync(file);
    const entry = { path: relative, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) entries.push({ ...entry, link: fs.readlinkSync(file) });
    else if (stat.isDirectory()) {
      entries.push({ ...entry, directory: true });
      for (const child of fs.readdirSync(file).sort()) visit(path.join(relative, child));
    } else if (stat.isFile()) entries.push({ ...entry, ...installedFileIdentity(file) });
    else throw new Error(`Unsupported application entry: ${relative}`);
  };
  visit('');
  return hash(JSON.stringify(entries));
}

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
  const match = /^accepted-release:[a-f0-9]{64}:([A-Za-z0-9_-]+)$/.exec(reference ?? '');
  if (!match) throw new Error('Invalid accepted release reference.');
  const file = Buffer.from(match[1], 'base64url').toString('utf8');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid accepted release receipt.');
  const bytes = fs.readFileSync(file);
  if (`accepted-release:${hash(bytes)}:${match[1]}` !== reference) throw new Error('Accepted release receipt bytes changed.');
  const receipt = JSON.parse(bytes);
  const root = receipt.package.handle.root;
  if (file !== path.join(path.dirname(root), '.receipts', `${receipt.package.handle.runId}-accepted-release.json`)) throw new Error('Accepted release custody locator changed.');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
  if (!ownedRunIdentityMatches(root, metadata.ownership) || metadata.ownership.runId !== receipt.package.handle.runId
      || metadata.ownership.state === 'terminal') throw new Error('Accepted payload is disposed or claimed for disposal.');
}

export function acceptedReleaseFilesystemReferences(home, reference, releasingHandoff) {
  const reasons = [];
  if (readBundleOwner({ runtimeDir: path.join(home, 'config/local-sessions') })?.acceptedRelease === reference) reasons.push('The installed release still owns these bytes.');
  const active = readRuntimeHandoffLock(home);
  if (active && (!active.journalPath || !active.bindingDigest || !active.requestId || !active.executionId)) reasons.push('unreadable handoff ownership');
  if (active?.journalPath) {
    const journal = JSON.parse(fs.readFileSync(active.journalPath, 'utf8'));
    const released = releasingHandoff?.file === active.journalPath && releasingHandoff?.bindingDigest === journal.bindingDigest
      && journal.attempt?.fence && journal.attempt?.state === 'complete' && journal.binding?.bundleOwner?.acceptedRelease === reference;
    if (!released && [journal.binding?.acceptedRelease?.reference, journal.binding?.bundleOwner?.acceptedRelease].includes(reference)) reasons.push('An unresolved handoff still owns these bytes.');
  }
  const directory = path.join(home, 'config/local-sessions/handoff');
  if (fs.existsSync(directory)) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name, 'journal.json');
    if (!fs.existsSync(file)) { reasons.push('unclassified handoff directory'); continue; }
    const bytes = fs.readFileSync(file);
    const journal = JSON.parse(bytes);
    if (journal.schema !== 'mandible-runtime-handoff@1' || !journal.binding || typeof journal.phase !== 'string') { reasons.push(`unclassified handoff journal ${entry.name}`); continue; }
    if (releasingHandoff?.file === file && releasingHandoff?.bindingDigest === journal.bindingDigest && journal.attempt?.fence
        && journal.attempt?.state === 'complete' && journal.binding?.bundleOwner?.acceptedRelease === reference) continue;
    const retirement = path.join(path.dirname(file), 'retirement.json');
    if (fs.existsSync(retirement)) {
      const retired = JSON.parse(fs.readFileSync(retirement, 'utf8'));
      if (retired.bindingDigest === journal.bindingDigest && retired.journalSha256 === hash(bytes)) continue;
    }
    if (journal.cleanup?.state === 'complete' || journal.phase === 'acknowledged') continue;
    if ([journal.binding?.acceptedRelease?.reference, journal.binding?.bundleOwner?.acceptedRelease].includes(reference)) reasons.push(`unresolved handoff ${entry.name}`);
  }
  return reasons;
}

/** Resolve only the selected immutable receipt; never discover another acceptance or app. */
export function readAcceptedReleaseReceipt(reference, expectedCandidate) {
  const match = /^accepted-release:([a-f0-9]{64}):([A-Za-z0-9_-]+)$/.exec(reference ?? '');
  if (!match || reference.length > 512) throw new Error('Invalid accepted release reference.');
  const file = Buffer.from(match[2], 'base64url').toString('utf8');
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()
      || installedFileIdentity(file).sha256 !== match[1]) throw new Error('Accepted release receipt bytes changed.');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateCandidate(receipt.candidate);
  if (receipt.schema !== ACCEPTED_RELEASE_SCHEMA || receipt.package?.custody !== 'owned-run'
      || receipt.package.path !== 'Mandible.app' || !receipt.acceptance?.run_id
      || !receipt.retention?.project || !receipt.retention?.work_unit) throw new Error('Invalid accepted release receipt.');
  if (expectedCandidate && candidateKeys.some(key => expectedCandidate[key] !== receipt.candidate[key])) throw new Error('Accepted release belongs to a different candidate.');
  if (installedFileIdentity(receipt.evidence.receipt).sha256 !== receipt.evidence.sha256) throw new Error('Accepted release evidence bytes changed.');
  const handle = receipt.package.handle;
  if (!handle?.root || file !== path.join(path.dirname(handle.root), '.receipts', `${handle.runId}-accepted-release.json`)
      || receipt.acceptance.run_id !== handle.runId) throw new Error('Accepted release custody locator changed.');
  return receipt;
}

export function resolveAcceptedRelease(reference, expectedCandidate) {
  const receipt = readAcceptedReleaseReceipt(reference, expectedCandidate);
  const handle = receipt.package.handle;
  const metadata = JSON.parse(fs.readFileSync(path.join(handle.root, 'metadata.json'), 'utf8'));
  if (!ownedRunIdentityMatches(handle.root, metadata.ownership) || metadata.ownership.runId !== handle.runId
      || metadata.ownership.project !== receipt.retention.project || metadata.ownership.workUnit !== receipt.retention.work_unit) throw new Error('Accepted release owner changed.');
  const app = path.join(handle.root, receipt.package.path);
  if (applicationIdentity(app) !== receipt.package.sha256) throw new Error('Accepted application bytes changed.');
  const resources = path.join(app, 'Contents', 'Resources');
  // Acceptance verified the inventory before exercise and revalidated the app
  // before sealing. Its full-app digest binds the payload and manifest together.
  const shipped = readInstalledRelease(resources);
  if (JSON.stringify(shipped) !== JSON.stringify(receipt.shipped) || shipped.target !== receipt.target
      || shipped.provenance.commit !== receipt.candidate.pin_sha) throw new Error('Accepted application provenance changed.');
  return { receipt, app, resources };
}

/** Explicit delivery-owner disposal; pending acceptances never expire as cache material. */
export async function disposeAcceptedRelease(reference, expectedCandidate, reason, { home, assertHeld, claim, releasingHandoff, database } = {}) {
  if (!reason?.trim()) throw new Error('Accepted release disposal requires an owner reason.');
  const receipt = readAcceptedReleaseReceipt(reference, expectedCandidate);
  const root = receipt.package.handle.root;
  home ??= path.dirname(path.dirname(root));
  if (!assertHeld && releasingHandoff) throw new Error('Handoff release requires its existing observation authority.');
  if (!assertHeld) return withInstallationGatewayLock(home, (_token, held) => disposeAcceptedRelease(reference, expectedCandidate, reason, { home, assertHeld: held, claim, database }));
  assertHeld();
  if (!fs.existsSync(root)) return { action: 'delete-owned', reason: 'payload already removed', remaining: [] };
  return withOwnedRunLock(root, async () => {
    const exact = readAcceptedReleaseReceipt(reference, expectedCandidate);
    const references = acceptedReleaseFilesystemReferences(home, reference, releasingHandoff);
    if (references.length) throw new Error(`Accepted release is retained: ${references.join(', ')}`);
    const metadataFile = path.join(root, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    const { ownership } = metadata;
    if (!ownedRunIdentityMatches(root, ownership) || ownership.runId !== exact.package.handle.runId
        || ownership.project !== exact.retention.project || ownership.workUnit !== exact.retention.work_unit) throw new Error('Accepted release owner changed.');
    if (ownership.state === 'investigating') throw new Error('Explicit investigation retains these bytes until released.');
    if (metadata.pendingAcceptance && ownership.state !== 'terminal') {
      const { acceptedReleaseProducerReferences } = await import('./accepted-release-retention.mjs');
      const producers = acceptedReleaseProducerReferences(metadata);
      if (producers.length) throw new Error(`Accepted release is retained: ${producers.join(', ')}`);
    }
    assertHeld();
    const mark = () => { if (ownership.state !== 'terminal') {
      metadata.ownership = { ...ownership, disposable: true,
        outputs: ownership.outputs.map(output => ({ ...output, kind: 'generated' })) };
      saveOwnedMetadata(metadataFile, metadata);
      finalizeOwnedRun(metadataFile, { expectedRevision: ownership.revision, outcome: 'abandoned', disposition: 'discard', summary: reason });
    } };
    if (claim) claim(mark);
    else {
      const [{ default: Database }, { claimAcceptedReleaseDisposal }] = await Promise.all([import('../src/sqlite.ts'), import('./accepted-release-retention.mjs')]);
      const db = new Database(database || process.env.MANDIBLE_DB || path.join(home, 'mandible.db'), { fileMustExist: true });
      try { claimAcceptedReleaseDisposal(db, reference, exact, mark); }
      finally { db.close(); }
    }
    assertHeld();
    return cleanupOwnedRun(metadataFile, { apply: true });
  }, { recoverStale: true });
}

/** Durable custody precedes exercise; only an accepted receipt grants acceptance. */
export async function createPendingRelease({ storage, ownership }) {
  if (!/^[a-zA-Z0-9-]+$/.test(ownership.runId) || !ownership.instanceId || !ownership.project || !ownership.workUnit) throw new Error('Pending release requires an exact owner.');
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  const retained = path.join(fs.realpathSync(storage), ownership.runId);
  fs.mkdirSync(retained, { mode: 0o700 });
  return withOwnedRunLock(retained, async () => {
    const owner = createOwnedRun({ root: retained, runId: ownership.runId, instanceId: ownership.instanceId,
      project: ownership.project, workUnit: ownership.workUnit, outputs: [{ path: 'Mandible.app', kind: 'interactive' }] });
    saveOwnedMetadata(path.join(retained, 'metadata.json'), { ownership: owner,
      ...(process.env.MANDIBLE_ACCEPTANCE_ID ? { pendingAcceptance: { recordId: process.env.MANDIBLE_ACCEPTANCE_ID, requestId: process.env.MANDIBLE_ACCEPTANCE_REQUEST,
        scratchRoot: ownership.root, runId: ownership.runId } } : {}) });
    const app = path.join(retained, 'Mandible.app');
    return { root: retained, runId: owner.runId, ownership: owner, app, resources: path.join(app, 'Contents/Resources') };
  });
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

/** Seal the exercised app in place; the result is valid only for this operation. */
export async function retainAcceptedRelease({ pending, candidate, acceptance, evidence, expectedDigest, shipped }) {
  validateCandidate(candidate);
  return withOwnedRunLock(pending.root, async () => {
    const { receiptFile, ownership } = pendingOwner(pending);
    if (fs.readdirSync(pending.root).some(name => !['Mandible.app', 'metadata.json'].includes(name))) throw new Error('Pending release contains unknown entries.');
    const consumers = inspectRunConsumers(pending.root);
    if (!consumers.idle) throw new Error(consumers.reason);
    if (applicationIdentity(pending.app) !== expectedDigest) throw new Error('Application changed during acceptance.');
    const manifest = readInstalledRelease(pending.resources);
    if (JSON.stringify(manifest) !== JSON.stringify(shipped) || manifest.provenance.commit !== candidate.pin_sha) throw new Error('Accepted application provenance changed.');
    const receipt = { schema: ACCEPTED_RELEASE_SCHEMA, acceptance: { ...acceptance, run_id: ownership.runId }, candidate,
      target: shipped.target, shipped, package: { custody: 'owned-run', handle: { root: pending.root, runId: ownership.runId }, path: 'Mandible.app', sha256: expectedDigest },
      retention: { project: ownership.project, work_unit: ownership.workUnit, policy: 'Explicit owner disposal after delivery or abandonment; not cache material.' }, evidence };
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
    saveOwnedMetadata(receiptFile, receipt);
    return { reference: referenceFor(receiptFile), receipt, root: pending.root, app: pending.app, resources: pending.resources, digest: expectedDigest };
  });
}

export async function disposePendingRelease(pending, expectedDigest, reason) {
  return withOwnedRunLock(pending.root, async () => {
    const { metadataFile, ownership } = pendingOwner(pending);
    if (expectedDigest && applicationIdentity(pending.app) !== expectedDigest) throw new Error('Pending application changed; preserving owned material.');
    finalizeOwnedRun(metadataFile, { expectedRevision: ownership.revision, outcome: 'failed', disposition: 'discard', summary: reason });
    return cleanupOwnedRun(metadataFile, { apply: true });
  });
}
