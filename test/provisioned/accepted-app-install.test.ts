// @provisioned launchd
// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { retainAcceptedRelease, applicationIdentity, readAcceptedReleaseReceipt, disposeAcceptedRelease } from '../../scripts/accepted-release.mjs';
import { installAcceptedApplication, acceptedInstallPaths } from '../../scripts/accepted-app-install.mjs';
import { installedFileIdentity } from '../../scripts/installed-release.mjs';
import { serviceInstallationContext, inspectServiceDefinitionsSync, matchingServiceDefinitions } from '../../scripts/service-definitions.mjs';
import { readBundleOwner, nativeServiceControl } from '../../scripts/bundle-services.mjs';
import { reconcileBundleServiceStart } from '../../scripts/bundle-service-start.mjs';
import { readBundleProcess } from '../../scripts/local-runtime.mjs';
import { stageBundleServices } from '../../scripts/prepare-bundle-services.mjs';
import { withLifecycleLock, processIdentity } from '../../scripts/lifecycle-lock.mjs';
import { runSupervisedCommand } from '../../scripts/process-group-supervisor.mjs';
import { runtimeProcessChanged } from '../../scripts/runtime-observation.mjs';
import type { ServiceKind } from '../../scripts/service-definitions.mjs';
import type { RuntimeProcessIdentity } from '../../scripts/runtime-observation.mjs';

it('replaces retained signed bundles through real native service startup, qualified drain and exact package custody', async () => {
  if (process.platform !== 'darwin') throw new Error('The native replacement proof requires macOS.');
  const started = Date.now();
  // Includes helper provisioning and teardown, below the common 60s hang guard.
  const deadline = started + 20_000;
  const workUntil = deadline - 5_000;
  const costs: Array<{ phase: string; ms: number }> = [];
  const checkDeadline = (phase: string, until = workUntil) => {
    if (Date.now() >= until) throw new Error(`Native replacement deadline exceeded during ${phase}.`);
  };
  const run = (program: string, args: string[], phase: string, until = workUntil) => {
    const remaining = until - Date.now();
    if (remaining <= 0) throw new Error(`Native replacement deadline exceeded before ${phase}.`);
    const before = Date.now();
    try {
      const output = execFileSync(program, args, { timeout: remaining, encoding: 'utf8', stdio: 'pipe' });
      checkDeadline(phase, until);
      return output;
    }
    finally { costs.push({ phase, ms: Date.now() - before }); }
  };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-accepted-install-')));
  const home = path.join(root, 'account/.mandible');
  const accountHome = path.dirname(home);
  const app = path.join(root, 'Installed.app');
  const identifier = `bio.mll.mandible.fixture.${randomUUID().replaceAll('-', '')}`;
  const context = serviceInstallationContext({ home, accountHome, bundleRoot: app, bundleIdentifier: identifier });
  const roles: ServiceKind[] = ['backend', 'gateway'];
  const references: string[] = [];
  const generations: unknown[] = [];
  let qualified: Partial<Record<ServiceKind, RuntimeProcessIdentity>> = {};
  const waitFor = async (phase: string, predicate: () => boolean, until = workUntil) => {
    for (;;) {
      checkDeadline(phase, until);
      const done = predicate();
      checkDeadline(phase, until);
      if (done) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, until - Date.now())));
    }
  };
  const stopped = (until: number) => {
    const inspection = inspectServiceDefinitionsSync(context, { until });
    if (!inspection.ok) throw new Error(inspection.refusal.message);
    return inspection.observations.every(item => !item.job.loaded || !item.job.pid)
      && Object.values(qualified).every(item => !processIdentity(item.pid, { until }));
  };
  const stop = async (until: number) => {
    for (const role of roles) nativeServiceControl(context, 'unregister', role, { until });
    await waitFor('qualified native service drain', () => stopped(until), until);
  };
  try {
    const runtime = process.env.MANDIBLE_RUNTIME;
    if (!runtime) throw new Error('Run through the pinned provisioned test runner.');
    const helperTarget = path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/service-helper/target');
    // Current checkout, once, with Cargo's ordinary persistent target and
    // fingerprints. No installed helper or hidden prebuild substitutes for it.
    const toolchainHome = run('/bin/sh', ['-c', 'eval "printf %s ~$(id -un)"'], 'toolchain account discovery').trim();
    const helperStarted = Date.now();
    const helperLog = fs.openSync(path.join(root, 'helper-build.log'), 'w');
    try {
      if (Date.now() >= workUntil) throw new Error('Native replacement deadline exceeded before helper build.');
      await runSupervisedCommand('cargo', ['build', '--locked', '--release', '--manifest-path', path.resolve('src-tauri/service-helper/Cargo.toml')], {
        cwd: process.cwd(), env: { ...process.env, CARGO_HOME: process.env.CARGO_HOME || path.join(toolchainHome, '.cargo'),
          RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(toolchainHome, '.rustup') },
        stdio: ['ignore', helperLog, helperLog], timeout: workUntil - Date.now(), graceMs: 500,
      });
    } catch (error) {
      console.error('native_fixture_helper_build_failed', fs.readFileSync(path.join(root, 'helper-build.log'), 'utf8').slice(-4000));
      throw error;
    } finally {
      fs.closeSync(helperLog);
      costs.push({ phase: 'current-source helper build and process cleanup', ms: Date.now() - helperStarted });
    }
    const helper = path.join(helperTarget, 'release/mandible-service');
    fs.mkdirSync(path.join(home, 'config/client-auth'), { recursive: true });
    const authority = path.join(home, 'config/client-auth/authority-id');
    const credentials = path.join(home, 'config/client-auth/credentials');
    fs.writeFileSync(authority, 'preserved-authority');
    fs.writeFileSync(credentials, 'preserved-credentials');
    let prior: ReturnType<typeof readBundleOwner> = null;
    let previousReference = '';
    for (const [index, pin] of ['a', 'b'].entries()) {
      const phaseStarted = Date.now();
      const scratch = path.join(root, `build-${pin}`);
      const built = path.join(scratch, 'Mandible.app');
      const contents = path.join(built, 'Contents');
      const resources = path.join(contents, 'Resources');
      fs.mkdirSync(resources, { recursive: true });
      fs.mkdirSync(path.join(contents, 'MacOS'));
      fs.copyFileSync('/usr/bin/true', path.join(contents, 'MacOS/mandible-app'));
      fs.copyFileSync(runtime, path.join(contents, 'MacOS/mandible-bun'), fs.constants.COPYFILE_FICLONE);
      fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>mandible-app</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${index + 1}</string></dict></plist>`);
      stageBundleServices(contents, helper, identifier);
      run('/usr/bin/codesign', ['--force', '--sign', '-', path.join(contents, 'MacOS/mandible-service')], `sign ${pin} helper`);
      const candidate = { pin_sha: pin.repeat(40), tree_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40), head_sha: 'e'.repeat(40) };
      fs.writeFileSync(path.join(resources, 'service-fixture.json'), JSON.stringify({ accountHome }));
      fs.writeFileSync(path.join(resources, 'foreground.mjs'), `import fs from 'node:fs'; import path from 'node:path';
const root=process.env.MANDIBLE_RELEASE_ROOT; const role=process.argv[2];
const release=JSON.parse(fs.readFileSync(path.join(root,'release.json')));
const owner=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.mandible/config/local-sessions/bundle-owner.json')));
if(!['backend','gateway'].includes(role)||owner.bundleRoot!==path.resolve(root,'../..')||owner.generation!==release.provenance.commit||owner.installationId!=='preserved-authority')throw Error('Fixture service owner differs');
const file=path.join(process.env.HOME,'.cache/mandible',role+'.json');
const pulse=()=>{const next=file+'.'+process.pid;fs.writeFileSync(next,JSON.stringify({pid:process.pid,generation:release.provenance.commit,role,root,at:Date.now()}));fs.renameSync(next,file);};
pulse(); const timer=setInterval(pulse,100);process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0);});
`);
      const native = { bun: '../MacOS/mandible-bun', serviceHelper: '../MacOS/mandible-service' };
      const files = Object.fromEntries(['foreground.mjs', 'service-fixture.json', ...Object.values(native)].map(relative => [relative, installedFileIdentity(path.resolve(resources, relative))]));
      checkDeadline(`generation ${pin} inventory`);
      fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify({ schema: 'mandible-installed-release@1', version: String(index + 1), target: `${process.platform}-${process.arch}`,
        layout: { kind: 'macos-app', roots: { resources: '.', executables: '../MacOS', agents: '../Library/LaunchAgents' } },
        provenance: { commit: candidate.pin_sha, source_digest: pin.repeat(64) }, entrypoints: { daemon: 'foreground.mjs', service: 'foreground.mjs' }, native, files }));
      run('/usr/bin/codesign', ['--force', '--sign', '-', built], `sign ${pin} bundle`);
      const evidence = path.join(root, `evidence-${pin}`);
      fs.writeFileSync(evidence, JSON.stringify({ scope: 'private native service replacement fixture', generation: candidate.pin_sha }));
      checkDeadline(`generation ${pin} retention admission`);
      const reference = await retainAcceptedRelease({ app: built, storage: path.join(root, 'retained'), ownership: { runId: randomUUID(), instanceId: 'fixture', project: 'mandible', workUnit: 'fixture' },
        candidate, acceptance: { record_id: null, request_id: null }, evidence: { receipt: evidence, sha256: installedFileIdentity(evidence).sha256 }, expectedDigest: applicationIdentity(built) });
      references.push(reference);
      checkDeadline(`generation ${pin} retention`);
      fs.rmSync(scratch, { recursive: true });
      const binding = { nativeApp: app, requestId: `request-${index}`, executionId: `execution-${index}`, acceptedRelease: { reference }, bundleOwner: prior,
        priorAppSha256: index ? applicationIdentity(app) : null };
      await withLifecycleLock(home, async () => {
        if (index) await stop(workUntil);
        checkDeadline(`generation ${pin} install admission`);
        installAcceptedApplication(binding, context);
        checkDeadline(`generation ${pin} install`);
        installAcceptedApplication(binding, context);
        checkDeadline(`generation ${pin} install replay`);
        qualified = {};
        for (const role of roles) {
          const result = await reconcileBundleServiceStart(context, role, { until: workUntil,
            control: (ctx, operation, service) => nativeServiceControl(ctx, operation, service, { until: workUntil }),
            readProcess: readBundleProcess, processes: qualified });
          if (!result.ok) throw result.error;
          qualified = result.processes;
          // Admission can precede PID publication after kickstart. Qualify the
          // actual process and heartbeat, retaining earlier roles' continuity.
          await waitFor(`generation ${pin} ${role} qualification`, () => {
            const inspection = inspectServiceDefinitionsSync(context, { until: workUntil });
            if (!inspection.ok) {
              if (inspection.refusal.category === 'starting') return false;
              throw new Error(inspection.refusal.message);
            }
            for (const service of roles) if (qualified[service]
                && runtimeProcessChanged(qualified[service], readBundleProcess(context, service, { until: workUntil }))) {
              throw new Error(`Qualified ${service} process changed during native proof.`);
            }
            const observed = inspection.observations.find(item => item.service === role);
            const current = readBundleProcess(context, role, { until: workUntil });
            const file = path.join(accountHome, '.cache/mandible', `${role}.json`);
            if (!current?.startedAt || current.pid !== observed?.job.pid || !fs.existsSync(file)) return false;
            const beat = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (beat.generation !== candidate.pin_sha || beat.pid !== current.pid || beat.role !== role
                || beat.root !== path.join(app, 'Contents/Resources')) return false;
            qualified[role] = current;
            return true;
          });
        }
        expect(matchingServiceDefinitions(inspectServiceDefinitionsSync(context, { until: workUntil })).ok).toBe(true);
        const receipt = readAcceptedReleaseReceipt(reference);
        expect(applicationIdentity(app)).toBe(receipt.package.sha256);
        checkDeadline(`generation ${pin} exact installed bytes`);
        const previous = acceptedInstallPaths(binding).previous;
        if (index) expect(applicationIdentity(previous)).toBe(binding.priorAppSha256);
        checkDeadline(`generation ${pin} disposal admission`);
        run(runtime, ['scripts/verify-accepted-release.mjs', reference, JSON.stringify(candidate), app, previous,
          binding.priorAppSha256 ?? '', previousReference], `verify/dispose ${pin}`);
        expect(fs.existsSync(previous)).toBe(false);
        if (previousReference) expect(fs.existsSync(readAcceptedReleaseReceipt(previousReference).package.handle.root)).toBe(false);
        expect(fs.readFileSync(authority, 'utf8')).toBe('preserved-authority');
        expect(fs.readFileSync(credentials, 'utf8')).toBe('preserved-credentials');
        prior = readBundleOwner(context);
        checkDeadline(`generation ${pin} custody/disposal`);
        for (const role of roles) if (runtimeProcessChanged(qualified[role], readBundleProcess(context, role, { until: workUntil }))) {
          throw new Error(`Qualified ${role} process changed before the replacement proof completed.`);
        }
        expect(prior).toMatchObject({ generation: candidate.pin_sha, acceptedRelease: reference, installationId: 'preserved-authority' });
        generations.push({ generation: candidate.pin_sha, processes: qualified, packageSha256: receipt.package.sha256,
          provisioning_install_proof_ms: Date.now() - phaseStarted });
      });
      previousReference = reference;
    }
  } finally {
    const teardownStarted = Date.now();
    let cleaned = false;
    try {
      if (fs.existsSync(app)) await withLifecycleLock(home, () => stop(deadline));
      for (const reference of references) {
        checkDeadline('final disposal admission', deadline);
        const receipt = readAcceptedReleaseReceipt(reference);
        if (fs.existsSync(receipt.package.handle.root)) {
          const disposed = await disposeAcceptedRelease(reference, receipt.candidate, 'Private native fixture complete');
          checkDeadline('final disposal', deadline);
          expect(disposed.remaining).toEqual([]);
        }
      }
      cleaned = true;
    } finally {
      // An unconfirmed service stop retains its exact app and evidence.
      if (cleaned) fs.rmSync(root, { recursive: true, force: true });
      console.info('native_bundle_replacement_proof', JSON.stringify({ scope: 'private SMAppService replacement; no product daemon, GUI, ledger or approval API',
        identifier, generations, command_costs: costs, whole_ms: Date.now() - started, teardown_ms: Date.now() - teardownStarted,
        target_ms: 60_000, deadline_ms: 20_000, teardown_reserve_ms: 5_000,
        cleanup: cleaned ? 'complete' : 'unconfirmed', retained_root: cleaned ? null : root }));
    }
    checkDeadline('final cleanup', deadline);
  }
});
