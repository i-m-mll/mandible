// @provisioned launchd
// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createPendingRelease, retainAcceptedRelease, applicationIdentity, readAcceptedReleaseReceipt } from '../../scripts/accepted-release.mjs';
import { acceptedInstallPaths } from '../../scripts/accepted-app-install.mjs';
import { installedFileIdentity, verifyInstalledRelease } from '../../scripts/installed-release.mjs';
import { serviceInstallationContext, inspectServiceDefinitionsSync, matchingServiceDefinitions } from '../../scripts/service-definitions.mjs';
import { readBundleOwner, nativeServiceControl } from '../../scripts/bundle-services.mjs';
import { bindingDigest, handoffDirectory, runRuntimeHandoffWorker } from '../../scripts/runtime-handoff.mjs';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { readBundleProcess } from '../../scripts/local-runtime.mjs';
import { stageBundleServices } from '../../scripts/prepare-bundle-services.mjs';
import { withLifecycleLock, processIdentity } from '../../scripts/lifecycle-lock.mjs';
import { runSupervisedCommand } from '../../scripts/process-group-supervisor.mjs';
import { RuntimeObservationError, runtimeProcessChanged } from '../../scripts/runtime-observation.mjs';
import type { ServiceKind } from '../../scripts/service-definitions.mjs';
import type { RuntimeProcessIdentity } from '../../scripts/runtime-observation.mjs';

it('replaces retained signed bundles through real native service startup, qualified drain and exact package custody', async () => {
  if (process.platform !== 'darwin') throw new Error('The native replacement proof requires macOS.');
  // The existing provisioned launcher starts this clock before private runtime
  // and Vitest setup. No fresh allowance begins when the test body starts.
  const started = Number(process.env.MANDIBLE_NATIVE_PROOF_STARTED_AT);
  const deadline = Number(process.env.MANDIBLE_NATIVE_PROOF_UNTIL);
  const cleanupUntil = Number(process.env.MANDIBLE_NATIVE_PROOF_CLEANUP_UNTIL);
  if (!Number.isFinite(started) || deadline !== started + 20_000 || cleanupUntil !== deadline - 2500 || Date.now() >= deadline) {
    throw new Error('Run the native proof through test:provisioned with its original command deadline.');
  }
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
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/mandible-native-'));
  const home = path.join(root, 'account/.mandible');
  const accountHome = path.dirname(home);
  const app = path.join(root, 'Installed.app');
  const gatewaySocket = path.join(root, 'admin.sock');
  const identifier = `bio.mll.mandible.fixture.${randomUUID().replaceAll('-', '')}`;
  const context = serviceInstallationContext({ home, accountHome, bundleRoot: app, bundleIdentifier: identifier });
  const roles: ServiceKind[] = ['backend', 'gateway'];
  const references: string[] = [];
  const generations: unknown[] = [];
  let sourceRevision: string | null = null;
  let candidateExecutables: Record<string, ReturnType<typeof installedFileIdentity>> | null = null;
  let failureDiagnostic: { json_excerpt: string; truncated: boolean; service_stderr: Record<string, string> } | null = null;
  console.info('native_bundle_replacement_started', JSON.stringify({ identifier, root, started, deadline }));
  const runtime = process.env.MANDIBLE_RUNTIME;
  const supervised = async (args: string[], phase: string, until = workUntil) => {
    checkDeadline(phase, until);
    const before = Date.now();
    const logFile = path.join(root, `${phase.replaceAll(/[^a-zA-Z0-9]/g, '-')}.log`);
    const log = fs.openSync(logFile, 'w');
    try {
      const timeout = until - Date.now() - 500;
      if (timeout <= 0) throw new Error(`Native replacement termination allowance exhausted before ${phase}.`);
      await runSupervisedCommand(runtime!, args, { cwd: process.cwd(), env: process.env,
        stdio: ['ignore', log, log], timeout, graceMs: 100 });
      checkDeadline(phase, until);
    } catch (error) {
      console.error('native_fixture_phase_failed', { phase, error: String(error), excerpt: fs.readFileSync(logFile, 'utf8').slice(-4000) });
      throw error;
    } finally { fs.closeSync(log); costs.push({ phase, ms: Date.now() - before }); }
  };
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
    if (!runtime) throw new Error('Run through the pinned provisioned test runner.');
    sourceRevision = run('git', ['rev-parse', 'HEAD'], 'source revision').trim();
    if (run('git', ['status', '--porcelain', '--untracked-files=all'], 'source checkout check').trim()) throw new Error('Native qualification requires a clean committed source checkout.');
    const candidateApp = process.env.MANDIBLE_NATIVE_PROOF_APP;
    if (!candidateApp || !path.isAbsolute(candidateApp)) throw new Error('Native proof requires MANDIBLE_NATIVE_PROOF_APP from the candidate package already built for this qualification.');
    const candidateMacOS = path.join(candidateApp, 'Contents/MacOS');
    const helper = path.join(candidateMacOS, 'mandible-service');
    for (const executable of ['mandible-service', 'mandible-bun', 'mandible-caddy']) if (!fs.statSync(path.join(candidateMacOS, executable)).isFile()) throw new Error('Candidate native proof executable is missing: ' + executable);
    candidateExecutables = Object.fromEntries(['mandible-service', 'mandible-bun', 'mandible-caddy'].map(executable => [executable, installedFileIdentity(path.join(candidateMacOS, executable))]));
    fs.mkdirSync(path.join(home, 'config/client-auth'), { recursive: true });
    const authority = path.join(home, 'config/client-auth/authority-id');
    const credentials = path.join(home, 'config/client-auth/credentials');
    fs.writeFileSync(authority, 'preserved-authority');
    fs.writeFileSync(credentials, 'preserved-credentials');
    const predecessor = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const terminated = once(predecessor, 'exit');
    let initialProcess: { pid: number; startedAt: string };
    try {
      await once(predecessor, 'spawn');
      initialProcess = { pid: predecessor.pid!, startedAt: run('/bin/ps', ['-p', String(predecessor.pid), '-o', 'lstart='], 'capture initial process birth').trim() };
      expect(initialProcess.startedAt).not.toBe('');
    } finally {
      predecessor.kill('SIGTERM');
      await terminated;
    }
    expect(processIdentity(initialProcess.pid, { until: workUntil })).toBeNull();
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
      fs.copyFileSync(path.join(candidateMacOS, 'mandible-bun'), path.join(contents, 'MacOS/mandible-bun'), fs.constants.COPYFILE_FICLONE);
      fs.copyFileSync(path.join(candidateMacOS, 'mandible-caddy'), path.join(contents, 'MacOS/mandible-caddy'), fs.constants.COPYFILE_FICLONE);
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
if(role==='gateway')process.execve(path.join(root,'../MacOS/mandible-caddy'),[path.join(root,'../MacOS/mandible-caddy'),'run','--config',path.join(process.env.HOME,'.mandible/config/local-sessions/fixture-caddy.json')],process.env);
const file=path.join(process.env.HOME,'.cache/mandible',role+'.json');
const pulse=()=>{const active=path.join(process.env.HOME,'.mandible/config/local-sessions/handoff-active.json');if(fs.existsSync(active)){const owner=JSON.parse(fs.readFileSync(active));const handoff=JSON.parse(fs.readFileSync(owner.journal));if(handoff.acknowledgedAt&&handoff.bridgeInstalled&&handoff.attempt?.effects.prepare?.completedAt&&handoff.binding.oldProcess.pid===process.pid)process.exit(0);}const next=file+'.'+process.pid;fs.writeFileSync(next,JSON.stringify({pid:process.pid,generation:release.provenance.commit,role,root,at:Date.now()}));fs.renameSync(next,file);};
pulse(); const timer=setInterval(pulse,100);process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0);});
`);
      const native = { bun: '../MacOS/mandible-bun', caddy: '../MacOS/mandible-caddy', serviceHelper: '../MacOS/mandible-service' };
      const files = Object.fromEntries(['foreground.mjs', 'service-fixture.json', ...Object.values(native)].map(relative => [relative, installedFileIdentity(path.resolve(resources, relative))]));
      checkDeadline(`generation ${pin} inventory`);
      fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify({ schema: 'mandible-installed-release@1', version: String(index + 1), target: `${process.platform}-${process.arch}`,
        layout: { kind: 'macos-app', roots: { resources: '.', executables: '../MacOS', agents: '../Library/LaunchAgents' } },
        provenance: { commit: candidate.pin_sha, source_digest: pin.repeat(64) }, entrypoints: { daemon: 'foreground.mjs', service: 'foreground.mjs' }, serviceExecutables: { backend: 'bun', gateway: 'caddy' }, native, files }));
      run('/usr/bin/codesign', ['--force', '--sign', '-', built], `sign ${pin} bundle`);
      const evidence = path.join(root, `evidence-${pin}`);
      fs.writeFileSync(evidence, JSON.stringify({ scope: 'private native service replacement fixture', generation: candidate.pin_sha }));
      checkDeadline(`generation ${pin} retention admission`);
      const pending = await createPendingRelease({ storage: path.join(root, 'retained'), ownership: { runId: randomUUID(), instanceId: 'fixture', project: 'mandible', workUnit: 'fixture' } });
      fs.cpSync(built, pending.app, { recursive: true, verbatimSymlinks: true });
      const { reference } = await retainAcceptedRelease({ pending,
        candidate, acceptance: { record_id: null, request_id: null }, evidence: { receipt: evidence, sha256: installedFileIdentity(evidence).sha256 },
        expectedDigest: applicationIdentity(pending.app), shipped: verifyInstalledRelease(pending.resources) });
      references.push(reference);
      checkDeadline(`generation ${pin} retention`);
      fs.rmSync(scratch, { recursive: true });
      const before = index ? inspectServiceDefinitionsSync(context, { until: workUntil }) : null;
      if (before && !before.ok) throw new Error(before.refusal.message);
      const previousServices = Object.fromEntries((before?.observations ?? []).map(item => [item.service, { argv: item.job.argv, definition: item.loadedDefinition, process: { pid: item.job.pid, startedAt: item.job.startedAt } }]));
      const binding = { home, root: path.join(root, 'absent-checkout'), nativeApp: app, requestId: 'request-' + index, executionId: 'execution-' + index,
        acceptedRelease: { reference }, bundleOwner: prior, priorAppSha256: index ? applicationIdentity(app) : null,
        runtime: { path: runtime, sha256: installedFileIdentity(runtime).sha256 }, installationId: 'preserved-authority',
        domain: context.domain, backendLabel: context.backendLabel, gatewayLabel: context.gatewayLabel,
        priorBackend: { ...previousServices.backend, launchMode: 'manual' }, priorGateway: previousServices.gateway,
        oldProcess: previousServices.backend?.process ?? initialProcess, desktopWasRunning: false };
      const dir = handoffDirectory(home, binding.requestId, binding.executionId); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'journal.json');
      fs.writeFileSync(file, JSON.stringify({ schema: 'mandible-runtime-handoff@1', binding, bindingDigest: bindingDigest(binding), phase: 'armed',
        deadline: workUntil, bridgeInstalled: true, attempt: { id: 'native-attempt-' + index, enteredAt: Date.now(), deadline: workUntil, state: 'running', effects: {} } }));
      fs.writeFileSync(path.join(home, 'config/local-sessions/handoff-active.json'), JSON.stringify({ journal: file, bindingDigest: bindingDigest(binding) }));
      let nativeRuntime;
      let interrupted = false;
      const readAccess = async (awaitReady = false) => {
        const processes = Object.fromEntries(roles.map(role => [role, readBundleProcess(context, role, { until: workUntil })]));
        if (roles.some(role => !processes[role]?.startedAt)) throw new Error('Native process qualification is missing.');
        const heartbeatFile = path.join(accountHome, '.cache/mandible/backend.json');
        await waitFor('native backend heartbeat', () => fs.existsSync(heartbeatFile)
          && JSON.parse(fs.readFileSync(heartbeatFile, 'utf8')).generation === candidate.pin_sha);
        const heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
        expect(heartbeat.pid).toBe(processes.backend.pid);
        expect(heartbeat.role).toBe('backend');
        expect(heartbeat.root).toBe(path.join(app, 'Contents/Resources'));
        const probeGateway = () => new Promise<number>((resolve, reject) => {
          const request = http.get({ socketPath: gatewaySocket, path: '/config/' }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
          request.setTimeout(Math.max(1, workUntil - Date.now()), () => request.destroy(new Error('Native gateway access deadline.')));
          request.on('error', reject);
        });
        let status: number;
        for (;;) {
          try { status = await probeGateway(); break; }
          catch (error) {
            if (!awaitReady || !['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
            checkDeadline('native gateway readiness');
            await new Promise(resolve => setTimeout(resolve, Math.min(25, workUntil - Date.now())));
          }
        }
        expect(status).toBe(200);
        for (const role of roles) if (runtimeProcessChanged(processes[role], readBundleProcess(context, role, { until: workUntil }))) throw new Error(`Qualified ${role} process changed during native access.`);
        return { processes, heartbeat, gatewayAdmin: status };
      };
      const control = async (journal, command, _currentVerifier, options) => {
        const priorJournal = process.env.MANDIBLE_RUNTIME_HANDOFF_JOURNAL;
        process.env.MANDIBLE_RUNTIME_HANDOFF_JOURNAL = file;
        try {
        if (command === 'handoff-remove' && !index) return '{}';
        if (command === 'handoff-start' && index && !interrupted) { interrupted = true; throw new RuntimeObservationError('fixture_interruption', 'Installed before launch.', null, 'pending'); }
        if (!nativeRuntime) {
          const priorEnv = { MANDIBLE_HOME: process.env.MANDIBLE_HOME, MANDIBLE_SERVICE_ACCOUNT_HOME: process.env.MANDIBLE_SERVICE_ACCOUNT_HOME, MANDIBLE_RUNTIME_HANDOFF_CAPTURE: process.env.MANDIBLE_RUNTIME_HANDOFF_CAPTURE };
          Object.assign(process.env, { MANDIBLE_HOME: home, MANDIBLE_SERVICE_ACCOUNT_HOME: accountHome, MANDIBLE_RUNTIME_HANDOFF_CAPTURE: '1' });
          try { nativeRuntime = await import(pathToFileURL(path.resolve('scripts/local-runtime.mjs')).href + '?nativeFixture=' + identifier); }
          finally { for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
        }
        if (command === 'handoff-remove') return JSON.stringify(await nativeRuntime.removeHandoffDefinitions(binding, { until: options.until }));
        if (command === 'handoff-start') return JSON.stringify(await nativeRuntime.startHandoffDefinitions(binding, { until: options.until,
          processes: journal.attempt.effects.services?.processes ?? {}, initialize: async () => {}, configure: async () => {
            fs.writeFileSync(path.join(context.runtimeDir, 'fixture-caddy.json'), JSON.stringify({ admin: { listen: 'unix/' + gatewaySocket }, apps: {} }));
          } }));
        return JSON.stringify(await readAccess(options.awaitReady));
        } finally { if (priorJournal === undefined) delete process.env.MANDIBLE_RUNTIME_HANDOFF_JOURNAL; else process.env.MANDIBLE_RUNTIME_HANDOFF_JOURNAL = priorJournal; }
      };
      const options = { control, verifyPublication: async () => {}, waitMs: Math.max(1, workUntil - Date.now()),
        observe: async journal => ({ bindingDigest: journal.bindingDigest, evidence: await readAccess(), files: {}, completedAt: Date.now() }) };
      let completed = await runRuntimeHandoffWorker(file, options);
      if (index) {
        expect(completed.attempt.state, JSON.stringify(completed.attempt.lastObservation)).toBe('running');
        expect(applicationIdentity(app)).toBe(readAcceptedReleaseReceipt(reference).package.sha256);
        expect(completed.attempt.effects.replace.completedAt).toBeDefined();
        const attemptId = completed.attempt.id;
        completed = await runRuntimeHandoffWorker(file, options);
        expect(completed.attempt.id).toBe(attemptId);
      }
      expect(completed.attempt.state, JSON.stringify(completed.attempt.lastObservation)).toBe('complete');
      qualified = completed.attempt.effects.services.processes;
      await withLifecycleLock(home, async () => {
        expect(matchingServiceDefinitions(inspectServiceDefinitionsSync(context, { until: workUntil })).ok).toBe(true);
        const receipt = readAcceptedReleaseReceipt(reference);
        expect(applicationIdentity(app)).toBe(receipt.package.sha256);
        checkDeadline(`generation ${pin} exact installed bytes`);
        const previous = acceptedInstallPaths(binding).previous;
        if (index) expect(applicationIdentity(previous)).toBe(binding.priorAppSha256);
        checkDeadline(`generation ${pin} disposal admission`);
        await supervised(['scripts/verify-accepted-release.mjs', reference, JSON.stringify(candidate), app, previous,
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
  } catch (error) {
    const serialized = JSON.stringify(error instanceof RuntimeObservationError ? error.toJSON()
      : { name: error instanceof Error ? error.name : 'UnknownError', message: String(error) },
    (key, value) => key === 'observations' && Array.isArray(value) ? value.slice(-4) : value);
    failureDiagnostic = { json_excerpt: serialized.slice(0, 16_000), truncated: serialized.length > 16_000,
      service_stderr: Object.fromEntries(['production', 'local-front-door'].map(role => {
        const file = path.join(accountHome, '.cache/mandible', `${role}-stderr.log`);
        return [role, fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-4000) : ''];
      })) };
    console.error('native_bundle_replacement_failed', JSON.stringify(failureDiagnostic));
    throw error;
  } finally {
    const teardownStarted = Date.now();
    let cleaned = false;
    try {
      if (fs.existsSync(app)) await withLifecycleLock(home, () => stop(cleanupUntil));
      for (const reference of references) {
        checkDeadline('final disposal admission', cleanupUntil);
        const receipt = readAcceptedReleaseReceipt(reference);
        if (fs.existsSync(receipt.package.handle.root)) {
          await supervised(['scripts/verify-accepted-release.mjs', reference, JSON.stringify(receipt.candidate), '', '', '', reference, 'cleanup'], 'final retained package disposal', cleanupUntil);
          checkDeadline('final disposal', cleanupUntil);
          expect(fs.existsSync(receipt.package.handle.root)).toBe(false);
        }
      }
      cleaned = true;
    } finally {
      // An unconfirmed service stop retains its exact app and evidence.
      if (cleaned) fs.rmSync(root, { recursive: true, force: true });
      console.info('native_bundle_replacement_proof', JSON.stringify({ scope: 'private SMAppService replacement; no product daemon, GUI, ledger or approval API',
        source_revision: sourceRevision, candidate_app: process.env.MANDIBLE_NATIVE_PROOF_APP, candidate_executables: candidateExecutables,
        runtime_source: 'Current source reconciler and native effect modules; fixture authority/access adapters; copied candidate helper is re-signed for private descriptors.',
        identifier, generations, command_costs: costs, failure: failureDiagnostic,
        clock_origin: 'provisioned runner entry; external wall includes earlier runtime selector/import startup',
        runner_entry_elapsed_ms: Date.now() - started, teardown_ms: Date.now() - teardownStarted,
        target_ms: 60_000, deadline_ms: 20_000, teardown_reserve_ms: 5_000,
        termination_margin_ms: deadline - cleanupUntil,
        cleanup: cleaned ? 'complete' : 'unconfirmed', retained_root: cleaned ? null : root }));
    }
    checkDeadline('final cleanup', cleanupUntil);
  }
});
