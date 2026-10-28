import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applicationIdentity, resolveAcceptedRelease, readAcceptedReleaseReceipt } from './accepted-release.mjs';
import { readInstalledRelease } from './installed-release.mjs';
import { assertLifecycleLockHeld } from './lifecycle-lock.mjs';
import { adoptBundleRelease, readBundleOwner } from './bundle-services.mjs';
import { runtimeObservationTimeout } from './runtime-observation.mjs';

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

/** Runs only after the exact captured writer and owned service jobs have drained. */
export function installAcceptedApplication(binding, context, { until } = {}) {
  assertLifecycleLockHeld();
  const check = () => runtimeObservationTimeout(until, 60_000);
  check();
  const accepted = acceptedApplication(binding);
  check();
  const owner = readBundleOwner(context);
  const installedOwner = owner?.generation === accepted.receipt.shipped.provenance.commit
    && owner?.sourceDigest === accepted.receipt.shipped.provenance.source_digest && owner?.bundleRoot === context.bundleRoot
    && owner?.acceptedRelease === binding.acceptedRelease.reference;
  if (!installedOwner && JSON.stringify(owner) !== JSON.stringify(binding.bundleOwner ?? null)) throw new Error('Bundle ownership changed during installation.');
  const paths = acceptedInstallPaths(binding);
  if (fs.existsSync(binding.nativeApp) && applicationIdentity(binding.nativeApp) === accepted.receipt.package.sha256) {
    check();
    if (!installedOwner) adoptBundleRelease(context, accepted.receipt.shipped, owner, binding.acceptedRelease.reference, { until });
    check();
    return { packageSha256: accepted.receipt.package.sha256, ...paths };
  }
  if (installedOwner || fs.existsSync(paths.previous) && fs.existsSync(binding.nativeApp)) throw new Error('Installation paths changed after package replacement.');
  fs.mkdirSync(path.dirname(binding.nativeApp), { recursive: true });
  if (!fs.existsSync(paths.staging)) {
    const result = spawnSync('/usr/bin/ditto', [accepted.app, paths.staging], { timeout: check(), encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`Accepted app copy failed: ${result.error?.message || result.stderr}`);
  }
  if (applicationIdentity(paths.staging) !== accepted.receipt.package.sha256) throw new Error('Staged application differs from the exact accepted package.');
  check();
  const signed = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', paths.staging], { timeout: runtimeObservationTimeout(until, 30_000), encoding: 'utf8' });
  if (signed.error || signed.status !== 0) throw new Error(`Accepted application signature failed: ${signed.error?.message || signed.stderr}`);
  if (fs.existsSync(binding.nativeApp)) {
    if (applicationIdentity(binding.nativeApp) !== binding.priorAppSha256) throw new Error('Prior installed application changed after admission.');
    check();
    fs.renameSync(binding.nativeApp, paths.previous);
  } else if (binding.priorAppSha256 && !fs.existsSync(paths.previous)) throw new Error('Prior installed application disappeared after admission.');
  check();
  fs.renameSync(paths.staging, binding.nativeApp);
  verifyAcceptedApplication(binding);
  check();
  adoptBundleRelease(context, accepted.receipt.shipped, owner, binding.acceptedRelease.reference, { until });
  check();
  return { packageSha256: accepted.receipt.package.sha256, ...paths };
}
