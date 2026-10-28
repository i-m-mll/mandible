import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { assertLifecycleLockHeld, processIdentity } from './lifecycle-lock.mjs';
import { inspectServiceDefinitionsSync } from './service-definitions.mjs';
import { readServiceConfiguration, publishServiceConfiguration } from './service-configuration.mjs';
import { readInstalledRelease, releaseFile } from './installed-release.mjs';

const ownerFile = context => path.join(context.runtimeDir, 'bundle-owner.json');
const launchFile = context => path.join(context.runtimeDir, 'bundle-launch.json');
export function readBundleOwner(context) {
  try { return JSON.parse(fs.readFileSync(ownerFile(context), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function publish(file, value) {
  assertLifecycleLockHeld();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
}
let loginSession;
export function bundleLoginSession() {
  if (loginSession) return loginSession;
  const domain = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}`], { encoding: 'utf8', timeout: 2500, maxBuffer: 4 * 1024 * 1024 });
  const boot = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2500 });
  const handle = domain.stdout?.match(/^\s*handle = (\d+)$/m)?.[1];
  if (domain.error || domain.status !== 0 || boot.error || boot.status !== 0 || !handle
      || !/^[A-Fa-f0-9-]{36}$/.test(boot.stdout.trim())) throw new Error('Cannot identify the logged-in service session.');
  loginSession = `${boot.stdout.trim()}:${handle}`;
  return loginSession;
}
export function bundleLaunchAllowed(preference, session, role = 'backend') {
  return (role === 'gateway' ? preference?.gatewayEnabled : preference?.enabled) === true
    && (preference.launchMode === 'on_demand' || preference.launchMode === 'manual' && preference.session === session);
}
export function readBundleLaunch(context) {
  return JSON.parse(fs.readFileSync(launchFile(context), 'utf8'));
}

/** Read-only admission. Replacement authorization belongs to the drained delivery transaction. */
export function admitBundleOwner(context, release, { relocation = false } = {}) {
  const owner = readBundleOwner(context);
  if (!owner) return { ok: true, owner: null };
  const authority = fs.readFileSync(path.join(context.home, 'config/client-auth/authority-id'), 'utf8').trim();
  if (owner.installationId !== authority) return { ok: false, code: 'ownership_conflict', message: 'Bundle registration belongs to another installation authority.' };
  if (owner.generation !== release.provenance.commit || owner.sourceDigest !== release.provenance.source_digest) return {
    ok: false, code: 'replacement_required', message: 'The installed release differs from the service owner. Use the accepted-package handoff to replace it.',
  };
  if (owner.bundleRoot !== context.bundleRoot && !(relocation && !fs.existsSync(owner.bundleRoot))) return {
    ok: false, code: 'ownership_conflict', message: 'Another app location owns these services. Preserve it or explicitly relocate the owned app.',
  };
  return { ok: true, owner };
}

/** The delivery journal authorizes replacement; this boundary proves the old writer is gone. */
export function adoptBundleRelease(context, release, expectedOwner, acceptedRelease) {
  assertLifecycleLockHeld();
  const current = readBundleOwner(context);
  if (JSON.stringify(current) !== JSON.stringify(expectedOwner)) throw new Error('Bundle owner changed after handoff capture.');
  const inspection = inspectServiceDefinitionsSync(context);
  if (!inspection.ok) throw new Error(inspection.refusal.message);
  if (inspection.observations.some(item => item.job.pid || item.installed.some(definition => !definition.record.BundleProgram))) {
    throw new Error('Bundle adoption requires stopped writers and removal of legacy service definitions.');
  }
  const installationId = fs.readFileSync(path.join(context.home, 'config/client-auth/authority-id'), 'utf8').trim();
  if (current && current.installationId !== installationId) throw new Error('Bundle owner belongs to another installation authority.');
  publish(ownerFile(context), { schema: 'mandible-bundle-owner@1', bundleRoot: context.bundleRoot, installationId,
    generation: release.provenance.commit, sourceDigest: release.provenance.source_digest, ...(acceptedRelease ? { acceptedRelease } : {}) });
  return readBundleOwner(context);
}

export function nativeServiceControl(context, operation, role) {
  if (!['status', 'register', 'unregister', 'settings'].includes(operation) || !['backend', 'gateway'].includes(role)) throw new Error('Invalid native service operation.');
  if (operation !== 'status') assertLifecycleLockHeld();
  const resources = path.join(context.bundleRoot, 'Contents/Resources');
  const release = readInstalledRelease(resources);
  const helper = releaseFile(resources, release.native.serviceHelper, release.layout);
  const result = spawnSync(helper, [operation, role], {
    encoding: 'utf8', timeout: 10_000, env: { HOME: context.accountHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  if (result.error || result.status !== 0) throw new Error(`Native ${role} ${operation} failed: ${result.stderr || result.error?.message}`);
  const status = JSON.parse(result.stdout);
  if (status.service !== role || status.label !== context[`${role}Label`] || !['not_registered', 'enabled', 'requires_approval', 'not_found'].includes(status.status)) throw new Error('Native service returned invalid identity/status.');
  if (operation === 'register' && status.status === 'enabled' && status.registration_changed === false) {
    const started = spawnSync('/bin/launchctl', ['kickstart', `${context.domain}/${status.label}`], { encoding: 'utf8', timeout: 2500 });
    if (started.error || started.status !== 0) throw new Error(`Cannot start the registered ${role}: ${started.stderr || started.error?.message}`);
  }
  return status;
}

export async function bundleRuntimeCommand(command, { context, release, launchMode, initialize, inspect, configureGateway,
  reloadGateway, restartGateway, previewCount, waitReady,
  control = nativeServiceControl, session = bundleLoginSession, observe = inspectServiceDefinitionsSync }) {
  if (control === nativeServiceControl && (context.home !== path.join(os.userInfo().homedir, '.mandible')
      || context.accountHome !== os.userInfo().homedir || process.env.MANDIBLE_INSTANCE_ROLE === 'preview')) {
    throw new Error('Isolated instances cannot inspect or register production bundle services.');
  }
  if (!['status', 'start', 'stop', 'restart', 'install', 'repair', 'remove', 'configure-launch-mode', 'reload-gateway', 'background-settings'].includes(command)) throw new Error('Unsupported bundle lifecycle operation.');
  const mutating = command !== 'status';
  const admission = admitBundleOwner(context, release, { relocation: command === 'repair' });
  if (!admission.ok) throw new Error(admission.message);
  const relocating = command === 'repair' && admission.owner?.bundleRoot !== undefined && admission.owner.bundleRoot !== context.bundleRoot;
  const observationContext = relocating ? { ...context, bundleRoot: admission.owner.bundleRoot } : context;
  const inspection = observe(observationContext);
  if (!inspection.ok) throw new Error(inspection.refusal.message);
  if (inspection.observations.some(observation => observation.installed.some(item => !item.record.BundleProgram)
      || observation.job.loaded && !observation.loadedDefinition?.BundleProgram)) throw new Error('Legacy services require the explicit drained package migration; preserving them.');
  if (mutating) assertLifecycleLockHeld();
  if (!admission.owner && mutating && ['backend', 'gateway'].some(role => ['enabled', 'requires_approval'].includes(control(context, 'status', role).status))) {
    throw new Error('Registered services have no matching durable bundle owner; preserve them for explicit repair.');
  }
  if (command === 'background-settings') { control(context, 'settings', 'backend'); return (await inspect({ launchMode })).status; }
  const previews = admission.owner ? previewCount(path.join(context.bundleRoot, 'Contents/Resources')) : 0;
  if ((command === 'remove' || relocating) && previews > 0) throw new Error('Registered previews still use the shared gateway; stop them before removing or relocating the app.');
  const restarting = command === 'restart' || relocating;
  const beforeRestart = restarting ? await inspect({ launchMode }) : null;
  if (['stop', 'remove', 'restart'].includes(command) || relocating) {
    const stoppedRoles = command === 'restart' || command === 'stop' && previews > 0 ? ['backend'] : ['gateway', 'backend'];
    const previous = inspection.observations.filter(item => stoppedRoles.includes(item.service) && item.job.pid).map(item => ({ pid: item.job.pid, identity: processIdentity(item.job.pid) }));
    publish(launchFile(context), { enabled: false, gatewayEnabled: !stoppedRoles.includes('gateway'), launchMode, session: session() });
    for (const role of stoppedRoles) control(context, 'unregister', role);
    const until = Date.now() + 20_000;
    for (;;) {
      const remaining = observe(observationContext);
      if (!remaining.ok) throw new Error(remaining.refusal.message);
      if (remaining.observations.filter(item => stoppedRoles.includes(item.service)).every(item => !item.job.loaded || !item.job.pid)
          && previous.every(item => !item.identity || processIdentity(item.pid) !== item.identity)) break;
      if (Date.now() >= until) throw new Error('Owned services have not finished stopping; preserve the owner record.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (command === 'remove' && readBundleOwner(context)) fs.unlinkSync(ownerFile(context));
  }
  if (['start', 'restart', 'install', 'repair', 'configure-launch-mode', 'reload-gateway'].includes(command)) {
    await initialize(path.join(context.bundleRoot, 'Contents/Resources'));
    const configuration = readServiceConfiguration(context);
    if (configuration.migrated) publishServiceConfiguration(configuration.file, configuration.configuration);
    const installationId = fs.readFileSync(path.join(context.home, 'config/client-auth/authority-id'), 'utf8').trim();
    publish(ownerFile(context), { ...admission.owner, schema: 'mandible-bundle-owner@1', bundleRoot: context.bundleRoot, installationId,
      generation: release.provenance.commit, sourceDigest: release.provenance.source_digest });
    const prior = fs.existsSync(launchFile(context)) ? readBundleLaunch(context) : null;
    const currentSession = session();
    const enabled = ['start', 'restart'].includes(command) || relocating && !!beforeRestart?.backendJob.pid
      || bundleLaunchAllowed(prior, currentSession) || command === 'install' && launchMode === 'on_demand';
    publish(launchFile(context), { enabled, gatewayEnabled: enabled || previews > 0, launchMode, session: currentSession });
    if (enabled) {
      const before = await inspect({ launchMode });
      if (before.status.state === 'port_conflict' || before.backendPortOpen && !before.backendJob.loaded) throw new Error('A listener is not owned by this installation; preserving it.');
      control(context, 'register', 'backend');
      const current = await inspect({ launchMode });
      if (!current.trusted.error) {
        const gateway = await configureGateway(current.production.root);
        control(context, 'register', 'gateway');
        if (inspection.observations.some(item => item.service === 'gateway' && item.job.loaded) && !relocating) {
          if (gateway.adminRestartRequired) restartGateway();
          else reloadGateway();
        }
      }
    }
  }
  const services = Object.fromEntries(['backend', 'gateway'].map(role => [role, control(context, 'status', role).status]));
  if (!readBundleOwner(context)) return { state: 'stopped', launch_mode: launchMode, healthy: false, dashboard_ready: false,
    port: 0, pid: null, pid_file: '', log_file: '', detail: null, dashboard_origin: 'https://app.mandible.localhost:19420',
    gateway_state: 'stopped', gateway_error: null, gateway_log_file: '', background_services: services };
  const current = ['start', 'restart'].includes(command) ? await waitReady(launchMode) : await inspect({ launchMode });
  if (command === 'restart' && (!current.backend?.ok || !current.backend.document?.startup_epoch
      || current.backend.document.startup_epoch === beforeRestart?.backend?.document?.startup_epoch)) throw new Error('Restart did not confirm a ready backend with a new startup epoch.');
  if (command === 'stop' && current.status.healthy) throw new Error('Stop was requested, but the backend is still responding.');
  const dormant = !current.status.healthy && !current.backendJob.pid && !bundleLaunchAllowed(readBundleLaunch(context), session());
  return { ...current.status, ...(dormant ? { state: 'stopped' } : {}), background_services: services,
    ...(Object.values(services).includes('requires_approval') ? { state: 'background_permission_required', detail: 'Allow Mandible in System Settings → General → Login Items & Extensions.' } : {}) };
}
