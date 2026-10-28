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

/** Validate the replacement at its final-volume staging path while the old app serves. */
export function prepareAcceptedApplication(binding, { until } = {}) {
  const accepted = acceptedApplication(binding);
  const paths = acceptedInstallPaths(binding);
  const currentDigest = fs.existsSync(binding.nativeApp) ? applicationIdentity(binding.nativeApp) : null;
  const installed = currentDigest === accepted.receipt.package.sha256;
  if (!installed && currentDigest !== (binding.priorAppSha256 ?? null)
    && !(currentDigest === null && fs.existsSync(paths.previous) && applicationIdentity(paths.previous) === binding.priorAppSha256)) throw new Error('Prior installed application changed before preparation.');
  if (!installed) {
    fs.mkdirSync(path.dirname(binding.nativeApp), { recursive: true });
    if (!fs.existsSync(paths.staging)) {
      const result = spawnSync('/usr/bin/ditto', [accepted.app, paths.staging], { timeout: runtimeObservationTimeout(until, 60_000), encoding: 'utf8' });
      if (result.error || result.status !== 0) throw new Error(`Accepted app copy failed: ${result.error?.message || result.stderr}`);
    }
    if (applicationIdentity(paths.staging) !== accepted.receipt.package.sha256) throw new Error('Staged application differs from the exact accepted package.');
    const signed = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', paths.staging], { timeout: runtimeObservationTimeout(until, 30_000), encoding: 'utf8' });
    if (signed.error || signed.status !== 0) throw new Error(`Accepted application signature failed: ${signed.error?.message || signed.stderr}`);
  }
  runtimeObservationTimeout(until, 60_000);
  const target = installed ? binding.nativeApp : paths.staging;
  const stat = fs.statSync(target);
  const bundleIdentifier = serviceInstallationContext({ home: binding.home ?? path.dirname(binding.nativeApp), bundleRoot: target }).bundleIdentifier;
  const prepared = Object.freeze({ packageSha256: accepted.receipt.package.sha256, bundleIdentifier, target, installed, identity: Object.freeze({ dev: stat.dev, ino: stat.ino }), ...paths });
  preparedApplications.set(prepared, { binding: JSON.stringify(binding), accepted });
  return prepared;
}

/** Runs only after the exact captured writer and owned service jobs have drained. */
export function installAcceptedApplication(binding, context, { until, prepared = prepareAcceptedApplication(binding, { until }) } = {}) {
  assertLifecycleLockHeld();
  const check = () => runtimeObservationTimeout(until, 60_000);
  check();
  const verified = preparedApplications.get(prepared);
  if (!verified || verified.binding !== JSON.stringify(binding)) throw new Error('Installation requires its own verified prepared application.');
  const { accepted } = verified;
  const staged = fs.statSync(prepared.target);
  if (staged.dev !== prepared.identity.dev || staged.ino !== prepared.identity.ino) throw new Error('Prepared application identity changed.');
  check();
  const owner = readBundleOwner(context);
  const installedOwner = owner?.generation === accepted.receipt.shipped.provenance.commit
    && owner?.sourceDigest === accepted.receipt.shipped.provenance.source_digest && owner?.bundleRoot === context.bundleRoot
    && owner?.acceptedRelease === binding.acceptedRelease.reference;
  if (!installedOwner && JSON.stringify(owner) !== JSON.stringify(binding.bundleOwner ?? null)) throw new Error('Bundle ownership changed during installation.');
  const paths = acceptedInstallPaths(binding);
  if (prepared.installed) {
    check();
    if (!installedOwner) adoptBundleRelease(context, accepted.receipt.shipped, owner, binding.acceptedRelease.reference, { until });
    check();
    return { packageSha256: accepted.receipt.package.sha256, ...paths };
  }
  if (installedOwner || fs.existsSync(paths.previous) && fs.existsSync(binding.nativeApp)) throw new Error('Installation paths changed after package replacement.');
  if (fs.existsSync(binding.nativeApp)) {
    if (applicationIdentity(binding.nativeApp) !== binding.priorAppSha256) throw new Error('Prior installed application changed after admission.');
    check();
    fs.renameSync(binding.nativeApp, paths.previous);
  } else if (binding.priorAppSha256 && !fs.existsSync(paths.previous)) throw new Error('Prior installed application disappeared after admission.');
  check();
  fs.renameSync(paths.staging, binding.nativeApp);
  check();
  adoptBundleRelease(context, accepted.receipt.shipped, owner, binding.acceptedRelease.reference, { until });
  check();
  return { packageSha256: accepted.receipt.package.sha256, ...paths };
}
