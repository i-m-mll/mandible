import fs from 'node:fs';
import path from 'node:path';
import { applicationIdentity, resolveAcceptedRelease, readAcceptedReleaseReceipt, readAcceptedInstalledRelease, readAcceptedInstalledReleaseIdentity } from './accepted-release.mjs';
import { assertLifecycleLockHeld } from './lifecycle-lock.mjs';
import { adoptBundleRelease, readBundleOwner } from './bundle-services.mjs';
import { applicationRootIdentity, assertInstalledApplicationVerification, installedApplicationVerification, installedRuntimeEnvironment } from './installed-release.mjs';
import { daemonPreflightCommand, readDaemonPreflight } from './daemon-preflight.mjs';
import { runRuntimeCommand, runtimeObservationTimeout } from './runtime-observation.mjs';
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
  readAcceptedInstalledRelease(receipt, path.join(binding.nativeApp, 'Contents/Resources'));
  return receipt;
}
export function acceptedInstallPaths(binding) {
  const scope = `${binding.requestId}-${binding.executionId}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(scope)) throw new Error('Invalid app replacement owner.');
  const parent = path.dirname(binding.nativeApp);
  return { staging: path.join(parent, `.Mandible-${scope}.staging.app`), previous: path.join(parent, `.Mandible-${scope}.previous.app`) };
}

const preparedApplications = new WeakMap();

export { applicationRootIdentity };

function sameRoot(root, identity) {
  const actual = applicationRootIdentity(root);
  if (!identity || actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error('Application root ownership changed.');
}

export function preparedApplicationContext(prepared, binding) {
  const verified = preparedApplications.get(prepared);
  if (!verified || verified.binding !== JSON.stringify(binding)) throw new Error('Operation requires its own live prepared application.');
  verified.assertHeld();
  sameRoot(verified.app, prepared.identity);
  return { app: verified.app, resources: path.join(verified.app, 'Contents/Resources'), release: verified.release,
    receipt: verified.receipt, reference: binding.acceptedRelease.reference, digest: prepared.packageSha256,
    bundleIdentifier: prepared.bundleIdentifier, identity: prepared.identity, installed: verified.installed, verification: verified.verification };
}

export function validatePreparedDaemon(binding, prepared, database, { until } = {}) {
  const application = preparedApplicationContext(prepared, binding);
  const { resources, release } = application;
  const { binary, args } = daemonPreflightCommand(resources, release, database);
  const env = installedRuntimeEnvironment(resources, { HOME: binding.accountHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  const result = runRuntimeCommand(binary, args, { until, cwd: resources, env });
  if (result.status !== 0) throw new Error(`Staged daemon failed preflight: ${result.stderr || `exit ${result.status}`}`);
  return readDaemonPreflight(result.stdout);
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
    } else if (!stageIdentity) throw new Error('Existing application stage has no recorded owner.');
    assertHeld();
    sameRoot(paths.staging, stageIdentity);
    for (const entry of fs.readdirSync(paths.staging)) {
      assertHeld();
      sameRoot(paths.staging, stageIdentity);
      fs.rmSync(path.join(paths.staging, entry), { recursive: true });
    }
    const source = path.join(receipt.package.handle.root, receipt.package.path);
    const result = runRuntimeCommand('/usr/bin/ditto', ['--clone', source, paths.staging], { until });
    if (result.status !== 0) throw new Error(`Accepted app copy failed: ${result.stderr}`);
    assertHeld();
    sameRoot(paths.staging, stageIdentity);
    fs.chmodSync(paths.staging, fs.lstatSync(source).mode & 0o777);
  }
  assertHeld();
  runtimeObservationTimeout(until);
  const target = installed ? binding.nativeApp : paths.staging;
  if (stageIdentity) sameRoot(target, stageIdentity);
  const identity = applicationRootIdentity(target);
  if (applicationIdentity(target) !== receipt.package.sha256) throw new Error('Prepared application differs from the exact accepted package.');
  const { release, sha256 } = readAcceptedInstalledReleaseIdentity(receipt, path.join(target, 'Contents/Resources'));
  const verification = installedApplicationVerification(target, receipt.package.sha256, sha256);
  const bundleIdentifier = serviceInstallationContext({ home: binding.home ?? path.dirname(binding.nativeApp), bundleRoot: target }).bundleIdentifier;
  assertHeld();
  const prepared = Object.freeze({ packageSha256: receipt.package.sha256, bundleIdentifier, target, installed, identity, attemptId, ...paths });
  preparedApplications.set(prepared, { binding: JSON.stringify(binding), receipt, release, app: target, installed, assertHeld, verification });
  return prepared;
}

/** Runs only after the exact captured writer and owned service jobs have drained. */
export function installAcceptedApplication(binding, context, { until, prepared } = {}) {
  assertLifecycleLockHeld();
  const check = () => { preparedApplicationContext(prepared, binding); runtimeObservationTimeout(until); };
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
    if (!installedOwner || !owner.verification) adoptBundleRelease(context, accepted.release, owner, binding.acceptedRelease.reference, { until, verification: accepted.verification });
    else {
      assertInstalledApplicationVerification(accepted.resources, owner.verification);
      if (owner.verification.packageSha256 !== accepted.verification.packageSha256) throw new Error('Installed verification differs from the exact accepted package.');
    }
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
  adoptBundleRelease(context, accepted.release, owner, binding.acceptedRelease.reference, { until, verification: accepted.verification });
  check();
  return { packageSha256: accepted.receipt.package.sha256, ...paths };
}
