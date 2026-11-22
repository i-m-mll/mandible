import fs from 'node:fs';
import path from 'node:path';
import { applicationIdentity, assertAcceptedInstalledReleaseIdentity, resolveAcceptedRelease, readAcceptedReleaseReceipt, readAcceptedInstalledRelease } from './accepted-release.mjs';
import { adoptBundleRelease } from './bundle-services.mjs';
import { applicationRootIdentity } from './installed-release.mjs';
import { runRuntimeCommand } from './runtime-observation.mjs';
import { assertApplicationRoot, installStagedApplication, preparedApplicationContext, prepareStagedApplication, stagedInstallPaths } from './staged-app-install.mjs';

export { applicationRootIdentity, preparedApplicationContext, stagedInstallPaths as acceptedInstallPaths };

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
/** Copy the selected package into the stage consumed by native activation. */
export function prepareAcceptedApplication(binding, { until, attemptId, assertHeld, phase = 'staged', stageIdentity, onStageCreated } = {}) {
  if (typeof assertHeld !== 'function' || !attemptId) throw new Error('Preparation requires an owned attempt and live lease.');
  assertHeld();
  const receipt = readAcceptedReleaseReceipt(binding.acceptedRelease?.reference);
  const paths = stagedInstallPaths(binding);
  if (phase === 'staged') {
    fs.mkdirSync(path.dirname(binding.nativeApp), { recursive: true });
    if (!fs.existsSync(paths.staging)) {
      if (stageIdentity) throw new Error('Owned application stage disappeared.');
      fs.mkdirSync(paths.staging, { mode: 0o700 });
      stageIdentity = applicationRootIdentity(paths.staging);
      onStageCreated?.({ path: paths.staging, identity: stageIdentity });
    } else if (!stageIdentity) throw new Error('Existing application stage has no recorded owner.');
    assertHeld();
    assertApplicationRoot(paths.staging, stageIdentity);
    for (const entry of fs.readdirSync(paths.staging)) {
      assertHeld();
      assertApplicationRoot(paths.staging, stageIdentity);
      fs.rmSync(path.join(paths.staging, entry), { recursive: true });
    }
    const source = path.join(receipt.package.handle.root, receipt.package.path);
    const result = runRuntimeCommand('/usr/bin/ditto', ['--clone', source, paths.staging], { until });
    if (result.status !== 0) throw new Error(`Accepted app copy failed: ${result.stderr}`);
    assertHeld();
    assertApplicationRoot(paths.staging, stageIdentity);
    fs.chmodSync(paths.staging, fs.lstatSync(source).mode & 0o777);
  }
  const prepared = prepareStagedApplication(binding, receipt.package.sha256, { until, attemptId, assertHeld, phase, stageIdentity });
  const { release, verification } = preparedApplicationContext(prepared, binding);
  assertAcceptedInstalledReleaseIdentity(receipt, { release, sha256: verification.manifestSha256 });
  return prepared;
}

export function installAcceptedApplication(binding, context, { until, prepared } = {}) {
  const reference = binding.acceptedRelease.reference;
  return installStagedApplication(binding, context, { until, prepared,
    ownsOwner: owner => owner.acceptedRelease === reference,
    publishOwner: (application, owner) => adoptBundleRelease(context, application.release, owner, reference,
      { until, verification: application.verification }) });
}
