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
import { readBuildRevision } from "./build-revision.mjs";

const DEFAULT_HOME = path.join(os.homedir(), ".mandible");
const configuredHome = process.env.MANDIBLE_HOME?.trim() || DEFAULT_HOME;
const expandedHome = configuredHome === "~" ? os.homedir()
  : configuredHome.startsWith("~/") ? path.join(os.homedir(), configuredHome.slice(2))
    : configuredHome;
const HOME = path.resolve(expandedHome);
const HOME_DIR = path.dirname(HOME);
const RUNTIME_DIR = path.join(HOME, "config", "local-sessions");
const AUTHORITY_DB = path.join(RUNTIME_DIR, "sessions.db");
const INSTALLATION_AUTHORITY = path.join(HOME, "config", "client-auth", "authority-id");
const SERVICE_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const PRIVATE_SERVICE_DIR = path.join(RUNTIME_DIR, "launch-agents");
const GATEWAY_CONFIG = path.join(RUNTIME_DIR, "Caddyfile");
const LOG_DIR = path.join(HOME_DIR, ".cache", "mandible");
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;
const IS_DEFAULT_INSTALL = HOME === DEFAULT_HOME;
const INSTALL_SUFFIX = IS_DEFAULT_INSTALL ? "" : `.${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const BACKEND_LABEL = `bio.mll.mandible.local-session-production${INSTALL_SUFFIX}`;
const GATEWAY_LABEL = `bio.mll.mandible.local-front-door${INSTALL_SUFFIX}`;
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
  const pid = loaded ? Number(result.stdout.match(/\bpid = (\d+)/)?.[1] ?? 0) || null : null;
  const argumentsText = result.stdout.match(/\n\s*arguments = \{\n([\s\S]*?)\n\s*\}/)?.[1];
  const argv = argumentsText?.split('\n').map(line => line.trim()).filter(Boolean) ?? [];
  return { loaded, pid, argv, detail: result.stderr.trim() };
}

function processStart(pid) {
  if (!pid) return null;
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1500 });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function handoffService(label) {
  const installed = locateLaunchAgent(label);
  if (!installed) throw new Error(`Owned service ${label} is missing.`);
  const job = inspectJob(label);
  const argv = installed.record.ProgramArguments;
  if (!Array.isArray(argv) || argv.length < 2 || (job.loaded && JSON.stringify(job.argv) !== JSON.stringify(argv))) {
    throw new Error(`Loaded arguments differ from the owned service definition for ${label}.`);
  }
  return { file: installed.file, sha256: createHash('sha256').update(fs.readFileSync(installed.file)).digest('hex'), argv, loaded: job.loaded };
}

export function captureRuntimeHandoff(root) {
  const production = readProductionRecord();
  if (production.root !== path.resolve(root)) throw new Error('Handoff checkout differs from the installed production checkout.');
  const main = readMainInstance(root);
  const backend = handoffService(BACKEND_LABEL);
  const gateway = handoffService(GATEWAY_LABEL);
  const job = inspectJob(BACKEND_LABEL);
  const startedAt = processStart(job.pid);
  if (!job.loaded || !job.pid || !startedAt) throw new Error('Handoff requires the exact running production LaunchAgent.');
  return { installationId: main.installation_id, home: HOME, root: production.root, domain: DOMAIN,
    backendLabel: BACKEND_LABEL, gatewayLabel: GATEWAY_LABEL, publicOrigin: main.public_origin,
    daemonLog: readRunnerMetadata(production).logFile,
    oldProcess: { pid: job.pid, startedAt }, priorBackend: { ...backend, runnerSha256: createHash('sha256').update(fs.readFileSync(backend.argv[1])).digest('hex'), launchMode: installedLaunchMode() }, priorGateway: gateway };
}

function assertHandoffInstallation(binding) {
  if (binding.home !== HOME || binding.domain !== DOMAIN || binding.backendLabel !== BACKEND_LABEL || binding.gatewayLabel !== GATEWAY_LABEL
    || fs.readFileSync(INSTALLATION_AUTHORITY, 'utf8').trim() !== binding.installationId) throw new Error('Runtime handoff belongs to another installation.');
  if (processStart(binding.oldProcess.pid) === binding.oldProcess.startedAt) throw new Error('The old production process has not finished draining.');
}

export function removeHandoffDefinitions(binding) {
  assertHandoffInstallation(binding);
  for (const [label, prior] of [[BACKEND_LABEL, binding.priorBackend], [GATEWAY_LABEL, binding.priorGateway]]) {
    // A stable Caddy gateway can remain live. A legacy JS gateway must be
    // unloaded before its source/dependencies change under the old interpreter.
    if (label === GATEWAY_LABEL && !prior.argv.some(arg => /\.m?js$/.test(arg))) continue;
    const current = inspectJob(label);
    if (!current.loaded) continue;
    if (JSON.stringify(current.argv) !== JSON.stringify(prior.argv)) throw new Error(`Service ${label} changed during handoff; preserving it.`);
    if (label === BACKEND_LABEL && current.pid) {
      const file = path.join(RUNTIME_DIR, 'handoff', `${binding.requestId}-${binding.executionId}`, 'bridge-process.json');
      const bridge = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      if (bridge?.pid !== current.pid || bridge.startedAt !== processStart(current.pid)) throw new Error('An old application process respawned before the bridge; preserve its work and drain it before continuing.');
    }
    const result = runLaunchctl(['bootout', `${DOMAIN}/${label}`]);
    if (result.status !== 0 || inspectJob(label).loaded) throw new Error(`Could not unload exact service ${label}: ${result.stderr.trim()}`);
  }
}

export async function startHandoffDefinitions(binding) {
  assertHandoffInstallation(binding);
  if (readBuildRevision(binding.root) !== binding.mergeCommit) throw new Error('Runtime handoff build differs from its applied merge.');
  for (const label of [BACKEND_LABEL, GATEWAY_LABEL]) {
    const installed = locateLaunchAgent(label);
    if (!installed) throw new Error(`Candidate service ${label} is missing.`);
    const job = inspectJob(label);
    const gatewayDefinitionChanged = label === GATEWAY_LABEL && createHash('sha256').update(fs.readFileSync(installed.file)).digest('hex') !== binding.priorGateway.sha256;
    if (job.loaded && (gatewayDefinitionChanged || JSON.stringify(job.argv) !== JSON.stringify(installed.record.ProgramArguments))) {
      if (JSON.stringify(job.argv) !== JSON.stringify(binding.priorGateway.argv) || label !== GATEWAY_LABEL) throw new Error(`Unrecognized loaded service ${label}; preserving it.`);
      const removed = runLaunchctl(['bootout', `${DOMAIN}/${label}`]);
      if (removed.status !== 0 || inspectJob(label).loaded) throw new Error(`Could not unload changed gateway ${label}.`);
    }
    ensureEnabledAndLoaded(label);
    const started = runLaunchctl(['kickstart', `${DOMAIN}/${label}`]);
    if (started.status !== 0) throw new Error(`Could not start candidate service ${label}: ${started.stderr.trim()}`);
  }
  return verifyHandoffDefinitions(binding);
}

export async function verifyHandoffDefinitions(binding) {
  if (binding.home !== HOME || binding.installationId !== fs.readFileSync(INSTALLATION_AUTHORITY, 'utf8').trim()) throw new Error('Candidate installation identity differs.');
  const backend = handoffService(BACKEND_LABEL);
  const gateway = handoffService(GATEWAY_LABEL);
  if (!backend.loaded || !gateway.loaded || backend.argv[0] !== binding.runtime.path) throw new Error('Candidate services are not loaded with the pinned runtime.');
  const status = await inspectRuntime({ launchMode: binding.priorBackend.launchMode });
  if (!status.status.dashboard_ready || status.main.backend_generation !== binding.mergeCommit) throw new Error('Candidate production front door is not ready at the exact merge generation.');
  return { backend, gateway, health: status.backend.document, frontDoorHealth: status.gateway.document };
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

async function inspectRuntime({ launchMode = "on_demand" } = {}) {
  const production = readProductionRecord();
  const main = readMainInstance(production.root);
  const expected = { installationId: main.installation_id, publicOrigin: PRODUCTION_ORIGIN, generation: main.backend_generation };
  const backendJob = inspectJob(BACKEND_LABEL);
  const gatewayJob = inspectJob(GATEWAY_LABEL);
  const [backendResponse, trusted, gatewayPortOpen, backendPortOpen] = await Promise.all([
    probeJson(healthEndpointUrl(main.backend_origin)),
    Promise.resolve().then(() => readTrustedRoot()).catch((error) => ({ ca: null, error: error.message })),
    portOpen(main.publicUrl),
    portOpen(main.backendUrl),
  ]);
  const backendError = backendResponse.ok ? healthDocumentError(backendResponse.document, expected) : backendResponse.error;
  const backend = backendError ? { ok: false, error: backendError } : { ok: true, document: backendResponse.document };
  let gateway = { ok: false, error: trusted.error };
  if (!trusted.error) {
    const gatewayResponse = await probeJson(healthEndpointUrl(PRODUCTION_ORIGIN), { ca: trusted.ca });
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

function runtimeBinary() {
  return process.execPath;
}

function standardPlistPath(label) {
  return path.join(SERVICE_DIR, `${label}.plist`);
}

function privatePlistPath(label) {
  return path.join(PRIVATE_SERVICE_DIR, `${label}.plist`);
}

function locateLaunchAgent(label) {
  const files = [standardPlistPath(label), privatePlistPath(label)].filter((file) => fs.existsSync(file));
  if (files.length > 1) throw new Error(`Multiple Mandible LaunchAgents use label ${label}; preserving both and refusing to guess.`);
  if (files.length === 0) return null;
  const file = files[0];
  const record = parsePlist(file);
  if (record.Label !== label) throw new Error(`LaunchAgent ${file} has an unexpected label; preserving it.`);
  return { file, record };
}

function targetPlistPath(label, launchMode) {
  // KeepAlive implies RunAtLoad, so manual jobs stay outside the login-scanned directory until Start.
  if (label === BACKEND_LABEL) {
    return launchMode === "manual" ? privatePlistPath(label) : standardPlistPath(label);
  }
  return fs.existsSync(GATEWAY_CONFIG) ? standardPlistPath(label) : privatePlistPath(label);
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
    assertOwnedLaunchAgent(file, existingRecord, existing.includes(managedMarker), label, recognizesLegacy);
    if (!existing.includes(managedMarker)) archiveLaunchAgent(file, label, fs.readFileSync(file));
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { flag: "w", mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return true;
}

function assertOwnedLaunchAgent(file, record, managed, label, recognizesLegacy) {
  if (record.Label !== label) {
    throw new Error(`LaunchAgent ${file} has an unexpected label; preserving it and reporting an ownership conflict.`);
  }
  if (!managed && !recognizesLegacy(record)) {
    throw new Error(`A launchd configuration already exists at ${file} and is not managed by Mandible; preserving it.`);
  }
}

function writeServicePlist(label, file, contents, { recognizesLegacy = () => false } = {}) {
  const existing = locateLaunchAgent(label);
  if (!existing || existing.file === file) {
    return writeOwnedPlist(file, contents, { label, recognizesLegacy });
  }

  const bytes = fs.readFileSync(existing.file);
  const managedMarker = bytes.toString("utf8").includes("<key>Comment</key><string>Mandible runtime agent mandible-launch-agent@1</string>");
  assertOwnedLaunchAgent(existing.file, existing.record, managedMarker, label, recognizesLegacy);
  archiveLaunchAgent(existing.file, label, bytes);
  writeOwnedPlist(file, contents, { label, recognizesLegacy });
  fs.unlinkSync(existing.file);
  return true;
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

const PRESERVED_BACKEND_ENVIRONMENT = new Set([
  "MANDIBLE_DB", "MANDIBLE_LAUNCH_MODE", "MANDIBLE_PID_FILE", "MANDIBLE_STDERR_LOG_PATH", "MANDIBLE_SQLITE_LIBRARY", "MANDIBLE_SQLITE_LIBRARY_ARCHIVE", "NODE_OPTIONS", "PATH",
]);

function existingBackendEnvironment() {
  const existing = locateLaunchAgent(BACKEND_LABEL);
  if (!existing) return {};
  const { record } = existing;
  const env = record.EnvironmentVariables ?? {};
  return Object.fromEntries(Object.entries(env).filter(([key]) => PRESERVED_BACKEND_ENVIRONMENT.has(key)));
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

function prepareServicePlists(production, main, launchMode) {
  const runtime = runtimeBinary();
  const pathValue = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
  const backendEnvironment = {
    ...existingBackendEnvironment(),
    ...Object.fromEntries(['MANDIBLE_SQLITE_LIBRARY', 'MANDIBLE_SQLITE_LIBRARY_ARCHIVE'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    HOME: os.homedir(),
    MANDIBLE_HOME: HOME,
    MANDIBLE_PRODUCTION_ROOT: production.root,
    MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR: RUNTIME_DIR,
    MANDIBLE_CLIENT_AUTH_DIR: path.join(HOME, "config", "client-auth"),
    MANDIBLE_CONTEXT_VERIFICATION_KEY: path.join(RUNTIME_DIR, "context-verification-key.pem"),
    MANDIBLE_LAUNCH_MODE: launchMode,
    MANDIBLE_PORT: String(Number(main.backendUrl.port) || DEFAULT_BACKEND_PORT),
    MANDIBLE_BASE: PRODUCTION_ORIGIN,
    PATH: pathValue,
    GIT_OPTIONAL_LOCKS: "0",
  };
  const gatewayEnvironment = { HOME: os.homedir(), MANDIBLE_HOME: HOME, PATH: pathValue, GIT_OPTIONAL_LOCKS: "0" };
  const backendFile = targetPlistPath(BACKEND_LABEL, launchMode);
  const gatewayFile = targetPlistPath(GATEWAY_LABEL, launchMode);
  const oldBackendRunner = path.join(RUNTIME_DIR, "production-runner.mjs");
  const oldGatewayRunner = path.join(production.root, "scripts", "local-front-door.mjs");
  const backendContents = renderLaunchAgent({
    label: BACKEND_LABEL,
    programArguments: [runtime, path.join(RUNTIME_DIR, "production-runner.mjs"), "run"],
    workingDirectory: RUNTIME_DIR,
    environment: backendEnvironment,
    stdoutPath: path.join(LOG_DIR, "production-stdout.log"),
    stderrPath: path.join(LOG_DIR, "production-stderr.log"),
  });
  const gatewayContents = renderLaunchAgent({
    label: GATEWAY_LABEL,
    programArguments: [pinnedCaddyBinary(HOME), "run", "--config", path.join(RUNTIME_DIR, "Caddyfile"), "--adapter", "caddyfile"],
    workingDirectory: RUNTIME_DIR,
    environment: gatewayEnvironment,
    stdoutPath: path.join(LOG_DIR, "local-front-door-stdout.log"),
    stderrPath: path.join(LOG_DIR, "local-front-door-stderr.log"),
  });
  return {
    backendChanged: writeServicePlist(BACKEND_LABEL, backendFile, backendContents, {
      recognizesLegacy: (record) => {
        const args = record.ProgramArguments ?? [];
        return args.length === 3 && path.resolve(args[1]) === oldBackendRunner && args[2] === "run";
      },
    }),
    gatewayChanged: writeServicePlist(GATEWAY_LABEL, gatewayFile, gatewayContents, {
      recognizesLegacy: (record) => {
        const args = record.ProgramArguments ?? [];
        return args.length === 3 && path.resolve(args[1]) === oldGatewayRunner
          && args[2] === "serve" && record.EnvironmentVariables?.MANDIBLE_RUNTIME_SUPERVISED === "1";
      },
    }),
  };
}

function ensureInstalled(production, main, launchMode) {
  const beforeBackend = inspectJob(BACKEND_LABEL);
  const beforeGateway = inspectJob(GATEWAY_LABEL);
  prepareRunner(production.root);
  const changed = prepareServicePlists(production, main, launchMode);
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  return { wasBackendLoaded: beforeBackend.loaded, wasGatewayLoaded: beforeGateway.loaded, ...changed };
}

function ensureEnabledAndLoaded(label) {
  const current = inspectJob(label);
  if (current.loaded) return false;
  const enabled = runLaunchctl(["enable", `${DOMAIN}/${label}`]);
  if (enabled.status !== 0) throw new Error(`Could not enable Mandible service ${label}: ${enabled.stderr.trim()}`);
  const installed = locateLaunchAgent(label);
  if (!installed) throw new Error(`Mandible service ${label} has no installed LaunchAgent.`);
  const loaded = runLaunchctl(["bootstrap", DOMAIN, installed.file]);
  if (loaded.status !== 0 && !inspectJob(label).loaded) {
    throw new Error(`Could not start Mandible service ${label}: ${(loaded.stderr || loaded.stdout).trim()}`);
  }
  return true;
}

function stopOwnedJob(label) {
  const disabled = runLaunchctl(["disable", `${DOMAIN}/${label}`]);
  if (disabled.status !== 0) throw new Error(`Could not disable Mandible service ${label}: ${disabled.stderr.trim()}`);
  if (inspectJob(label).loaded) {
    const result = runLaunchctl(["bootout", `${DOMAIN}/${label}`]);
    if (result.status !== 0 && inspectJob(label).loaded) {
      throw new Error(`Could not stop Mandible service ${label}: ${result.stderr.trim()}`);
    }
  }
  if (inspectJob(label).loaded) throw new Error(`Mandible service ${label} remained loaded after Stop.`);
}

function ensureGatewayBinary() {
  const binary = pinnedCaddyBinary(HOME);
  if (!fs.existsSync(binary)) installPinnedCaddy(HOME);
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) throw new Error(`The pinned HTTPS gateway is missing: ${binary}`);
}

function configureGateway(root) {
  const script = path.join(root, "scripts", "local-front-door.mjs");
  const result = spawnSync(runtimeBinary(), [script, "configure"], {
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

async function startRuntime({ launchMode = "on_demand" } = {}) {
  let current = await inspectRuntime({ launchMode });
  if (current.status.state === "port_conflict") return current.status;
  const registration = await initializeMainRegistration(current.production.root);
  current = await inspectRuntime({ launchMode });
  if (current.status.state === "port_conflict") return current.status;
  ensureInstalled(current.production, current.main, launchMode);
  if (registration.legacyEffectsMigrated) {
    if (!current.backendJob.loaded && current.backendPortOpen) {
      throw new Error("The production effect ceiling was updated, but the healthy backend is not owned by Mandible's LaunchAgent; restart it explicitly to apply the update.");
    }
    if (current.backendJob.loaded) restartOwnedJob(BACKEND_LABEL);
  }
  current = await inspectRuntime({ launchMode });
  if (current.status.state === "port_conflict") return current.status;
  if (!current.backend.ok) {
    if (current.backendPortOpen && !current.backendJob.loaded) return current.status;
    if (!current.backendJob.loaded) ensureEnabledAndLoaded(BACKEND_LABEL);
  }
  if (!current.gatewayJob.loaded && !current.gateway.ok && !current.trusted.error) {
    if (current.gatewayPortOpen) return current.status;
    prepareGateway(current.production);
    ensureInstalled(current.production, current.main, launchMode);
    ensureEnabledAndLoaded(GATEWAY_LABEL);
  }
  const ready = await waitForRuntime(OPERATION_TIMEOUT_MS, launchMode, (candidate) => !registration.legacyEffectsMigrated
    || sameEffectList(candidate.backend.document?.instance?.allowed_effects, candidate.main.effectCeiling));
  if (ready.status.state === "port_conflict") return ready.status;
  if (registration.legacyEffectsMigrated
    && !sameEffectList(ready.backend.document?.instance?.allowed_effects, ready.main.effectCeiling)) {
    throw new Error("The production service restarted, but its active effect ceiling does not match the registered production ceiling.");
  }
  return ready.status;
}

function registeredPreviewCount(root) {
  const Database = createRequire(path.join(root, "package.json"))("./dist/sqlite.js").default;
  const db = new Database(AUTHORITY_DB, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT COUNT(*) AS count FROM instance_registrations WHERE role = 'preview'").get().count; }
  finally { db.close(); }
}

async function stopRuntime({ launchMode = "on_demand" } = {}) {
  const current = await inspectRuntime({ launchMode });
  ensureInstalled(current.production, current.main, launchMode);
  const owned = await inspectRuntime({ launchMode });
  const previews = registeredPreviewCount(current.production.root);
  if (owned.backendJob.loaded) stopOwnedJob(BACKEND_LABEL);
  if (previews === 0 && owned.gatewayJob.loaded) stopOwnedJob(GATEWAY_LABEL);
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

async function restartRuntime({ launchMode = "on_demand" } = {}) {
  let current = await inspectRuntime({ launchMode });
  if (current.status.state === "port_conflict") return current.status;
  await initializeMainRegistration(current.production.root);
  current = await inspectRuntime({ launchMode });
  if (current.status.state === "port_conflict") return current.status;
  const beforeEpoch = current.backend.document?.startup_epoch;
  ensureInstalled(current.production, current.main, launchMode);
  current = await inspectRuntime({ launchMode });
  if (current.backendJob.loaded) restartOwnedJob(BACKEND_LABEL);
  else if (current.backend.ok) throw new Error("The production backend is healthy but is not owned by Mandible's launchd service; preserving the running process.");
  else restartOwnedJob(BACKEND_LABEL);
  if (!current.gatewayJob.loaded && !current.gateway.ok && !current.trusted.error) {
    prepareGateway(current.production);
    ensureInstalled(current.production, current.main, launchMode);
    if (!current.gatewayPortOpen) ensureEnabledAndLoaded(GATEWAY_LABEL);
  }
  current = await waitForRuntime(OPERATION_TIMEOUT_MS, launchMode);
  if (current.backend.ok && beforeEpoch && current.backend.document?.startup_epoch === beforeEpoch) {
    throw new Error("Mandible restarted its backend service, but the startup marker did not change. The old process may still be responding; it was preserved.");
  }
  return current.status;
}

async function reloadGatewayRuntime({ launchMode = "on_demand", ifConfigured = false } = {}) {
  const initial = await inspectRuntime({ launchMode });
  const configPath = path.join(RUNTIME_DIR, "Caddyfile");
  if (ifConfigured && !fs.existsSync(configPath)) return { skipped: "local HTTPS gateway is not configured" };
  if (initial.status.state === "port_conflict") throw new Error(initial.status.detail ?? "A required Mandible port is owned by another process.");
  if (initial.trusted.error) throw new Error(initial.trusted.error);
  if (!initial.backend.ok) throw new Error("The production daemon is not ready; the shared gateway was not changed.");
  ensureInstalled(initial.production, initial.main, launchMode);
  prepareGateway(initial.production);
  ensureInstalled(initial.production, initial.main, launchMode);
  const current = await inspectRuntime({ launchMode });
  if (current.gatewayJob.loaded) {
    try { reloadCaddy(pinnedCaddyBinary(HOME)); }
    catch { restartOwnedJob(GATEWAY_LABEL); }
  } else if (current.gateway.ok) {
    throw new Error("The dashboard gateway answers requests but is not owned by Mandible's launchd service; preserving the running process.");
  } else {
    if (current.gatewayPortOpen) throw new Error("The HTTPS dashboard port is owned by an unrecognized process; preserving it.");
    ensureEnabledAndLoaded(GATEWAY_LABEL);
  }
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
    const result = spawnSync(runtimeBinary(), [path.join(root, "scripts", "local-front-door.mjs"), "initialize"], {
      cwd: root,
      env: { ...process.env, HOME: os.homedir(), MANDIBLE_HOME: HOME },
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
    const result = command === 'handoff-remove' ? removeHandoffDefinitions(journal.binding)
      : command === 'handoff-start' ? await startHandoffDefinitions(journal.binding) : await verifyHandoffDefinitions(journal.binding);
    process.stdout.write(`${JSON.stringify(result ?? { removed: true })}\n`);
    return;
  }
  const launchModeArg = args.find((arg) => arg.startsWith("--launch-mode="))?.slice("--launch-mode=".length);
  if (launchModeArg && !["manual", "on_demand"].includes(launchModeArg)) {
    throw new Error(`Unsupported launch mode: ${launchModeArg}`);
  }
  const launchMode = launchModeArg ?? "on_demand";
  if (command === "status") {
    const { status } = await inspectRuntime({ launchMode });
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  let status;
  if (command === "start") status = await startRuntime({ launchMode });
  else if (command === "stop") status = await stopRuntime({ launchMode });
  else if (command === "restart") status = await restartRuntime({ launchMode });
  else if (command === "reload-gateway") status = await reloadGatewayRuntime({ launchMode, ifConfigured: args.includes("--if-configured") });
  else if (command === "configure-launch-mode") {
    const production = readProductionRecord();
    const mainInstance = readMainInstance(production.root);
    ensureInstalled(production, mainInstance, launchMode);
    status = (await inspectRuntime({ launchMode })).status;
  }
  else if (command === "install") {
    if (directHandoff && inspectJob(BACKEND_LABEL).loaded) throw new Error('The old backend definition must be unloaded before candidate installation.');
    const rootArgIndex = args.indexOf("--root");
    const root = path.resolve(rootArgIndex >= 0 ? (args[rootArgIndex + 1] ?? "") : process.cwd());
    if (!fs.existsSync(path.join(root, "package.json")) || !fs.existsSync(path.join(root, "dist", "index.js"))) {
      throw new Error(`A built Mandible checkout is required to install local services: ${root}`);
    }
    const production = await initializeMainRegistration(root);
    const mainInstance = readMainInstance(root);
    const effectiveLaunchMode = launchModeArg ? launchMode : installedLaunchMode();
    const installScript = path.join(production.root, "scripts", "local-front-door.mjs");
    const result = spawnSync(runtimeBinary(), [installScript, "install"], {
      cwd: production.root, env: { ...process.env, HOME: HOME_DIR, MANDIBLE_HOME: HOME },
      encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(`Gateway installation failed: ${(result.stderr || result.error?.message || "unknown failure").trim()}`);
    const installed = ensureInstalled(production, mainInstance, effectiveLaunchMode);
    if (production.legacyEffectsMigrated && !directHandoff) {
      if (installed.wasBackendLoaded) restartOwnedJob(BACKEND_LABEL);
      else if (await portOpen(mainInstance.backendUrl)) {
        throw new Error("The production effect ceiling was updated, but the healthy backend is not owned by Mandible's LaunchAgent; restart it explicitly to apply the update.");
      }
    }
    process.stdout.write(`${JSON.stringify({ installed: true, launch_mode: effectiveLaunchMode, ...installed })}\n`);
    return;
  } else {
    throw new Error("Usage: local-runtime.mjs status|install [--root <checkout>]|configure-launch-mode|start|stop|restart|reload-gateway [--launch-mode=manual|on_demand]");
  }
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
