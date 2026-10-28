import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applicationIdentity, resolveAcceptedRelease, readAcceptedReleaseReceipt } from './accepted-release.mjs';
import { readInstalledRelease } from './installed-release.mjs';
import { assertLifecycleLockHeld } from './lifecycle-lock.mjs';
import { adoptBundleRelease, readBundleOwner } from './bundle-services.mjs';
import { runtimeObservationTimeout } from './runtime-observation.mjs';
import { serviceInstallationContext } from './service-definitions.mjs';

export function acceptedApplication(binding) {
  if (!binding.acceptedRelease) throw new Error('Handoff has no frozen accepted release.');
  return resolveAcceptedRelease(binding.acceptedRelease.reference);
}
export function verifyAcceptedApplication(binding) {
  const accepted = acceptedApplication(binding);
  if (applicationIdentity(binding.nativeApp) !== accepted.receipt.package.sha256) throw new Error('Installed application differs from the exact accepted package.');
  return accepted;
}
export function inspectAcceptedApplication(binding) {
  const receipt = readAcceptedReleaseReceipt(binding.acceptedRelease.reference);
  const shipped = readInstalledRelease(path.join(binding.nativeApp, 'Contents/Resources'));
  if (JSON.stringify(shipped) !== JSON.stringify(receipt.shipped)) throw new Error('Installed manifest differs from the exact accepted release.');
  return receipt;
}
export function acceptedInstallPaths(binding) {
  const scope = `${binding.requestId}-${binding.executionId}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(scope)) throw new Error('Invalid app replacement owner.');
  const parent = path.dirname(binding.nativeApp);
  return { staging: path.join(parent, `.Mandible-${scope}.staging.app`), previous: path.join(parent, `.Mandible-${scope}.previous.app`) };
}

const preparedApplications = new WeakMap();

export function applicationRootIdentity(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('Application root must be a canonical directory.');
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameRoot(root, identity) {
  const actual = applicationRootIdentity(root);
  if (!identity || actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error('Application root ownership changed.');
}

export function preparedApplicationContext(prepared, binding) {
  const verified = preparedApplications.get(prepared);
  if (!verified || verified.binding !== JSON.stringify(binding)) throw new Error('Operation requires its own live prepared application.');
  verified.assertHeld();
  sameRoot(verified.app, prepared.identity);
  return { app: verified.app, resources: path.join(verified.app, 'Contents/Resources'), release: verified.receipt.shipped,
    receipt: verified.receipt, reference: binding.acceptedRelease.reference, digest: prepared.packageSha256,
    bundleIdentifier: prepared.bundleIdentifier, identity: prepared.identity, installed: verified.installed };
}

/** Validate the replacement at its final-volume staging path while the old app serves. */
export function prepareAcceptedApplication(binding, { until, attemptId, assertHeld, phase = 'staged', stageIdentity, onStageCreated } = {}) {
  if (typeof assertHeld !== 'function' || !attemptId) throw new Error('Preparation requires an owned attempt and live lease.');
  assertHeld();
  const receipt = readAcceptedReleaseReceipt(binding.acceptedRelease?.reference);
  const paths = acceptedInstallPaths(binding);
  if (!['staged', 'installed'].includes(phase)) throw new Error('Unknown application preparation phase.');
  const installed = phase === 'installed';
  if (installed && !stageIdentity) throw new Error('Installed target has no recorded prepared owner.');
  if (!installed) {
    fs.mkdirSync(path.dirname(binding.nativeApp), { recursive: true });
    if (!fs.existsSync(paths.staging)) {
      if (stageIdentity) throw new Error('Owned application stage disappeared.');
      fs.mkdirSync(paths.staging, { mode: 0o700 });
      stageIdentity = applicationRootIdentity(paths.staging);
      onStageCreated?.({ path: paths.staging, identity: stageIdentity });
      assertHeld();
      const result = spawnSync('/usr/bin/ditto', [path.join(receipt.package.handle.root, receipt.package.path), paths.staging], { timeout: runtimeObservationTimeout(until, 60_000), encoding: 'utf8' });
      if (result.error || result.status !== 0) throw new Error(`Accepted app copy failed: ${result.error?.message || result.stderr}`);
      assertHeld();
      sameRoot(paths.staging, stageIdentity);
      fs.chmodSync(paths.staging, fs.lstatSync(path.join(receipt.package.handle.root, receipt.package.path)).mode & 0o777);
    } else if (!stageIdentity) throw new Error('Existing application stage has no recorded owner.');
  }
  assertHeld();
  runtimeObservationTimeout(until, 60_000);
  const target = installed ? binding.nativeApp : paths.staging;
  if (stageIdentity) sameRoot(target, stageIdentity);
  const identity = applicationRootIdentity(target);
  if (applicationIdentity(target) !== receipt.package.sha256) throw new Error('Prepared application differs from the exact accepted package.');
  const bundleIdentifier = serviceInstallationContext({ home: binding.home ?? path.dirname(binding.nativeApp), bundleRoot: target }).bundleIdentifier;
  assertHeld();
  const prepared = Object.freeze({ packageSha256: receipt.package.sha256, bundleIdentifier, target, installed, identity, attemptId, ...paths });
  preparedApplications.set(prepared, { binding: JSON.stringify(binding), receipt, app: target, installed, assertHeld });
  return prepared;
}

/** Runs only after the exact captured writer and owned service jobs have drained. */
export function installAcceptedApplication(binding, context, { until, prepared } = {}) {
  assertLifecycleLockHeld();
  const check = () => { preparedApplicationContext(prepared, binding); runtimeObservationTimeout(until, 60_000); };
  check();
  const accepted = preparedApplicationContext(prepared, binding);
  check();
  const owner = readBundleOwner(context);
  const installedOwner = owner?.generation === accepted.release.provenance.commit
    && owner?.sourceDigest === accepted.release.provenance.source_digest && owner?.bundleRoot === context.bundleRoot
    && owner?.acceptedRelease === binding.acceptedRelease.reference;
  if (!installedOwner && JSON.stringify(owner) !== JSON.stringify(binding.bundleOwner ?? null)) throw new Error('Bundle ownership changed during installation.');
  const paths = acceptedInstallPaths(binding);
  if (accepted.installed) {
    check();
    if (!installedOwner) adoptBundleRelease(context, accepted.release, owner, binding.acceptedRelease.reference, { until });
    check();
    return { packageSha256: accepted.receipt.package.sha256, ...paths };
  }
  if (installedOwner || fs.existsSync(paths.previous) && fs.existsSync(binding.nativeApp)) throw new Error('Installation paths changed after package replacement.');
  if (fs.existsSync(binding.nativeApp)) {
    sameRoot(binding.nativeApp, binding.priorAppIdentity);
    check();
    fs.renameSync(binding.nativeApp, paths.previous);
  } else if (binding.priorAppIdentity) {
    if (!fs.existsSync(paths.previous)) throw new Error('Prior installed application disappeared after admission.');
    sameRoot(paths.previous, binding.priorAppIdentity);
  }
  check();
  fs.renameSync(paths.staging, binding.nativeApp);
  const verified = preparedApplications.get(prepared);
  verified.app = binding.nativeApp; verified.installed = true;
  check();
  adoptBundleRelease(context, accepted.receipt.shipped, owner, binding.acceptedRelease.reference, { until });
  check();
  return { packageSha256: accepted.receipt.package.sha256, ...paths };
}
