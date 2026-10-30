#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { localCaPaths, assertLocalCaIdentity, probeCurrentMacOsTrust } from './local-ca-trust.mjs';
import { installedRuntimeEnvironment, releaseFile, verifyInstalledRelease, verifyApplicationRelease } from './installed-release.mjs';
import { installedExecutionProfile } from './installed-execution.mjs';
import { applicationIdentity, createPendingRelease, retainAcceptedRelease, disposePendingRelease } from './accepted-release.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { runSupervisedCommand } from './process-group-supervisor.mjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as abortableDelay } from 'node:timers/promises';
import { withOwnedRunLock, createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun } from './owned-run.mjs';
import { reconcileGeneratedScratch, recordScratchProcess } from './generated-scratch.mjs';
import { generatedStorage } from './generated-storage.mjs';
import Database from '../src/sqlite.ts';
import { readBuildRevision } from './build-revision.mjs';
import { acceptanceResultPath } from './acceptance-result.mjs';
import { acceptanceDeadline, acceptanceBudgetExhausted } from './acceptance-deadline.mjs';
import { acceptanceFailure, compactFailure, describeAcceptanceFailure, sentence } from './acceptance-failure.mjs';
import { observeRuntimeHealthCoverage, RuntimeHealthObservationError, EVENT_LOOP_STALL_BUDGET_MS } from '../src/runtime-health-contract.ts';
import { gatewayCaddyfile, GATEWAY_GRACE_SECONDS } from './gateway-config.mjs';
import { resolveAppSigning, requireNativeAppSigning } from './app-signing.mjs';


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacySweepWorkDirectory = 'route-cost-work';
export const acceptanceScope = 'exact signed shipped package, isolated bundled-runtime Settings persistence, contemporaneous production health/memory/lag, supervised shutdown/logs, exact-byte retention and cleanup; excludes full-corpus source-preview performance and installed upgrade convergence';
const applicationPolicyProgram = '/usr/sbin/taskpolicy';
export function acceptanceApplicationPolicy() {
  const budget = acceptanceDeadline();
  budget.remaining('total');
  if (process.platform !== 'darwin') throw acceptanceFailure('environment', `Candidate acceptance runs the packaged desktop app, which needs macOS; this machine runs ${process.platform}.`);
  const scope = process.env.MANDIBLE_ACCEPTANCE_CLOCK_SCOPE ?? budget.reading().scope;
  if (process.env.MANDIBLE_ACCEPTANCE_APPLICATION_POLICY_PID !== String(process.pid)) {
    process.execve(applicationPolicyProgram, [applicationPolicyProgram, '-a', process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
      ...process.env,
      ...(process.env.MANDIBLE_ACCEPTANCE_DEADLINE === undefined ? budget.env : {}),
      MANDIBLE_ACCEPTANCE_APPLICATION_POLICY_PID: String(process.pid),
      MANDIBLE_ACCEPTANCE_CLOCK_SCOPE: scope,
    });
    throw acceptanceFailure('environment', 'Acceptance could not relaunch itself under the macOS application policy (taskpolicy).');
  }
  return { ...budget, reading: () => ({ ...budget.reading(), scope }) };
}
export const acceptanceOwnedOutputs = ['home', 'build.log', 'daemon.log', 'desktop.log', 'gateway.log', 'Caddyfile'].map(path => ({ path, kind: 'generated' }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const instant = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms);
const exit = child => child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode}`;
const restarted = () => acceptanceFailure('either', 'The packaged daemon restarted during acceptance (its startup epoch changed), which usually means it crashed; the daemon log excerpt in the acceptance result shows why.');
const stopped = () => acceptanceFailure('environment', 'Acceptance was stopped before it finished, because its time ran out or the daemon cancelled the run.');
const interaction = 'In the packaged app, acceptance skips the optional-integrations setup, changes the app theme in Settings, completes the setup, and reloads twice, checking after each step that the change persisted.';
const interactionReport = [
  [evidence => evidence.rendered, 'the edited theme showing after reload'],
  [evidence => evidence.edit, 'the Settings edit'],
  [evidence => evidence.setup?.skipped === 'skipped', 'setup recorded as skipped'],
  [evidence => evidence.setup?.completed === 'complete', 'setup recorded as complete'],
  [evidence => evidence.setup?.reloads === 2, 'both reloads'],
  [evidence => evidence.setup?.promptDismissedAfterReload, 'the setup prompt staying dismissed after reload'],
  [evidence => evidence.setup?.integrationsUnchanged, 'integrations left unchanged by setup'],
];
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 60_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim();
}

import { assessRuntimeLogs } from './runtime-log-assessment.mjs';

export function acceptanceSummary(result) {
  const checks = result.checks ?? {};
  const phases = [
    result.provenance?.package_sha256 ? 'package provenance verified' : 'package verification not completed',
    checks.readiness ? 'daemon readiness checked' : 'daemon readiness not completed',
    checks.desktop_interaction?.passed ? 'packaged Settings edit checked' : 'packaged Settings edit not completed',
  ];
  if (checks.log_digest) phases.push(`raw-log SHA256 ${checks.log_digest}`);
  return `${result.candidate}: ${result.status}${result.error ? ` — ${result.error}` : ''}; ${phases.join('; ')}`;
}

export function compactAcceptanceResult(result) {
  if (JSON.stringify(result).length <= 60 * 1024) return result;
  const checks = result.checks ?? {};
  const route = checks.route_cost;
  return { schema: result.schema, truncated: true, status: result.status, candidate: result.candidate, binding: result.binding, scope: result.scope,
    budget: result.budget, phases: result.phases, error: result.error?.slice(0, 1024), failure: compactFailure(result.failure), cleanup_error: result.cleanup_error?.slice(0, 512), receipt: result.receipt,
    checks: { readiness: checks.readiness, desktop_interaction: checks.desktop_interaction, health_coverage: checks.health_coverage,
      log_digest: checks.log_digest, log_bytes: checks.log_bytes, cleanup: checks.cleanup,
      initial_transport_error: checks.initial_transport_error,
      failure_logs: checks.failure_logs?.map(log => ({ ...log, excerpt: log.excerpt.slice(-1000) })),
      route_cost: route ? { complete: route.complete, diagnostic: route.diagnostic, error: route.error?.slice(0, 512),
        progress: route.progress, counts: route.counts, pending_confirmations: route.pending_confirmations?.slice(0, 32),
        routes_not_run: route.routes_not_run?.slice(0, 32), source_stderr: route.source_stderr?.slice(-1000) } : route,
    } };
}

/**
 * The app's completion time, in whole milliseconds, which must fall within the
 * health observation. Flooring keeps a sub-millisecond mtime from rounding
 * past the clock reading it is compared with.
 */
export function interactionCompletion(evidenceMtimeMs, daemonReadyAt, checkedAt) {
  const completedAt = Math.floor(evidenceMtimeMs);
  if (Number.isFinite(completedAt) && completedAt >= daemonReadyAt && completedAt <= checkedAt) return completedAt;
  throw acceptanceFailure('environment', `Acceptance monitors the daemon's health for as long as the packaged app works, but the app's Settings edit is dated ${instant(completedAt)}, outside the period acceptance monitored: from the daemon's readiness at ${instant(daemonReadyAt)} to ${instant(checkedAt)}, when it found the app's result. The system clock most likely moved during the run.`,
    { daemon_ready_at: daemonReadyAt, interaction_completed_at: evidenceMtimeMs, checked_at: checkedAt });
}

export function createAcceptanceHome(home) {
  fs.mkdirSync(home, { mode: 0o700 });
}

async function verifyPackagedUpdaterEntrypoint({ resources, runtime, environment, home, profile, budget }) {
  const privateHome = path.join(home, 'updater-entrypoint');
  const journal = path.join(privateHome, 'config/local-sessions/handoff/invalid-request-invalid-execution/journal.json');
  fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
  fs.writeFileSync(journal, JSON.stringify({ schema: 'invalid', bindingDigest: '0'.repeat(64),
    binding: { home: privateHome, requestId: 'invalid-request', executionId: 'invalid-execution' } }), { mode: 0o600 });
  try {
    await runSupervisedCommand('/usr/bin/sandbox-exec', ['-p', profile, runtime, '--no-install', path.join(resources, 'handoff/helper.mjs'), 'worker', journal], {
      env: { ...environment, MANDIBLE_HOME: privateHome }, cwd: privateHome, capture: true, maxBuffer: 16 * 1024,
      timeout: budget.remaining('preparation'), graceMs: 250, deadline: budget.cutoffs.report,
    });
  } catch (error) {
    if (error.exitCode === 1 && error.processGroupSettled && error.stderr?.trim() === 'Runtime handoff binding is malformed or changed.') {
      return { status: 'passed', exit_code: 1, refusal: error.stderr.trim() };
    }
    if (error.timedOut) throw error;
    throw acceptanceFailure('candidate', `The packaged updater was given a deliberately invalid handoff journal and should have refused it with "Runtime handoff binding is malformed or changed.", but it ended differently: ${sentence(error.stderr?.trim() || error.message)}`);
  }
  throw acceptanceFailure('candidate', 'The packaged updater accepted a deliberately invalid handoff journal; it must refuse one.');
}

export function diagnosticReplayPackage(receiptFile, app) {
  if (!receiptFile || !app) throw new Error('Diagnostic replay requires both --diagnostic-receipt and --diagnostic-app.');
  const source = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const failed = source.acceptance;
  const shipped = verifyInstalledRelease(path.join(app, 'Contents/Resources'));
  if (source.schema !== 'mandible-owned-run@1' || failed?.status !== 'failed'
      || failed.schema !== 'mandible-candidate-acceptance@1'
      || applicationIdentity(app) !== failed.provenance?.package_sha256
      || shipped.provenance.commit !== failed.candidate
      || shipped.provenance.source_digest !== failed.provenance.marker?.source_digest) throw new Error('Diagnostic package does not match the exact failed acceptance.');
  return { app: fs.realpathSync(app), candidate: failed.candidate, marker: failed.provenance.marker,
    sha256: failed.provenance.package_sha256, receipt: fs.realpathSync(receiptFile), receipt_sha256: sha256(receiptFile) };
}

export function diagnosticReport(result) {
  return { ...result, schema: 'mandible-candidate-diagnostic@1', status: 'diagnostic',
    diagnostic: { ...result.diagnostic, qualifying: false, observation_status: result.status } };
}

async function retainDiagnosticEvidence(run, ownership) {
  const destination = path.join(path.dirname(run), 'diagnostics', ownership.runId);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  await withOwnedRunLock(destination, async () => {
    const owner = createOwnedRun({ root: destination, runId: ownership.runId, instanceId: ownership.instanceId,
      project: ownership.project, workUnit: ownership.workUnit, outputs: [{ path: 'diagnostics', kind: 'interactive' }] });
    saveOwnedMetadata(path.join(destination, 'metadata.json'), { ownership: owner });
    fs.cpSync(path.join(run, 'diagnostics'), path.join(destination, 'diagnostics'), { recursive: true });
  });
  return destination;
}

export function acceptanceGatewayConfig({ origin, backendPort, storageRoot }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.hostname !== 'app.mandible.localhost' || !url.port || url.origin !== origin) throw new Error('Acceptance requires an exact Mandible HTTPS origin.');
  const ports = [Number(url.port), backendPort];
  if (!ports.every(port => Number.isInteger(port) && port > 0 && port < 65536) || new Set(ports).size !== 2 || !path.isAbsolute(storageRoot)) throw new Error('Acceptance gateway requires distinct valid ports and owned absolute storage.');
  return gatewayCaddyfile([{ role: 'main', instance_id: 'acceptance', public_origin: origin,
    backend_origin: `http://127.0.0.1:${backendPort}` }], { storageRoot });
}

/** Acceptance's log verdict: runtime log failures plus every health event, since a stall on the fixture is the code's. */
export function assessAcceptanceLogs(text, context) {
  const { failures, diagnostics } = assessRuntimeLogs(text, context);
  return { failures: [...failures, ...diagnostics.health_events.retained.map(entry => `Runtime health event: ${JSON.stringify(entry)}`)], diagnostics };
}

const healthFindings = {
  event_loop_stall: sample => `While the packaged app ran, the daemon's event loop was blocked for ${sample.maxMs} ms at once; acceptance allows less than ${EVENT_LOOP_STALL_BUDGET_MS} ms. Blocks that long usually come from daemon code doing slow synchronous work, though a heavily loaded machine can cause them.`,
  event_loop_lag: () => "While the packaged app ran, the daemon raised its event-loop lag warning: requests waited noticeably before being handled.",
  memory_warning: () => 'While the packaged app ran, the daemon raised its memory warning.',
};

export async function observeAcceptanceHealth({
  probe,
  now = Date.now,
  wait = delay,
  observationMs = 0,
  deadlineMs = 62_000,
  onEvidence = () => {},
  live,
}) {
  const result = await observeRuntimeHealthCoverage({
    probe,
    healthOf: value => value,
    validate: (value, initial) => {
      if (value.startup_epoch !== initial.startup_epoch) throw restarted();
    },
    now,
    wait,
    pollMs: 500,
    observationMs,
    deadlineMs,
    live,
  });
  onEvidence({ mode: live ? 'live production collectors through actual packaged interaction completion' : 'completed periodic intervals', observation: result.observation, samples: result.samples, performance: result.performance,
    periodic_windows_completed: Math.max(0, (result.samples.last.eventLoop?.sequence ?? 0) - (result.samples.initial.eventLoop?.sequence ?? 0)) });
  // A performance finding on the owned fixture fails acceptance.
  const [finding] = result.performance.findings;
  if (finding) throw Object.assign(new RuntimeHealthObservationError(finding.code, healthFindings[finding.code](finding.sample), { observation: result.observation, performance: result.performance }), { acceptanceFault: 'either' });
  return result.value;
}

export function copyAcceptanceCa(sourceHome, home, { timeoutMs = 5000 } = {}) {
  const source = localCaPaths(sourceHome);
  if (assertLocalCaIdentity(source).state !== 'trusted') throw acceptanceFailure('environment', "Acceptance serves the packaged app over HTTPS with this installation's local certificate authority, which is not trusted yet; set up secure local connections first.");
  probeCurrentMacOsTrust(source, { timeoutMs });
  const ca = localCaPaths(home);
  fs.mkdirSync(path.dirname(ca.installationAuthority), { recursive: true });
  fs.copyFileSync(source.installationAuthority, ca.installationAuthority);
  fs.cpSync(source.storageRoot, ca.storageRoot, { recursive: true });
  const receipt = JSON.parse(fs.readFileSync(source.receipt, 'utf8'));
  fs.writeFileSync(ca.receipt, JSON.stringify({ ...receipt, storage_root: ca.storageRoot, fixture_source_digest: sha256(source.receipt) }), { mode: 0o600 });
  assertLocalCaIdentity(ca);
  return ca;
}

export function acceptanceHealth(origin, rootCert, signal) {
  return new Promise((resolve, reject) => {
    const request = https.get(`${origin}/api/health`, {
      ca: fs.readFileSync(rootCert),
      lookup: (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
    }, response => {
      let bytes = ''; response.on('data', chunk => { bytes += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`The daemon's health endpoint answered HTTP ${response.statusCode} through the HTTPS gateway${response.statusCode === 502 ? ', meaning the gateway could not reach the daemon' : ''}.`);
          resolve(JSON.parse(bytes));
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(1500, () => request.destroy(new Error("The daemon's health endpoint did not answer within 1.5 seconds.")));
    if (signal) {
      const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('Acceptance health observation aborted'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      request.once('close', () => signal.removeEventListener('abort', abort));
    }
    request.on('error', reject);
  });
}

// A process that has not bound its port yet refuses the connection.
function readinessPending(error) {
  return error.cause?.code === 'ECONNREFUSED' || ['ECONNREFUSED', 'ConnectionRefused'].includes(error.code);
}

/** Resolve once something accepts TCP connections on the loopback port. */
export function loopbackListening(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', reject);
  });
}

/**
 * Probe until `isReady` accepts an answer. Connection refusal is pending by
 * default; callers may supply a scoped startup predicate. Expiry names the
 * last observation within the same fixed deadline.
 */
export async function awaitReadiness(probe, isReady, { timeout, description, interval = 100, pending = readinessPending }) {
  const end = Date.now() + timeout;
  let last = 'no attempt completed';
  while (Date.now() < end) {
    try {
      const value = await probe();
      if (isReady(value)) return value;
      last = 'it answered but was not ready';
    } catch (error) {
      if (!pending(error)) throw error;
      last = error.message;
    }
    await delay(interval);
  }
  throw new Error(`${description} (waited ${timeout} ms; last observation: ${last}).`);
}

export function awaitAcceptanceGatewayReadiness(probe, isReady, { onInitialTlsError = () => {}, ...options }) {
  let answered = false;
  return awaitReadiness(async () => {
    const value = await probe();
    answered = true;
    return value;
  }, isReady, { ...options, pending: error => {
    if (!answered && error.code === 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR') {
      onInitialTlsError({ code: error.code, message: error.message });
      return true;
    }
    return readinessPending(error);
  } });
}

export function acceptanceFailureLogs(run) {
  const sweepWork = path.join(run, legacySweepWorkDirectory);
  const sourceLogs = fs.existsSync(path.join(sweepWork, 'source-preview.log')) ? [{ name: 'source-preview', file: path.join(sweepWork, 'source-preview.log') }] : fs.existsSync(sweepWork) ? fs.readdirSync(sweepWork).filter(name => name.startsWith('run-'))
    .map(name => ({ name: 'source-preview', file: path.join(sweepWork, name, 'stderr.log') })) : [];
  return [...['daemon', 'gateway', 'route-cost'].map(name => ({ name, file: path.join(run, `${name}.log`) })), ...sourceLogs.slice(-1)].flatMap(({ name, file }) => {
    if (!fs.existsSync(file)) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const bytes = fs.fstatSync(fd).size;
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let read;
      while ((read = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, read));
      const excerpt = Buffer.alloc(Math.min(bytes, 8000));
      fs.readSync(fd, excerpt, 0, excerpt.length, Math.max(0, bytes - excerpt.length));
      return [{ name, sha256: hash.digest('hex'), bytes, excerpt: excerpt.toString('utf8') }];
    } finally { fs.closeSync(fd); }
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(predicate, timeout, failure, fault = 'either') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(100);
  }
  throw acceptanceFailure(fault, `${failure} (waited ${timeout} ms)`);
}

export async function stopOwned(child, remaining, label = 'owned process') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const requestedAt = Date.now();
  const signalled = child.kill('SIGTERM');
  try { await until(() => child.exitCode !== null || child.signalCode !== null, Math.max(1, remaining() - 1000), `The ${label} did not exit after acceptance asked it to stop`); }
  catch (error) {
    child.kill('SIGKILL');
    await until(() => child.exitCode !== null || child.signalCode !== null, Math.min(1000, remaining()), `The ${label} did not exit after acceptance killed it`);
    throw error;
  }
  if (signalled) return { pid: child.pid, signal: 'SIGTERM', requestedAt, exitedAt: Date.now(),
    exitCode: child.exitCode, exitSignal: child.signalCode };
}

export async function finalizeAcceptance({ metadataFile, result, candidateBinding, testedPackageDigest, pendingPackage, diagnostic, diagnostics, cache, run, ownership, deadlineEnv }) {
  const deadline = acceptanceDeadline(deadlineEnv);
  deadline.remaining('report');
  const reading = () => ({ ...deadline.reading(), scope: result.budget.scope });
  let ownedReceipt;
  let accepted;
  try {
    let acceptedReference;
    let diagnosticDestination;
    if (diagnostic) {
      for (const name of ['daemon', 'desktop', 'gateway']) {
        const log = path.join(run, `${name}.log`);
        if (fs.existsSync(log)) fs.copyFileSync(log, path.join(diagnostics, `${name}.log`));
      }
      saveOwnedMetadata(path.join(diagnostics, 'result.json'), diagnosticReport(result));
      diagnosticDestination = await retainDiagnosticEvidence(run, ownership);
      result.diagnostic.evidence_root = diagnosticDestination;
    }
    if (result.status === 'passed' && !diagnostic) {
      try {
        const evidence = path.join(cache, '.receipts', `${ownership.runId}-acceptance.json`);
        accepted = await retainAcceptedRelease({ pending: pendingPackage, candidate: candidateBinding,
          acceptance: { record_id: process.env.MANDIBLE_ACCEPTANCE_ID || null, request_id: process.env.MANDIBLE_ACCEPTANCE_REQUEST || null },
          evidence: { receipt: evidence, sha256: sha256(evidence) }, expectedDigest: testedPackageDigest, shipped: result.provenance.shipped });
        acceptedReference = accepted.reference;
      } catch (error) { if (error.code === 'PROCESS_LOCK_LOST') throw error; result.status = 'failed'; result.cleanup_error = error.message; }
    }
    if (pendingPackage && !accepted) {
      try {
        result.checks.package_cleanup = await disposePendingRelease(pendingPackage, testedPackageDigest, 'Candidate acceptance did not pass.');
        if (result.checks.package_cleanup.action !== 'delete-owned' || result.checks.package_cleanup.remaining?.length) throw new Error('some of its files remain.');
      } catch (error) {
        if (error.code === 'PROCESS_LOCK_LOST') throw error;
        result.status = 'failed';
        result.cleanup_error = [result.cleanup_error, `The built package could not be fully deleted: ${error.message}`].filter(Boolean).join('; ');
        result.checks.package_cleanup ??= { action: 'skip', reason: error.message, handle: { root: pendingPackage.root, runId: pendingPackage.runId } };
      }
    }
    const final = finalizeOwnedRun(metadataFile, { expectedRevision: ownership.revision, outcome: result.status === 'passed' ? 'assessed' : 'failed',
      ...(diagnosticDestination ? { disposition: 'transferred', destination: diagnosticDestination, transferReference: `diagnostic:${ownership.runId}` } : {}),
      summary: acceptanceSummary(result) });
    const receipt = final.ownership.receipt;
    ownedReceipt = receipt;
    result.receipt = acceptedReference || receipt;
    result.budget = reading();
    saveOwnedMetadata(receipt, { ...JSON.parse(fs.readFileSync(receipt, 'utf8')), acceptance: diagnostic ? diagnosticReport(result) : result });
    result.checks.cleanup = cleanupOwnedRun(metadataFile, { apply: true });
    if (result.checks.cleanup.action !== 'delete-owned' || result.checks.cleanup.remaining?.length) result.status = 'failed';
    result.budget = reading();
    if (Date.now() >= deadline.cutoffs.report) { result.status = 'failed'; result.cleanup_error = 'The time reserved for reporting the result ran out during cleanup.'; }
    result.receipt = acceptedReference || receipt;

  } catch (error) { if (error.code === 'PROCESS_LOCK_LOST') throw error; result.status = 'failed'; result.cleanup_error = error.message; }
  finally {
    result.budget = reading();
    if (result.phases.finalization) {
      result.phases.finalization.status = result.checks.cleanup?.action === 'delete-owned' && !result.checks.cleanup.remaining?.length && !result.cleanup_error ? 'passed' : 'failed';
      result.phases.finalization.elapsed_ms = Date.now() - result.phases.finalization.started_at;
    }
    if (ownedReceipt) saveOwnedMetadata(ownedReceipt, { ...JSON.parse(fs.readFileSync(ownedReceipt, 'utf8')), acceptance: diagnostic ? diagnosticReport(result) : result });
  }
  return result;
}

async function main(budget) {
  const boundedCommand = (binary, args, options = {}) => command(binary, args, { ...options, timeout: budget.remaining('preparation') });
  const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const diagnostic = option('--diagnostic-receipt') || option('--diagnostic-app')
    ? diagnosticReplayPackage(option('--diagnostic-receipt'), option('--diagnostic-app')) : null;
  if (!diagnostic) requireNativeAppSigning(resolveAppSigning(root));
  const candidate = diagnostic?.candidate || boundedCommand('git', ['rev-parse', 'HEAD']);
  const parents = boundedCommand('git', ['show', '-s', '--format=%P', candidate]).split(' ');
  const candidateBinding = { pin_sha: candidate, tree_sha: boundedCommand('git', ['rev-parse', `${candidate}^{tree}`]),
    base_sha: process.env.MANDIBLE_ACCEPTANCE_BASE || parents[0], head_sha: process.env.MANDIBLE_ACCEPTANCE_HEAD || parents[1] || candidate };
  if (boundedCommand('git', ['status', '--porcelain', '--untracked-files=all'])) throw acceptanceFailure('environment', 'The acceptance checkout of the candidate has uncommitted or untracked files, so a build there would not be the exact candidate.');
  const runtime = boundedCommand('/bin/sh', [path.join(root, 'scripts', 'bun-runtime.sh')]);
  const buildEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', PATH: `${path.dirname(runtime)}${path.delimiter}${process.env.PATH}` };
  const cache = path.join(os.homedir(), '.cache', 'mandible', 'acceptance');
  fs.mkdirSync(cache, { recursive: true });
  if (process.env.MANDIBLE_ACCEPTANCE_ID && process.env.MANDIBLE_DB && process.env.MANDIBLE_HOME) {
    const db = new Database(process.env.MANDIBLE_DB, { fileMustExist: true });
    try { await generatedStorage({ db, home: process.env.MANDIBLE_HOME, cache: path.dirname(cache), apply: true, until: Math.min(Date.now() + 2000, budget.cutoffs.preparation) }); }
    finally { db.close(); }
  } else await reconcileGeneratedScratch(cache, { apply: true, until: Math.min(Date.now() + 2000, budget.cutoffs.preparation) });
  const run = fs.mkdtempSync(path.join(cache, 'candidate-'));
  const project = option('--project'); const workUnit = option('--work-unit');
  if (!project || !workUnit) { fs.rmdirSync(run); throw acceptanceFailure('environment', 'Acceptance was started without the project and work unit to record its result under (--project and --work-unit).'); }
  return withOwnedRunLock(run, async () => {
  const nonce = randomBytes(32).toString('hex');
  const instanceId = `acceptance-${nonce.slice(0, 16)}`;
  const outputs = diagnostic ? [...acceptanceOwnedOutputs, { path: 'Mandible.app', kind: 'generated' }, { path: 'diagnostics', kind: 'interactive' }] : acceptanceOwnedOutputs;
  const ownership = createOwnedRun({ root: run, instanceId, project, workUnit, disposable: true, outputs,
    ...(!diagnostic && process.env.MANDIBLE_ACCEPTANCE_ID ? { runId: process.env.MANDIBLE_ACCEPTANCE_ID } : {}) });
  const metadataFile = path.join(run, 'metadata.json');
  saveOwnedMetadata(metadataFile, { ownership, candidate });
  const home = path.join(run, 'home');
  createAcceptanceHome(home);
  const evidence = acceptanceResultPath(cache, ownership.runId);
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  const result = { schema: 'mandible-candidate-acceptance@1', scope: acceptanceScope, status: 'failed', candidate, runtime, run, checks: {}, provenance: {} };
  result.binding = { recordId: ownership.runId, runId: ownership.runId, requestId: process.env.MANDIBLE_ACCEPTANCE_REQUEST ?? null,
    projectId: project, workUnitId: workUnit, ...candidateBinding, started_at: budget.started, deadline: budget.deadline };
  result.receipt = evidence;
  result.budget = budget.reading();
  result.phases = {};
  const phase = async (name, operation) => {
    const deadlinePhase = name === 'package_build' ? 'preparation' : 'work';
    budget.remaining(deadlinePhase);
    const start = Date.now();
    result.phases[name] = { status: 'running', started_at: start, cutoff: budget.cutoffs[deadlinePhase], remaining_ms: budget.remaining(deadlinePhase) };
    try { const value = await operation(); budget.remaining(deadlinePhase); result.phases[name].status = 'passed'; return value; }
    catch (error) {
      if (Date.now() >= budget.cutoffs[deadlinePhase]) {
        result.phases[name].termination_error = error.message;
        try { budget.remaining(deadlinePhase); } catch (exhausted) { error = exhausted; }
      }
      result.phases[name].status = 'failed'; result.phases[name].error = error.message; throw error;
    }
    finally { result.phases[name].elapsed_ms = Date.now() - start; }
  };
  const stage = () => Object.keys(result.phases).at(-1) ?? 'startup';
  const recordFailure = (error, at = stage()) => {
    if (result.error) return;
    const described = describeAcceptanceFailure(error, at);
    result.error = described.text;
    result.failure = { fault: described.fault, detail: described.detail, ...(described.values ? { values: described.values } : {}),
      ...(error?.code ? { code: error.code } : {}), ...(error?.evidence ? { evidence: error.evidence } : {}) };
  };
  if (diagnostic) result.diagnostic = { qualifying: false, source: diagnostic, deadline_ms: 60_000 };
  let daemon, desktop, gateway, stallProbe, diagnosticDeadline, testedPackageDigest, pendingPackage;
  let passiveHealth, passiveError;
  let interactionCompletedAt = null;
  const interactionController = new AbortController();
  const passiveController = new AbortController();
  const interactionWake = new AbortController();
  const diagnostics = path.join(run, 'diagnostics');
  if (diagnostic) fs.mkdirSync(diagnostics, { mode: 0o700 });
  let executionProfile;
  const files = [];
  const launch = (binary, args, env, name) => {
    const fd = fs.openSync(path.join(run, `${name}.log`), 'w'); files.push(fd);
    const child = spawn('/usr/bin/sandbox-exec', ['-p', executionProfile, binary, ...args], { cwd: run, env, stdio: ['ignore', fd, fd] });
    recordScratchProcess(metadataFile, child);
    child.on('error', error => { result.checks[`${name}_launch_error`] = error.message; });
    return child;
  };
  let interrupted = false;
  const interrupt = () => { interrupted = true; interactionController.abort(stopped()); daemon?.kill('SIGTERM'); desktop?.kill('SIGTERM'); gateway?.kill('SIGTERM'); stallProbe?.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const deadlineTimer = setTimeout(() => { recordFailure(acceptanceBudgetExhausted('work')); interrupt(); }, budget.remaining());
  try {
    let builtApp = diagnostic?.app;
    if (!diagnostic) {
    const buildLog = fs.openSync(path.join(run, 'build.log'), 'w'); files.push(buildLog);
    await phase('package_build', () => runSupervisedCommand(runtime, ['run', 'tauri:build', '--', '--bundles', 'app'], { cwd: root, env: buildEnv, stdio: ['ignore', buildLog, buildLog], timeout: budget.remaining('preparation'), graceMs: 250, deadline: budget.cutoffs.report, onSpawn: child => recordScratchProcess(metadataFile, child, true) })
      .catch(error => {
        if (error.timedOut || error.exitCode == null) throw error;
        throw acceptanceFailure('either', `Building the signed Mandible.app from the candidate failed with exit code ${error.exitCode}. The end of the build log is kept with the acceptance result (build_failure_excerpt): a compile or bundling error there points at the branch, a missing tool or signing identity at the environment.`);
      }));
    const builtRevision = readBuildRevision(root);
    if (builtRevision !== candidate) throw acceptanceFailure('either', `The build produced a daemon for revision ${builtRevision}, not the candidate ${candidate}, so the package was not built from the candidate.`, { built: builtRevision, candidate });
    builtApp = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Mandible.app');
    }
    budget.remaining('preparation');
    result.phases.package_verification = { status: 'running', started_at: Date.now(), cutoff: budget.cutoffs.preparation, remaining_ms: budget.remaining('preparation') };
    if (!diagnostic) pendingPackage = await createPendingRelease({
      storage: path.join(process.env.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible'), 'accepted-releases'), ownership });
    const app = pendingPackage?.app ?? path.join(run, 'Mandible.app');
    fs.cpSync(builtApp, app, { recursive: true, verbatimSymlinks: true });
    boundedCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const resources = path.join(app, 'Contents', 'Resources');
    const marker = diagnostic?.marker || JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-revision.json'), 'utf8'));
    const { release: shipped, digest } = verifyApplicationRelease(app);
    if (shipped.provenance.commit !== candidate || shipped.provenance.source_digest !== marker.source_digest) {
      const values = { package_commit: shipped.provenance.commit, package_source_digest: shipped.provenance.source_digest, candidate, candidate_source_digest: marker.source_digest };
      throw acceptanceFailure('either', `The built Mandible.app records commit ${values.package_commit} with source digest ${values.package_source_digest}, but the candidate is commit ${candidate} with source digest ${values.candidate_source_digest}, so the package is not the candidate.`, values);
    }
    const resourceEnv = installedRuntimeEnvironment(resources, { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: run });
    const packagedRuntime = resourceEnv.MANDIBLE_RUNTIME;
    testedPackageDigest = digest;
    if (diagnostic && testedPackageDigest !== diagnostic.sha256) throw new Error('Diagnostic package changed while copying.');
    executionProfile = installedExecutionProfile({ checkout: root, commonDirectory: boundedCommand("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]), app });
    if (!diagnostic) result.checks.updater_entrypoint = await verifyPackagedUpdaterEntrypoint({ resources, runtime: packagedRuntime,
      environment: resourceEnv, home, profile: executionProfile, budget });
    result.provenance = { marker, daemon_sha256: sha256(releaseFile(resources, shipped.entrypoints.daemon)), native_sha256: sha256(path.join(app, "Contents/MacOS/mandible-app")), harness_sha256: sha256(fileURLToPath(import.meta.url)), package_sha256: testedPackageDigest, shipped };
    budget.remaining('preparation');
    result.phases.package_verification.status = 'passed';
    result.phases.package_verification.elapsed_ms = Date.now() - result.phases.package_verification.started_at;
    budget.remaining('readiness');
    result.phases.readiness = { status: 'running', started_at: Date.now(), cutoff: budget.cutoffs.readiness, remaining_ms: budget.remaining('readiness') };
    const ports = new Set();
    while (ports.size < 2) ports.add(await freePort());
    const [port, publicPort] = [...ports];
    const origin = `https://app.mandible.localhost:${publicPort}`;
    const caHome = option('--ca-home') || process.env.MANDIBLE_TEST_CA_HOME || process.env.MANDIBLE_HOME || path.join(os.homedir(), '.mandible');
    const ca = copyAcceptanceCa(caHome, home, { timeoutMs: Math.min(5000, budget.remaining('readiness')) });
    const gatewayBinary = releaseFile(resources, shipped.native.caddy);
    const gatewayConfig = path.join(run, 'Caddyfile');
    fs.writeFileSync(gatewayConfig, acceptanceGatewayConfig({ origin, backendPort: port, storageRoot: ca.storageRoot }), { mode: 0o600 });
    result.provenance.ca_root_sha256 = sha256(ca.rootCert);
    result.provenance.gateway_sha256 = sha256(gatewayBinary);
    fs.writeFileSync(path.join(home, 'acceptance.json'), JSON.stringify({ home, origin, nonce, workUntil: budget.cutoffs.work }), { mode: 0o600 });
    const env = { ...resourceEnv, HOME: home, MANDIBLE_HOME: home, MANDIBLE_DB: path.join(home, 'mandible.db'), MANDIBLE_PORT: String(port), MANDIBLE_PUBLIC_ORIGIN: origin, MANDIBLE_INSTANCE_ROLE: 'main', MANDIBLE_INSTANCE_ID: instanceId, MANDIBLE_INSTALLATION_ID: instanceId, MANDIBLE_BACKEND_GENERATION: candidate, MANDIBLE_WORK_SCANNER_ROOTS: JSON.stringify([{ path: home, depth: 1 }]), MANDIBLE_PID_FILE: path.join(home, 'daemon.pid'), MANDIBLE_SOCKET: path.join(home, 'api.sock'), MANDIBLE_STDERR_LOG_PATH: path.join(run, 'daemon.log'), MANDIBLE_USER_PREFERENCES_DIR: path.join(home, 'settings', 'users'), MANDIBLE_CANDIDATE_ACCEPTANCE: path.join(home, 'acceptance.json') };
    daemon = launch(packagedRuntime, [...(diagnostic ? ['--cpu-prof', `--cpu-prof-dir=${diagnostics}`, '--cpu-prof-name=daemon.cpuprofile'] : []), '--no-install', releaseFile(resources, shipped.entrypoints.daemon)], env, 'daemon');
    if (diagnostic) {
      diagnosticDeadline = setTimeout(interrupt, budget.remaining());
      result.diagnostic.started_at = Date.now();
    }
    // The gateway answers 502, and logs an error, for any request that reaches
    // it before its upstream is listening, so it starts only after the bind.
    const daemonRunning = () => {
      if (interrupted) throw stopped();
      if (daemon.exitCode !== null || daemon.signalCode !== null) throw acceptanceFailure('either', `The packaged daemon exited (${exit(daemon)}) before acceptance finished, which usually means it crashed; the daemon log excerpt in the acceptance result shows why.`, { exit_code: daemon.exitCode, signal: daemon.signalCode });
    };
    await awaitReadiness(() => {
      daemonRunning();
      return loopbackListening(port);
    }, () => true, { timeout: Math.min(30_000, budget.remaining('readiness')), description: 'The packaged daemon did not start listening on its port' });
    gateway = launch(gatewayBinary, ['run', '--config', gatewayConfig, '--adapter', 'caddyfile'], env, 'gateway');
    const probe = async (signal) => {
      daemonRunning();
      if (gateway.exitCode !== null || gateway.signalCode !== null) throw acceptanceFailure('either', `The HTTPS gateway in front of the packaged daemon exited (${exit(gateway)}) before acceptance finished; the gateway log excerpt in the acceptance result shows why.`, { exit_code: gateway.exitCode, signal: gateway.signalCode });
      const value = await acceptanceHealth(origin, ca.rootCert, signal);
      if (value.instance?.instance_id !== env.MANDIBLE_INSTANCE_ID || value.instance?.backend_generation !== candidate || value.instance?.public_origin !== origin) {
        const values = { expected: { instance_id: env.MANDIBLE_INSTANCE_ID, backend_generation: candidate, public_origin: origin },
          answered: { instance_id: value.instance?.instance_id ?? null, backend_generation: value.instance?.backend_generation ?? null, public_origin: value.instance?.public_origin ?? null } };
        throw acceptanceFailure('either', `The daemon that answered the health check is not the one acceptance started: it reported instance ${values.answered.instance_id}, revision ${values.answered.backend_generation} and origin ${values.answered.public_origin}, where acceptance expected instance ${env.MANDIBLE_INSTANCE_ID}, revision ${candidate} and origin ${origin}. Another Mandible instance on the same port causes this; so does a candidate daemon that misreports its identity.`, values);
      }
      return value;
    };
    const health = await awaitAcceptanceGatewayReadiness(probe, value => value.ready === true && value.startup_commit?.hash === candidate,
      { timeout: Math.min(30_000, budget.remaining('readiness')), description: 'The packaged daemon did not report ready for this exact candidate',
        onInitialTlsError: error => { result.checks.initial_transport_error ??= error; } });
    result.checks.readiness = { startup_epoch: health.startup_epoch, instance_id: health.instance.instance_id, origin };
    if (!health.current) throw acceptanceFailure('candidate', 'The packaged daemon reported ready without the live health diagnostics (event-loop delay and memory) that acceptance samples while the app runs.');
    passiveHealth = observeAcceptanceHealth({
      live: { startedAt: health.current.observedAt, through: () => interactionCompletedAt },
      deadlineMs: budget.remaining(),
      wait: async ms => {
        try { await abortableDelay(ms, undefined, { signal: AbortSignal.any([passiveController.signal, interactionWake.signal]) }); }
        catch (error) { if (passiveController.signal.aborted || !interactionWake.signal.aborted) throw error; }
      },
      probe: async (_deadline, signal) => {
        if (passiveController.signal.aborted) throw passiveController.signal.reason;
        const current = await probe(AbortSignal.any([signal, passiveController.signal]));
        if (current.startup_epoch !== health.startup_epoch) throw restarted();
        if (desktop && (desktop.exitCode !== null || desktop.signalCode !== null)) throw acceptanceFailure('either', `The packaged app closed (${exit(desktop)}) before acceptance finished watching it, which usually means it crashed.`, { exit_code: desktop.exitCode, signal: desktop.signalCode });
        return current;
      },
      onEvidence: evidence => { result.checks.health_coverage = evidence; },
    }).catch(error => { if (!passiveController.signal.aborted) { passiveError = error; interactionController.abort(error); } });
    if (passiveError) throw passiveError;
    interactionController.signal.throwIfAborted();
    if (!health.local_socket_path?.startsWith(`${home}${path.sep}`)) throw acceptanceFailure('candidate', `The packaged daemon reported its local API socket at ${health.local_socket_path}, outside the isolated home acceptance gave it (${home}); it must keep its files inside that home.`, { socket: health.local_socket_path ?? null, home });
    if (diagnostic) {
      const out = fs.openSync(path.join(diagnostics, 'probe.jsonl'), 'w'); files.push(out);
      const err = fs.openSync(path.join(diagnostics, 'probe.stderr'), 'w'); files.push(err);
      stallProbe = spawn(runtime, [path.join(root, 'scripts/daemon-stall-probe.mjs'), '--socket', health.local_socket_path,
        '--pid', String(daemon.pid), '--duration', String(Math.max(1, Math.floor(budget.remaining() / 1000))), '--sample', '--sample-max', '4', '--out', diagnostics, '--json'],
        { cwd: run, env: buildEnv, stdio: ['ignore', out, err] });
      stallProbe.on('error', error => { result.checks.probe_launch_error = error.message; });
      recordScratchProcess(metadataFile, stallProbe);
    }
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ slug: 'candidate-operator', display_name: 'Candidate operator', email: 'candidate@example.invalid' });
      const request = http.request({ signal: interactionController.signal, socketPath: health.local_socket_path, path: '/api/users/setup', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        let bytes = ''; response.on('data', chunk => { bytes += chunk; });
        response.on('end', () => response.statusCode === 200 ? resolve() : reject(acceptanceFailure('candidate', `Creating the operator account on the packaged daemon (POST /api/users/setup) answered HTTP ${response.statusCode}: ${sentence(bytes.slice(0, 500))}`)));
      });
      const bootstrapTimeout = Math.min(5000, budget.remaining('readiness'));
      request.setTimeout(bootstrapTimeout, () => request.destroy(acceptanceFailure('either', `Creating the operator account on the packaged daemon (POST /api/users/setup) did not answer within ${bootstrapTimeout} ms.`)));
      request.on('error', reject); request.end(body);
    });
    interactionController.signal.throwIfAborted();
    budget.remaining('readiness');
    result.phases.readiness.status = 'passed';
    result.phases.readiness.elapsed_ms = Date.now() - result.phases.readiness.started_at;
    result.phases.desktop_interaction = { status: 'running', started_at: Date.now(), cutoff: budget.cutoffs.work, remaining_ms: budget.remaining() };
    desktop = launch(path.join(app, 'Contents', 'MacOS', 'mandible-app'), [], env, 'desktop');
    const evidencePath = path.join(home, 'desktop-evidence.json');
    await until(async () => {
      interactionController.signal.throwIfAborted();
      const current = await probe(interactionController.signal);
      if (current.startup_epoch !== health.startup_epoch) throw restarted();
      if (desktop.exitCode !== null || desktop.signalCode !== null) throw acceptanceFailure('either', `The packaged app exited (${exit(desktop)}) before finishing its first-run setup and Settings edit, which usually means it crashed.`, { exit_code: desktop.exitCode, signal: desktop.signalCode });
      return fs.existsSync(evidencePath);
    }, Math.min(45_000, budget.remaining()), 'The packaged app did not finish its first-run setup and Settings edit');
    interactionCompletedAt = interactionCompletion(fs.statSync(evidencePath).mtimeMs, health.current.observedAt, Date.now());
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    if (!evidence.passed) {
      const reason = typeof evidence.error === 'string' ? evidence.error : 'it reported no reason';
      throw /deadline exceeded/.test(reason)
        ? acceptanceFailure('either', `${interaction} The app ran out of time before finishing: ${sentence(reason)} A busy machine usually causes this, though a branch that makes the app much slower can too.`)
        : acceptanceFailure('candidate', `${interaction} The app stopped with: ${sentence(reason)}`);
    }
    const missing = interactionReport.filter(([holds]) => !holds(evidence)).map(([, name]) => name);
    if (missing.length) throw acceptanceFailure('candidate', `${interaction} The app reported success, but its report lacks ${missing.join(', ')}.`, { report: evidence });
    result.checks.desktop_interaction = evidence;
    result.checks.desktop_interaction_completed_at = interactionCompletedAt;
    result.phases.desktop_interaction.status = 'passed';
    result.phases.desktop_interaction.elapsed_ms = Date.now() - result.phases.desktop_interaction.started_at;
    interactionWake.abort();
    await phase('health_coverage', async () => {
      await passiveHealth;
      if (passiveError) throw passiveError;
    });
    if (interrupted) throw stopped();
    result.status = 'passed';
  } catch (error) {
    recordFailure(error, error instanceof RuntimeHealthObservationError ? 'health_coverage' : stage());
    result.budget = budget.reading();
    for (const phase of Object.values(result.phases)) if (phase.status === 'running') { phase.status = 'failed'; phase.error = result.error; phase.elapsed_ms = Date.now() - phase.started_at; }
    saveOwnedMetadata(evidence, compactAcceptanceResult(result));
  }
  finally {
    if (diagnosticDeadline) clearTimeout(diagnosticDeadline);
    clearTimeout(deadlineTimer);
    interactionController.abort();
    passiveController.abort();
    await passiveHealth;
    const shutdowns = {};
    const labels = { probe: 'stall probe', desktop: 'packaged app', gateway: 'HTTPS gateway', daemon: 'packaged daemon' };
    await Promise.all([['probe', stallProbe], ['desktop', desktop], ['gateway', gateway], ['daemon', daemon]].map(async ([name, child]) => {
      try { shutdowns[name] = await stopOwned(child, () => budget.remaining('report'), labels[name]); }
      catch (error) { result.status = 'failed'; result.cleanup_error = [result.cleanup_error, error.message].filter(Boolean).join('; '); recordFailure(error, 'finalization'); }
    }));
    for (const fd of files) fs.closeSync(fd);
    const logSources = [['daemon', daemon], ['desktop', desktop], ['gateway', gateway]].map(([name, child]) => {
      const file = path.join(run, `${name}.log`);
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      return { name, text, assessment: assessAcceptanceLogs(text, { process: { role: name, pid: child?.pid, owned: !!child },
        shutdown: name === 'gateway' && shutdowns[name] ? { ...shutdowns[name], graceSeconds: GATEWAY_GRACE_SECONDS } : undefined }) };
    });
    const logs = logSources.map(source => source.text).join('\n');
    result.checks.log_failures = logSources.flatMap(source => source.assessment.failures.map(line => `${source.name}: ${line}`));
    result.checks.log_diagnostics = Object.fromEntries(logSources.map(source => [source.name, source.assessment.diagnostics]));
    if (result.status !== 'passed' && fs.existsSync(path.join(run, 'build.log'))) result.checks.build_failure_excerpt = fs.readFileSync(path.join(run, 'build.log'), 'utf8').split('\n').slice(-30).join('\n').slice(-8000);
    result.checks.log_digest = createHash('sha256').update(logs).digest('hex');
    result.checks.log_bytes = Buffer.byteLength(logs);
    if (result.checks.log_failures.length) {
      result.status = 'failed';
      const count = result.checks.log_failures.length;
      recordFailure(acceptanceFailure('either', `The logs of the packaged daemon, app and HTTPS gateway from this run contain ${count === 1 ? 'a problem' : `${count} problems`} acceptance does not allow, starting with: ${result.checks.log_failures.slice(0, 2).map(line => line.slice(0, 300)).join('; ')}`));
    }
    result.checks.shutdown = { daemon_exit: daemon?.exitCode, daemon_signal: daemon?.signalCode, desktop_exit: desktop?.exitCode, desktop_signal: desktop?.signalCode, gateway_exit: gateway?.exitCode, gateway_signal: gateway?.signalCode };
    if (diagnostic) Object.assign(result.checks.shutdown, { probe_exit: stallProbe?.exitCode, probe_signal: stallProbe?.signalCode });
    for (const [name, child] of [['daemon', daemon], ['gateway', gateway]]) {
      if (!child || (child.exitCode === 0 && !child.signalCode)) continue;
      result.status = 'failed';
      recordFailure(acceptanceFailure('either', `The ${labels[name]} ended with ${exit(child)} instead of exiting cleanly when acceptance stopped it; its log excerpt in the acceptance result shows why.`, { exit_code: child.exitCode, signal: child.signalCode }));
    }
    if (result.status !== 'passed') result.checks.failure_logs = acceptanceFailureLogs(run);
    if (![stallProbe, daemon, desktop, gateway].every(child => !child || child.exitCode !== null || child.signalCode !== null)) {
      result.status = 'failed'; result.cleanup_error = 'A process acceptance started was still running after shutdown, so acceptance kept its scratch files instead of deleting them.';
      recordFailure(acceptanceFailure('environment', result.cleanup_error));
    } else {
      result.phases.finalization = { status: 'running', started_at: Date.now(), cutoff: budget.cutoffs.report, remaining_ms: budget.reading().remaining_ms.report };
      result.budget = budget.reading();
      result.receipt = evidence;
      saveOwnedMetadata(evidence, result);
      try {
        const finalized = await finalizeAcceptance({ metadataFile, result, candidateBinding, testedPackageDigest, pendingPackage,
          diagnostic, diagnostics, cache, run, ownership, deadlineEnv: budget.env });
        Object.assign(result, finalized, { checks: { ...result.checks, ...finalized.checks } });
      } catch (error) {
        if (error.code === 'PROCESS_LOCK_LOST') throw error;
        result.status = 'failed'; result.cleanup_error = error.message;
        result.phases.finalization.status = 'failed';
        result.phases.finalization.elapsed_ms = Date.now() - result.phases.finalization.started_at;
        result.checks.finalization_stderr = error.stderr?.slice(-4000);
        const receipt = path.join(cache, '.receipts', `${ownership.runId}.json`);
        if (fs.existsSync(receipt)) result.receipt = receipt;
        const retainedReceipt = path.join(process.env.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible'), 'accepted-releases', '.receipts', `${ownership.runId}-accepted-release.json`);
        if (!fs.existsSync(retainedReceipt)) saveOwnedMetadata(evidence, result);
        if (fs.existsSync(receipt)) saveOwnedMetadata(receipt, { ...JSON.parse(fs.readFileSync(receipt, 'utf8')), acceptance: result });
      }
    }
    result.budget = budget.reading();
    if (Date.now() >= budget.cutoffs.report) { result.status = 'failed'; result.cleanup_error = 'The time reserved for reporting the result ran out during cleanup.'; }
    if (result.status === 'failed') {
      recordFailure(new Error(result.cleanup_error || 'acceptance could not delete all of its scratch files.'), 'finalization');
      const sealed = path.join(process.env.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible'), 'accepted-releases', '.receipts', ownership.runId + '-accepted-release.json');
      if (!fs.existsSync(sealed)) saveOwnedMetadata(evidence, compactAcceptanceResult(result));
    }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (diagnostic) {
    Object.assign(result, diagnosticReport(result));
  }
  process.stdout.write(`${JSON.stringify(compactAcceptanceResult(result), null, 2)}\n`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const execution = (async () => {
    const budget = acceptanceApplicationPolicy();
    await main(budget);
  })();
  execution.catch(error => { console.error(JSON.stringify({ status: 'unavailable', error: describeAcceptanceFailure(error, 'startup').text })); process.exitCode = 1; });
}
