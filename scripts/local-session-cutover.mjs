#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const SCHEMA = "mandible-local-session-cutover@1";
const STATES = new Set([
  "prepared",
  "activating",
  "migration",
  "completing",
  "rolling_back",
  "complete",
  "rolled_back",
  "recovery_failed",
]);
const PUBLIC_PORT = Object.freeze({ main: 19420, preview: 19421 });
const HEALTH_TIMEOUT_MS = 30_000;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await runCli();
}

async function runCli() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runCutoverCommand(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export async function runCutoverCommand(options, effects = systemEffects()) {
  if (options.command === "prepare") {
    const manifest = readJson(options.manifest);
    validateManifest(manifest);
    const journalPath = options.journal ?? defaultJournalPath();
    if (fs.existsSync(journalPath)) {
      const current = readJson(journalPath);
      if (current.state !== "complete" && current.state !== "rolled_back") {
        throw new Error(`Cutover journal is already active at ${journalPath}.`);
      }
    }
    await preflight(manifest, effects);
    stageRegistrations(manifest);
    const legacyProcessFingerprints = Object.fromEntries(await Promise.all(
      manifest.instances.map(async (instance) => [instance.role, await effects.controlIdentity(instance.legacy.stop)]),
    ));
    const rollback = manifest.rollback_files.map(snapshotPath);
    if (Object.values(legacyProcessFingerprints).some((value) => !value)) {
      throw new Error("Every legacy process requires a verifiable prepare-time identity.");
    }
    const journal = {
      schema: SCHEMA,
      id: manifest.id,
      state: "prepared",
      revision: 1,
      manifest,
      manifest_digest: digest(manifest),
      rollback,
      rollback_digest: digest(rollback),
      legacy_process_fingerprints: legacyProcessFingerprints,
      runtime: {},
      prepared_at: new Date().toISOString(),
    };
    writeJsonAtomic(journalPath, journal);
    return publicState(journalPath, journal);
  }

  const journalPath = options.journal ?? defaultJournalPath();
  const journal = readJournal(journalPath);
  if (options.command === "status") return publicState(journalPath, journal);
  if (options.command === "activate") {
    if (!options.confirmCaTrusted) {
      throw new Error("Activation requires --confirm-ca-trusted; the cutover never changes certificate trust.");
    }
    return activate(journalPath, journal, effects);
  }
  if (options.command === "complete") {
    if (!options.confirmBrowserConversion) {
      throw new Error("Completion requires --confirm-browser-conversion after every legacy browser has converted.");
    }
    return complete(journalPath, journal, effects);
  }
  if (options.command === "rollback") return rollback(journalPath, journal, effects);
  throw new Error(`Unknown cutover command: ${options.command}`);
}

async function activate(journalPath, journal, effects) {
  requireState(journal, "prepared");
  await preflight(journal.manifest, effects);
  let working = advance(journal, "activating", {
    runtime: { stopped_roles: [], candidates: {}, gateway_pid: null, gateway_fingerprint: null, gateway_mode: null },
    activation_started_at: new Date().toISOString(),
  });
  writeJsonAtomic(journalPath, working);
  try {
    for (const instance of journal.manifest.instances) {
      const expectedFingerprint = journal.legacy_process_fingerprints[instance.role];
      if (await effects.controlIdentity(instance.legacy.stop) !== expectedFingerprint) {
        throw new Error(`Legacy ${instance.role} process identity changed after prepare.`);
      }
      await effects.stopControl(instance.legacy.stop, expectedFingerprint);
      working = persistStep(journalPath, working, {
        runtime: { ...working.runtime, stopped_roles: [...working.runtime.stopped_roles, instance.role] },
      });
    }
    for (const instance of journal.manifest.instances) {
      if (await effects.portOpen(instance.public_port)) {
        throw new Error(`Legacy public port ${instance.public_port} remained occupied after its validated listener stopped.`);
      }
    }
    for (const instance of journal.manifest.instances) {
      const started = await effects.startProcess(instance.candidate.process, {
        MANDIBLE_LEGACY_CONVERSION: "allow",
      });
      working = persistStep(journalPath, working, {
        runtime: { ...working.runtime, candidates: { ...working.runtime.candidates, [instance.role]: started } },
      });
      await effects.waitHealth(instance.candidate.backend_port, candidateExpectation(instance, true));
    }
    effects.configureGateway(journal.manifest.gateway, "migration");
    assertGatewayConfig(journal.manifest.gateway.config_path, "migration");
    const gateway = await effects.startProcess(journal.manifest.gateway.process, {});
    working = persistStep(journalPath, working, {
      runtime: {
        ...working.runtime,
        gateway_pid: gateway.launcher_pid,
        gateway_fingerprint: gateway.process_fingerprint,
        gateway_mode: "migration",
      },
    });
    for (const instance of journal.manifest.instances) await effects.waitPort(instance.public_port);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    try {
      await compensateToLegacy(working, effects);
      const rolledBack = advance(working, "rolled_back", { rolled_back_at: new Date().toISOString(), failure });
      writeJsonAtomic(journalPath, rolledBack);
      throw new Error(`Cutover activation failed and legacy listeners were restored: ${failure}`);
    } catch (recoveryError) {
      if (recoveryError instanceof Error && recoveryError.message.startsWith("Cutover activation failed")) throw recoveryError;
      const failed = advance(working, "recovery_failed", {
        failure,
        recovery_failure: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
      writeJsonAtomic(journalPath, failed);
      throw new Error(`Cutover activation failed and rollback also failed: ${failed.recovery_failure}`);
    }
  }
  const active = advance(working, "migration", {
    activated_at: new Date().toISOString(),
  });
  writeJsonAtomic(journalPath, active);
  return publicState(journalPath, active);
}

async function complete(journalPath, journal, effects) {
  requireState(journal, "migration");
  await verifyCandidates(journal, effects, true);
  let working = advance(journal, "completing", { completion_started_at: new Date().toISOString() });
  writeJsonAtomic(journalPath, working);
  await stopCandidates(working, effects);
  working = persistStep(journalPath, working, { runtime: { ...working.runtime, candidates: {} } });
  try {
    for (const instance of journal.manifest.instances) {
      const started = await effects.startProcess(instance.candidate.process, {});
      working = persistStep(journalPath, working, {
        runtime: { ...working.runtime, candidates: { ...working.runtime.candidates, [instance.role]: started } },
      });
      await effects.waitHealth(instance.candidate.backend_port, candidateExpectation(instance, false));
    }
    effects.configureGateway(journal.manifest.gateway, "normal");
    assertGatewayConfig(journal.manifest.gateway.config_path, "normal");
    effects.reloadGateway(journal.manifest.gateway);
    working = persistStep(journalPath, working, {
      runtime: { ...working.runtime, gateway_mode: "normal" },
    });
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (working.runtime.gateway_mode === "normal") {
      const failed = advance(working, "recovery_failed", { failure, recovery_failure: "normal gateway is already active; recovery is forward-only" });
      writeJsonAtomic(journalPath, failed);
      throw new Error(`Normal-mode completion failed after activation; recover forward: ${failure}`);
    }
    try {
      await stopCandidates(working, effects);
      working = persistStep(journalPath, working, {
        runtime: { ...working.runtime, candidates: {} },
      });
      for (const instance of journal.manifest.instances) {
        const started = await effects.startProcess(instance.candidate.process, { MANDIBLE_LEGACY_CONVERSION: "allow" });
        working = persistStep(journalPath, working, {
          runtime: { ...working.runtime, candidates: { ...working.runtime.candidates, [instance.role]: started } },
        });
        await effects.waitHealth(instance.candidate.backend_port, candidateExpectation(instance, true));
      }
      effects.configureGateway(journal.manifest.gateway, "migration");
      assertGatewayConfig(journal.manifest.gateway.config_path, "migration");
      effects.reloadGateway(journal.manifest.gateway);
      const restored = advance(working, "migration", {
        runtime: { ...working.runtime, gateway_mode: "migration" },
        completion_failure: failure,
      });
      writeJsonAtomic(journalPath, restored);
      throw new Error(`Normal-mode completion failed; migration mode was restored: ${failure}`);
    } catch (recoveryError) {
      if (recoveryError instanceof Error && recoveryError.message.startsWith("Normal-mode completion failed")) throw recoveryError;
      const failed = advance(working, "recovery_failed", {
        failure,
        recovery_failure: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
      writeJsonAtomic(journalPath, failed);
      throw new Error(`Normal-mode completion failed and migration recovery also failed: ${failed.recovery_failure}`);
    }
  }
  const completed = advance(working, "complete", {
    completed_at: new Date().toISOString(),
    operator_confirmed_browser_conversion: true,
  });
  writeJsonAtomic(journalPath, completed);
  return publicState(journalPath, completed);
}

async function rollback(journalPath, journal, effects) {
  requireOneState(journal, ["activating", "migration", "completing", "recovery_failed"]);
  if (journal.runtime.gateway_mode === "normal") {
    throw new Error("Normal gateway activation is forward-only because legacy credentials may already be retired.");
  }
  let working = advance(journal, "rolling_back", { rollback_started_at: new Date().toISOString() });
  writeJsonAtomic(journalPath, working);
  try {
    await effects.stopPid(working.runtime.gateway_pid, working.runtime.gateway_fingerprint);
    await stopCandidates(working, effects);
    await restoreLegacy(working, effects);
    const rolledBack = advance(working, "rolled_back", { rolled_back_at: new Date().toISOString() });
    writeJsonAtomic(journalPath, rolledBack);
    return publicState(journalPath, rolledBack);
  } catch (error) {
    const failed = advance(working, "recovery_failed", {
      recovery_failure: error instanceof Error ? error.message : String(error),
    });
    writeJsonAtomic(journalPath, failed);
    throw new Error(`Cutover rollback failed: ${failed.recovery_failure}`);
  }
}

async function preflight(manifest, effects) {
  for (const instance of manifest.instances) {
    const health = await effects.health(instance.public_port);
    assertHealth(health, instance.legacy.expected, `legacy ${instance.role}`);
    if (!fs.existsSync(instance.candidate.process.command)) {
      throw new Error(`Candidate ${instance.role} executable is missing: ${instance.candidate.process.command}`);
    }
    if (instance.candidate.process.cwd && !fs.statSync(instance.candidate.process.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Candidate ${instance.role} working directory is missing: ${instance.candidate.process.cwd}`);
    }
    if (!fs.existsSync(instance.legacy.credential_directory)) {
      throw new Error(`Legacy ${instance.role} credential directory is missing: ${instance.legacy.credential_directory}`);
    }
    if (path.resolve(instance.candidate.credential_directory) !== path.resolve(instance.legacy.credential_directory)) {
      throw new Error(`Candidate ${instance.role} must retain the exact legacy credential directory.`);
    }
    if (await effects.portOpen(instance.candidate.backend_port)) {
      throw new Error(`Candidate ${instance.role} backend port ${instance.candidate.backend_port} is occupied.`);
    }
  }
  effects.validateGateway(manifest.gateway);
  validateStagedRegistrations(manifest);
}

async function verifyCandidates(journal, effects, migration) {
  for (const instance of journal.manifest.instances) {
    const health = await effects.health(instance.candidate.backend_port);
    assertHealth(health, candidateExpectation(instance, migration), `candidate ${instance.role}`);
  }
  if (journal.runtime.gateway_mode !== "migration") throw new Error("Cutover journal is not in migration gateway mode.");
  assertGatewayConfig(journal.manifest.gateway.config_path, "migration");
}

async function compensateToLegacy(journal, effects) {
  if (journal.runtime.gateway_pid) await effects.stopPid(journal.runtime.gateway_pid, journal.runtime.gateway_fingerprint);
  for (const started of Object.values(journal.runtime.candidates).reverse()) {
    await effects.stopPid(started.daemon_pid ?? started.launcher_pid, started.process_fingerprint);
  }
  restoreSnapshots(journal.rollback);
  const stopped = journal.manifest.instances.filter((instance) => journal.runtime.stopped_roles.includes(instance.role));
  for (const instance of [...stopped].reverse()) await effects.startControl(instance.legacy.restore);
  for (const instance of stopped) {
    await effects.waitHealth(instance.public_port, instance.legacy.expected);
  }
}

async function restoreLegacy(journal, effects) {
  restoreSnapshots(journal.rollback);
  const stopped = journal.manifest.instances.filter((instance) => journal.runtime.stopped_roles.includes(instance.role));
  for (const instance of [...stopped].reverse()) await effects.startControl(instance.legacy.restore);
  for (const instance of stopped) {
    await effects.waitHealth(instance.public_port, instance.legacy.expected);
  }
}

async function stopCandidates(journal, effects) {
  for (const started of Object.values(journal.runtime.candidates ?? {}).reverse()) {
    await effects.stopPid(started.daemon_pid ?? started.launcher_pid, started.process_fingerprint);
  }
}

function validateManifest(manifest) {
  if (manifest?.schema !== SCHEMA || typeof manifest.id !== "string" || !manifest.id) {
    throw new Error(`Cutover manifest must use ${SCHEMA} and have a non-empty id.`);
  }
  if (!Array.isArray(manifest.instances) || manifest.instances.length !== 2) {
    throw new Error("Cutover manifest must contain exactly one production and one preview instance.");
  }
  const roles = new Set(manifest.instances.map((entry) => entry.role));
  if (roles.size !== 2 || !roles.has("main") || !roles.has("preview")) {
    throw new Error("Cutover manifest must contain exactly the main and preview roles.");
  }
  const backendPorts = new Set();
  for (const instance of manifest.instances) {
    if (instance.public_port !== PUBLIC_PORT[instance.role]) {
      throw new Error(`${instance.role} public port must remain ${PUBLIC_PORT[instance.role]}.`);
    }
    const backend = instance.candidate?.backend_port;
    if (!Number.isInteger(backend) || backend < 1024 || backend === 19420 || backend === 19421 || backendPorts.has(backend)) {
      throw new Error("Candidate backends must use distinct non-public loopback ports.");
    }
    backendPorts.add(backend);
    validateProcess(instance.candidate.process, `candidate ${instance.role}`);
    validateControl(instance.legacy.stop, `legacy ${instance.role} stop`);
    validateControl(instance.legacy.restore, `legacy ${instance.role} restore`);
    if (!instance.legacy.expected?.startup_epoch || instance.legacy.expected.role !== instance.role) {
      throw new Error(`Legacy ${instance.role} requires an exact startup epoch and role.`);
    }
    const env = instance.candidate.process.env ?? {};
    if (env.MANDIBLE_LEGACY_CONVERSION !== undefined) {
      throw new Error("Candidate process env must not hard-code migration mode; the state machine owns it.");
    }
    if (env.MANDIBLE_PORT !== String(backend) || env.MANDIBLE_INSTANCE_ROLE !== instance.role) {
      throw new Error(`Candidate ${instance.role} process env does not match its backend and role.`);
    }
    if (!instance.candidate.instance_id || env.MANDIBLE_INSTANCE_ID !== instance.candidate.instance_id) {
      throw new Error(`Candidate ${instance.role} process env does not match its durable instance identity.`);
    }
    if (path.resolve(env.MANDIBLE_CLIENT_AUTH_DIR ?? "") !== path.resolve(instance.candidate.credential_directory ?? "")) {
      throw new Error(`Candidate ${instance.role} process env does not pin its credential directory.`);
    }
    for (const key of ["MANDIBLE_INSTALLATION_ID", "MANDIBLE_BACKEND_GENERATION", "MANDIBLE_ALLOWED_EFFECTS", "MANDIBLE_WRITABLE_ROOTS"]) {
      if (!env[key]) throw new Error(`Candidate ${instance.role} process env is missing ${key}.`);
    }
    for (const key of ["MANDIBLE_ALLOWED_EFFECTS", "MANDIBLE_WRITABLE_ROOTS"]) {
      const parsed = JSON.parse(env[key]);
      if (!Array.isArray(parsed)) throw new Error(`Candidate ${instance.role} ${key} must be a JSON array.`);
    }
    const publicOrigin = new URL(env.MANDIBLE_PUBLIC_ORIGIN);
    if (publicOrigin.protocol !== "https:" || Number(publicOrigin.port) !== instance.public_port) {
      throw new Error(`Candidate ${instance.role} public origin must use HTTPS on ${instance.public_port}.`);
    }
  }
  validateProcess(manifest.gateway?.process, "gateway");
  validateProcess(manifest.gateway?.configure, "gateway configure");
  validateProcess(manifest.gateway?.reload, "gateway reload");
  for (const key of ["migration_args", "normal_args"]) {
    if (!Array.isArray(manifest.gateway?.configure?.[key])) {
      throw new Error(`Gateway configure ${key} must be an argument array.`);
    }
  }
  if (!path.isAbsolute(manifest.authority_db ?? "")) throw new Error("authority_db must be absolute.");
  if (!path.isAbsolute(manifest.gateway?.config_path ?? "")) throw new Error("Gateway config_path must be absolute.");
  if (!Array.isArray(manifest.rollback_files)) throw new Error("rollback_files must be an array.");
  if (new Set(manifest.rollback_files.map((filePath) => path.resolve(filePath))).size !== manifest.rollback_files.length) {
    throw new Error("rollback_files must not contain duplicate paths.");
  }
  for (const filePath of manifest.rollback_files) {
    if (!path.isAbsolute(filePath)) throw new Error(`Rollback path must be absolute: ${filePath}`);
  }
}

function registrationFromInstance(instance) {
  const env = instance.candidate.process.env;
  return {
    instance_id: instance.candidate.instance_id,
    installation_id: env.MANDIBLE_INSTALLATION_ID,
    role: instance.role,
    public_origin: env.MANDIBLE_PUBLIC_ORIGIN,
    backend_origin: `http://127.0.0.1:${instance.candidate.backend_port}`,
    backend_generation: env.MANDIBLE_BACKEND_GENERATION,
    effect_ceiling_json: env.MANDIBLE_ALLOWED_EFFECTS,
    writable_roots_json: env.MANDIBLE_WRITABLE_ROOTS,
  };
}

function stageRegistrations(manifest) {
  const db = new Database(manifest.authority_db);
  try {
    db.transaction(() => {
      for (const instance of manifest.instances) {
        const registration = registrationFromInstance(instance);
        const existing = db.prepare("SELECT * FROM instance_registrations WHERE instance_id = ?").get(registration.instance_id);
        if (existing && (existing.installation_id !== registration.installation_id || existing.role !== registration.role || existing.public_origin !== registration.public_origin)) {
          throw new Error(`Conflicting durable registration for ${registration.instance_id}.`);
        }
        db.prepare(`INSERT INTO instance_registrations (
          instance_id, installation_id, role, public_origin, backend_origin,
          backend_generation, effect_ceiling_json, writable_roots_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET
          backend_origin=excluded.backend_origin,
          backend_generation=excluded.backend_generation,
          effect_ceiling_json=excluded.effect_ceiling_json,
          writable_roots_json=excluded.writable_roots_json,
          updated_at=excluded.updated_at`).run(
          registration.instance_id,
          registration.installation_id,
          registration.role,
          registration.public_origin,
          registration.backend_origin,
          registration.backend_generation,
          registration.effect_ceiling_json,
          registration.writable_roots_json,
          Date.now(),
        );
      }
    })();
  } finally { db.close(); }
}

function validateStagedRegistrations(manifest) {
  if (!fs.existsSync(manifest.authority_db)) throw new Error(`Session authority database is missing: ${manifest.authority_db}`);
  const db = new Database(manifest.authority_db, { readonly: true, fileMustExist: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instance_registrations'").get();
    if (!table) throw new Error("Session authority database has no instance_registrations table.");
    for (const instance of manifest.instances) {
      const expected = registrationFromInstance(instance);
      const existing = db.prepare("SELECT * FROM instance_registrations WHERE instance_id = ?").get(expected.instance_id);
      if (!existing) continue;
      for (const key of ["installation_id", "role", "public_origin"]) {
        if (existing[key] !== expected[key]) throw new Error(`Durable registration drift for ${expected.instance_id}: ${key}.`);
      }
    }
  } finally { db.close(); }
}

function candidateExpectation(instance, migration) {
  return {
    role: instance.role,
    instance_id: instance.candidate.instance_id,
    credential_directory: instance.candidate.credential_directory,
    legacy_conversion: migration,
  };
}

function assertHealth(health, expected, label) {
  if (!health || health.ready !== true || health.warm !== true || health.instance?.role !== expected.role) {
    throw new Error(`${label} is not ready and warm with role ${expected.role}.`);
  }
  if (expected.startup_epoch && health.startup_epoch !== expected.startup_epoch) {
    throw new Error(`${label} startup epoch changed.`);
  }
  if (expected.instance_id && health.instance?.instance_id !== expected.instance_id) {
    throw new Error(`${label} instance identity does not match.`);
  }
  if (expected.credential_directory && path.resolve(health.client_auth?.credential_directory ?? "") !== path.resolve(expected.credential_directory)) {
    throw new Error(`${label} credential directory does not match.`);
  }
  if (expected.legacy_conversion !== undefined && health.client_auth?.legacy_conversion !== expected.legacy_conversion) {
    throw new Error(`${label} legacy-conversion mode does not match.`);
  }
}

function assertGatewayConfig(configPath, mode) {
  const config = fs.readFileSync(configPath, "utf8");
  if (!/^\{[\s\S]*?\bskip_install_trust\b/m.test(config)) {
    throw new Error("Gateway configuration permits automatic certificate trust installation.");
  }
  const hasMigration = config.includes("/api/client-auth/legacy-conversion/complete");
  if ((mode === "migration") !== hasMigration) throw new Error(`Gateway configuration is not in ${mode} mode.`);
}

function systemEffects() {
  return {
    health: readHealth,
    waitHealth: async (port, expected) => waitUntil(async () => {
      const health = await readHealth(port);
      try { assertHealth(health, expected, `port ${port}`); return true; } catch { return false; }
    }, `health on port ${port}`),
    portOpen,
    waitPort: (port) => waitUntil(() => portOpen(port), `listener on port ${port}`),
    validateGateway: (gateway) => {
      for (const spec of [gateway.configure, gateway.process, gateway.reload]) {
        if (!fs.existsSync(spec.command)) throw new Error(`Gateway executable is missing: ${spec.command}`);
      }
    },
    configureGateway: (gateway, mode) => {
      const args = mode === "migration" ? gateway.configure.migration_args : gateway.configure.normal_args;
      runSync({ ...gateway.configure, args });
    },
    reloadGateway: (gateway) => runSync(gateway.reload),
    startProcess: async (spec, envOverlay) => {
      if (spec.pid_file) {
        const stalePid = readPid(spec.pid_file);
        if (stalePid && processFingerprint(stalePid)) throw new Error(`Candidate PID file is still live: ${spec.pid_file}`);
        fs.rmSync(spec.pid_file, { force: true });
      }
      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: { ...spec.env, ...envOverlay },
        detached: true,
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      const daemonPid = spec.pid_file ? await waitForPidFile(spec.pid_file) : null;
      const ownedPid = daemonPid ?? child.pid ?? null;
      const fingerprint = ownedPid ? processFingerprint(ownedPid) : null;
      if (!fingerprint) throw new Error(`Started process has no verifiable identity: ${spec.command}`);
      return { launcher_pid: child.pid ?? null, daemon_pid: daemonPid, process_fingerprint: fingerprint };
    },
    controlIdentity: async (control) => control.type === "pid_file"
      ? processFingerprint(readPid(control.path))
      : digest({ command: control.command, args: control.args, cwd: control.cwd, env: control.env }),
    stopControl: async (control, fingerprint) => control.type === "pid_file"
      ? stopPid(readPid(control.path), fingerprint)
      : runSync(control),
    startControl: async (control) => control.type === "pid_file" ? runSync(control.restore) : runSync(control),
    stopPid,
  };
}

function validateProcess(spec, label) {
  if (!spec || typeof spec.command !== "string" || !path.isAbsolute(spec.command) || !Array.isArray(spec.args ?? [])) {
    throw new Error(`${label} requires an absolute command and argument array.`);
  }
  if (spec.cwd !== undefined && !path.isAbsolute(spec.cwd)) throw new Error(`${label} cwd must be absolute.`);
}

function validateControl(control, label) {
  if (control?.type === "pid_file") {
    if (!path.isAbsolute(control.path ?? "")) throw new Error(`${label} pid file must be absolute.`);
    if (label.includes("restore")) validateProcess(control.restore, label);
    return;
  }
  if (control?.type !== "command") throw new Error(`${label} must be a command or pid_file control.`);
  validateProcess(control, label);
}

function runSync(spec) {
  const result = spawnSync(spec.command, spec.args ?? [], { cwd: spec.cwd, env: spec.env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${spec.command} failed: ${(result.stderr || result.stdout || "no output").trim()}`);
}

function snapshotPath(filePath) {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) return { path: filePath, kind: "missing" };
  if (stats.isSymbolicLink()) return { path: filePath, kind: "symlink", target: fs.readlinkSync(filePath) };
  if (!stats.isFile()) throw new Error(`Rollback path must be a file or symlink: ${filePath}`);
  return { path: filePath, kind: "file", mode: stats.mode & 0o777, data: fs.readFileSync(filePath).toString("base64") };
}

function restoreSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    fs.rmSync(snapshot.path, { force: true });
    if (snapshot.kind === "missing") continue;
    fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
    if (snapshot.kind === "symlink") fs.symlinkSync(snapshot.target, snapshot.path);
    else fs.writeFileSync(snapshot.path, Buffer.from(snapshot.data, "base64"), { mode: snapshot.mode });
  }
}

function readJournal(journalPath) {
  const journal = readJson(journalPath);
  if (journal?.schema !== SCHEMA || !STATES.has(journal.state) ||
      digest(journal.manifest) !== journal.manifest_digest || digest(journal.rollback) !== journal.rollback_digest) {
    throw new Error(`Invalid or drifted cutover journal: ${journalPath}`);
  }
  return journal;
}

function advance(journal, state, fields) {
  return { ...journal, ...fields, state, revision: journal.revision + 1 };
}

function requireState(journal, expected) {
  if (journal.state !== expected) throw new Error(`Cutover is ${journal.state}; expected ${expected}.`);
}

function requireOneState(journal, expected) {
  if (!expected.includes(journal.state)) throw new Error(`Cutover is ${journal.state}; expected one of ${expected.join(", ")}.`);
}

function persistStep(journalPath, journal, fields) {
  const updated = advance(journal, journal.state, fields);
  writeJsonAtomic(journalPath, updated);
  return updated;
}

function publicState(journalPath, journal) {
  return { ok: true, schema: SCHEMA, id: journal.id, state: journal.state, revision: journal.revision, journal: journalPath, gateway_mode: journal.runtime?.gateway_mode ?? null };
}

function readJson(filePath) {
  if (!filePath) throw new Error("A manifest or journal path is required.");
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, resolved);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function defaultJournalPath() {
  const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.homedir(), ".mandible"));
  return path.join(home, "config", "local-sessions", "cutover.json");
}

function readHealth(port) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 1_000 }, (response) => {
      if (response.statusCode !== 200) { response.resume(); resolve(null); return; }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    request.on("timeout", () => { request.destroy(); resolve(null); });
    request.on("error", () => resolve(null));
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function waitUntil(test, label, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForPidFile(filePath) {
  await waitUntil(() => readPid(filePath) !== null, `PID file ${filePath}`);
  return readPid(filePath);
}

function readPid(filePath) {
  try {
    const pid = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch { return null; }
}

async function stopPid(pid, expectedFingerprint = null) {
  if (!pid) return;
  const actualFingerprint = processFingerprint(pid);
  if (!actualFingerprint) return;
  if (expectedFingerprint && actualFingerprint !== expectedFingerprint) {
    throw new Error(`Refusing to stop reused PID ${pid}; process identity changed.`);
  }
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; return; }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  await waitUntil(() => processFingerprint(pid) === null, `process ${pid} to exit`, 5_000);
}

function processFingerprint(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || null;
}

function parseArgs(argv) {
  const command = argv[0] ?? "status";
  const options = { command, manifest: null, journal: null, confirmCaTrusted: false, confirmBrowserConversion: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") options.manifest = argv[++index];
    else if (arg === "--journal") options.journal = argv[++index];
    else if (arg === "--confirm-ca-trusted") options.confirmCaTrusted = true;
    else if (arg === "--confirm-browser-conversion") options.confirmBrowserConversion = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}
