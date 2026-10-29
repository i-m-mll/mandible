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
import { fileURLToPath } from "node:url";
import { DEFAULT_BACKEND_PORT, PRODUCTION_ORIGIN } from "./canonical-origin.mjs";
import { assertLocalCaIdentity, localCaPaths, probeCurrentMacOsTrust } from "./local-ca-trust.mjs";
import { installPinnedCaddy, pinnedCaddyBinary } from "./pinned-caddy.mjs";
import { readBuildRevision, compiledBuildDigest, runtimeDependenciesDigest } from "./build-revision.mjs";
import { serviceInstallationContext, parseLoadedService, loadedServiceMatches, ownsServiceDefinition, inspectServiceDefinitionsSync, matchingServiceDefinitions, loadedServiceDefinition, runtimeHandoffReadiness } from "./service-definitions.mjs";
import { installationRuntime, servicePath, readServiceConfiguration, publishServiceConfiguration, validateServiceConfiguration } from "./service-configuration.mjs";
import { withInstallationGatewayLock, assertLifecycleLockHeld } from './lifecycle-lock.mjs';
import { RUNTIME_HEALTH_PROBE_INTERVAL_MS } from './runtime-probe-cadence.mjs';
import { RuntimeObservationError, runtimeProcessChanged, runtimeObservationTimeout } from './runtime-observation.mjs';
import { reloadGatewayConfiguration, gatewayAdminNeedsRestart } from './gateway-admin.mjs';
export { parseLoadedService, loadedServiceMatches } from "./service-definitions.mjs";

import { readBundleOwner, nativeServiceControl, nativeServiceControls, readBundleLaunch, bundleLoginSession } from './bundle-services.mjs';
import { reconcileBundleServiceStart, bundleServiceStartAction, startOwnedJob, BUNDLE_SERVICE_START_TIMEOUT_MS } from './bundle-service-start.mjs';
import { installAcceptedApplication } from './accepted-app-install.mjs';

import * as installedModuleReader from './installed-release.mjs';
import * as acceptedInstall from './accepted-app-install.mjs';
import { configureLocalFrontDoor } from './local-front-door.mjs';
import SqliteDatabase from '../src/sqlite.ts';
import { LocalSessionAuthority } from '../src/client-auth/session-authority.ts';
import { resolveInstanceInfo } from '../src/instance-policy.ts';

import { nativeExecutionModel, classifyNativeExecution } from './native-service-execution.mjs';

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
const handoffControl = !!(process.env.MANDIBLE_RUNTIME_HANDOFF_CAPTURE || process.env.MANDIBLE_RUNTIME_HANDOFF_JOURNAL);
let cliInstallation;
function defaultInstallation() { return cliInstallation ??= serviceInstallationContext({ home: HOME,
  ...(handoffControl ? { bundleRoot: null } : {}),
  ...(HOME !== DEFAULT_HOME && process.env.MANDIBLE_SERVICE_ACCOUNT_HOME ? { accountHome: process.env.MANDIBLE_SERVICE_ACCOUNT_HOME } : {}) }); }
function serviceDirectory() { return defaultInstallation().serviceDir; }
function privateServiceDirectory() { return defaultInstallation().privateServiceDir; }
function backendLabel() { return defaultInstallation().backendLabel; }
function gatewayLabel() { return defaultInstallation().gatewayLabel; }
const HEALTH_TIMEOUT_MS = 900;
const OPERATION_TIMEOUT_MS = 4500;
const BODY_LIMIT = 256 * 1024;
const MIGRATABLE_MAIN_EFFECT = "preferences:instance";
const installedResources = handoffControl ? null : process.env.MANDIBLE_RELEASE_ROOT;
const installedModule = installedResources ? await import('./installed-release.mjs') : null;
const installedRelease = () => installedModule?.readInstalledRelease(installedResources);


/** Select an installation once; imported operations never select a bundle from process environment. */
export function createHandoffContext({ home, root, accountHome = os.userInfo().homedir, domain = `gui/${process.getuid?.() ?? 0}`,
  bundleRoot, bundleIdentifier, storageModule } = {}) {
  if (!path.isAbsolute(home ?? '')) throw new Error('Handoff context requires an absolute installation home.');
  const ownerFile = path.join(home, 'config/local-sessions/bundle-owner.json');
  bundleRoot ??= fs.existsSync(ownerFile) ? JSON.parse(fs.readFileSync(ownerFile, 'utf8')).bundleRoot : null;
  const context = serviceInstallationContext({ home, accountHome, domain, bundleRoot, bundleIdentifier });
  return Object.freeze({ ...context, root, storageModule });
}

function readProductionRecord() {
  if (installedResources) return { root: installedResources, environment: readServiceConfiguration(defaultInstallation()).configuration.environment };
  const owner = readBundleOwner(defaultInstallation());
  if (owner) return { root: path.join(owner.bundleRoot, 'Contents/Resources'), environment: readServiceConfiguration(defaultInstallation()).configuration.environment };
  const installed = locateLaunchAgent(backendLabel());
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

export function readMainInstance(root, { context = defaultInstallation(), storageModule } = {}) {
  const AUTHORITY_DB = path.join(context.runtimeDir, "sessions.db");
  const INSTALLATION_AUTHORITY = path.join(context.home, "config/client-auth/authority-id");
  if (!fs.existsSync(AUTHORITY_DB)) throw new Error(`Local-session authority is missing: ${AUTHORITY_DB}`);
  storageModule ??= context.storageModule;
  const Database = storageModule ? createRequire(path.join(root, "package.json"))(storageModule).default : SqliteDatabase;
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
  return healthDocumentObservation(document, expected).error ?? null;
}

export function healthDocumentObservation(document, expected) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, code: 'malformed_health', error: 'The service returned malformed health data.' };
  }
  const instance = document.instance;
  if (!instance || instance.role !== "main" || instance.instance_id !== "production"
    || instance.installation_id !== expected.installationId
    || instance.public_origin !== expected.publicOrigin
    || instance.backend_generation !== expected.generation) {
    return { ok: false, code: 'wrong_instance', error: 'The service response belongs to a different Mandible instance or build.' };
  }
  if (document.status !== 'ok' || document.ready !== true) {
    return { ok: false, code: 'not_ready', error: 'The service responded, but Mandible is not ready yet.' };
  }
  return { ok: true, document };
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
      finish({ ok: false, code: 'invalid_protocol', error: "The health URL must use HTTP or HTTPS." });
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    deadline = setTimeout(() => {
      request?.destroy(new Error("health probe exceeded its deadline"));
      finish({ ok: false, code: 'probe_deadline', error: `Health check exceeded its ${timeoutMs} ms deadline.` });
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
          finish({ ok: false, code: 'http_status', status: response.statusCode, error: `Health endpoint returned HTTP ${response.statusCode ?? "unknown"}.` });
          return;
        }
        try {
          finish({ ok: true, document: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          finish({ ok: false, code: 'malformed_health', error: "The service returned malformed health data." });
        }
      });
      });
    } catch (error) {
      finish({ ok: false, code: 'connection_error', error: `The service could not be reached: ${error.message}` });
      return;
    }
    request.on("timeout", () => request.destroy(Object.assign(new Error("health probe exceeded its deadline"), { code: 'ETIMEDOUT' })));
    request.on("error", (error) => {
      const code = error.code === 'ETIMEDOUT' ? 'probe_deadline'
        : /^(CERT_|ERR_TLS_|DEPTH_ZERO_|UNABLE_TO_)/.test(error.code ?? '') ? 'tls_error'
          : error.code === 'ECONNREFUSED' ? 'connection_refused' : 'connection_error';
      const message = code === 'probe_deadline'
        ? `Health check exceeded its ${timeoutMs} ms deadline.`
        : code === 'tls_error'
          ? "The HTTPS certificate failed verification against this installation's trusted Mandible certificate."
          : code === 'connection_refused'
            ? "The service is not accepting connections."
            : `The service could not be reached: ${error.message}`;
      finish({ ok: false, code, error: message });
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
  assertLifecycleLockHeld();
  if (process.platform !== "darwin") throw new Error("Mandible's supervised local runtime requires macOS launchd.");
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error(`launchctl ${args[0]} failed: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function inspectJob(label, until) {
  const result = runLaunchctl(["print", `${DOMAIN}/${label}`], runtimeObservationTimeout(until, 2500));
  const loaded = result.status === 0;
  if (!loaded && !/Could not find service|service not found/i.test(result.stderr)) throw new Error(`Cannot inspect launchd service ${label}: ${result.stderr}`);
  const pid = loaded ? Number(result.stdout.match(/\bpid = (\d+)/)?.[1] ?? 0) || null : null;
  const runs = loaded ? Number(result.stdout.match(/\bruns = (\d+)/)?.[1] ?? 0) : 0;
  const lastExit = loaded ? result.stdout.match(/\blast exit code = ([^\n]+)/)?.[1]?.trim() ?? null : null;
  return { loaded, pid, runs, lastExit, ...parseLoadedService(result.stdout), detail: result.stderr.trim() };
}

function processStart(pid, until) {
  if (!pid) return null;
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: runtimeObservationTimeout(until, 1500) });
  if (result.error || result.status !== 0 && result.stderr?.trim()) throw new Error(`Cannot inspect process ${pid}: ${result.error?.message || result.stderr.trim()}`);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function handoffService(label, inspection) {
  if (!inspection.ok && inspection.refusal.category === 'starting') throw new RuntimeObservationError('starting', inspection.refusal.message,
    inspection, 'pending');
  if (!inspection.ok) throw new Error(inspection.refusal.message);
  const observation = inspection.observations.find(item => item.label === label);
  const installed = observation.installed[0];
  const definition = observation.loadedDefinition ?? installed?.record ?? null;
  return { file: installed?.file ?? null, sha256: installed?.sha256 ?? null,
    installed: observation.installed, argv: definition?.ProgramArguments ?? [], loaded: observation.job.loaded, definition,
    process: observation.job.pid && observation.job.startedAt ? { pid: observation.job.pid, startedAt: observation.job.startedAt, runs: observation.job.runs } : null };
}

function capturedGatewayChildren(observation, context) {
  if (!observation?.job.pid || observation.job.executable !== path.join(context.bundleRoot, 'Contents/MacOS/mandible-bun')) return [];
  const result = spawnSync('/usr/bin/pgrep', ['-P', String(observation.job.pid), '-x', 'mandible-caddy'], { encoding: 'utf8', timeout: 2500 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Cannot inspect the prior Bun gateway children.');
  const executable = path.join(context.bundleRoot, 'Contents/MacOS/mandible-caddy');
  const command = `${executable} run --config ${path.join(context.runtimeDir, 'Caddyfile')} --adapter caddyfile`;
  return result.stdout.trim().split('\n').filter(Boolean).map(value => {
    const pid = Number(value), startedAt = processStart(pid);
    const actual = spawnSync('/bin/ps', ['-ww', '-p', value, '-o', 'command='], { encoding: 'utf8', timeout: 2500 });
    if (!startedAt || actual.error || actual.status !== 0 || actual.stdout.trim() !== command) throw new Error('Prior gateway child has a different executable or configuration.');
    return { pid, startedAt, command };
  });
}

async function drainCapturedGatewayChildren(children, until) {
  for (const child of children ?? []) {
    if (processStart(child.pid, until) !== child.startedAt) continue;
    const actual = spawnSync('/bin/ps', ['-ww', '-p', String(child.pid), '-o', 'command='], { encoding: 'utf8', timeout: runtimeObservationTimeout(until, 2500) });
    if (actual.error || actual.status !== 0 || actual.stdout.trim() !== child.command) throw new Error('Captured old gateway writer changed; preserving it.');
    process.kill(child.pid, 'SIGTERM');
    const grace = Math.min(until, Date.now() + 1000);
    while (Date.now() < grace && processStart(child.pid, until) === child.startedAt) await new Promise(resolve => setTimeout(resolve, 25));
    if (processStart(child.pid, until) === child.startedAt) process.kill(child.pid, 'SIGKILL');
    while (processStart(child.pid, until) === child.startedAt) {
      if (Date.now() >= until) throw new Error('Captured old gateway writer did not drain.');
      await new Promise(resolve => setTimeout(resolve, Math.min(25, until - Date.now())));
    }
  }
}

export function captureRuntimeHandoff(root, { context = defaultInstallation(), storageModule } = {}) {
  const HOME = context.home, DOMAIN = context.domain;
  const BACKEND_LABEL = context.backendLabel, GATEWAY_LABEL = context.gatewayLabel;
  const serviceInspection = runtimeHandoffReadiness(inspectServiceDefinitionsSync(context));
  const backend = handoffService(BACKEND_LABEL, serviceInspection);
  const gateway = handoffService(GATEWAY_LABEL, serviceInspection);
  const bundleOwner = readBundleOwner(context);
  const bundled = !!backend.definition.BundleProgram;
  if (bundled) gateway.children = capturedGatewayChildren(serviceInspection.observations.find(item => item.service === 'gateway'), context);
  const production = { root: bundled ? path.join(bundleOwner.bundleRoot, 'Contents/Resources') : backend.definition.EnvironmentVariables.MANDIBLE_PRODUCTION_ROOT };
  if (!path.isAbsolute(production.root ?? '')) throw new Error('Loaded backend does not identify its production checkout.');
  const destination = fs.realpathSync(root);
  const sourceRoot = fs.realpathSync(production.root);
  const main = readMainInstance(root, { context, storageModule: storageModule ?? context.storageModule });
  let source;
  if (!bundled && sourceRoot !== destination) {
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
  return { installationId: main.installation_id, home: HOME, root: destination, bundleOwner, ...(source ? { source } : {}), domain: DOMAIN,
    backendLabel: BACKEND_LABEL, gatewayLabel: GATEWAY_LABEL, publicOrigin: main.public_origin,
    daemonLog: bundled ? path.join(context.accountHome, '.cache/mandible/production-stderr.log') : backend.definition.StandardErrorPath,
    serviceConfiguration: readServiceConfiguration(context, job.environment, sourceRoot),
    oldProcess: { pid: job.pid, startedAt }, priorBackend: { ...backend, runnerSha256: bundled ? null : createHash('sha256').update(fs.readFileSync(backend.argv[1])).digest('hex'), launchMode: bundled ? readBundleLaunch(context).launchMode : launchModeFromAgent(backend.definition) }, priorGateway: gateway };
}

function assertHandoffInstallation(binding, context = defaultInstallation()) {
  const HOME = context.home, DOMAIN = context.domain, BACKEND_LABEL = context.backendLabel, GATEWAY_LABEL = context.gatewayLabel;
  const INSTALLATION_AUTHORITY = path.join(HOME, "config/client-auth/authority-id");
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

function bundleContext(binding) { return serviceInstallationContext({ ...defaultInstallation(), bundleRoot: binding.nativeApp }); }

function assertHandoffContext(binding, context, assertHeld) {
  if (!context || typeof assertHeld !== 'function') throw new Error('Accepted runtime operations require explicit installation context and live ownership.');
  assertHeld();
  if (binding.home !== context.home || binding.domain !== context.domain || binding.backendLabel !== context.backendLabel
      || binding.gatewayLabel !== context.gatewayLabel || binding.nativeApp !== context.bundleRoot
      || fs.readFileSync(path.join(context.home, 'config/client-auth/authority-id'), 'utf8').trim() !== binding.installationId) {
    throw new Error('Runtime handoff belongs to another installation.');
  }
}
function assertHandoffMutation(binding, { context, journal, assertHeld }) {
  assertHandoffContext(binding, context, assertHeld);
  const file = path.join(context.runtimeDir, 'handoff', `${binding.requestId}-${binding.executionId}`, 'journal.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const active = JSON.parse(fs.readFileSync(path.join(context.runtimeDir, 'handoff-active.json'), 'utf8'));
  if (!journal || JSON.stringify(journal.binding) !== JSON.stringify(binding) || current.bindingDigest !== journal.bindingDigest
      || active.journal !== file || active.bindingDigest !== journal.bindingDigest || current.attempt?.id !== journal.attempt?.id
      || current.attempt?.fence || current.attempt?.state !== 'running') throw new Error('Runtime mutation requires the exact active unfenced attempt.');
}

export async function removeHandoffDefinitions(binding, { context = defaultInstallation(), journal, assertHeld, until = Date.now() + BUNDLE_SERVICE_START_TIMEOUT_MS } = {}) {
  const HOME = context.home, RUNTIME_DIR = context.runtimeDir;
  const INSTALLATION_AUTHORITY = path.join(HOME, "config/client-auth/authority-id");
  const BACKEND_LABEL = context.backendLabel, GATEWAY_LABEL = context.gatewayLabel;
  if (binding.acceptedRelease) assertHandoffMutation(binding, { context, journal, assertHeld });
  if (binding.home !== HOME || binding.installationId !== fs.readFileSync(INSTALLATION_AUTHORITY, 'utf8').trim()) throw new Error('Runtime handoff belongs to another installation.');
  if (!binding.acceptedRelease) assertLifecycleMutation(true);
  const inspectionContext = binding.bundleOwner ? { ...context, bundleRoot: binding.bundleOwner.bundleRoot } : context;
  const inspection = inspectServiceDefinitionsSync(inspectionContext, { until });
  if (!inspection.ok) throw new Error(inspection.refusal.message);
  for (const observation of inspection.observations) {
    const prior = observation.service === 'backend' ? binding.priorBackend : binding.priorGateway;
    if (observation.job.loaded && (JSON.stringify(observation.job.argv) !== JSON.stringify(prior.argv)
      || prior.definition && !loadedServiceMatches(prior.definition, observation.job))) throw new Error(`Service ${observation.label} changed during handoff; preserving it.`);
  }
  if (binding.serviceConfiguration) {
    const captured = binding.serviceConfiguration;
    if (captured.file !== path.join(RUNTIME_DIR, 'service-config.json')) throw new Error('Captured service configuration belongs to another installation.');
    const current = readServiceConfiguration(context);
    if (!captured.migrated && current.migrated || !current.migrated && JSON.stringify(current.configuration) !== JSON.stringify(captured.configuration)) throw new Error('Service configuration changed after capture; preserving it.');
    publishServiceConfiguration(captured.file, captured.configuration);
  }
  if (binding.acceptedRelease && binding.bundleOwner) {
    if (JSON.stringify(readBundleOwner(inspectionContext)) !== JSON.stringify(binding.bundleOwner)) throw new Error('Bundle owner changed before drain.');
    const processes = Object.fromEntries(inspection.observations.map(item => [item.service, item.job.pid && {
      pid: item.job.pid, startedAt: item.job.startedAt, runs: item.job.runs,
    }]));
    assertHeld();
    nativeServiceControls(inspectionContext, 'unregister', ['backend', 'gateway'], { until });
    assertHeld();
    for (;;) {
      assertHeld();
      const live = Object.values(processes).filter(Boolean).filter(item => processStart(item.pid, until) === item.startedAt);
      if (!live.length) {
        let registered = false;
        for (const role of ['backend', 'gateway']) {
          const result = spawnSync('/bin/launchctl', ['print', `${inspectionContext.domain}/${inspectionContext[`${role}Label`]}`],
            { encoding: 'utf8', timeout: runtimeObservationTimeout(until, 2500) });
          if (result.error || result.status !== 0 && !/Could not find service|service not found/i.test(result.stderr)) throw new Error('Cannot confirm native unregister.');
          if (result.status !== 0) continue;
          const job = parseLoadedService(result.stdout);
          if (job.bundleProgram !== 'Contents/MacOS/mandible-service' || job.parentBundleIdentifier !== inspectionContext.bundleIdentifier
              || JSON.stringify(job.argv) !== JSON.stringify(['mandible-service', 'foreground', role])) throw new Error('Service ownership changed while unregistering.');
          if (/\bpid = \d+/.test(result.stdout)) throw new RuntimeObservationError('process_changed', 'A new process appeared after native unregister.', job);
          registered = true;
        }
        if (!registered) break;
      }
      if (Date.now() >= until) throw new RuntimeObservationError('drain_pending', 'Native service unregister has not drained its qualified processes.', { processes }, 'pending');
      await new Promise(resolve => setTimeout(resolve, Math.min(25, until - Date.now())));
    }
    const current = inspectServiceDefinitionsSync(inspectionContext, { until });
    if (!current.ok) throw new RuntimeObservationError(current.refusal.category, current.refusal.message, current);
    if (current.observations.some(item => item.job.loaded && item.job.pid)) throw new RuntimeObservationError('process_changed', 'A new process appeared after native unregister.', current);
    await drainCapturedGatewayChildren(binding.priorGateway.children, until);
    assertHeld();
    return { removed: true, processes };
  }
  assertHandoffInstallation(binding, context);
  for (const [label, prior] of [[BACKEND_LABEL, binding.priorBackend], [GATEWAY_LABEL, binding.priorGateway]]) {
    // A stable Caddy gateway can remain live. A legacy JS gateway must be
    // unloaded before its source/dependencies change under the old interpreter.
    if (!binding.acceptedRelease && label === GATEWAY_LABEL && !prior.argv.some(arg => /\.m?js$/.test(arg))) continue;
    const current = inspectJob(label);
    if (!current.loaded) continue;
    // Retained journals predating definition capture retain their argv guard.
    // New journals must still own the complete loaded definition after drain.
    if (JSON.stringify(current.argv) !== JSON.stringify(prior.argv) || prior.definition && !loadedServiceMatches(prior.definition, current)) throw new Error(`Service ${label} changed during handoff; preserving it.`);
    if (label === BACKEND_LABEL && current.pid && !prior.definition?.BundleProgram) {
      const file = path.join(RUNTIME_DIR, 'handoff', `${binding.requestId}-${binding.executionId}`, 'bridge-process.json');
      const bridge = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      if (bridge?.pid !== current.pid || bridge.startedAt !== processStart(current.pid)) throw new Error('An old application process respawned before the bridge; preserve its work and drain it before continuing.');
    }
    await unloadExactHandoffService(label, prior.argv, prior.definition);
  }
  if (binding.acceptedRelease) {
    for (const observation of inspection.observations) for (const item of observation.installed) {
      if (item.record.BundleProgram) continue;
      if (createHash('sha256').update(fs.readFileSync(item.file)).digest('hex') !== item.sha256) throw new Error('Legacy definition changed before removal.');
      fs.unlinkSync(item.file);
    }
  }
}

export function readBundleProcess(context, role, { until } = {}) {
  const inspection = inspectServiceDefinitionsSync(context, { until, services: [role] });
  if (!inspection.ok) {
    if (inspection.refusal.category === 'starting') return null;
    throw new RuntimeObservationError(inspection.refusal.category, inspection.refusal.message, inspection);
  }
  const job = inspection.observations[0].job;
  return job.loaded && job.pid ? { pid: job.pid, startedAt: job.startedAt ?? processStart(job.pid, until), runs: job.runs } : null;
}

export async function startHandoffDefinitions(binding, { context, journal, assertHeld, prepared,
  until = Date.now() + BUNDLE_SERVICE_START_TIMEOUT_MS, processes = {},
  initialize = initializeMainRegistration, configure = configureLocalFrontDoor } = {}) {
  if (binding.acceptedRelease) {
    assertHandoffMutation(binding, { context, journal, assertHeld });
    const application = acceptedInstall.preparedApplicationContext(prepared, binding);
    if (!application.installed) throw new Error('Service start requires the installed prepared application.');
    if (processStart(binding.oldProcess.pid, until) === binding.oldProcess.startedAt) throw new Error('The old production process has not finished draining.');
    const ownership = inspectServiceDefinitionsSync(context, { until });
    if (!ownership.ok && ownership.refusal.category !== 'starting') throw new RuntimeObservationError(ownership.refusal.category, ownership.refusal.message, ownership);
    Object.assign(processes, inspectHandoffProcesses(binding, { context, prepared, assertHeld, until, processes }).processes);
    await initialize(application.resources, { context, assertHeld });
    assertHeld();
    fs.writeFileSync(path.join(context.runtimeDir, 'bundle-launch.json'), JSON.stringify({ enabled: true, gatewayEnabled: true,
      launchMode: binding.priorBackend.launchMode, session: bundleLoginSession() }), { mode: 0o600 });
    await configure(context, { binary: path.resolve(application.resources, application.release.native.caddy), assertHeld });
    assertHandoffMutation(binding, { context, journal, assertHeld });
    Object.assign(processes, inspectHandoffProcesses(binding, { context, prepared, assertHeld, until, processes }).processes);
    const statuses = nativeServiceControls(context, 'register', ['backend', 'gateway'], { until, release: application.release });
    if (Object.values(statuses).some(status => status.status === 'requires_approval')) throw new RuntimeObservationError('background_permission_required',
      'Allow Mandible background services in System Settings.', statuses, 'pending');
    const progress = Object.fromEntries(Object.entries(statuses).map(([role, status]) => [role, { previousStatus: status.status, registered: true }]));
    for (;;) {
      assertHeld();
      const observed = inspectHandoffProcesses(binding, { context, prepared, assertHeld, until, processes });
      Object.assign(processes, observed.processes);
      if (!observed.pending) break;
      if (Date.now() >= until) throw new RuntimeObservationError('starting', observed.pending, { processes }, 'pending');
      const unqualified = ['backend', 'gateway'].filter(role => !processes[role]);
      const native = nativeServiceControls(context, 'status', unqualified, { until, release: application.release });
      if (Object.values(native).some(status => status.status === 'requires_approval')) throw new RuntimeObservationError('background_permission_required',
        'Allow Mandible background services in System Settings.', { native, processes }, 'pending');
      const current = inspectHandoffProcesses(binding, { context, prepared, assertHeld, until, processes });
      Object.assign(processes, current.processes);
      if (Date.now() >= until) throw new RuntimeObservationError('starting', current.pending, { processes }, 'pending');
      if (!current.pending) break;
      const register = [];
      for (const role of unqualified.filter(role => !processes[role])) {
        const action = bundleServiceStartAction(progress[role], native[role].status, current.jobs[role]);
        if (action === 'register') register.push(role);
        if (action === 'start') {
          assertHandoffMutation(binding, { context, journal, assertHeld });
          const started = startOwnedJob(context, role, until);
          if (!started.ok) throw new RuntimeObservationError('service_start_failed', `Could not start owned ${role} service: ${started.error}`, { processes });
        }
      }
      if (register.length) {
        assertHandoffMutation(binding, { context, journal, assertHeld });
        const registered = nativeServiceControls(context, 'register', register, { until, release: application.release });
        if (Object.values(registered).some(status => status.status === 'requires_approval')) throw new RuntimeObservationError('background_permission_required',
          'Allow Mandible background services in System Settings.', { registered, processes }, 'pending');
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(25, until - Date.now())));
    }
    return { started: [context.backendLabel, context.gatewayLabel], packageSha256: application.digest, processes };
  }
  assertHandoffInstallation(binding);

  if (readBuildRevision(binding.root) !== binding.mergeCommit) throw new Error('Runtime handoff build differs from its applied merge.');
  if (await gatewayAdminNeedsRestart(HOME)) {
    const production = readProductionRecord();
    await prepareGateway(production);
    await reconcileServiceDefinitions(production, readMainInstance(production.root), binding.priorBackend.launchMode, {
      services: ['gateway'], running: ['gateway'], restart: ['gateway'], handoff: true,
    });
  }
  for (const label of [backendLabel(), gatewayLabel()]) {
    const observation = observeOwnedService(label === backendLabel() ? 'backend' : 'gateway');
    const installed = observation.installed.length === 1 ? observation.installed[0] : null;
    if (!installed) throw new Error(`Candidate service ${label} is missing.`);
    const job = inspectJob(label);
    if (job.loaded && !loadedServiceMatches(installed.record, job)) {
      if (JSON.stringify(job.argv) !== JSON.stringify(binding.priorGateway.argv) || label !== gatewayLabel() || binding.priorGateway.definition && !loadedServiceMatches(binding.priorGateway.definition, job)) throw new Error(`Unrecognized loaded service ${label}; preserving it.`);
      await unloadExactHandoffService(label, binding.priorGateway.argv, binding.priorGateway.definition);
    }
    ensureEnabledAndLoaded(label);
    if (!loadedServiceMatches(installed.record, inspectJob(label))) throw new Error(`Candidate service ${label} differs from its installed definition.`);
    const started = runLaunchctl(['kickstart', `${DOMAIN}/${label}`]);
    if (started.status !== 0) throw new Error(`Could not start candidate service ${label}: ${started.stderr.trim()}`);
  }
  // A freshly started daemon cannot be ready yet. Readiness is awaited by a
  // separate bounded verification, so a start never reports a false failure.
  return { started: [backendLabel(), gatewayLabel()] };
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
  return handoffFrontDoorObservation(inspection, mergeCommit).error ?? null;
}

export function handoffFrontDoorObservation(inspection, mergeCommit, { expectedServing = false } = {}) {
  if (inspection.nativeOwnershipPending) return { outcome: 'pending', code: 'starting', error: inspection.nativeOwnershipPending.message };
  if (inspection.main.backend_generation !== mergeCommit) return { outcome: 'failed', code: 'wrong_generation',
    error: `The registered generation ${inspection.main.backend_generation} is not the merge ${mergeCommit}.` };
  if (inspection.status.state === 'port_conflict') return { outcome: 'failed', code: 'access_path_failed', error: inspection.status.detail };
  for (const response of [inspection.backend, inspection.gateway]) {
    if (!response || response.ok) continue;
    if (response.code === 'probe_deadline' || response.code === 'not_ready') continue;
    if (!expectedServing && (response.code === 'connection_refused' || response.code === 'http_status' && [502, 503].includes(response.status))) continue;
    return { outcome: 'failed', code: response.code ?? 'access_path_failed', error: response.error };
  }
  if (!inspection.status.dashboard_ready) return { outcome: 'pending', code: 'starting',
    error: inspection.status.detail || `Runtime state is ${inspection.status.state}.` };
  return { outcome: 'confirmed' };
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
    const first = started?.[name];
    if (!job.loaded && first?.pid) return `The candidate ${name} service was unloaded.`;
    if (!job.pid) {
      if (first?.pid || exit) return `The candidate ${name} process exited${exit}.`;
      continue;
    }
    if (first?.pid && (job.pid !== first.pid || job.runs > first.runs
        || first.startedAt && inspection.qualifiedProcesses?.[name]?.startedAt && first.startedAt !== inspection.qualifiedProcesses[name].startedAt)) return `The candidate ${name} process ${first.pid} exited and launchd started ${job.pid}${exit}.`;
  }
  const backend = inspection.backendJob;
  if (!started?.backend?.pid && backend.lastExit && backend.lastExit !== NEVER_EXITED) return `The candidate backend process exited before readiness (last exit code ${backend.lastExit}).`;
  return null;
}

/**
 * Await readiness after a start: inspect until the front door answers ready at
 * the exact merge generation. The handoff deadline bounds only a daemon that is
 * alive but slow: an exited or replaced service process fails at once. Each
 * inspection waits for the daemon's answer; the short pause only paces
 * refused or not-ready answers.
 */
export async function awaitHandoffReadiness(mergeCommit, until, inspect, {
  pauseMs = RUNTIME_HEALTH_PROBE_INTERVAL_MS, now = Date.now,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  expectedProcesses = null, expectedServing = false,
} = {}) {
  let started = expectedProcesses ? structuredClone(expectedProcesses) : null;
  for (;;) {
    const inspection = await inspect(handoffProbeTimeout(until, now()));
    const exited = handoffServiceExit(started, inspection);
    if (exited) return { inspection, error: exited, exited: true, outcome: 'failed', code: 'process_changed' };
    started ??= {};
    for (const [name, identity] of Object.entries(inspection.qualifiedProcesses ?? {})) if (!started[name]) started[name] = identity;
    const outcome = handoffFrontDoorObservation(inspection, mergeCommit, { expectedServing });
    if (outcome.outcome !== 'pending' || now() >= until) return { inspection, ...outcome, error: outcome.error ?? null, exited: false };
    await wait(Math.min(pauseMs, Math.max(0, until - now())));
  }
}

/**
 * The daemon's own startup failure for this build: the last error-level line
 * logged after a runner start marker for the merge generation, from the tail
 * of its log. Only this handoff starts that generation in this installation.
 */
export function candidateStartupFailure(logText, mergeCommit) {
  const lines = logText.split('\n');
  const start = lines.findLastIndex(line => line.startsWith('[production-runner] starting ') && line.trimEnd().endsWith(` build ${mergeCommit}`));
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

/** Qualify both roles before returning pending, so one launcher cannot hide another replacement. */
export function inspectHandoffProcesses(binding, { context, prepared, assertHeld, until, processes = {} }) {
  assertHandoffContext(binding, context, assertHeld);
  const resources = path.join(context.bundleRoot, 'Contents/Resources');
  const application = prepared ? acceptedInstall.preparedApplicationContext(prepared, binding)
    : { resources, release: installedModuleReader.readInstalledRelease(resources) };
  const execution = nativeExecutionModel(context.bundleRoot, application.release);
  if (!execution.ok) throw new RuntimeObservationError('unreadable_state', execution.message);
  const jobs = Object.fromEntries(['backend', 'gateway'].map(role => {
    const result = spawnSync('/bin/launchctl', ['print', `${context.domain}/${context[`${role}Label`]}`],
      { encoding: 'utf8', timeout: runtimeObservationTimeout(until, 2500) });
    if (result.error || result.status !== 0 && !/Could not find service|service not found/i.test(result.stderr)) throw new RuntimeObservationError('service_observation_failed', result.error?.message || result.stderr);
    const job = result.status === 0 ? { loaded: true, ...parseLoadedService(result.stdout),
      pid: Number(result.stdout.match(/\bpid = (\d+)/)?.[1]) || null, runs: Number(result.stdout.match(/\bruns = (\d+)/)?.[1]) || 0 } : { loaded: false, pid: null };
    if (job.loaded && (job.bundleProgram !== 'Contents/MacOS/mandible-service' || job.parentBundleIdentifier !== context.bundleIdentifier
        || job.program && job.program !== path.join(context.bundleRoot, 'Contents/MacOS/mandible-service')
        || JSON.stringify(job.argv) !== JSON.stringify(['mandible-service', 'foreground', role]))) {
      throw new RuntimeObservationError('ownership_conflict', `Candidate ${role} registration differs from the owned native service.`, job);
    }
    return [role, job];
  }));
  const pids = Object.values(jobs).flatMap(job => job.pid ? [job.pid] : []);
  const actual = new Map();
  if (pids.length) {
    const result = spawnSync('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,lstart=,comm='],
      { encoding: 'utf8', timeout: runtimeObservationTimeout(until, 2500) });
    if (result.error || result.status !== 0 && result.stderr.trim()) throw new RuntimeObservationError('service_observation_failed', result.error?.message || result.stderr);
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const row = line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/);
      if (!row) throw new RuntimeObservationError('service_observation_failed', 'Cannot decode candidate process identity.');
      actual.set(Number(row[1]), { startedAt: row[2].trim(), executable: row[3].trim() });
    }
  }
  const qualified = {};
  let pending = null;
  const identities = Object.fromEntries(Object.entries(jobs).map(([role, job]) => {
    const process = actual.get(job.pid);
    return [role, job.pid && process ? { pid: job.pid, startedAt: process.startedAt, runs: job.runs } : null];
  }));
  for (const [role, expected] of Object.entries(processes)) {
    if (runtimeProcessChanged(expected, identities[role])) throw new RuntimeObservationError('process_changed', `Candidate ${role} process changed.`, { expected, current: identities[role] });
  }
  for (const [role, job] of Object.entries(jobs)) {
    const process = actual.get(job.pid);
    const identity = identities[role];
    const stage = identity ? classifyNativeExecution(execution, role, process.executable) : 'pending';
    if (stage === 'pending') {
      if (processes[role]) throw new RuntimeObservationError('process_changed', `Qualified ${role} process is no longer serving.`, { expected: processes[role], current: identity });
      pending = `Candidate ${role} process is not qualified yet.`;
      continue;
    }
    const executable = execution.roles[role].terminal;
    if (stage === 'foreign') throw new RuntimeObservationError('ownership_conflict', `Candidate ${role} process belongs to another executable.`, { expected: executable, actual: process.executable });
    qualified[role] = identity;
  }
  assertHeld();
  return { processes: qualified, jobs, pending };
}

function acceptedHandoffEvidence(binding, expectedProcesses, options) {
  const { context, assertHeld, until } = options;
  const observed = inspectHandoffProcesses(binding, { ...options, processes: expectedProcesses ?? {} });
  if (observed.pending) throw new RuntimeObservationError('starting', observed.pending, { processes: observed.processes }, 'pending');
  const inspection = matchingServiceDefinitions(inspectServiceDefinitionsSync(context, { until }));
  if (!inspection.ok) throw new RuntimeObservationError(inspection.refusal.category === 'starting' ? 'process_changed' : inspection.refusal.category,
    inspection.refusal.message, inspection);
  for (const observation of inspection.observations) {
    const current = { pid: observation.job.pid, startedAt: observation.job.startedAt, runs: observation.job.runs };
    if (runtimeProcessChanged(observed.processes[observation.service], current)) throw new RuntimeObservationError('process_changed', 'Candidate process changed during qualification.', { current });
  }
  const logPath = binding.daemonLog;
  const writer = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(observed.processes.backend.pid), '-d', '2', '-Fn'],
    { encoding: 'utf8', timeout: runtimeObservationTimeout(until, 2500) });
  if (writer.error || writer.status !== 0 || !writer.stdout.split('\n').includes(`n${logPath}`)) throw new RuntimeObservationError('log_identity_changed', 'Current daemon stderr writer differs from its captured log.');
  const log = fs.statSync(logPath);
  assertHeld();
  return { outcome: 'confirmed', backend: handoffService(context.backendLabel, inspection), gateway: handoffService(context.gatewayLabel, inspection),
    processes: observed.processes, process: { ...observed.processes.backend }, daemonLog: { path: logPath, dev: log.dev, ino: log.ino, size: log.size } };
}

/** User-serving readiness only; no launchd, process, TCP, package or direct-backend inspection. */
export async function probeHandoffRuntime(binding, { context, prepared, assertHeld, until, startupEpoch, generation, processes = {}, expectedServing = false,
  probe = probeJson } = {}) {
  assertHandoffContext(binding, context, assertHeld);
  if (prepared) generation = acceptedInstall.preparedApplicationContext(prepared, binding).release.provenance.commit;
  if (!/^[a-f0-9]{40}$/.test(generation ?? '')) throw new Error('Runtime readiness requires an exact generation target.');
  const main = readMainInstance(context.root ?? path.join(context.bundleRoot, 'Contents/Resources'), { context });
  if (main.backend_generation !== generation) throw new RuntimeObservationError('wrong_generation', 'Registered production generation differs from the prepared application.');
  const paths = localCaPaths(context.home);
  const response = await probe(healthEndpointUrl(main.public_origin), { ca: fs.readFileSync(paths.rootCert), timeoutMs: handoffProbeTimeout(until) });
  assertHeld();
  if (!response.ok) {
    const pending = response.code === 'probe_deadline' || !expectedServing && (response.code === 'connection_refused' || response.code === 'http_status' && [502, 503].includes(response.status));
    throw new RuntimeObservationError(response.code, response.error, { processes }, pending ? 'pending' : 'failed');
  }
  const health = response.document;
  const expected = { installationId: binding.installationId, publicOrigin: binding.publicOrigin, generation };
  const verdict = healthDocumentObservation(health, expected);
  const database = binding.serviceConfiguration?.configuration.environment.MANDIBLE_DB ?? path.join(context.home, 'mandible.db');
  if (health.instance?.db_path !== database) throw new RuntimeObservationError('wrong_database', 'Serving runtime uses another database.');
  if (typeof health.startup_epoch !== 'string' || !health.startup_epoch || startupEpoch && health.startup_epoch !== startupEpoch) {
    throw new RuntimeObservationError('process_changed', 'Serving runtime startup epoch changed.', { expected: startupEpoch, current: health.startup_epoch });
  }
  if (!verdict.ok) throw new RuntimeObservationError(verdict.code, verdict.error, { processes, health }, verdict.code === 'not_ready' ? 'pending' : 'failed');
  return { outcome: 'confirmed', health, frontDoorHealth: health, processes,
    process: { ...processes.backend, startupEpoch: health.startup_epoch } };
}

async function verifyAcceptedHandoff(binding, options) {
  const { until, awaitReady = false, assertHeld } = options;
  const initial = acceptedHandoffEvidence(binding, options.expectedProcesses, options);
  let startupEpoch = options.startupEpoch;
  for (;;) {
    assertHeld();
    let health;
    try { health = await probeHandoffRuntime(binding, { ...options, processes: initial.processes, startupEpoch }); }
    catch (error) {
      startupEpoch ??= error.evidence?.health?.startup_epoch;
      if (!(error instanceof RuntimeObservationError) || error.outcome !== 'pending' || !awaitReady || Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(RUNTIME_HEALTH_PROBE_INTERVAL_MS, until - Date.now())));
      continue;
    }
    const final = acceptedHandoffEvidence(binding, initial.processes, options);
    return { ...final, ...health };
  }
}

export function inspectHandoffEvidence(binding, expectedProcesses = null, options = {}) {
  if (binding.acceptedRelease) return acceptedHandoffEvidence(binding, expectedProcesses, options);
  if (binding.home !== HOME || binding.installationId !== fs.readFileSync(INSTALLATION_AUTHORITY, 'utf8').trim()) throw new Error('Candidate installation identity differs.');
  const context = defaultInstallation();
  for (const [role, expected] of Object.entries(expectedProcesses ?? {})) {
    if (!expected?.pid) continue;
    const bound = matchingServiceDefinitions(inspectServiceDefinitionsSync(context, { services: [role] }));
    if (!bound.ok) continue;
    const job = bound.observations[0].job;
    const identity = job.pid ? { pid: job.pid, startedAt: job.startedAt ?? processStart(job.pid), runs: job.runs } : null;
    if (runtimeProcessChanged(expected, identity)) throw new RuntimeObservationError('process_changed', `Candidate ${role} process exited or was unloaded.`, { job, expected });
  }
  const serviceInspection = matchingServiceDefinitions(inspectServiceDefinitionsSync(context));
  if (!serviceInspection.ok) {
    if (serviceInspection.refusal.category === 'starting') throw new RuntimeObservationError('starting', serviceInspection.refusal.message, serviceInspection, 'pending');
    throw new Error(serviceInspection.refusal.message);
  }
  const backendJob = serviceInspection.observations.find(item => item.service === 'backend').job;
  const gatewayJob = serviceInspection.observations.find(item => item.service === 'gateway').job;
  const processes = {};
  let waiting = null;
  for (const [name, job] of [['backend', backendJob], ['gateway', gatewayJob]]) {
    const expected = expectedProcesses?.[name];
    const identity = job.pid ? { pid: job.pid, startedAt: job.startedAt ?? processStart(job.pid), runs: job.runs } : null;
    if (runtimeProcessChanged(expected, identity)) {
      throw new RuntimeObservationError('process_changed', `Candidate ${name} process exited or was unloaded.`, { job, expected });
    }
    if (!job.pid) { waiting = `Candidate ${name} launch is not yet confirmed.`; continue; }
    if (!identity.startedAt) {
      if (expected?.pid) throw new RuntimeObservationError('process_changed', `Candidate ${name} process exited.`, { job, expected });
      waiting = `Candidate ${name} launch is not yet confirmed.`;
      continue;
    }
    processes[name] = identity;
  }
  // Check every bound role before an unqualified launcher can return pending.
  // These raw observations become authoritative only after strict ownership.
  const backend = handoffService(backendLabel(), serviceInspection);
  const gateway = handoffService(gatewayLabel(), serviceInspection);
  if (backend.argv[0] !== binding.runtime.path) throw new Error('Candidate services differ from the pinned runtime.');
  const installed = locateLaunchAgent(backendLabel());
  const logPath = installed?.record.StandardErrorPath;
  if (!path.isAbsolute(logPath || '')) throw new Error('Loaded service log provenance is unavailable.');
  const startup = fs.existsSync(logPath) ? candidateStartupFailure(readLogTail(logPath), binding.mergeCommit) : null;
  if (startup) throw new RuntimeObservationError('startup_failed', `Candidate runtime failed to start: ${startup}`);
  const job = backendJob;
  const startedAt = processes.backend?.startedAt;
  if (!startedAt) throw new RuntimeObservationError('starting', waiting, { processes }, 'pending');
  if (!fs.existsSync(logPath)) throw new RuntimeObservationError('starting', 'Candidate log is not available yet.', { processes }, 'pending');
  const writer = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(job.pid), '-d', '2', '-Fn'], { encoding: 'utf8', timeout: 2500 });
  if (writer.error || writer.status !== 0 || !writer.stdout.split('\n').includes(`n${logPath}`)) throw new Error('Current daemon stderr writer differs from the loaded service log.');
  const log = fs.statSync(logPath);
  const evidence = { outcome: 'confirmed', backend, gateway, processes, process: { pid: job.pid, startedAt },
    daemonLog: { path: logPath, dev: log.dev, ino: log.ino, size: log.size } };
  if (waiting) throw new RuntimeObservationError('starting', waiting, evidence, 'pending');
  return evidence;
}

export async function verifyHandoffDefinitions(binding, { context, prepared, assertHeld, startupEpoch, probe, until = Date.now(), awaitReady = false, expectedProcesses = null, expectedServing = false,
  inspect: inspectStatus = probeTimeoutMs => inspectRuntime({ launchMode: binding.priorBackend.launchMode, probeTimeoutMs }),
} = {}) {
  if (binding.acceptedRelease) return verifyAcceptedHandoff(binding, { context, prepared, assertHeld, startupEpoch, probe, until, awaitReady, expectedProcesses, expectedServing });
  let qualified = { ...expectedProcesses };
  const observeOwnership = () => {
    try {
      const evidence = inspectHandoffEvidence(binding, qualified);
      Object.assign(qualified, evidence.processes);
      return null;
    } catch (error) {
      if (!(error instanceof RuntimeObservationError) || error.outcome !== 'pending') throw error;
      Object.assign(qualified, error.evidence?.processes);
      return error;
    }
  };
  const firstPending = observeOwnership();
  if (firstPending && !awaitReady) throw firstPending;
  const inspect = async probeTimeoutMs => {
    const pending = observeOwnership();
    const inspection = await inspectStatus(probeTimeoutMs);
    return { ...inspection, qualifiedProcesses: { ...qualified }, nativeOwnershipPending: pending };
  };
  const { inspection: status, error, exited, outcome, code } = awaitReady
    ? await awaitHandoffReadiness(binding.mergeCommit, until, inspect, { expectedProcesses: qualified, expectedServing })
    : await inspect(handoffProbeTimeout(until)).then(inspection => ({ inspection,
      ...handoffFrontDoorObservation(inspection, binding.mergeCommit, { expectedServing }), exited: false }));
  if (exited) {
    const logPath = locateLaunchAgent(backendLabel())?.record.StandardErrorPath;
    let startup = null;
    try { startup = logPath ? candidateStartupFailure(readLogTail(logPath), binding.mergeCommit) : null; } catch { /* the exit itself is the reported failure */ }
    throw new RuntimeObservationError('startup_failed', `Candidate runtime failed to start: ${error}${startup ? ` Daemon reported: ${startup}` : ''}`);
  }
  if (error) throw new RuntimeObservationError(code, `Candidate production front door is not ready at the exact merge generation: ${error}`, { inspection: status, processes: qualified }, outcome);
  const evidence = inspectHandoffEvidence(binding, qualified);
  return { ...evidence, health: status.backend.document, frontDoorHealth: status.gateway.document,
    process: { ...evidence.process, startupEpoch: status.backend.document.startup_epoch } };
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

export async function inspectRuntime({ launchMode = "on_demand", probeTimeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const production = readProductionRecord();
  const main = readMainInstance(production.root);
  const expected = { installationId: main.installation_id, publicOrigin: PRODUCTION_ORIGIN, generation: main.backend_generation };
  const backendJob = inspectJob(backendLabel());
  const gatewayJob = inspectJob(gatewayLabel());
  const [backendResponse, trusted, gatewayPortOpen, backendPortOpen] = await Promise.all([
    probeJson(healthEndpointUrl(main.backend_origin), { timeoutMs: probeTimeoutMs }),
    Promise.resolve().then(() => readTrustedRoot()).catch((error) => ({ ca: null, error: error.message })),
    portOpen(main.publicUrl),
    portOpen(main.backendUrl),
  ]);
  const backend = backendResponse.ok ? healthDocumentObservation(backendResponse.document, expected) : backendResponse;
  let gateway = { ok: false, code: 'tls_error', error: trusted.error };
  if (!trusted.error) {
    const gatewayResponse = await probeJson(healthEndpointUrl(PRODUCTION_ORIGIN), { ca: trusted.ca, timeoutMs: probeTimeoutMs });
    gateway = gatewayResponse.ok ? healthDocumentObservation(gatewayResponse.document, expected) : gatewayResponse;
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
  if (fs.existsSync(path.join(root, 'release.json'))) {
    const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
    return path.resolve(root, release.native.bun);
  }
  if (installedResources) return process.env.MANDIBLE_RUNTIME;
  return installationRuntime(root, defaultInstallation());
}

function standardPlistPath(label) {
  return path.join(serviceDirectory(), `${label}.plist`);
}

function privatePlistPath(label) {
  return path.join(privateServiceDirectory(), `${label}.plist`);
}

function locateLaunchAgent(label) {
  const service = label === backendLabel() ? 'backend' : 'gateway';
  const files = [standardPlistPath(label), privatePlistPath(label)].filter(file => fs.existsSync(file));
  if (files.length === 1) {
    const record = parsePlist(files[0]);
    if (!ownsServiceDefinition(defaultInstallation(), service, record)) throw new Error(`Unowned installed service ${label}; preserving it.`);
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
  assertLifecycleLockHeld();
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
  assertLifecycleLockHeld();
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
  assertLifecycleLockHeld();
  const service = label === backendLabel() ? 'backend' : 'gateway';
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
  assertLifecycleLockHeld();
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
  const installed = locateLaunchAgent(backendLabel());
  return installed ? launchModeFromAgent(installed.record) : "on_demand";
}

/** The running job's environment is authoritative for migration; the plist on disk only when unloaded. */
function legacyBackendEnvironment() {
  const job = inspectJob(backendLabel());
  return job.loaded ? job.environment : locateLaunchAgent(backendLabel())?.record.EnvironmentVariables ?? {};
}

export function prepareServicePlists(production, main, launchMode, { context = defaultInstallation(), configuration } = {}) {
  const runtime = installationRuntime(production.root, context);
  const config = configuration ? { file: path.join(context.runtimeDir, 'service-config.json'), migrated: false, configuration: validateServiceConfiguration(configuration) }
    : readServiceConfiguration(context, context === defaultInstallation() ? legacyBackendEnvironment() : {}, production.root);
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
  const inspection = inspectServiceDefinitionsSync(defaultInstallation());
  if (!inspection.ok) throw new Error(inspection.refusal.message);
  return inspection.observations.find(observation => observation.service === service);
}

export async function reconcileServiceDefinitions(production, main, launchMode, { services = ['backend', 'gateway'], running = [], restart = [], handoff = false, configuration, loadService = ensureEnabledAndLoaded } = {}) {
  assertLifecycleMutation(handoff);
  const desired = prepareServicePlists(production, main, launchMode, { configuration });
  const runnersChanged = services.includes('backend') && runnerChanged(production.root);
  // Observe and validate both services before the first write or bootout.
  const inspection = inspectServiceDefinitionsSync(defaultInstallation(), { desired: Object.fromEntries(desired.definitions.map(item => [item.service, item.record])) });
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
    writeServicePlist(definition.label, definition.file, definition.contents, { recognizesLegacy: record => ownsServiceDefinition(defaultInstallation(), definition.service, record) });
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

async function configureGateway(root) {
  const adminRestartRequired = await gatewayAdminNeedsRestart(HOME);
  const script = path.join(root, "scripts", "local-front-door.mjs");
  const result = spawnSync(runtimeBinary(root), [script, "configure"], {
    cwd: root,
    env: { ...process.env, HOME: HOME_DIR, MANDIBLE_HOME: HOME, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8", timeout: 12_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not prepare the trusted dashboard gateway: ${(result.stderr || result.error?.message || "configuration failed").trim()}`);
  }
  return { adminRestartRequired };
}

function reloadCaddy(binary) {
  reloadGatewayConfiguration(binary, HOME, path.join(RUNTIME_DIR, 'Caddyfile'));
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
  return configureGateway(production.root);
}

async function startRuntime({ launchMode = installedLaunchMode() } = {}) {
  let current = await inspectRuntime({ launchMode });
  if (current.status.state === 'port_conflict') throw new Error(current.status.detail);
  const registration = await initializeMainRegistration(current.production.root);
  current = await inspectRuntime({ launchMode });
  if (current.backendPortOpen && !current.backendJob.loaded) throw new Error('The production backend is not owned by Mandible; preserving it.');
  const gateway = !current.trusted.error ? await prepareGateway(current.production) : null;
  await reconcileServiceDefinitions(current.production, current.main, launchMode, {
    running: current.trusted.error ? ['backend'] : ['backend', 'gateway'], restart: [
      ...(registration.legacyEffectsMigrated ? ['backend'] : []), ...(gateway?.adminRestartRequired ? ['gateway'] : []),
    ],
  });
  const ready = await waitForRuntime(OPERATION_TIMEOUT_MS, launchMode, candidate => !registration.legacyEffectsMigrated
    || sameEffectList(candidate.backend.document?.instance?.allowed_effects, candidate.main.effectCeiling));
  if (registration.legacyEffectsMigrated && !sameEffectList(ready.backend.document?.instance?.allowed_effects, ready.main.effectCeiling)) throw new Error('The active production effect ceiling differs from its registration.');
  assertInstalledDefinitions();
  return ready.status;
}

function assertInstalledDefinitions() {
  const inspection = matchingServiceDefinitions(inspectServiceDefinitionsSync(defaultInstallation()));
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
  observeOwnedService('backend', backendLabel());
  observeOwnedService('gateway', gatewayLabel());
  const owned = await inspectRuntime({ launchMode });
  const previews = registeredPreviewCount(current.production.root);
  if (owned.backendJob.loaded) await stopOwnedJob(backendLabel());
  if (previews === 0 && owned.gatewayJob.loaded) await stopOwnedJob(gatewayLabel());
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
  const gateway = !current.trusted.error ? await prepareGateway(current.production) : null;
  await reconcileServiceDefinitions(current.production, current.main, launchMode, {
    running: current.trusted.error ? ['backend'] : ['backend', 'gateway'], restart: ['backend', ...(gateway?.adminRestartRequired ? ['gateway'] : [])],
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
  assertLifecycleMutation();
  const gateway = await prepareGateway(initial.production);
  const reconciled = await reconcileServiceDefinitions(initial.production, initial.main, launchMode, { services: ['gateway'], running: ['gateway'],
    restart: gateway.adminRestartRequired ? ['gateway'] : [] });
  if (!gateway.adminRestartRequired && !reconciled.gatewayChanged && reconciled.wasGatewayLoaded) reloadCaddy(pinnedCaddyBinary(HOME));
  assertInstalledDefinitions();
  const inspected = await inspectRuntime({ launchMode });
  if (!inspected.gatewayPortOpen) throw new Error('Shared gateway listener is unavailable after reconciliation');
  return inspected.status;
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

export async function initializeMainRegistration(root, { context = defaultInstallation(), assertHeld } = {}) {
  const INSTALLATION_AUTHORITY = path.join(context.home, "config/client-auth/authority-id");
  const RUNTIME_DIR = context.runtimeDir;
  assertHeld?.();
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
  const release = fs.existsSync(path.join(root, 'release.json')) ? (await import('./installed-release.mjs')).readInstalledRelease(root) : null;
  const generation = release?.provenance.commit ?? readBuildRevision(root);
  assertHeld?.();

  const authority = new LocalSessionAuthority(RUNTIME_DIR, installationId, { initialize: true });
  let legacyEffectsMigrated = false;
  try {
    const instance = resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "main",
        MANDIBLE_INSTANCE_ID: "production",
        MANDIBLE_INSTALLATION_ID: installationId,
        MANDIBLE_PUBLIC_ORIGIN: PRODUCTION_ORIGIN,
        MANDIBLE_BACKEND_GENERATION: generation,
      },
    });
    legacyEffectsMigrated = reconcileMainRegistration(authority, instance, `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`);
    if (release) {
      const registered = authority.instance('production');
      if (registered.backend_generation !== generation) authority.registerInstance({ ...registered, backend_generation: generation });
    }
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

async function mainLocked() {
  const [command, ...args] = process.argv.slice(2);
  const journalPath = process.env.MANDIBLE_RUNTIME_HANDOFF_JOURNAL;
  const activePath = path.join(RUNTIME_DIR, 'handoff-active.json');
  const active = fs.existsSync(activePath) ? JSON.parse(fs.readFileSync(activePath, 'utf8')) : null;
  const journal = journalPath ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : null;
  const directHandoff = !!journal && active?.journal === journalPath && active?.bindingDigest === journal.bindingDigest && journal.binding.home === HOME;
  if (active && !directHandoff && command !== 'status') throw new Error('A production runtime handoff is pending; preserve its owned service definitions.');
  if (installedResources && !command?.startsWith('handoff-')) {
    const launchMode = args.find(arg => arg.startsWith('--launch-mode='))?.split('=')[1] ?? 'on_demand';
    if (!['manual', 'on_demand'].includes(launchMode)) throw new Error('Invalid launch mode.');
    const { bundleRuntimeCommand } = await import('./bundle-services.mjs');
    const status = await bundleRuntimeCommand(command, { context: defaultInstallation(), release: installedRelease(), launchMode,
      initialize: initializeMainRegistration, inspect: inspectRuntime, configureGateway,
      previewCount: registeredPreviewCount, reloadGateway: () => reloadCaddy(process.env.MANDIBLE_CADDY),
      readProcess: readBundleProcess,
      restartGateway: () => { observeOwnedService('gateway'); restartOwnedJob(gatewayLabel()); },
      waitReady: mode => waitForRuntime(OPERATION_TIMEOUT_MS, mode) });
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  if (command === 'handoff-snapshot') {
    const rootIndex = args.indexOf('--root');
    process.stdout.write(`${JSON.stringify(captureRuntimeHandoff(args[rootIndex + 1] ?? process.cwd()))}\n`);
    return;
  }
  if (['handoff-remove', 'handoff-install', 'handoff-start', 'handoff-verify', 'handoff-evidence'].includes(command)) {
    const acceptedProbe = ['handoff-verify', 'handoff-evidence'].includes(command) && (journal?.phase === 'acknowledged' || journal?.phase === 'complete' && journal.cleanupStartedAt) && journal.binding.home === HOME;
    if (!directHandoff && !acceptedProbe) throw new Error('Runtime handoff command requires its exact active journal.');
    if (journal.attempt?.fence && ['handoff-remove', 'handoff-install', 'handoff-start'].includes(command)) throw new Error('This runtime attempt is fenced.');
    const untilIndex = args.indexOf('--until');
    const until = untilIndex >= 0 ? Number(args[untilIndex + 1]) : Date.now();
    if (!Number.isFinite(until)) throw new Error('Runtime handoff verification requires a numeric --until deadline.');
    const recoveryQualified = journal.recoveryStart?.qualifiedAt && journal.recoveryStart.id === journal.launch?.id;
    const expectedProcesses = journal.attempt?.effects?.services?.processes ?? (journal.phase === 'failed' && !recoveryQualified ? null : journal.launch?.processes);
    const result = command === 'handoff-install' ? installAcceptedApplication(journal.binding, bundleContext(journal.binding))
      : command === 'handoff-remove' ? await removeHandoffDefinitions(journal.binding, { until })
      : command === 'handoff-start' ? await startHandoffDefinitions(journal.binding, { until, processes: { ...expectedProcesses } })
        : command === 'handoff-evidence' ? inspectHandoffEvidence(journal.binding, expectedProcesses)
          : await verifyHandoffDefinitions(journal.binding, { until, awaitReady: args.includes('--await-ready'),
            expectedProcesses,
            expectedServing: journal.attempt ? !!journal.attempt.effects.services?.readyAt || journal.attempt.state === 'complete'
              : !!journal.launch?.readyAt || ['failed', 'complete', 'acknowledged'].includes(journal.phase) });
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
    observeOwnedService('backend', backendLabel());
    observeOwnedService('gateway', gatewayLabel());
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
    if (directHandoff && inspectJob(backendLabel()).loaded) throw new Error('The old backend definition must be unloaded before candidate installation.');
    const rootArgIndex = args.indexOf("--root");
    const root = path.resolve(rootArgIndex >= 0 ? (args[rootArgIndex + 1] ?? "") : process.cwd());
    if (!fs.existsSync(path.join(root, "package.json")) || !fs.existsSync(path.join(root, "dist", "index.js"))) {
      throw new Error(`A built Mandible checkout is required to install local services: ${root}`);
    }
    runtimeBinary(root);
    if (!configuration) readServiceConfiguration(defaultInstallation(), legacyBackendEnvironment());
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

async function main() {
  if (installedModule) Object.assign(process.env, installedModule.installedRuntimeEnvironment(installedResources));
  const command = process.argv[2];
  if (['status', 'handoff-snapshot', 'handoff-verify', 'handoff-evidence'].includes(command)) return mainLocked();
  return withInstallationGatewayLock(HOME, async token => {
    const previous = process.env.MANDIBLE_GATEWAY_LOCK_TOKEN;
    process.env.MANDIBLE_GATEWAY_LOCK_TOKEN = token;
    try { return await mainLocked(); }
    finally { if (previous === undefined) delete process.env.MANDIBLE_GATEWAY_LOCK_TOKEN; else process.env.MANDIBLE_GATEWAY_LOCK_TOKEN = previous; }
  });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'local-runtime.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const failure = error instanceof RuntimeObservationError ? error : new RuntimeObservationError('controller_failed', error.message);
    process.stderr.write(`${process.argv[2]?.startsWith('handoff-') ? JSON.stringify(failure) : error.message}\n`);
    process.exitCode = 1;
  });
}
