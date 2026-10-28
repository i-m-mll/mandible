import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installedFileIdentity, readInstalledRelease } from './installed-release.mjs';
import { createOwnedRun, saveOwnedMetadata, withOwnedRunLock, ownedRunIdentityMatches, finalizeOwnedRun, cleanupOwnedRun, inspectRunConsumers } from './owned-run.mjs';

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
export async function disposeAcceptedRelease(reference, expectedCandidate, reason) {
  if (!reason?.trim()) throw new Error('Accepted release disposal requires an owner reason.');
  const { receipt } = resolveAcceptedRelease(reference, expectedCandidate);
  const root = receipt.package.handle.root;
  return withOwnedRunLock(root, async () => {
    resolveAcceptedRelease(reference, expectedCandidate);
    const metadataFile = path.join(root, 'metadata.json');
    const { ownership } = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    finalizeOwnedRun(metadataFile, { expectedRevision: ownership.revision, outcome: 'abandoned', disposition: 'discard', summary: reason });
    return cleanupOwnedRun(metadataFile, { apply: true });
  });
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
    saveOwnedMetadata(path.join(retained, 'metadata.json'), { ownership: owner });
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
