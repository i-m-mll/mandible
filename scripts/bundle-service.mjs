import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { serviceInstallationContext } from './service-definitions.mjs';
import { readServiceConfiguration, servicePath } from './service-configuration.mjs';
import { admitBundleOwner, readBundleLaunch, bundleLaunchAllowed, bundleLoginSession } from './bundle-services.mjs';
import { installedRuntimeEnvironment, readInstalledRelease, releaseFile } from './installed-release.mjs';
import { prepareGatewayAdmin } from './gateway-admin.mjs';

const root = process.env.MANDIBLE_RELEASE_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Foreground services require an explicit installed release root.');
const release = readInstalledRelease(root);
const context = serviceInstallationContext({ home: process.env.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible') });
const role = process.argv[2];
if (!['backend', 'gateway'].includes(role)) throw new Error('Unknown foreground service role.');
const admission = admitBundleOwner(context, release);
if (!admission.ok || !admission.owner) throw new Error(admission.message || 'This bundle does not own the installation.');
const preference = readBundleLaunch(context);
if (bundleLaunchAllowed(preference, bundleLoginSession(), role)) {
  const configuration = readServiceConfiguration(context).configuration;
  const runtime = releaseFile(root, release.native.bun, release.layout);
  const environment = installedRuntimeEnvironment(root, { HOME: context.accountHome,
    PATH: servicePath(runtime, root, context, configuration), ...configuration.environment });
  Object.assign(process.env, environment, { MANDIBLE_HOME: context.home,
    MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR: context.runtimeDir,
    MANDIBLE_CLIENT_AUTH_DIR: path.join(context.home, 'config/client-auth'),
    MANDIBLE_CONTEXT_VERIFICATION_KEY: path.join(context.runtimeDir, 'context-verification-key.pem'),
    MANDIBLE_LAUNCH_MODE: preference.launchMode, MANDIBLE_BASE: 'https://app.mandible.localhost:19420',
    GIT_OPTIONAL_LOCKS: '0' });
  if (role === 'backend') {
    const { readMainInstance } = await import('./local-runtime.mjs');
    const main = readMainInstance(root);
    if (main.backend_generation !== release.provenance.commit) throw new Error('Registered backend generation differs from the owning release.');
    Object.assign(process.env, { MANDIBLE_INSTANCE_ROLE: 'main', MANDIBLE_INSTANCE_ID: 'production',
      MANDIBLE_INSTALLATION_ID: main.installation_id, MANDIBLE_PUBLIC_ORIGIN: main.public_origin,
      MANDIBLE_BACKEND_GENERATION: release.provenance.commit, MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(main.effectCeiling),
      MANDIBLE_WRITABLE_ROOTS: JSON.stringify(main.writableRoots), MANDIBLE_PORT: main.backendUrl.port,
      MANDIBLE_PID_FILE: configuration.environment.MANDIBLE_PID_FILE || path.join(context.accountHome, '.cache/mandible/production.pid'),
      MANDIBLE_STDERR_LOG_PATH: configuration.environment.MANDIBLE_STDERR_LOG_PATH || path.join(context.accountHome, '.cache/mandible/production-stderr.log') });
    process.chdir(root);
    const entry = path.join(root, release.entrypoints.daemon);
    process.argv = [runtime, entry];
    await import(pathToFileURL(entry).href);
  } else {
    prepareGatewayAdmin(context.home);
    if (!fs.existsSync(path.join(context.runtimeDir, 'Caddyfile'))) throw new Error('Gateway configuration is missing.');
    const child = spawn(environment.MANDIBLE_CADDY, ['run', '--config', path.join(context.runtimeDir, 'Caddyfile'), '--adapter', 'caddyfile'],
      { cwd: context.runtimeDir, env: process.env, stdio: 'inherit' });
    const forward = signal => child.kill(signal);
    process.on('SIGTERM', () => forward('SIGTERM'));
    process.on('SIGINT', () => forward('SIGINT'));
    child.on('error', error => { throw error; });
    child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code; });
  }
}
