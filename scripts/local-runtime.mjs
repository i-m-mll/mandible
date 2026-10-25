#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_BACKEND_PORT, PRODUCTION_ORIGIN } from "./canonical-origin.mjs";
import { assertLocalCaIdentity, localCaPaths, probeCurrentMacOsTrust } from "./local-ca-trust.mjs";
import { installPinnedCaddy, pinnedCaddyBinary } from "./pinned-caddy.mjs";
import { readBuildRevision, compiledBuildDigest, runtimeDependenciesDigest } from "./build-revision.mjs";
import { serviceInstallationContext, parseLoadedService, loadedServiceMatches, ownsServiceDefinition, inspectServiceDefinitionsSync, matchingServiceDefinitions, loadedServiceDefinition, runtimeHandoffReadiness } from "./service-definitions.mjs";
import { installationRuntime, servicePath, readServiceConfiguration, publishServiceConfiguration, validateServiceConfiguration } from "./service-configuration.mjs";
export { parseLoadedService, loadedServiceMatches } from "./service-definitions.mjs";

const ACCOUNT_HOME = os.userInfo().homedir;
const DEFAULT_HOME = path.join(ACCOUNT_HOME, ".mandible");
const configuredHome = process.env.MANDIBLE_HOME?.trim() || DEFAULT_HOME;
const expandedHome = configuredHome === "~" ? ACCOUNT_HOME
  : configuredHome.startsWith("~/") ? path.join(ACCOUNT_HOME, configuredHome.slice(2))
    : configuredHome;
const HOME = path.resolve(expandedHome);
const HOME_DIR = path.dirname(HOME);
const RUNTIME_DIR = path.join(HOME, "config", "local-sessions");
const AUTHORITY_DB = path.join(RUNTIME_DIR, "sessions.db");
const INSTALLATION_AUTHORITY = path.join(HOME, "config", "client-auth", "authority-id");

const GATEWAY_CONFIG = path.join(RUNTIME_DIR, "Caddyfile");
const LOG_DIR = path.join(HOME_DIR, ".cache", "mandible");
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;
const INSTALLATION = serviceInstallationContext({ home: HOME,
  ...(HOME !== DEFAULT_HOME && process.env.MANDIBLE_SERVICE_ACCOUNT_HOME ? { accountHome: process.env.MANDIBLE_SERVICE_ACCOUNT_HOME } : {}) });
const SERVICE_DIR = INSTALLATION.serviceDir;
const PRIVATE_SERVICE_DIR = INSTALLATION.privateServiceDir;
const BACKEND_LABEL = INSTALLATION.backendLabel;
const GATEWAY_LABEL = INSTALLATION.gatewayLabel;
const HEALTH_TIMEOUT_MS = 900;
const OPERATION_TIMEOUT_MS = 4500;
const BODY_LIMIT = 256 * 1024;
const MIGRATABLE_MAIN_EFFECT = "preferences:instance";

function readProductionRecord() {
  const installed = locateLaunchAgent(BACKEND_LABEL);
  if (!installed) throw new Error("Mandible's production LaunchAgent is not installed.");
  const { file, record } = installed;
  const args = record.ProgramArguments ?? [];
  if (args.length !== 3 || path.resolve(args[1]) !== path.join(RUNTIME_DIR, "production-runner.mjs") || args[2] !== "run") {
    throw new Error(`The production LaunchAgent does not point to Mandible's managed runner: ${file}`);
  }
  const root = record.EnvironmentVariables?.MANDIBLE_PRODUCTION_ROOT;
  if (!path.isAbsolute(root ?? "") || !fs.existsSync(path.join(root, "package.json"))
    || !fs.existsSync(path.join(root, "dist", "index.js"))) {
    throw new Error(`The production LaunchAgent does not identify a built Mandible checkout: ${file}`);
  }
  return { root: path.resolve(root), environment: record.EnvironmentVariables ?? {} };
}

function readMainInstance(root) {
  if (!fs.existsSync(AUTHORITY_DB)) throw new Error(`Local-session authority is missing: ${AUTHORITY_DB}`);
  const requireFromProject = createRequire(path.join(root, "package.json"));
  const Database = requireFromProject(process.env.MANDIBLE_RUNTIME_HANDOFF_STORAGE || "./dist/sqlite.js").default;
  const db = new Database(AUTHORITY_DB, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT instance_id, installation_id, role, public_origin, backend_origin, backend_generation, effect_ceiling_json, writable_roots_json FROM instance_registrations WHERE role = 'main'").all();
    if (rows.length !== 1) throw new Error(`Expected one registered production instance, found ${rows.length}.`);
    const main = rows[0];
    if (main.instance_id !== "production" || main.public_origin !== PRODUCTION_ORIGIN) {
      throw new Error("The registered production instance does not match the canonical HTTPS origin.");
    }
    const backend = new URL(main.backend_origin);
    const publicUrl = new URL(PRODUCTION_ORIGIN);
    if (backend.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname)
      || !backend.port || Number(backend.port) === Number(publicUrl.port)) {
      throw new Error("The registered production backend is not an isolated loopback HTTP listener.");
    }
    if (!/^[a-f0-9]{40}$/.test(main.backend_generation ?? "")) {
      throw new Error("The registered production instance has no exact backend generation.");
    }
    const installationAuthority = fs.readFileSync(INSTALLATION_AUTHORITY, "utf8").trim();
    if (!installationAuthority || installationAuthority !== main.installation_id) {
      throw new Error("The production instance does not match this installation's client-auth authority.");
    }
    return {
      ...main,
      effectCeiling: JSON.parse(main.effect_ceiling_json),
      writableRoots: JSON.parse(main.writable_roots_json),
      backendUrl: backend,
      publicUrl,
    };
  } finally {
    db.close();
  }
}

export function healthDocumentError(document, expected) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return "The service returned malformed health data.";
  if (document.status !== "ok" || document.ready !== true || document.warm !== true) {
    return "The service responded, but Mandible is not ready yet.";
  }
  const instance = document.instance;
  if (!instance || instance.role !== "main" || instance.instance_id !== "production"
    || instance.installation_id !== expected.installationId
    || instance.public_origin !== expected.publicOrigin
    || instance.backend_generation !== expected.generation) {
    return "The service response belongs to a different Mandible instance or build.";
  }
  return null;
}

export function probeJson(url, { ca, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let received = 0;
    let request;
    let deadline;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      finish({ ok: false, error: "The health URL must use HTTP or HTTPS." });
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    deadline = setTimeout(() => {
      request?.destroy(new Error("health probe exceeded its deadline"));
      finish({ ok: false, error: `Health check exceeded its ${timeoutMs} ms deadline.` });
    }, timeoutMs);
    const options = {
      timeout: timeoutMs,
      ...(target.protocol === "https:" ? {
        ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
      } : {}),
      headers: { accept: "application/json", connection: "close" },
    };
    try {
      request = transport.get(target, options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > BODY_LIMIT) request.destroy(new Error("health response exceeded its size limit"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          finish({ ok: false, error: `Health endpoint returned HTTP ${response.statusCode ?? "unknown"}.` });
          return;
        }
        try {
          finish({ ok: true, document: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          finish({ ok: false, error: "The service returned malformed health data." });
        }
      });
      });
    } catch (error) {
      finish({ ok: false, error: `The service could not be reached: ${error.message}` });
      return;
    }
    request.on("timeout", () => request.destroy(new Error("health probe exceeded its deadline")));
    request.on("error", (error) => {
      const message = error.code === "ETIMEDOUT" || /deadline|timed out/i.test(error.message)
        ? `Health check exceeded its ${timeoutMs} ms deadline.`
        : error.code?.startsWith("CERT_") || /certificate|self-signed|issuer/i.test(error.message)
          ? "The HTTPS certificate failed verification against this installation's trusted Mandible certificate."
          : error.code === "ECONNREFUSED"
            ? "The service is not accepting connections."
            : `The service could not be reached: ${error.message}`;
      finish({ ok: false, error: message });
    });
  });
}

export function healthEndpointUrl(origin) {
  const url = new URL(origin);
  url.pathname = "/api/health";
  url.search = "";
  url.hash = "";
  return url;
}

function readTrustedRoot() {
  const paths = localCaPaths(HOME);
  const identity = assertLocalCaIdentity(paths);
  if (identity.state !== "trusted") {
    return { ca: null, error: "Secure local connections are not set up. Use the explicit Secure local connections setup action in Settings." };
  }
  if (process.platform === "darwin") probeCurrentMacOsTrust(paths, { timeoutMs: 1500 });
  return { ca: fs.readFileSync(paths.rootCert), error: null };
}

function runLaunchctl(args, timeout = 2500) {
  if (process.platform !== "darwin") throw new Error("Mandible's supervised local runtime requires macOS launchd.");
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error(`launchctl ${args[0]} failed: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function inspectJob(label) {
  const result = runLaunchctl(["print", `${DOMAIN}/${label}`]);
  const loaded = result.status === 0;
  if (!loaded && !/Could not find service|service not found/i.test(result.stderr)) throw new Error(`Cannot inspect launchd service ${label}: ${result.stderr}`);
  const pid = loaded ? Number(result.stdout.match(/\bpid = (\d+)/)?.[1] ?? 0) || null : null;
  const runs = loaded ? Number(result.stdout.match(/\bruns = (\d+)/)?.[1] ?? 0) : 0;
  const lastExit = loaded ? result.stdout.match(/\blast exit code = ([^\n]+)/)?.[1]?.trim() ?? null : null;
  return { loaded, pid, runs, lastExit, ...parseLoadedService(result.stdout), detail: result.stderr.trim() };
}

function processStart(pid) {
  if (!pid) return null;
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1500 });
  if (result.error || result.status !== 0 && result.stderr?.trim()) throw new Error(`Cannot inspect process ${pid}: ${result.error?.message || result.stderr.trim()}`);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function handoffService(label, inspection) {
  if (!inspection.ok) throw new Error(inspection.refusal.message);
  const observation = inspection.observations.find(item => item.label === label);
  const installed = observation.installed[0];
  const definition = observation.loadedDefinition ?? installed?.record ?? null;
  return { file: installed?.file ?? null, sha256: installed?.sha256 ?? null,
    installed: observation.installed, argv: definition?.ProgramArguments ?? [], loaded: observation.job.loaded, definition };
}

export function captureRuntimeHandoff(root) {
  const serviceInspection = runtimeHandoffReadiness(inspectServiceDefinitionsSync(INSTALLATION));
  const backend = handoffService(BACKEND_LABEL, serviceInspection);
  const gateway = handoffService(GATEWAY_LABEL, serviceInspection);
  const production = { root: backend.definition.EnvironmentVariables.MANDIBLE_PRODUCTION_ROOT };
  if (!path.isAbsolute(production.root ?? '')) throw new Error('Loaded backend does not identify its production checkout.');
  const destination = fs.realpathSync(root);
  const sourceRoot = fs.realpathSync(production.root);
  const main = readMainInstance(root);
  let source;
  if (sourceRoot !== destination) {
    const git = (checkout, args) => {
      const result = spawnSync('git', args, { cwd: checkout, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 5000 });
      if (result.error || result.status !== 0) throw new Error(`Cannot bind the installed source checkout: ${result.stderr || result.error?.message}`);
      return result.stdout.trim();
    };
    const commonGitDir = fs.realpathSync(git(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (commonGitDir !== fs.realpathSync(git(destination, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) throw new Error('Installed source and handoff destination belong to different Git repositories.');
    const buildRevision = readBuildRevision(sourceRoot);
    if (main.backend_generation !== buildRevision) throw new Error('Installed source build differs from the registered running generation.');
    source = { root: sourceRoot, commonGitDir, head: git(sourceRoot, ['rev-parse', 'HEAD']), buildRevision, compiledDigest: compiledBuildDigest(sourceRoot), dependencies: { root: fs.realpathSync(path.join(sourceRoot, 'node_modules')), digest: runtimeDependenciesDigest(sourceRoot) },
      files: Object.fromEntries(['bin/mandible'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, name))).digest('hex')])) };
  }
  if (source) source.runtime = { path: backend.argv[0], sha256: createHash('sha256').update(fs.readFileSync(backend.argv[0])).digest('hex') };
  const job = serviceInspection.observations.find(item => item.service === 'backend').job;
  const startedAt = processStart(job.pid);
  if (!job.loaded || !job.pid || !startedAt) throw new Error('Handoff requires the exact running production LaunchAgent.');
  return { installationId: main.installation_id, home: HOME, root: destination, ...(source ? { source } : {}), domain: DOMAIN,
    backendLabel: BACKEND_LABEL, gatewayLabel: GATEWAY_LABEL, publicOrigin: main.public_origin,
    daemonLog: backend.definition.StandardErrorPath,
    serviceConfiguration: readServiceConfiguration(INSTALLATION, job.environment, sourceRoot),
    oldProcess: { pid: job.pid, startedAt }, priorBackend: { ...backend, runnerSha256: createHash('sha256').update(fs.readFileSync(backend.argv[1])).digest('hex'), launchMode: launchModeFromAgent(backend.definition) }, priorGateway: gateway };
}

function assertHandoffInstallation(binding) {
  if (binding.home !== HOME || binding.domain !== DOMAIN || binding.backendLabel !== BACKEND_LABEL || binding.gatewayLabel !== GATEWAY_LABEL
    || fs.readFileSync(INSTALLATION_AUTHORITY, 'utf8').trim() !== binding.installationId) throw new Error('Runtime handoff belongs to another installation.');
  if (processStart(binding.oldProcess.pid) === binding.oldProcess.startedAt) throw new Error('The old production process has not finished draining.');
}

async function unloadExactHandoffService(label, expectedArguments, expectedDefinition) {
  const previous = inspectJob(label);
  if (!previous.loaded) return;
  if (JSON.stringify(previous.argv) !== JSON.stringify(expectedArguments) || expectedDefinition && !loadedServiceMatches(expectedDefinition, previous)) throw new Error(`Service ${label} changed before unloading; preserving it.`);
  const startedAt = processStart(previous.pid);
  // bootout returns once launchd has stopped the job: a running daemon's graceful
  // shutdown takes up to 5 s, and launchd kills a job still running after its
  // default 20 s exit timeout.
  const result = runLaunchctl(['bootout', `${DOMAIN}/${label}`], 25_000);
  if (result.status !== 0) throw new Error(`Could not unload exact service ${label} (launchctl exit ${result.status}): stdout=${JSON.stringify(result.stdout.trim())}; stderr=${JSON.stringify(result.stderr.trim())}`);
  const deadline = Date.now() + 5000;
  while (true) {
    const remaining = inspectJob(label);
    if (!remaining.loaded && (!previous.pid || !startedAt || processStart(previous.pid) !== startedAt)) return;
    if (remaining.loaded && (JSON.stringify(remaining.argv) !== JSON.stringify(expectedArguments) || expectedDefinition && !loadedServiceMatches(expectedDefinition, remaining))) throw new Error(`Service ${label} changed while unloading; preserving it.`);
    if (Date.now() >= deadline) throw new Error(`Exact service ${label} or its old process is still present after successful bootout.`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function removeHandoffDefinitions(binding) {
  assertHandoffInstallation(binding);
  assertLifecycleMutation(true);
  const inspection = inspectServiceDefinitionsSync(INSTALLATION);
  if (!inspection.ok) throw new Error(inspection.refusal.message);
  for (const observation of inspection.observations) {
    const prior = observation.service === 'backend' ? binding.priorBackend : binding.priorGateway;
    if (observation.job.loaded && (JSON.stringify(observation.job.argv) !== JSON.stringify(prior.argv)
      || prior.definition && !loadedServiceMatches(prior.definition, observation.job))) throw new Error(`Service ${observation.label} changed during handoff; preserving it.`);
  }
  if (binding.serviceConfiguration) {
    const captured = binding.serviceConfiguration;
    if (captured.file !== path.join(RUNTIME_DIR, 'service-config.json')) throw new Error('Captured service configuration belongs to another installation.');
    const current = readServiceConfiguration(INSTALLATION);
    if (!captured.migrated && current.migrated || !current.migrated && JSON.stringify(current.configuration) !== JSON.stringify(captured.configuration)) throw new Error('Service configuration changed after capture; preserving it.');
    publishServiceConfiguration(captured.file, captured.configuration);
  }
  for (const [label, prior] of [[BACKEND_LABEL, binding.priorBackend], [GATEWAY_LABEL, binding.priorGateway]]) {
    // A stable Caddy gateway can remain live. A legacy JS gateway must be
    // unloaded before its source/dependencies change under the old interpreter.
    if (label === GATEWAY_LABEL && !prior.argv.some(arg => /\.m?js$/.test(arg))) continue;
    const current = inspectJob(label);
    if (!current.loaded) continue;
    // Retained journals predating definition capture retain their argv guard.
    // New journals must still own the complete loaded definition after drain.
    if (JSON.stringify(current.argv) !== JSON.stringify(prior.argv) || prior.definition && !loadedServiceMatches(prior.definition, current)) throw new Error(`Service ${label} changed during handoff; preserving it.`);
    if (label === BACKEND_LABEL && current.pid) {
      const file = path.join(RUNTIME_DIR, 'handoff', `${binding.requestId}-${binding.executionId}`, 'bridge-process.json');
      const bridge = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      if (bridge?.pid !== current.pid || bridge.startedAt !== processStart(current.pid)) throw new Error('An old application process respawned before the bridge; preserve its work and drain it before continuing.');
    }
    await unloadExactHandoffService(label, prior.argv, prior.definition);
  }
}

export async function startHandoffDefinitions(binding) {
  assertHandoffInstallation(binding);
  if (readBuildRevision(binding.root) !== binding.mergeCommit) throw new Error('Runtime handoff build differs from its applied merge.');
  for (const label of [BACKEND_LABEL, GATEWAY_LABEL]) {
    const observation = observeOwnedService(label === BACKEND_LABEL ? 'backend' : 'gateway');
    const installed = observation.installed.length === 1 ? observation.installed[0] : null;
    if (!installed) throw new Error(`Candidate service ${label} is missing.`);
    const job = inspectJob(label);
    if (job.loaded && !loadedServiceMatches(installed.record, job)) {
      if (JSON.stringify(job.argv) !== JSON.stringify(binding.priorGateway.argv) || label !== GATEWAY_LABEL || binding.priorGateway.definition && !loadedServiceMatches(binding.priorGateway.definition, job)) throw new Error(`Unrecognized loaded service ${label}; preserving it.`);
      await unloadExactHandoffService(label, binding.priorGateway.argv, binding.priorGateway.definition);
    }
    ensureEnabledAndLoaded(label);
    if (!loadedServiceMatches(installed.record, inspectJob(label))) throw new Error(`Candidate service ${label} differs from its installed definition.`);
    const started = runLaunchctl(['kickstart', `${DOMAIN}/${label}`]);
    if (started.status !== 0) throw new Error(`Could not start candidate service ${label}: ${started.stderr.trim()}`);
  }
  // A freshly started daemon cannot be ready yet. Readiness is awaited by a
  // separate bounded verification, so a start never reports a false failure.
  return { started: [BACKEND_LABEL, GATEWAY_LABEL] };
}

/**
 * A handoff probe waits for the daemon's actual answer until the caller's
 * deadline. A slow answer is still the daemon's state; only the deadline, never
 * a fixed per-request timeout, turns waiting into failure.
 */
export function handoffProbeTimeout(until, now = Date.now()) {
  return Math.max(HEALTH_TIMEOUT_MS, until - now);
}

/** One answered inspection of the candidate front door, with the reason it is not ready. */
export function handoffFrontDoorError(inspection, mergeCommit) {
  if (!inspection.status.dashboard_ready) return inspection.status.detail || `Runtime state is ${inspection.status.state}.`;
  if (inspection.main.backend_generation !== mergeCommit) return `The registered generation ${inspection.main.backend_generation} is not the merge ${mergeCommit}.`;
  return null;
}

const NEVER_EXITED = '(never exited)';

/**
 * Why a started candidate service is no longer the process that was started,
 * or null while it still is. A freshly bootstrapped backend job has never
 * exited; any exit, replacement or unload means its startup failed.
 */
export function handoffServiceExit(started, inspection) {
  for (const [name, job] of [['backend', inspection.backendJob], ['gateway', inspection.gatewayJob]]) {
    const exit = job.lastExit && job.lastExit !== NEVER_EXITED ? ` (last exit code ${job.lastExit})` : '';
    if (!job.loaded) return `The candidate ${name} service was unloaded.`;
    if (!job.pid) return `The candidate ${name} process exited${exit}.`;
    const first = started?.[name];
    if (first && (job.pid !== first.pid || job.runs > first.runs)) return `The candidate ${name} process ${first.pid} exited and launchd started ${job.pid}${exit}.`;
  }
  const backend = inspection.backendJob;
  if (!started && backend.lastExit && backend.lastExit !== NEVER_EXITED) return `The candidate backend process exited before readiness (last exit code ${backend.lastExit}).`;
  return null;
}

/**
 * Await readiness after a start: inspect until the front door answers ready at
 * the exact merge generation. The handoff deadline bounds only a daemon that is
 * alive but slow: an exited or replaced service process fails at once. Each
 * inspection waits for the daemon's answer; the short pause only paces
 * refused or not-ready answers.
 */
export async function awaitHandoffReadiness(mergeCommit, until, inspect, { pauseMs = 200, now = Date.now } = {}) {
  let started = null;
  for (;;) {
    const inspection = await inspect(handoffProbeTimeout(until, now()));
    const exited = handoffServiceExit(started, inspection);
    if (exited) return { inspection, error: exited, exited: true };
    started ??= Object.fromEntries([['backend', inspection.backendJob], ['gateway', inspection.gatewayJob]].map(([name, job]) => [name, { pid: job.pid, runs: job.runs }]));
    const error = handoffFrontDoorError(inspection, mergeCommit);
    if (!error || inspection.status.state === 'port_conflict' || now() >= until) return { inspection, error, exited: false };
    await new Promise(resolve => setTimeout(resolve, Math.min(pauseMs, Math.max(0, until - now()))));
  }
}

/**
 * The daemon's own startup failure for this build: the last error-level line
 * logged after a runner start marker for the merge generation, from the tail
 * of its log. Only this handoff starts that generation in this installation.
 */
export function candidateStartupFailure(logText, mergeCommit) {
  const lines = logText.split('\n');
  const start = lines.findIndex(line => line.startsWith('[production-runner] starting ') && line.trimEnd().endsWith(` build ${mergeCommit}`));
  if (start < 0) return null;
  let failure = null;
  for (const line of lines.slice(start + 1)) {
    try {
      const row = JSON.parse(line);
      if (row?.level === 'error') failure = [row.message || row.event, row.error].filter(Boolean).join(': ');
    } catch { /* runner and tool output lines carry no level */ }
  }
  return failure;
}

function readLogTail(file, limit = 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, limit));
    fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
    return bytes.toString('utf8');
  } finally { fs.closeSync(fd); }
}

export async function verifyHandoffDefinitions(binding, { until = Date.now(), awaitReady = false } = {}) {
  if (binding.home !== HOME || binding.installationId !== fs.readFileSync(INSTALLATION_AUTHORITY, 'utf8').trim()) throw new Error('Candidate installation identity differs.');
  const serviceInspection = matchingServiceDefinitions(inspectServiceDefinitionsSync(INSTALLATION));
  const backend = handoffService(BACKEND_LABEL, serviceInspection);
  const gateway = handoffService(GATEWAY_LABEL, serviceInspection);
  if (!backend.loaded || !gateway.loaded || backend.argv[0] !== binding.runtime.path) throw new Error('Candidate services are not loaded with the pinned runtime.');
  const inspect = probeTimeoutMs => inspectRuntime({ launchMode: binding.priorBackend.launchMode, probeTimeoutMs });
  const { inspection: status, error, exited } = awaitReady
    ? await awaitHandoffReadiness(binding.mergeCommit, until, inspect)
    : await inspect(handoffProbeTimeout(until)).then(inspection => ({ inspection, error: handoffFrontDoorError(inspection, binding.mergeCommit), exited: false }));
  if (exited) {
    const logPath = locateLaunchAgent(BACKEND_LABEL)?.record.StandardErrorPath;
    let startup = null;
    try { startup = logPath ? candidateStartupFailure(readLogTail(logPath), binding.mergeCommit) : null; } catch { /* the exit itself is the reported failure */ }
    throw new Error(`Candidate runtime failed to start: ${error}${startup ? ` Daemon reported: ${startup}` : ''}`);
  }
  if (error) throw new Error(`Candidate production front door is not ready at the exact merge generation: ${error}`);
  const job = inspectJob(BACKEND_LABEL);
  const startedAt = processStart(job.pid);
  const installed = locateLaunchAgent(BACKEND_LABEL);
  const logPath = installed?.record.StandardErrorPath;
  if (!job.pid || !startedAt || !path.isAbsolute(logPath || '')) throw new Error('Current daemon process or launchd log provenance is unavailable.');
  const writer = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(job.pid), '-d', '2', '-Fn'], { encoding: 'utf8', timeout: 2500 });
  if (writer.error || writer.status !== 0 || !writer.stdout.split('\n').includes(`n${logPath}`)) throw new Error('Current daemon stderr writer differs from the loaded service log.');
  const log = fs.statSync(logPath);
  return { backend, gateway, health: status.backend.document, frontDoorHealth: status.gateway.document,
    process: { pid: job.pid, startedAt, startupEpoch: status.backend.document.startup_epoch },
    daemonLog: { path: logPath, dev: log.dev, ino: log.ino, size: log.size } };
}

function portOpen(url) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(350, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function readRunnerMetadata(production) {
  const env = production.environment ?? {};
  return {
    pidFile: typeof env.MANDIBLE_PID_FILE === "string" ? env.MANDIBLE_PID_FILE : path.join(LOG_DIR, "production.pid"),
    logFile: typeof env.MANDIBLE_STDERR_LOG_PATH === "string" ? env.MANDIBLE_STDERR_LOG_PATH : path.join(LOG_DIR, "production-stderr.log"),
  };
}

export function classifyRuntimeStatus({ backend, gateway, backendPortOpen, gatewayPortOpen, backendJob, gatewayJob, launchMode = "on_demand", metadata = {} }) {
  const backendConflict = backendPortOpen && !backend.ok && !backendJob.loaded;
  const gatewayConflict = gatewayPortOpen && !gateway.ok && !gatewayJob.loaded;
  const dashboardReady = backend.ok && gateway.ok;
  const state = dashboardReady ? "running"
    : backendConflict || gatewayConflict ? "port_conflict"
      : backend.ok ? "gateway_unavailable"
        : backendJob.loaded || gatewayJob.loaded ? "starting"
          : "stopped";
  const detail = [!backend.ok ? `Backend: ${backend.error}` : null, !gateway.ok ? `Secure dashboard: ${gateway.error}` : null]
    .filter(Boolean).join(" ") || null;
  return {
    state,
    launch_mode: launchMode,
    port: metadata.port ?? 0,
    pid: backendJob.pid ?? null,
    pid_file: metadata.pidFile ?? "",
    log_file: metadata.logFile ?? "",
    detail,
    healthy: backend.ok,
    dashboard_ready: dashboardReady,
    dashboard_origin: metadata.dashboardOrigin ?? PRODUCTION_ORIGIN,
    gateway_state: gateway.ok || gatewayPortOpen ? "running" : gatewayJob.loaded ? "starting" : "stopped",
    gateway_error: gateway.ok ? null : gateway.error,
    gateway_log_file: metadata.gatewayLogFile ?? "",
  };
}

async function inspectRuntime({ launchMode = "on_demand", probeTimeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const production = readProductionRecord();
  const main = readMainInstance(production.root);
  const expected = { installationId: main.installation_id, publicOrigin: PRODUCTION_ORIGIN, generation: main.backend_generation };
  const backendJob = inspectJob(BACKEND_LABEL);
  const gatewayJob = inspectJob(GATEWAY_LABEL);
  const [backendResponse, trusted, gatewayPortOpen, backendPortOpen] = await Promise.all([
    probeJson(healthEndpointUrl(main.backend_origin), { timeoutMs: probeTimeoutMs }),
    Promise.resolve().then(() => readTrustedRoot()).catch((error) => ({ ca: null, error: error.message })),
    portOpen(main.publicUrl),
    portOpen(main.backendUrl),
  ]);
  const backendError = backendResponse.ok ? healthDocumentError(backendResponse.document, expected) : backendResponse.error;
  const backend = backendError ? { ok: false, error: backendError } : { ok: true, document: backendResponse.document };
  let gateway = { ok: false, error: trusted.error };
  if (!trusted.error) {
    const gatewayResponse = await probeJson(healthEndpointUrl(PRODUCTION_ORIGIN), { ca: trusted.ca, timeoutMs: probeTimeoutMs });
    const gatewayError = gatewayResponse.ok ? healthDocumentError(gatewayResponse.document, expected) : gatewayResponse.error;
    gateway = gatewayError ? { ok: false, error: gatewayError } : { ok: true, document: gatewayResponse.document };
  }
  const runner = readRunnerMetadata(production);
  const status = classifyRuntimeStatus({
    backend, gateway, backendPortOpen, gatewayPortOpen, backendJob, gatewayJob, launchMode,
    metadata: {
      port: main.backendUrl.port ? Number(main.backendUrl.port) : (main.backendUrl.protocol === "https:" ? 443 : 80),
      pidFile: runner.pidFile,
      logFile: runner.logFile,
      gatewayLogFile: path.join(LOG_DIR, "local-front-door-stderr.log"),
      dashboardOrigin: PRODUCTION_ORIGIN,
    },
  });
  return { status, production, main, backend, gateway, backendJob, gatewayJob, backendPortOpen, gatewayPortOpen, trusted };
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderLaunchAgent({ label, programArguments, workingDirectory, environment, stdoutPath, stderrPath }) {
  const strings = (values) => values.map((value) => `<string>${escapeXml(value)}</string>`).join("");
  const env = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${escapeXml(label)}</string>`,
    `<key>ProgramArguments</key><array>${strings(programArguments)}</array>`,
    `<key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>`,
    `<key>EnvironmentVariables</key><dict>${env}</dict>`,
    '<key>KeepAlive</key><true/>',
    '<key>ThrottleInterval</key><integer>10</integer>',
    `<key>StandardOutPath</key><string>${escapeXml(stdoutPath)}</string>`,
    `<key>StandardErrorPath</key><string>${escapeXml(stderrPath)}</string>`,
    '<key>Comment</key><string>Mandible runtime agent mandible-launch-agent@1</string>',
    '</dict></plist>',
    '',
  ].join('\n');
}

function runtimeBinary(root) {
  return installationRuntime(root, INSTALLATION);
}

function standardPlistPath(label) {
  return path.join(SERVICE_DIR, `${label}.plist`);
}

function privatePlistPath(label) {
  return path.join(PRIVATE_SERVICE_DIR, `${label}.plist`);
}

function locateLaunchAgent(label) {
  const service = label === BACKEND_LABEL ? 'backend' : 'gateway';
  const files = [standardPlistPath(label), privatePlistPath(label)].filter(file => fs.existsSync(file));
  if (files.length === 1) {
    const record = parsePlist(files[0]);
    if (!ownsServiceDefinition(INSTALLATION, service, record)) throw new Error(`Unowned installed service ${label}; preserving it.`);
    return { file: files[0], record };
  }
  const observation = observeOwnedService(service);
  const record = observation.loadedDefinition ?? observation.installed[0]?.record;
  if (!record) return null;
  const preferred = service === 'backend' && launchModeFromAgent(record) === 'manual' ? privatePlistPath(label) : standardPlistPath(label);
  const installed = observation.installed.find(item => item.file === preferred) ?? observation.installed[0];
  return { file: installed?.file ?? null, record };
}

function archiveLaunchAgent(file, label, bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const archiveDir = path.join(RUNTIME_DIR, "launch-agent-history");
  const archive = path.join(archiveDir, `${label}-${digest.slice(0, 12)}.plist`);
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(archive)) {
    if (!fs.readFileSync(archive).equals(bytes)) throw new Error(`Preserved LaunchAgent history differs at ${archive}; refusing to replace it.`);
  } else {
    fs.writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(archive, 0o600);
  }
  return archive;
}

function writeOwnedPlist(file, contents, { label, recognizesLegacy = () => false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    if (existing === contents) return false;
    const managedMarker = "<key>Comment</key><string>Mandible runtime agent mandible-launch-agent@1</string>";
    const existingRecord = parsePlist(file);
    assertOwnedLaunchAgent(file, existingRecord, label, recognizesLegacy);
    if (!existing.includes(managedMarker)) archiveLaunchAgent(file, label, fs.readFileSync(file));
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { flag: "w", mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return true;
}

function assertOwnedLaunchAgent(file, record, label, recognizesLegacy) {
  if (record.Label !== label) {
    throw new Error(`LaunchAgent ${file} has an unexpected label; preserving it and reporting an ownership conflict.`);
  }
  if (!recognizesLegacy(record)) {
    throw new Error(`A launchd configuration already exists at ${file} and is not managed by Mandible; preserving it.`);
  }
}

function writeServicePlist(label, file, contents, { recognizesLegacy = () => false } = {}) {
  const service = label === BACKEND_LABEL ? 'backend' : 'gateway';
  const { installed } = observeOwnedService(service);
  for (const existing of installed.filter(item => item.file !== file)) {
    archiveLaunchAgent(existing.file, label, Buffer.from(existing.bytesBase64, 'base64'));
  }
  const changed = writeOwnedPlist(file, contents, { label, recognizesLegacy });
  for (const existing of installed.filter(item => item.file !== file)) fs.unlinkSync(existing.file);
  return changed || installed.some(item => item.file !== file);
}

function parsePlist(file) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8", timeout: 1500 });
  if (result.error || result.status !== 0) throw new Error(`Could not inspect existing launchd configuration ${file}; preserving it.`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`Existing launchd configuration is malformed: ${file}`); }
}

function prepareRunner(root) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  for (const [sourceName, targetName] of [
    ["local-session-production-runner.mjs", "production-runner.mjs"],
    ["canonical-origin.mjs", "canonical-origin.mjs"],
    ["build-revision.mjs", "build-revision.mjs"],
  ]) {
    const source = path.join(root, "scripts", sourceName);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Production runtime source is missing: ${source}`);
    const target = path.join(RUNTIME_DIR, targetName);
    const sourceBytes = fs.readFileSync(source);
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(sourceBytes)) {
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, sourceBytes, { mode: 0o700 });
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o700);
    }
  }
}

export function launchModeFromAgent(record) {
  const configured = record.EnvironmentVariables?.MANDIBLE_LAUNCH_MODE;
  if (configured === "manual" || configured === "on_demand") return configured;
  return "on_demand";
}

function installedLaunchMode() {
  const installed = locateLaunchAgent(BACKEND_LABEL);
  return installed ? launchModeFromAgent(installed.record) : "on_demand";
}

/** The running job's environment is authoritative for migration; the plist on disk only when unloaded. */
function legacyBackendEnvironment() {
  const job = inspectJob(BACKEND_LABEL);
  return job.loaded ? job.environment : locateLaunchAgent(BACKEND_LABEL)?.record.EnvironmentVariables ?? {};
}

export function prepareServicePlists(production, main, launchMode, { context = INSTALLATION, configuration } = {}) {
  const runtime = installationRuntime(production.root, context);
  const config = configuration ? { file: path.join(context.runtimeDir, 'service-config.json'), migrated: false, configuration: validateServiceConfiguration(configuration) }
    : readServiceConfiguration(context, context === INSTALLATION ? legacyBackendEnvironment() : {}, production.root);
  const pathValue = servicePath(runtime, production.root, context, config.configuration);
  const logDir = path.join(path.dirname(context.home), '.cache/mandible');
  const backendEnvironment = {
    HOME: context.accountHome,
    ...(context.home !== DEFAULT_HOME && context.accountHome !== ACCOUNT_HOME ? { MANDIBLE_SERVICE_ACCOUNT_HOME: context.accountHome } : {}),
    MANDIBLE_HOME: context.home,
    MANDIBLE_PRODUCTION_ROOT: production.root,
    MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR: context.runtimeDir,
    MANDIBLE_CLIENT_AUTH_DIR: path.join(context.home, 'config/client-auth'),
    MANDIBLE_CONTEXT_VERIFICATION_KEY: path.join(context.runtimeDir, 'context-verification-key.pem'),
    MANDIBLE_LAUNCH_MODE: launchMode,
    MANDIBLE_PORT: String(Number(main.backendUrl.port) || DEFAULT_BACKEND_PORT),
    MANDIBLE_STDERR_LOG_PATH: path.join(logDir, 'production-stderr.log'),
    MANDIBLE_BASE: PRODUCTION_ORIGIN,
    PATH: pathValue,
    GIT_OPTIONAL_LOCKS: '0',
    ...config.configuration.environment,
  };
  const make = (service, arguments_, environment, stdout, stderr) => {
    const label = context[`${service}Label`];
    const directory = service === 'backend' ? launchMode === 'manual' ? context.privateServiceDir : context.serviceDir
      : fs.existsSync(path.join(context.runtimeDir, 'Caddyfile')) ? context.serviceDir : context.privateServiceDir;
    const record = { Label: label, ProgramArguments: arguments_, EnvironmentVariables: environment, WorkingDirectory: context.runtimeDir,
      KeepAlive: true, StandardOutPath: stdout, StandardErrorPath: stderr, Comment: 'Mandible runtime agent mandible-launch-agent@1' };
    return { service, label, file: path.join(directory, `${label}.plist`), record,
      contents: renderLaunchAgent({ label, programArguments: arguments_, environment, workingDirectory: context.runtimeDir, stdoutPath: stdout, stderrPath: stderr }) };
  };
  return { config, definitions: [
    make('backend', [runtime, path.join(context.runtimeDir, 'production-runner.mjs'), 'run'], backendEnvironment, path.join(logDir, 'production-stdout.log'), backendEnvironment.MANDIBLE_STDERR_LOG_PATH),
    make('gateway', [pinnedCaddyBinary(context.home), 'run', '--config', path.join(context.runtimeDir, 'Caddyfile'), '--adapter', 'caddyfile'],
      { HOME: context.accountHome, MANDIBLE_HOME: context.home, PATH: pathValue, GIT_OPTIONAL_LOCKS: '0' }, path.join(logDir, 'local-front-door-stdout.log'), path.join(logDir, 'local-front-door-stderr.log')),
  ] };
}

function runnerChanged(root) {
  return [['local-session-production-runner.mjs', 'production-runner.mjs'], ['canonical-origin.mjs', 'canonical-origin.mjs'], ['build-revision.mjs', 'build-revision.mjs']]
    .some(([source, target]) => !fs.existsSync(path.join(RUNTIME_DIR, target)) || !fs.readFileSync(path.join(root, 'scripts', source)).equals(fs.readFileSync(path.join(RUNTIME_DIR, target))));
}

function assertLifecycleMutation(allowHandoff = false) {
  const file = path.join(RUNTIME_DIR, 'handoff-active.json');
  if (!fs.existsSync(file)) return;
  const active = JSON.parse(fs.readFileSync(file, 'utf8'));
  const journalPath = process.env.MANDIBLE_RUNTIME_HANDOFF_JOURNAL;
  const journal = journalPath ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : null;
  if (!allowHandoff || active.journal !== journalPath || active.bindingDigest !== journal?.bindingDigest || journal?.binding.home !== HOME) throw new Error('A production runtime handoff is pending; preserve its owned service definitions.');
}

async function unloadOwnedDefinition(label, job) {
  await unloadExactHandoffService(label, job.argv, loadedServiceDefinition(label, job));
}

function observeOwnedService(service) {
  const inspection = inspectServiceDefinitionsSync(INSTALLATION);
  if (!inspection.ok) throw new Error(inspection.refusal.message);
  return inspection.observations.find(observation => observation.service === service);
}

export async function reconcileServiceDefinitions(production, main, launchMode, { services = ['backend', 'gateway'], running = [], restart = [], handoff = false, configuration, loadService = ensureEnabledAndLoaded } = {}) {
  assertLifecycleMutation(handoff);
  const desired = prepareServicePlists(production, main, launchMode, { configuration });
  const runnersChanged = services.includes('backend') && runnerChanged(production.root);
  // Observe and validate both services before the first write or bootout.
  const inspection = inspectServiceDefinitionsSync(INSTALLATION, { desired: Object.fromEntries(desired.definitions.map(item => [item.service, item.record])) });
  if (!inspection.ok) throw new Error(inspection.refusal.message);
  const observed = desired.definitions.map(definition => {
    const { installed, job } = inspection.observations.find(item => item.service === definition.service);
    const changed = installed.length !== 1 || installed[0].file !== definition.file || !Buffer.from(installed[0].bytesBase64, 'base64').equals(Buffer.from(definition.contents))
      || job.loaded && !loadedServiceMatches(definition.record, job) || definition.service === 'backend' && runnersChanged;
    return { ...definition, installed, job, changed };
  });
  for (const definition of observed.filter(definition => services.includes(definition.service))) {
    if (definition.job.loaded && definition.changed) await unloadOwnedDefinition(definition.label, definition.job);
  }
  assertLifecycleMutation(handoff);
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  if (services.includes('backend')) prepareRunner(production.root);
  for (const definition of observed.filter(definition => services.includes(definition.service))) {
    writeServicePlist(definition.label, definition.file, definition.contents, { recognizesLegacy: record => ownsServiceDefinition(INSTALLATION, definition.service, record) });
    if (running.includes(definition.service) || definition.job.loaded && !handoff) {
      try {
        await loadService(definition.label);
        if (restart.includes(definition.service) && definition.job.loaded && !definition.changed) restartOwnedJob(definition.label);
        const until = Date.now() + 2500;
        let job = inspectJob(definition.label);
        while (!job.loaded && Date.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 50));
          job = inspectJob(definition.label);
        }
        if (!job.loaded || !loadedServiceMatches(definition.record, job)) {
          if (job.loaded && JSON.stringify(job.argv) === JSON.stringify(definition.record.ProgramArguments)) await unloadOwnedDefinition(definition.label, job);
          throw new Error('Loaded definition does not match its installed replacement.');
        }
      } catch (error) {
        const current = inspectJob(definition.label);
        if (definition.changed && current.loaded && loadedServiceMatches(definition.record, current)) await unloadOwnedDefinition(definition.label, current);
        throw new Error(`Service ${definition.label} replacement is installed; loaded=${inspectJob(definition.label).loaded}. ${error.message}`);
      }
    }
  }
  if (services.includes('backend') && (desired.config.migrated || configuration)) publishServiceConfiguration(desired.config.file, desired.config.configuration);
  return { wasBackendLoaded: observed[0].job.loaded, wasGatewayLoaded: observed[1].job.loaded, backendChanged: observed[0].changed, gatewayChanged: observed[1].changed };
}

function ensureEnabledAndLoaded(label) {
  const current = inspectJob(label);
  if (current.loaded) return false;
  const enabled = runLaunchctl(["enable", `${DOMAIN}/${label}`]);
  if (enabled.status !== 0) throw new Error(`Could not enable Mandible service ${label}: ${enabled.stderr.trim()}`);
  const installed = locateLaunchAgent(label);
  if (!installed) throw new Error(`Mandible service ${label} has no installed LaunchAgent.`);
  const loaded = runLaunchctl(["bootstrap", DOMAIN, installed.file]);
  if (loaded.status !== 0) {
    throw new Error(`Could not start Mandible service ${label}: ${(loaded.stderr || loaded.stdout).trim()}`);
  }
  return true;
}

async function stopOwnedJob(label) {
  const current = inspectJob(label);
  const disabled = runLaunchctl(['disable', `${DOMAIN}/${label}`]);
  if (disabled.status !== 0) throw new Error(`Could not disable Mandible service ${label}: ${disabled.stderr.trim()}`);
  if (current.loaded) await unloadExactHandoffService(label, current.argv);
}

function ensureGatewayBinary() {
  const binary = pinnedCaddyBinary(HOME);
  if (!fs.existsSync(binary)) installPinnedCaddy(HOME);
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) throw new Error(`The pinned HTTPS gateway is missing: ${binary}`);
}

function configureGateway(root) {
  const script = path.join(root, "scripts", "local-front-door.mjs");
  const result = spawnSync(runtimeBinary(root), [script, "configure"], {
    cwd: root,
    env: { ...process.env, HOME: HOME_DIR, MANDIBLE_HOME: HOME, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8", timeout: 12_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not prepare the trusted dashboard gateway: ${(result.stderr || result.error?.message || "configuration failed").trim()}`);
  }
}

function reloadCaddy(binary) {
  const result = spawnSync(binary, ["reload", "--config", path.join(RUNTIME_DIR, "Caddyfile"), "--adapter", "caddyfile"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`The trusted dashboard gateway reload failed: ${(result.stderr || result.error?.message || "unknown failure").trim()}`);
  }
}

async function waitForRuntime(deadlineMs = OPERATION_TIMEOUT_MS, launchMode = "on_demand", additionalReadiness = () => true) {
  const deadline = Date.now() + deadlineMs;
  let current;
  do {
    current = await inspectRuntime({ launchMode });
    if ((current.status.dashboard_ready && additionalReadiness(current)) || current.status.state === "port_conflict") return current;
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 220));
  } while (Date.now() < deadline);
  return current;
}

function restartOwnedJob(label) {
  const current = inspectJob(label);
  if (!current.loaded) return ensureEnabledAndLoaded(label);
  const restarted = runLaunchctl(["kickstart", "-k", `${DOMAIN}/${label}`]);
  if (restarted.status !== 0) throw new Error(`Could not restart Mandible service ${label}: ${restarted.stderr.trim()}`);
  return true;
}

function prepareGateway(production) {
  ensureGatewayBinary();
  configureGateway(production.root);
}

async function startRuntime({ launchMode = installedLaunchMode() } = {}) {
  let current = await inspectRuntime({ launchMode });
  if (current.status.state === 'port_conflict') throw new Error(current.status.detail);
  const registration = await initializeMainRegistration(current.production.root);
  current = await inspectRuntime({ launchMode });
  if (current.backendPortOpen && !current.backendJob.loaded) throw new Error('The production backend is not owned by Mandible; preserving it.');
  if (!current.trusted.error) prepareGateway(current.production);
  await reconcileServiceDefinitions(current.production, current.main, launchMode, {
    running: current.trusted.error ? ['backend'] : ['backend', 'gateway'], restart: registration.legacyEffectsMigrated ? ['backend'] : [],
  });
  const ready = await waitForRuntime(OPERATION_TIMEOUT_MS, launchMode, candidate => !registration.legacyEffectsMigrated
    || sameEffectList(candidate.backend.document?.instance?.allowed_effects, candidate.main.effectCeiling));
  if (registration.legacyEffectsMigrated && !sameEffectList(ready.backend.document?.instance?.allowed_effects, ready.main.effectCeiling)) throw new Error('The active production effect ceiling differs from its registration.');
  assertInstalledDefinitions();
  return ready.status;
}

function assertInstalledDefinitions() {
  const inspection = matchingServiceDefinitions(inspectServiceDefinitionsSync(INSTALLATION));
  if (!inspection.ok) throw new Error(inspection.refusal.message);
}

function registeredPreviewCount(root) {
  const Database = createRequire(path.join(root, "package.json"))("./dist/sqlite.js").default;
  const db = new Database(AUTHORITY_DB, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT COUNT(*) AS count FROM instance_registrations WHERE role = 'preview'").get().count; }
  finally { db.close(); }
}

async function stopRuntime({ launchMode = "on_demand" } = {}) {
  const current = await inspectRuntime({ launchMode });
  assertLifecycleMutation();
  observeOwnedService('backend', BACKEND_LABEL);
  observeOwnedService('gateway', GATEWAY_LABEL);
  const owned = await inspectRuntime({ launchMode });
  const previews = registeredPreviewCount(current.production.root);
  if (owned.backendJob.loaded) await stopOwnedJob(BACKEND_LABEL);
  if (previews === 0 && owned.gatewayJob.loaded) await stopOwnedJob(GATEWAY_LABEL);
  const stopped = await waitForRuntime(3000, launchMode);
  if (stopped.status.healthy) throw new Error("Stop was requested, but the production backend is still responding.");
  if (previews > 0 && owned.gatewayJob.loaded
    && (!stopped.gatewayJob.loaded || !stopped.gatewayJob.pid || !stopped.gatewayPortOpen)) {
    throw new Error("The production backend stopped, but the launchd-owned shared preview gateway process or listener did not remain available.");
  }
  if (previews > 0 && !owned.gatewayJob.loaded && owned.gatewayPortOpen && !stopped.gatewayPortOpen) {
    throw new Error("The production backend stopped, but the previously active shared preview gateway listener did not remain available.");
  }
  return stopped.status;
}

async function restartRuntime({ launchMode = installedLaunchMode() } = {}) {
  let current = await inspectRuntime({ launchMode });
  if (current.status.state === 'port_conflict') throw new Error(current.status.detail);
  await initializeMainRegistration(current.production.root);
  current = await inspectRuntime({ launchMode });
  const beforeEpoch = current.backend.document?.startup_epoch;
  if (current.backendPortOpen && !current.backendJob.loaded) throw new Error('The production backend is not owned by Mandible; preserving it.');
  if (!current.trusted.error) prepareGateway(current.production);
  await reconcileServiceDefinitions(current.production, current.main, launchMode, {
    running: current.trusted.error ? ['backend'] : ['backend', 'gateway'], restart: ['backend'],
  });
  current = await waitForRuntime(OPERATION_TIMEOUT_MS, launchMode, candidate => candidate.backend.document?.startup_epoch !== beforeEpoch);
  if (!current.backend.ok || !current.backend.document?.startup_epoch || beforeEpoch && current.backend.document.startup_epoch === beforeEpoch) throw new Error('Restart did not confirm a ready backend with a new startup epoch.');
  assertInstalledDefinitions();
  return current.status;
}

async function reloadGatewayRuntime({ launchMode = installedLaunchMode(), ifConfigured = false } = {}) {
  const initial = await inspectRuntime({ launchMode });
  if (ifConfigured && !fs.existsSync(GATEWAY_CONFIG)) return { skipped: 'local HTTPS gateway is not configured' };
  if (initial.status.state === 'port_conflict') throw new Error(initial.status.detail);
  if (initial.trusted.error) throw new Error(initial.trusted.error);
  if (!initial.backend.ok) throw new Error('The production daemon is not ready; the shared gateway was not changed.');
  assertLifecycleMutation();
  prepareGateway(initial.production);
  const reconciled = await reconcileServiceDefinitions(initial.production, initial.main, launchMode, { services: ['gateway'], running: ['gateway'] });
  if (!reconciled.gatewayChanged && reconciled.wasGatewayLoaded) reloadCaddy(pinnedCaddyBinary(HOME));
  assertInstalledDefinitions();
  return (await waitForRuntime(OPERATION_TIMEOUT_MS, launchMode)).status;
}

function sameEffectList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((effect, index) => effect === expected[index]);
}

export function reconcileMainRegistration(authority, instance, backendOrigin) {
  const existing = authority.instance("production");
  if (existing) {
    if (existing.installation_id !== instance.installation_id || existing.role !== "main"
      || existing.public_origin !== instance.public_origin) {
      throw new Error("The registered production instance belongs to another installation or origin.");
    }
    const previousCanonicalEffects = instance.allowed_effects.filter((effect) => effect !== MIGRATABLE_MAIN_EFFECT);
    const isExactPriorDefault = instance.allowed_effects.includes(MIGRATABLE_MAIN_EFFECT)
      && sameEffectList(existing.effect_ceiling, previousCanonicalEffects);
    if (isExactPriorDefault) {
      authority.registerInstance({ ...existing, effect_ceiling: instance.allowed_effects });
      return true;
    }
    return false;
  }

  authority.registerInstance({
    instance_id: instance.instance_id,
    installation_id: instance.installation_id,
    role: instance.role,
    public_origin: instance.public_origin,
    backend_origin: backendOrigin,
    backend_generation: instance.backend_generation,
    effect_ceiling: instance.allowed_effects,
    writable_roots: instance.writable_roots,
  });
  return false;
}

async function initializeMainRegistration(root) {
  if (!fs.existsSync(INSTALLATION_AUTHORITY)) {
    const result = spawnSync(runtimeBinary(root), [path.join(root, "scripts", "local-front-door.mjs"), "initialize"], {
      cwd: root,
      env: { ...process.env, HOME: ACCOUNT_HOME, MANDIBLE_HOME: HOME },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Installation authority setup failed: ${(result.stderr || result.error?.message || "unknown failure").trim()}`);
    }
  }
  const installationId = fs.readFileSync(INSTALLATION_AUTHORITY, "utf8").trim();
  if (!installationId) throw new Error("The installation authority id is empty.");
  const generation = readBuildRevision(root);

  const [authorityModule, policyModule] = await Promise.all([
    import(pathToFileURL(path.join(root, "dist", "client-auth", "session-authority.js")).href),
    import(pathToFileURL(path.join(root, "dist", "instance-policy.js")).href),
  ]);
  const authority = new authorityModule.LocalSessionAuthority(RUNTIME_DIR, installationId, { initialize: true });
  let legacyEffectsMigrated = false;
  try {
    const instance = policyModule.resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "main",
        MANDIBLE_INSTANCE_ID: "production",
        MANDIBLE_INSTALLATION_ID: installationId,
        MANDIBLE_PUBLIC_ORIGIN: PRODUCTION_ORIGIN,
        MANDIBLE_BACKEND_GENERATION: generation,
      },
    });
    legacyEffectsMigrated = reconcileMainRegistration(authority, instance, `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`);
  } finally {
    authority.close();
  }
  return { root, environment: {}, legacyEffectsMigrated };
}

function explicitServiceConfiguration(args) {
  const index = args.indexOf('--service-config');
  if (index < 0) return undefined;
  if (!args[index + 1]) throw new Error('--service-config requires a JSON file.');
  return validateServiceConfiguration(JSON.parse(fs.readFileSync(args[index + 1], 'utf8')));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const journalPath = process.env.MANDIBLE_RUNTIME_HANDOFF_JOURNAL;
  const activePath = path.join(RUNTIME_DIR, 'handoff-active.json');
  const active = fs.existsSync(activePath) ? JSON.parse(fs.readFileSync(activePath, 'utf8')) : null;
  const journal = journalPath ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : null;
  const directHandoff = !!journal && active?.journal === journalPath && active?.bindingDigest === journal.bindingDigest && journal.binding.home === HOME;
  if (active && !directHandoff && command !== 'status') throw new Error('A production runtime handoff is pending; preserve its owned service definitions.');
  if (command === 'handoff-snapshot') {
    const rootIndex = args.indexOf('--root');
    process.stdout.write(`${JSON.stringify(captureRuntimeHandoff(args[rootIndex + 1] ?? process.cwd()))}\n`);
    return;
  }
  if (command === 'handoff-remove' || command === 'handoff-start' || command === 'handoff-verify') {
    const acceptedProbe = command === 'handoff-verify' && (journal?.phase === 'acknowledged' || journal?.phase === 'complete' && journal.cleanupStartedAt) && journal.binding.home === HOME;
    if (!directHandoff && !acceptedProbe) throw new Error('Runtime handoff command requires its exact active journal.');
    const untilIndex = args.indexOf('--until');
    const until = untilIndex >= 0 ? Number(args[untilIndex + 1]) : Date.now();
    if (!Number.isFinite(until)) throw new Error('Runtime handoff verification requires a numeric --until deadline.');
    const result = command === 'handoff-remove' ? await removeHandoffDefinitions(journal.binding)
      : command === 'handoff-start' ? await startHandoffDefinitions(journal.binding)
        : await verifyHandoffDefinitions(journal.binding, { until, awaitReady: args.includes('--await-ready') });
    process.stdout.write(`${JSON.stringify(result ?? { removed: true })}\n`);
    return;
  }
  const launchModeArg = args.find((arg) => arg.startsWith("--launch-mode="))?.slice("--launch-mode=".length);
  if (launchModeArg && !["manual", "on_demand"].includes(launchModeArg)) {
    throw new Error(`Unsupported launch mode: ${launchModeArg}`);
  }
  const launchMode = launchModeArg ?? (directHandoff ? journal.binding.priorBackend.launchMode : installedLaunchMode());
  if (args.includes('--service-config') && !['install', 'configure-launch-mode'].includes(command)) throw new Error('--service-config is accepted only by install and configure-launch-mode.');
  const configuration = explicitServiceConfiguration(args);
  if (command === "status") {
    const { status } = await inspectRuntime({ launchMode });
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  if (['start', 'restart', 'stop', 'reload-gateway', 'configure-launch-mode', 'install'].includes(command)) {
    observeOwnedService('backend', BACKEND_LABEL);
    observeOwnedService('gateway', GATEWAY_LABEL);
  }
  let status;
  if (command === "start") status = await startRuntime({ launchMode });
  else if (command === "stop") status = await stopRuntime({ launchMode });
  else if (command === "restart") status = await restartRuntime({ launchMode });
  else if (command === "reload-gateway") status = await reloadGatewayRuntime({ launchMode, ifConfigured: args.includes("--if-configured") });
  else if (command === "configure-launch-mode") {
    const production = readProductionRecord();
    const mainInstance = readMainInstance(production.root);
    await reconcileServiceDefinitions(production, mainInstance, launchMode, { configuration });
    assertInstalledDefinitions();
    status = (await inspectRuntime({ launchMode })).status;
  }
  else if (command === "install") {
    if (directHandoff && inspectJob(BACKEND_LABEL).loaded) throw new Error('The old backend definition must be unloaded before candidate installation.');
    const rootArgIndex = args.indexOf("--root");
    const root = path.resolve(rootArgIndex >= 0 ? (args[rootArgIndex + 1] ?? "") : process.cwd());
    if (!fs.existsSync(path.join(root, "package.json")) || !fs.existsSync(path.join(root, "dist", "index.js"))) {
      throw new Error(`A built Mandible checkout is required to install local services: ${root}`);
    }
    runtimeBinary(root);
    if (!configuration) readServiceConfiguration(INSTALLATION, legacyBackendEnvironment());
    const production = await initializeMainRegistration(root);
    const mainInstance = readMainInstance(root);
    const effectiveLaunchMode = launchMode;
    const installScript = path.join(production.root, "scripts", "local-front-door.mjs");
    const result = spawnSync(runtimeBinary(root), [installScript, "install"], {
      cwd: production.root, env: { ...process.env, HOME: HOME_DIR, MANDIBLE_HOME: HOME },
      encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(`Gateway installation failed: ${(result.stderr || result.error?.message || "unknown failure").trim()}`);
    const installed = await reconcileServiceDefinitions(production, mainInstance, effectiveLaunchMode, { handoff: directHandoff, configuration, restart: production.legacyEffectsMigrated && !directHandoff ? ['backend'] : [] });
    assertInstalledDefinitions();
    if (production.legacyEffectsMigrated && !directHandoff) {
      if (!installed.wasBackendLoaded && await portOpen(mainInstance.backendUrl)) {
        throw new Error("The production effect ceiling was updated, but the healthy backend is not owned by Mandible's LaunchAgent; restart it explicitly to apply the update.");
      }
    }
    process.stdout.write(`${JSON.stringify({ installed: true, launch_mode: effectiveLaunchMode, ...installed })}\n`);
    return;
  } else {
    throw new Error("Usage: local-runtime.mjs status|install [--root <checkout>] [--service-config <json>]|configure-launch-mode [--service-config <json>]|start|stop|restart|reload-gateway [--launch-mode=manual|on_demand]");
  }
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
