import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ownedRunIdentityMatches, processIdentity, saveOwnedMetadata, withOwnedRunLock } from './owned-run.mjs';
import { withLegacyPreviewRegistration } from './preview-registration.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Legacy owner receipt must be a regular file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const schema = 'mandible-preview-owner-adoption@1';

function assertRootLock(root, token) {
  const lock = read(path.join(path.dirname(root), `.${path.basename(root)}.lock`, 'owner.json'));
  if (!token || lock.token !== token || lock.pid !== process.pid || processIdentity(lock.pid) !== lock.identity) {
    throw new Error('Legacy preview adoption requires its exact live root lifecycle lock');
  }
}

function nativeReceipts(metadata, base) {
  if (!fs.existsSync(base)) return [];
  const manifest = path.join(metadata.previewRoot, 'metadata.json');
  const records = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.name.startsWith('native-') || !entry.isDirectory()) continue;
    const root = path.join(base, entry.name);
    const file = path.join(root, 'metadata.json');
    if (!fs.existsSync(file)) continue;
    const child = read(file);
    if (child.manifest !== manifest && child.previewRunId !== metadata.ownership.runId
      && child.parent?.runId !== metadata.ownership.runId && child.instanceId !== metadata.ownership.instanceId
      && child.origin !== metadata.instanceEnv.MANDIBLE_PUBLIC_ORIGIN) continue;
    records.push({ root, file });
  }
  return records.sort((a, b) => a.root.localeCompare(b.root));
}

function inspectNative(metadata, record) {
  const child = read(record.file);
  const owner = metadata.ownership;
  if (child.schema !== 'mandible-native-preview@1' || !ownedRunIdentityMatches(record.root, child.ownership)
    || child.ownership.project !== owner.project || child.ownership.workUnit !== owner.workUnit
    || child.ownership.instanceId !== owner.instanceId || child.ownership.state !== 'active'
    || !Number.isInteger(child.ownership.revision) || child.ownership.revision < 1
    || child.manifest !== path.join(owner.root, 'metadata.json') || child.previewRunId !== owner.runId
    || child.instanceId !== owner.instanceId || child.origin !== metadata.instanceEnv.MANDIBLE_PUBLIC_ORIGIN
    || child.profile !== path.join(record.root, 'profile')
    || !fs.lstatSync(child.profile).isDirectory() || fs.lstatSync(child.profile).isSymbolicLink()
    || !child.ownership.outputs.some(output => output.path === 'profile' && output.kind === 'interactive' && output.disposition === 'pending')
    || !['visible', 'stopped'].includes(child.status) || !Number.isInteger(child.pid) || !child.processIdentity
    || !/^[a-f0-9]{40}$/.test(child.build?.commit ?? '') || !/^[a-f0-9]{64}$/.test(child.build?.source_digest ?? '')
    || !child.executable?.startsWith(`${record.root}/app/`) || fs.realpathSync(child.executable) !== child.executable
    || createHash('sha256').update(fs.readFileSync(child.executable)).digest('hex') !== child.executableDigest) {
    throw new Error(`Legacy native ownership or profile evidence differs: ${record.file}`);
  }
  const marker = read(path.join(path.dirname(path.dirname(child.executable)), 'Resources', 'build-revision.json'));
  if (!isDeepStrictEqual(marker, child.build)) throw new Error('Legacy native package differs from its actual recorded build');
  const currentIdentity = processIdentity(child.pid);
  const identity = child.status === 'stopped' && currentIdentity !== child.processIdentity ? null : currentIdentity;
  if (identity !== null) {
    const checks = [
      ['status', child.status === 'visible'], ['process lifetime', identity === child.processIdentity],
      ['executable', identity.includes(child.executable)], ['window PID', child.window?.pid === child.pid],
      ['window run', child.window?.runId === child.ownership.runId], ['window profile', child.window?.profile === child.profile],
      ['window instance', child.window?.instanceId === owner.instanceId], ['window origin', child.window?.origin === child.origin],
    ];
    const mismatch = checks.find(([, matches]) => !matches);
    if (mismatch) throw new Error(`Legacy native process/start identity or page-load evidence differs (${mismatch[0]}): ${record.file}`);
  }
  if (child.buildProcess?.pid && !child.buildProcess.finishedAt || child.buildProcess?.remaining?.length) throw new Error('Legacy native build requires exact acquisition recovery');
  return { ...record, child, live: identity !== null };
}

function boundChild(child, plan, entry) {
  return { ...child, parent: entry.association.parent, attemptId: entry.association.attemptId, reservation: entry.association,
    legacyPreviewAdoption: { intentId: plan.id, boundAt: plan.createdAt, priorRevision: entry.priorRevision },
    ownership: { ...child.ownership, revision: entry.priorRevision + 1 } };
}

async function withChildLocks(records, operation, index = 0) {
  return index === records.length ? operation() : withOwnedRunLock(records[index].root, () => withChildLocks(records, operation, index + 1));
}

/** One restartable transition into the ordinary lifecycle; no runtime or data effects. */
export async function adoptLegacyPreview(metadata, { token, home, nativeBase, runtime, registration, verifyRuntime, effects = {} }) {
  const owner = metadata.ownership;
  assertRootLock(owner.root, token);
  if (owner.lifecycle || owner.state !== 'active' || owner.schema !== 'mandible-owned-run@1'
    || !ownedRunIdentityMatches(owner.root, owner) || !owner.project || !owner.workUnit
    || !Number.isInteger(owner.revision) || owner.revision < 1 || owner.consumers?.length) throw new Error('Unsupported or ambiguous legacy preview owner state');
  const file = path.join(owner.root, 'metadata.json');
  let parentDigest = digest(read(file));
  const persist = () => {
    if (digest(read(file)) !== parentDigest || !ownedRunIdentityMatches(owner.root, owner)) throw new Error('Legacy preview identity or revision changed before adoption commit');
    owner.revision++;
    saveOwnedMetadata(file, metadata);
    parentDigest = digest(metadata);
  };
  const discovered = nativeReceipts(metadata, nativeBase);
  return withChildLocks(discovered, async () => {
    const records = discovered.map(record => inspectNative(metadata, record));
    const retained = owner.legacyAdoption;
    if (retained && (retained.schema !== schema || retained.state !== 'binding'
      || !isDeepStrictEqual(retained.runtime, runtime) || !isDeepStrictEqual(retained.registration, registration)
      || !isDeepStrictEqual(retained.children.map(entry => entry.file).sort(), records.map(record => record.file).sort()))) throw new Error('Legacy adoption intent or retained native associations changed');
    const plan = retained ?? (() => {
      const live = records.filter(record => record.live);
      if (live.length > 1 || live.length === 0 && records.length > 1) throw new Error('Legacy native default is ambiguous; no unique live attachment proves the selected profile');
      const primary = live[0] ?? records[0];
      const plan = { schema, id: randomUUID(), state: 'binding', createdAt: new Date().toISOString(), runtime, registration,
        primaryConsumerId: primary?.child.ownership.runId ?? null, children: [] };
      for (const record of records) {
        const child = record.child;
        if (child.parent || child.reservation || child.attemptId || child.legacyPreviewAdoption) throw new Error('Legacy native receipt already has an unproven acquisition binding');
        const association = { consumerId: child.ownership.runId, runId: child.ownership.runId, root: record.root,
          rootIdentity: child.ownership.rootIdentity, metadataFile: record.file, borrowedBackend: true,
          parent: { root: owner.root, runId: owner.runId }, state: 'attached', generation: runtime.commit,
          source: child.build, attemptId: randomUUID(), identity: { pid: child.pid, processIdentity: child.processIdentity, build: child.build } };
        const entry = { file: record.file, priorRevision: child.ownership.revision, priorDigest: digest(child), association };
        entry.boundDigest = digest(boundChild(child, plan, entry));
        plan.children.push(entry);
      }
      return plan;
    })();
    for (const record of records) {
      const entry = plan.children.find(entry => entry.file === record.file);
      if (![entry.priorDigest, entry.boundDigest].includes(digest(record.child))) throw new Error('Legacy native receipt revision or adoption binding changed');
    }
    return withLegacyPreviewRegistration({ home, runId: owner.runId, registration }, async bindRegistration => {
      await verifyRuntime();
      if (!isDeepStrictEqual(nativeReceipts(metadata, nativeBase), discovered)) throw new Error('Legacy native associations changed during proof');
      if (!retained) { owner.legacyAdoption = plan; persist(); }
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const entry = plan.children.find(entry => entry.file === record.file);
        const current = inspectNative(metadata, record).child;
        const currentDigest = digest(current);
        if (currentDigest === entry.priorDigest) saveOwnedMetadata(record.file, boundChild(current, plan, entry));
        else if (currentDigest !== entry.boundDigest) throw new Error('Legacy native revision changed before binding commit');
        await effects.afterLegacyChildBound?.(index);
      }
      for (const entry of plan.children) if (digest(read(entry.file)) !== entry.boundDigest) throw new Error('Legacy native binding changed before parent commit');
      await verifyRuntime();
      bindRegistration();
      owner.consumers = plan.children.map(entry => entry.association).sort((a, b) =>
        Number(b.consumerId === plan.primaryConsumerId) - Number(a.consumerId === plan.primaryConsumerId));
      owner.lifecycle = { phase: 'ready', teardown: false, registration, launch: runtime.launch };
      plan.state = 'completed'; plan.completedAt = new Date().toISOString();
      persist();
      return metadata;
    });
  });
}
