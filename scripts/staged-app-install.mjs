import fs from 'node:fs';
import path from 'node:path';
import { assertLifecycleLockHeld } from './lifecycle-lock.mjs';
import { adoptBundleRelease, readBundleOwner } from './bundle-services.mjs';
import { applicationIdentity, applicationRootIdentity, assertInstalledApplicationVerification, installedApplicationVerification, installedRuntimeEnvironment, readInstalledReleaseIdentity } from './installed-release.mjs';
import { daemonPreflightCommand, readDaemonPreflight } from './daemon-preflight.mjs';
import { runRuntimeCommand, runtimeObservationTimeout } from './runtime-observation.mjs';
import { serviceInstallationContext } from './service-definitions.mjs';

export function stagedInstallPaths(binding) {
  const scope = `${binding.requestId}-${binding.executionId}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(scope)) throw new Error('Invalid app replacement owner.');
  const parent = path.dirname(binding.nativeApp);
  return { staging: path.join(parent, `.Mandible-${scope}.staging.app`), previous: path.join(parent, `.Mandible-${scope}.previous.app`) };
}

export function assertApplicationRoot(root, identity) {
  const actual = applicationRootIdentity(root);
  if (!identity || actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error('Application root ownership changed.');
}

const preparedApplications = new WeakMap();

export function preparedApplicationContext(prepared, binding) {
  const verified = preparedApplications.get(prepared);
  if (!verified || verified.binding !== JSON.stringify(binding)) throw new Error('Operation requires its own live prepared application.');
  verified.assertHeld();
  assertApplicationRoot(verified.app, prepared.identity);
  return { app: verified.app, resources: path.join(verified.app, 'Contents/Resources'), release: verified.release,
    digest: prepared.packageSha256, bundleIdentifier: prepared.bundleIdentifier, identity: prepared.identity,
    installed: verified.installed, verification: verified.verification };
}

/** The caller has custody of the stage and supplies its expected full-package digest. */
export function prepareStagedApplication(binding, expectedDigest, { until, attemptId, assertHeld, phase = 'staged', stageIdentity } = {}) {
  if (typeof assertHeld !== 'function' || !attemptId) throw new Error('Preparation requires an owned attempt and live lease.');
  if (!/^[a-f0-9]{64}$/.test(expectedDigest ?? '')) throw new Error('Preparation requires a verified package digest.');
  if (!['staged', 'installed'].includes(phase)) throw new Error('Unknown application preparation phase.');
  assertHeld();
  runtimeObservationTimeout(until);
  const paths = stagedInstallPaths(binding);
  const installed = phase === 'installed';
  const target = installed ? binding.nativeApp : paths.staging;
  assertApplicationRoot(target, stageIdentity);
  if (applicationIdentity(target) !== expectedDigest) throw new Error('Prepared application differs from the verified package.');
  const { release, sha256 } = readInstalledReleaseIdentity(path.join(target, 'Contents/Resources'));
  const verification = installedApplicationVerification(target, expectedDigest, sha256);
  const bundleIdentifier = serviceInstallationContext({ home: binding.home, bundleRoot: target }).bundleIdentifier;
  assertHeld();
  assertApplicationRoot(target, stageIdentity);
  const prepared = Object.freeze({ packageSha256: expectedDigest, bundleIdentifier, target, installed,
    identity: verification.identity, attemptId, ...paths });
  preparedApplications.set(prepared, { binding: JSON.stringify(binding), release, app: target, installed, assertHeld, verification });
  return prepared;
}

export function activationDatabase(binding) {
  const database = binding.serviceConfiguration?.configuration.environment.MANDIBLE_DB ?? path.join(binding.home, 'mandible.db');
  if (!path.isAbsolute(database)) throw new Error('The bound service database path must be absolute.');
  return path.normalize(database);
}

export function validatePreparedDaemon(binding, prepared, database, { until } = {}) {
  const { resources, release } = preparedApplicationContext(prepared, binding);
  const { binary, args } = daemonPreflightCommand(resources, release, database);
  const env = installedRuntimeEnvironment(resources, { HOME: binding.accountHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  const result = runRuntimeCommand(binary, args, { until, cwd: resources, env });
  if (result.status !== 0) throw new Error(`Staged daemon failed preflight: ${result.stderr || `exit ${result.status}`}`);
  return readDaemonPreflight(result.stdout);
}

/** Runs only after the exact captured writer and owned service jobs have drained. */
export function installStagedApplication(binding, context, { until, prepared, ownsOwner = () => true,
  publishOwner = (application, owner) => adoptBundleRelease(context, application.release, owner, undefined,
    { until, verification: application.verification }) } = {}) {
  assertLifecycleLockHeld();
  const check = () => { preparedApplicationContext(prepared, binding); runtimeObservationTimeout(until); };
  check();
  const application = preparedApplicationContext(prepared, binding);
  if (context.bundleRoot !== binding.nativeApp || context.home !== binding.home
      || context.bundleIdentifier !== application.bundleIdentifier) {
    throw new Error('Staged application and installation owner differ.');
  }
  const owner = readBundleOwner(context);
  const installedOwner = owner?.generation === application.release.provenance.commit
    && owner?.sourceDigest === application.release.provenance.source_digest && owner?.bundleRoot === context.bundleRoot
    && ownsOwner(owner);
  if (!installedOwner && JSON.stringify(owner) !== JSON.stringify(binding.bundleOwner ?? null)) throw new Error('Bundle ownership changed during installation.');
  const paths = stagedInstallPaths(binding);
  if (application.installed) {
    check();
    if (!installedOwner || !owner.verification) publishOwner(application, owner);
    else {
      assertInstalledApplicationVerification(application.resources, owner.verification);
      if (owner.verification.packageSha256 !== application.digest) throw new Error('Installed verification differs from the verified package.');
    }
    check();
    return { packageSha256: application.digest, ...paths };
  }
  if (installedOwner || fs.existsSync(paths.previous) && fs.existsSync(binding.nativeApp)) throw new Error('Installation paths changed after package replacement.');
  if (fs.existsSync(binding.nativeApp)) {
    assertApplicationRoot(binding.nativeApp, binding.priorAppIdentity);
    check();
    fs.renameSync(binding.nativeApp, paths.previous);
  } else if (binding.priorAppIdentity) {
    if (!fs.existsSync(paths.previous)) throw new Error('Prior installed application disappeared after admission.');
    assertApplicationRoot(paths.previous, binding.priorAppIdentity);
  }
  check();
  fs.renameSync(paths.staging, binding.nativeApp);
  const verified = preparedApplications.get(prepared);
  verified.app = binding.nativeApp;
  verified.installed = true;
  publishOwner(preparedApplicationContext(prepared, binding), owner);
  check();
  return { packageSha256: application.digest, ...paths };
}
