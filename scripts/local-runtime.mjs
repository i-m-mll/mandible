#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_ORIGIN } from "./canonical-origin.mjs";
import { assertLocalCaIdentity, localCaPaths, probeCurrentMacOsTrust } from "./local-ca-trust.mjs";
import { installPinnedCaddy, pinnedCaddyBinary } from "./pinned-caddy.mjs";

const DEFAULT_HOME = path.join(os.homedir(), ".mandible");
const HOME = path.resolve(process.env.MANDIBLE_HOME || DEFAULT_HOME);
const HOME_DIR = path.dirname(HOME);
const RUNTIME_DIR = path.join(HOME, "config", "local-sessions");
const READY_FILE = path.join(RUNTIME_DIR, "production-ready.json");
const CUTOVER_FILE = path.join(RUNTIME_DIR, "cutover.json");
const AUTHORITY_DB = path.join(RUNTIME_DIR, "sessions.db");
const INSTALLATION_AUTHORITY = path.join(HOME, "config", "client-auth", "authority-id");
const SERVICE_DIR = path.join(RUNTIME_DIR, "launch-agents");
const LOG_DIR = path.join(HOME_DIR, ".cache", "mandible");
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;
const IS_DEFAULT_INSTALL = HOME === DEFAULT_HOME;
const INSTALL_SUFFIX = IS_DEFAULT_INSTALL ? "" : `.${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const BACKEND_LABEL = `bio.mll.mandible.local-session-production${INSTALL_SUFFIX}`;
const GATEWAY_LABEL = `bio.mll.mandible.local-front-door${INSTALL_SUFFIX}`;
const HEALTH_TIMEOUT_MS = 900;
const OPERATION_TIMEOUT_MS = 4500;
const BODY_LIMIT = 256 * 1024;

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
}

function readProductionRecord() {
  const ready = fs.existsSync(READY_FILE) ? readJson(READY_FILE, "production build marker") : null;
  const cutover = readJson(CUTOVER_FILE, "local-session production record");
  if (cutover.state !== "complete") throw new Error("Local-session production setup is not complete.");
  const main = cutover.manifest?.instances?.find((instance) => instance.role === "main");
  const candidate = main?.candidate;
  const candidateRoot = candidate?.process?.cwd;
  if (!path.isAbsolute(candidateRoot ?? "") || !fs.existsSync(path.join(candidateRoot, "package.json"))) {
    throw new Error("The production record does not identify an installed Mandible checkout.");
  }
  if (ready && (!path.isAbsolute(ready.root ?? "") || !/^[a-f0-9]{40}$/.test(ready.commit ?? ""))) {
    throw new Error("The production build marker is malformed.");
  }
  const root = ready?.root ?? candidateRoot;
  const generation = ready?.commit ?? candidate?.commit;
  if (!/^[a-f0-9]{40}$/.test(generation ?? "")) {
    throw new Error("The production record has no exact backend generation.");
  }
  return { root, generation, candidate };
}

function readMainInstance(root) {
  if (!fs.existsSync(AUTHORITY_DB)) throw new Error(`Local-session authority is missing: ${AUTHORITY_DB}`);
  const requireFromProject = createRequire(path.join(root, "package.json"));
  const Database = requireFromProject("better-sqlite3");
  const db = new Database(AUTHORITY_DB, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT instance_id, installation_id, role, public_origin, backend_origin, backend_generation FROM instance_registrations WHERE role = 'main'").all();
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
    const installationAuthority = fs.readFileSync(INSTALLATION_AUTHORITY, "utf8").trim();
    if (!installationAuthority || installationAuthority !== main.installation_id) {
      throw new Error("The production instance does not match this installation's client-auth authority.");
    }
    return { ...main, backendUrl: backend, publicUrl };
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
  return { loaded, pid, detail: result.stderr.trim() };
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

function readRunnerMetadata(candidate) {
  const env = candidate?.process?.env ?? {};
  return {
    pidFile: typeof env.MANDIBLE_PID_FILE === "string" ? env.MANDIBLE_PID_FILE : path.join(HOME_DIR, ".cache", "mandible", "cutover-production.pid"),
    logFile: typeof env.MANDIBLE_STDERR_LOG_PATH === "string" ? env.MANDIBLE_STDERR_LOG_PATH : path.join(LOG_DIR, "cutover-production-stderr.log"),
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
    gateway_state: gateway.ok ? "running" : gatewayJob.loaded ? "starting" : "stopped",
    gateway_error: gateway.ok ? null : gateway.error,
    gateway_log_file: metadata.gatewayLogFile ?? "",
  };
}

async function inspectRuntime({ launchMode = "on_demand" } = {}) {
  const production = readProductionRecord();
  const main = readMainInstance(production.root);
  const expected = { installationId: main.installation_id, publicOrigin: PRODUCTION_ORIGIN, generation: production.generation };
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
  const runner = readRunnerMetadata(production.candidate);
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
    '<key>RunAtLoad</key><false/>',
    '<key>KeepAlive</key><true/>',
    '<key>ThrottleInterval</key><integer>10</integer>',
    `<key>StandardOutPath</key><string>${escapeXml(stdoutPath)}</string>`,
    `<key>StandardErrorPath</key><string>${escapeXml(stderrPath)}</string>`,
    '<key>Comment</key><string>Mandible runtime agent mandible-launch-agent@1</string>',
    '</dict></plist>',
    '',
  ].join('\n');
}

function nodeBinary() {
  return process.execPath;
}

function plistPath(label) {
  return path.join(SERVICE_DIR, `${label}.plist`);
}

function writeOwnedPlist(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    if (existing === contents) return false;
    if (!existing.includes("<key>Comment</key><string>Mandible runtime agent mandible-launch-agent@1</string>")) {
      throw new Error(`A launchd configuration already exists at ${file} and is not managed by Mandible; preserving it.`);
    }
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { flag: "w", mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return true;
}

function parsePlist(file) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8", timeout: 1500 });
  if (result.error || result.status !== 0) throw new Error(`Could not inspect existing launchd configuration ${file}; preserving it.`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`Existing launchd configuration is malformed: ${file}`); }
}

function preserveAndRemoveLegacyLaunchAgent(file, expectedLabel, isMandibleJob) {
  if (!fs.existsSync(file)) return false;
  const record = parsePlist(file);
  if (record.Label !== expectedLabel || !isMandibleJob(record)) {
    throw new Error(`LaunchAgent ${file} does not match the known Mandible runtime; preserving it and reporting an ownership conflict.`);
  }
  const bytes = fs.readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const archiveDir = path.join(RUNTIME_DIR, "legacy-launch-agents");
  const archive = path.join(archiveDir, `${expectedLabel}-${digest.slice(0, 12)}.plist`);
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(archive)) {
    if (!fs.readFileSync(archive).equals(bytes)) throw new Error(`Preserved launchd history differs at ${archive}; refusing to replace it.`);
    fs.unlinkSync(file);
  } else {
    fs.renameSync(file, archive);
    fs.chmodSync(archive, 0o600);
  }
  const job = inspectJob(expectedLabel);
  if (job.loaded) {
    const stopped = runLaunchctl(["bootout", `${DOMAIN}/${expectedLabel}`]);
    if (stopped.status !== 0 && inspectJob(expectedLabel).loaded) {
      throw new Error(`Could not stop the exact recognized Mandible LaunchAgent ${expectedLabel}; its original plist is preserved at ${archive}.`);
    }
  }
  if (expectedLabel !== BACKEND_LABEL) runLaunchctl(["disable", `${DOMAIN}/${expectedLabel}`]);
  return true;
}

function prepareRunner(root) {
  const source = path.join(root, "scripts", "local-session-production-runner.mjs");
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Production runner source is missing: ${source}`);
  const target = path.join(RUNTIME_DIR, "production-runner.mjs");
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const sourceBytes = fs.readFileSync(source);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(sourceBytes)) {
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, sourceBytes, { mode: 0o700 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o700);
  }
}

function prepareServicePlists(production) {
  const node = nodeBinary();
  const pathValue = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
  const commonEnvironment = { HOME: HOME_DIR, MANDIBLE_HOME: HOME, PATH: pathValue, GIT_OPTIONAL_LOCKS: "0" };
  const backendContents = renderLaunchAgent({
    label: BACKEND_LABEL,
    programArguments: [node, path.join(RUNTIME_DIR, "production-runner.mjs"), "run"],
    workingDirectory: RUNTIME_DIR,
    environment: commonEnvironment,
    stdoutPath: path.join(LOG_DIR, "cutover-production-stdout.log"),
    stderrPath: path.join(LOG_DIR, "cutover-production-stderr.log"),
  });
  const gatewayContents = renderLaunchAgent({
    label: GATEWAY_LABEL,
    programArguments: [pinnedCaddyBinary(HOME), "run", "--config", path.join(RUNTIME_DIR, "Caddyfile"), "--adapter", "caddyfile"],
    workingDirectory: RUNTIME_DIR,
    environment: commonEnvironment,
    stdoutPath: path.join(LOG_DIR, "local-front-door-stdout.log"),
    stderrPath: path.join(LOG_DIR, "local-front-door-stderr.log"),
  });
  return {
    backendChanged: writeOwnedPlist(plistPath(BACKEND_LABEL), backendContents),
    gatewayChanged: writeOwnedPlist(plistPath(GATEWAY_LABEL), gatewayContents),
  };
}

function adoptExistingLaunchAgents(production) {
  if (!IS_DEFAULT_INSTALL) return;
  const directory = path.join(os.homedir(), "Library", "LaunchAgents");
  const daemonFile = path.join(directory, `${BACKEND_LABEL}.plist`);
  preserveAndRemoveLegacyLaunchAgent(daemonFile, BACKEND_LABEL, (record) => {
    const args = record.ProgramArguments ?? [];
    return args.length === 3 && path.resolve(args[1]) === path.join(RUNTIME_DIR, "production-runner.mjs") && args[2] === "run";
  });

  const oldDirectFile = path.join(directory, "com.mll.mandible.plist");
  preserveAndRemoveLegacyLaunchAgent(oldDirectFile, "com.mll.mandible", (record) => {
    const args = record.ProgramArguments ?? [];
    return args.length === 2 && path.resolve(args[1]) === path.join(production.root, "dist", "index.js");
  });

  const oldGatewayFile = path.join(directory, `${GATEWAY_LABEL}.plist`);
  preserveAndRemoveLegacyLaunchAgent(oldGatewayFile, GATEWAY_LABEL, (record) => {
    const args = record.ProgramArguments ?? [];
    return args.length === 3 && path.resolve(args[1]) === path.join(production.root, "scripts", "local-front-door.mjs")
      && args[2] === "serve" && record.EnvironmentVariables?.MANDIBLE_RUNTIME_SUPERVISED === "1";
  });
}

function ensureInstalled(production) {
  const beforeBackend = inspectJob(BACKEND_LABEL);
  const beforeGateway = inspectJob(GATEWAY_LABEL);
  adoptExistingLaunchAgents(production);
  prepareRunner(production.root);
  const changed = prepareServicePlists(production);
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  return { wasBackendLoaded: beforeBackend.loaded, wasGatewayLoaded: beforeGateway.loaded, ...changed };
}

function ensureEnabledAndLoaded(label) {
  const current = inspectJob(label);
  if (current.loaded) return false;
  const enabled = runLaunchctl(["enable", `${DOMAIN}/${label}`]);
  if (enabled.status !== 0) throw new Error(`Could not enable Mandible service ${label}: ${enabled.stderr.trim()}`);
  const loaded = runLaunchctl(["bootstrap", DOMAIN, plistPath(label)]);
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
  const result = spawnSync(nodeBinary(), [script, "configure"], {
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

async function waitForRuntime(deadlineMs = OPERATION_TIMEOUT_MS, launchMode = "on_demand") {
  const deadline = Date.now() + deadlineMs;
  let current;
  do {
    current = await inspectRuntime({ launchMode });
    if (current.status.dashboard_ready || current.status.state === "port_conflict") return current;
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
  ensureInstalled(current.production);
  current = await inspectRuntime({ launchMode });
  if (current.status.state === "port_conflict") return current.status;
  if (!current.backend.ok) {
    if (current.backendPortOpen && !current.backendJob.loaded) return current.status;
    if (!current.backendJob.loaded) ensureEnabledAndLoaded(BACKEND_LABEL);
  }
  if (!current.gateway.ok && !current.trusted.error) {
    if (current.gatewayPortOpen && !current.gatewayJob.loaded) return current.status;
    prepareGateway(current.production);
    if (!current.gatewayJob.loaded) ensureEnabledAndLoaded(GATEWAY_LABEL);
  }
  return (await waitForRuntime(OPERATION_TIMEOUT_MS, launchMode)).status;
}

function registeredPreviewCount(root) {
  const Database = createRequire(path.join(root, "package.json"))("better-sqlite3");
  const db = new Database(AUTHORITY_DB, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT COUNT(*) AS count FROM instance_registrations WHERE role = 'preview'").get().count; }
  finally { db.close(); }
}

async function stopRuntime({ launchMode = "on_demand" } = {}) {
  const current = await inspectRuntime({ launchMode });
  ensureInstalled(current.production);
  const owned = await inspectRuntime({ launchMode });
  const previews = registeredPreviewCount(current.production.root);
  if (owned.backendJob.loaded) stopOwnedJob(BACKEND_LABEL);
  if (previews === 0 && owned.gatewayJob.loaded) stopOwnedJob(GATEWAY_LABEL);
  const stopped = (await waitForRuntime(3000, launchMode)).status;
  if (stopped.healthy) throw new Error("Stop was requested, but the production backend is still responding.");
  if (previews > 0 && owned.gateway.ok && stopped.gateway_state !== "running") {
    throw new Error("The production backend stopped, but the shared preview gateway did not remain available.");
  }
  return stopped;
}

async function restartRuntime({ launchMode = "on_demand" } = {}) {
  let current = await inspectRuntime({ launchMode });
  if (current.status.state === "port_conflict") return current.status;
  const beforeEpoch = current.backend.document?.startup_epoch;
  ensureInstalled(current.production);
  current = await inspectRuntime({ launchMode });
  if (current.backendJob.loaded) restartOwnedJob(BACKEND_LABEL);
  else if (current.backend.ok) throw new Error("The production backend is healthy but is not owned by Mandible's launchd service; preserving the running process.");
  else restartOwnedJob(BACKEND_LABEL);
  if (!current.gateway.ok && !current.trusted.error) {
    prepareGateway(current.production);
    if (current.gatewayJob.loaded) restartOwnedJob(GATEWAY_LABEL);
    else if (!current.gatewayPortOpen) ensureEnabledAndLoaded(GATEWAY_LABEL);
  }
  current = await waitForRuntime(OPERATION_TIMEOUT_MS, launchMode);
  if (current.backend.ok && beforeEpoch && current.backend.document?.startup_epoch === beforeEpoch) {
    throw new Error("Mandible restarted its backend service, but the startup marker did not change. The old process may still be responding; it was preserved.");
  }
  return current.status;
}

async function convergeRuntime({ launchMode = "on_demand" } = {}) {
  const before = await inspectRuntime({ launchMode });
  if (before.status.state === "port_conflict") throw new Error(before.status.detail ?? "A required Mandible port is owned by another process.");
  ensureInstalled(before.production);
  let current = await inspectRuntime({ launchMode });
  if (!current.backend.ok) {
    if (current.backendPortOpen && !current.backendJob.loaded) throw new Error("The backend port is owned by an unrecognized process; preserving it.");
    restartOwnedJob(BACKEND_LABEL);
  }
  if (current.trusted.error) throw new Error(current.trusted.error);
  prepareGateway(current.production);
  current = await inspectRuntime({ launchMode });
  if (current.gateway.ok) {
    if (current.gatewayJob.loaded) reloadCaddy(pinnedCaddyBinary(HOME));
  } else if (current.gatewayPortOpen && !current.gatewayJob.loaded) {
    throw new Error("The HTTPS dashboard port is owned by an unrecognized process; preserving it.");
  } else if (current.gatewayJob.loaded) restartOwnedJob(GATEWAY_LABEL);
  else ensureEnabledAndLoaded(GATEWAY_LABEL);
  const status = (await waitForRuntime(OPERATION_TIMEOUT_MS, launchMode)).status;
  if (!status.dashboard_ready) {
    const detail = status.detail || "The backend and trusted HTTPS dashboard did not both become ready.";
    throw new Error(`Mandible runtime convergence failed: ${detail}`);
  }
  return status;
}

async function reloadGatewayRuntime({ launchMode = "on_demand", ifConfigured = false } = {}) {
  const initial = await inspectRuntime({ launchMode });
  const configPath = path.join(RUNTIME_DIR, "Caddyfile");
  if (ifConfigured && !fs.existsSync(configPath)) return { skipped: "local HTTPS gateway is not configured" };
  if (initial.status.state === "port_conflict") throw new Error(initial.status.detail ?? "A required Mandible port is owned by another process.");
  if (initial.trusted.error) throw new Error(initial.trusted.error);
  if (!initial.backend.ok) throw new Error("The production daemon is not ready; the shared gateway was not changed.");
  ensureInstalled(initial.production);
  prepareGateway(initial.production);
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

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const launchModeArg = args.find((arg) => arg.startsWith("--launch-mode="))?.slice("--launch-mode=".length);
  const launchMode = launchModeArg === "manual" ? "manual" : "on_demand";
  if (command === "status") {
    const { status } = await inspectRuntime({ launchMode });
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  let status;
  if (command === "start") status = await startRuntime({ launchMode });
  else if (command === "stop") status = await stopRuntime({ launchMode });
  else if (command === "restart") status = await restartRuntime({ launchMode });
  else if (command === "converge") status = await convergeRuntime({ launchMode });
  else if (command === "reload-gateway") status = await reloadGatewayRuntime({ launchMode, ifConfigured: args.includes("--if-configured") });
  else if (command === "install") {
    const production = readProductionRecord();
    const installed = ensureInstalled(production);
    const installScript = path.join(production.root, "scripts", "local-front-door.mjs");
    const result = spawnSync(nodeBinary(), [installScript, "install"], {
      cwd: production.root, env: { ...process.env, HOME: HOME_DIR, MANDIBLE_HOME: HOME },
      encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(`Gateway installation failed: ${(result.stderr || result.error?.message || "unknown failure").trim()}`);
    process.stdout.write(`${JSON.stringify({ installed: true, ...installed })}\n`);
    return;
  } else {
    throw new Error("Usage: local-runtime.mjs status|install|start|stop|restart|converge|reload-gateway [--launch-mode=manual|on_demand]");
  }
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
