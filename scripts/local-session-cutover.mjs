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
const STATES = new Set(["preparing", "prepared", "activating", "migration", "completing", "normal_pending", "rolling_back", "complete", "rolled_back", "recovery_failed"]);
const PUBLIC_PORT = Object.freeze({ main: 19420, preview: 19421 });
const HEALTH_TIMEOUT_MS = 30_000;
const REGISTRATION_KEYS = ["instance_id", "installation_id", "role", "public_origin", "backend_origin", "backend_generation", "effect_ceiling_json", "writable_roots_json"];

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await runCli();

async function runCli() {
  try {
    const result = await runCutoverCommand(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}

export async function runCutoverCommand(options, effects = systemEffects()) {
  const journalPath = options.journal ?? defaultJournalPath();
  if (options.command === "prepare") return prepare(options, journalPath, effects);
  let journal = readJournal(journalPath);
  if (options.command === "status") return publicState(journalPath, journal);
  if (options.command === "activate") {
    if (!options.confirmCaTrusted) throw new Error("Activation requires --confirm-ca-trusted; the cutover never changes certificate trust.");
    try {
      journal = await activate(journalPath, journal, effects);
      return publicState(journalPath, journal);
    } catch (error) {
      if (error?.cutoverInterruption) throw error;
      const current = readJournal(journalPath);
      if (current.state === "normal_pending") throw error;
      const rollingBack = transition(journalPath, current, "rolling_back", { failure: messageOf(error) });
      try {
        await reconcileRollback(journalPath, rollingBack, effects);
      } catch (recoveryError) {
        const failed = transition(journalPath, readJournal(journalPath), "recovery_failed", { failure: messageOf(error), recovery_failure: messageOf(recoveryError), recovery_direction: "rollback" });
        throw new Error(`Cutover activation failed and rollback also failed: ${failed.recovery_failure}`);
      }
      throw new Error(`Cutover activation failed and legacy listeners were restored: ${messageOf(error)}`);
    }
  }
  if (options.command === "complete") {
    if (!options.confirmBrowserConversion) throw new Error("Completion requires --confirm-browser-conversion after every legacy browser has converted.");
    return publicState(journalPath, await complete(journalPath, journal, effects));
  }
  if (options.command === "rollback") return publicState(journalPath, await rollback(journalPath, journal, effects));
  throw new Error(`Unknown cutover command: ${options.command}`);
}

async function prepare(options, journalPath, effects) {
  const manifest = readJson(options.manifest);
  validateManifest(manifest);
  if (fs.existsSync(journalPath)) {
    const existing = readJournal(journalPath);
    if (existing.state === "preparing" && existing.manifest_digest === digest(manifest)) return publicState(journalPath, await reconcilePreparation(journalPath, existing));
    if (existing.state !== "complete" && existing.state !== "rolled_back") throw new Error(`Cutover journal is already active at ${journalPath}.`);
  }
  const legacy = {};
  for (const instance of manifest.instances) {
    const { health, listener } = await observeBoundListener(effects, instance.public_port, instance.legacy.expected, `legacy ${instance.role}`);
    legacy[instance.role] = { health_identity: healthIdentity(health), listener, stopped: false, restored_epoch: null };
  }
  await preflightCandidates(manifest, effects);
  const rollback = manifest.rollback_files.map(snapshotPath);
  const registrations = registrationCustody(manifest);
  const journal = {
    schema: SCHEMA, id: manifest.id, state: "preparing", revision: 1, manifest,
    manifest_digest: digest(manifest), rollback, rollback_digest: digest(rollback), registrations,
    registrations_digest: digest(registrations), legacy,
    runtime: { intents: {}, candidates: {}, gateway: null, gateway_mode: null },
    prepared_at: null, created_at: new Date().toISOString(),
  };
  writeJsonAtomic(journalPath, journal);
  return publicState(journalPath, await reconcilePreparation(journalPath, journal));
}

async function reconcilePreparation(journalPath, journal) {
  requireState(journal, "preparing");
  let working = beginIntent(journalPath, journal, "registrations.stage", { desired_digest: digest(journal.registrations.map((entry) => entry.desired)) });
  applyRegistrationCas(journal.manifest.authority_db, journal.registrations, "stage");
  working = finishIntent(journalPath, working, "registrations.stage");
  return transition(journalPath, working, "prepared", { prepared_at: new Date().toISOString() });
}

async function activate(journalPath, journal, effects) {
  requireOneState(journal, ["prepared", "activating"]);
  let working = journal.state === "prepared" ? transition(journalPath, journal, "activating", { activation_started_at: new Date().toISOString() }) : journal;
  if (!hasAnyStopIntent(working)) await revalidateLegacy(working, effects);
  for (const instance of working.manifest.instances) working = await ensureLegacyStopped(journalPath, working, instance, effects);
  for (const instance of working.manifest.instances) working = await ensureCandidate(journalPath, working, instance, true, effects);
  working = beginIntent(journalPath, working, "gateway.configure.migration", { mode: "migration" });
  effects.configureGateway(working.manifest.gateway, "migration");
  assertGatewayConfig(working.manifest.gateway.config_path, "migration");
  working = finishIntent(journalPath, working, "gateway.configure.migration");
  working = await ensureGatewayStarted(journalPath, working, effects);
  return transition(journalPath, working, "migration", { activated_at: new Date().toISOString() });
}

async function complete(journalPath, journal, effects) {
  requireOneState(journal, ["migration", "completing", "normal_pending", "recovery_failed"]);
  if (journal.state === "recovery_failed" && journal.recovery_direction !== "forward") throw new Error("Recovery is rollback-directed; run rollback instead of completion.");
  let working = journal.state === "migration" || journal.state === "completing"
    ? transition(journalPath, journal, "normal_pending", {
      completion_started_at: journal.completion_started_at ?? new Date().toISOString(),
      normal_pending_at: new Date().toISOString(),
      operator_confirmed_browser_conversion: true,
      runtime: { ...journal.runtime, gateway_mode: "normal_pending" },
    })
    : journal;
  try {
    for (const instance of working.manifest.instances) {
      if (working.runtime.candidates?.[instance.role]?.mode === "normal") {
        working = await ensureCandidate(journalPath, working, instance, false, effects);
        continue;
      }
      working = await ensureCandidateStopped(journalPath, working, instance, effects);
      working = await ensureCandidate(journalPath, working, instance, false, effects);
    }
    working = beginIntent(journalPath, working, "gateway.configure.normal", { mode: "normal" });
    effects.configureGateway(working.manifest.gateway, "normal");
    assertGatewayConfig(working.manifest.gateway.config_path, "normal");
    working = finishIntent(journalPath, working, "gateway.configure.normal");
    working = beginIntent(journalPath, working, "gateway.reload.normal", { mode: "normal" });
    effects.reloadGateway(working.manifest.gateway);
    for (const instance of working.manifest.instances) await effects.waitPort(instance.public_port);
    working = finishIntent(journalPath, working, "gateway.reload.normal");
    working = await promotePreview(journalPath, working);
    return transition(journalPath, working, "complete", { completed_at: new Date().toISOString(), operator_confirmed_browser_conversion: true, runtime: { ...working.runtime, gateway_mode: "normal" } });
  } catch (error) {
    if (error?.cutoverInterruption) throw error;
    const current = readJournal(journalPath);
    transition(journalPath, current, "recovery_failed", { failure: messageOf(error), recovery_direction: "forward", runtime: { ...current.runtime, gateway_mode: "normal_pending" } });
    throw new Error(`Normal-mode completion is forward-only and must be resumed: ${messageOf(error)}`);
  }
}

async function rollback(journalPath, journal, effects) {
  requireOneState(journal, ["preparing", "prepared", "activating", "migration", "completing", "rolling_back", "recovery_failed"]);
  if (journal.state === "recovery_failed" && journal.recovery_direction === "forward") throw new Error("Normal-mode activation is forward-only because legacy credentials may already be retired.");
  const working = journal.state === "rolling_back" ? journal : transition(journalPath, journal, "rolling_back", { rollback_started_at: new Date().toISOString() });
  try {
    return await reconcileRollback(journalPath, working, effects);
  } catch (error) {
    const current = readJournal(journalPath);
    transition(journalPath, current, "recovery_failed", { recovery_failure: messageOf(error), recovery_direction: "rollback" });
    throw new Error(`Cutover rollback failed and is resumable: ${messageOf(error)}`);
  }
}

async function reconcileRollback(journalPath, journal, effects) {
  let working = journal;
  working = await ensureGatewayStopped(journalPath, working, effects);
  for (const instance of [...working.manifest.instances].reverse()) working = await ensureCandidateStopped(journalPath, working, instance, effects);
  working = beginIntent(journalPath, working, "files.restore", { rollback_digest: working.rollback_digest });
  restoreSnapshots(working.rollback);
  working = finishIntent(journalPath, working, "files.restore");
  working = beginIntent(journalPath, working, "registrations.restore", { custody_digest: working.registrations_digest });
  applyRegistrationCas(working.manifest.authority_db, working.registrations, "restore");
  working = finishIntent(journalPath, working, "registrations.restore");
  for (const instance of [...working.manifest.instances].reverse()) working = await ensureLegacyRestored(journalPath, working, instance, effects);
  return transition(journalPath, working, "rolled_back", { rolled_back_at: new Date().toISOString() });
}

async function revalidateLegacy(journal, effects) {
  for (const instance of journal.manifest.instances) {
    const { health, listener } = await observeBoundListener(effects, instance.public_port, instance.legacy.expected, `legacy ${instance.role}`);
    if (!sameValue(healthIdentity(health), journal.legacy[instance.role].health_identity)) throw new Error(`Legacy ${instance.role} health identity changed after prepare.`);
    assertSameProcess(listener, journal.legacy[instance.role].listener, `legacy ${instance.role}`);
  }
}

async function ensureLegacyStopped(journalPath, journal, instance, effects) {
  const key = `legacy.${instance.role}.stop`;
  if (intentDone(journal, key)) return journal;
  let working = beginIntent(journalPath, journal, key, { listener: journal.legacy[instance.role].listener });
  const listener = await effects.discoverListener(instance.public_port);
  if (listener) {
    const observed = await observeBoundListener(effects, instance.public_port, instance.legacy.expected, `legacy ${instance.role}`);
    assertSameProcess(observed.listener, working.legacy[instance.role].listener, `legacy ${instance.role}`);
    await effects.stopPid(observed.listener.pid, observed.listener.fingerprint);
  }
  if (await effects.discoverListener(instance.public_port)) throw new Error(`Legacy ${instance.role} listener remained active after stop.`);
  working = finishIntent(journalPath, working, key);
  return persist(journalPath, working, { legacy: { ...working.legacy, [instance.role]: { ...working.legacy[instance.role], stopped: true } } });
}

async function ensureLegacyRestored(journalPath, journal, instance, effects) {
  const stopKey = `legacy.${instance.role}.stop`;
  const key = `legacy.${instance.role}.restore`;
  if (!intentDone(journal, stopKey) || intentDone(journal, key)) return journal;
  let working = beginIntent(journalPath, journal, key, { old_startup_epoch: instance.legacy.expected.startup_epoch });
  let listener = await effects.discoverListener(instance.public_port);
  let health = listener ? await effects.health(instance.public_port) : null;
  if (!listener) {
    await effects.startControl(instance.legacy.restore);
    await effects.waitHealth(instance.public_port, stableLegacyExpectation(instance));
  }
  const observed = await observeBoundListener(effects, instance.public_port, stableLegacyExpectation(instance), `restored legacy ${instance.role}`);
  health = observed.health;
  listener = observed.listener;
  if (!health.startup_epoch || health.startup_epoch === instance.legacy.expected.startup_epoch) throw new Error(`Restored legacy ${instance.role} did not prove a new startup epoch.`);
  working = finishIntent(journalPath, working, key, { listener, startup_epoch: health.startup_epoch });
  return persist(journalPath, working, { legacy: { ...working.legacy, [instance.role]: { ...working.legacy[instance.role], restored_epoch: health.startup_epoch } } });
}

async function ensureCandidate(journalPath, journal, instance, migration, effects) {
  const mode = migration ? "migration" : "normal";
  const key = `candidate.${instance.role}.${mode}.start`;
  const processToken = intentProcessToken(journal, key);
  let working = journal;
  if (intentDone(working, key)) {
    const existing = await effects.discoverListener(instance.candidate.backend_port);
    if (existing) {
      const observed = await observeBoundListener(effects, instance.candidate.backend_port, candidateExpectation(instance, migration), `candidate ${instance.role}`);
      assertSameProcess(observed.listener, working.runtime.intents[key].listener, `candidate ${instance.role}`);
      return working;
    }
    working = retryIntent(journalPath, working, key);
  }
  working = beginIntent(journalPath, working, key, { expectation: candidateExpectation(instance, migration), process_token: processToken });
  let listener = await effects.discoverListener(instance.candidate.backend_port);
  if (!listener) {
    if (await effects.portOpen(instance.candidate.backend_port)) throw new Error(`Candidate ${instance.role} backend port is occupied by an unidentified listener.`);
    const pendingProcess = await effects.discoverIntentProcess(processToken);
    if (!pendingProcess) {
      await effects.startProcess(instance.candidate.process, {
        ...(migration ? { MANDIBLE_LEGACY_CONVERSION: "allow" } : {}),
        MANDIBLE_CUTOVER_INTENT: processToken,
      });
    }
    await effects.waitHealth(instance.candidate.backend_port, candidateExpectation(instance, migration));
  }
  const observed = await observeBoundListener(effects, instance.candidate.backend_port, candidateExpectation(instance, migration), `candidate ${instance.role}`);
  listener = observed.listener;
  working = finishIntent(journalPath, working, key, { listener });
  return persist(journalPath, working, { runtime: { ...working.runtime, candidates: { ...working.runtime.candidates, [instance.role]: { mode, listener } } } });
}

async function ensureCandidateStopped(journalPath, journal, instance, effects) {
  const current = journal.runtime.candidates?.[instance.role];
  const key = `candidate.${instance.role}.${current?.mode ?? "any"}.stop`;
  if (intentDone(journal, key)) return journal;
  let working = beginIntent(journalPath, journal, key, { prior: current ?? null });
  const listener = await effects.discoverListener(instance.candidate.backend_port);
  if (listener) {
    const health = await effects.health(instance.candidate.backend_port);
    const migration = health?.client_auth?.legacy_conversion === true;
    const observed = await observeBoundListener(effects, instance.candidate.backend_port, candidateExpectation(instance, migration), `candidate ${instance.role}`);
    const mode = migration ? "migration" : "normal";
    const expected = current?.listener ?? working.runtime.intents[`candidate.${instance.role}.${mode}.start`]?.listener;
    if (expected) assertSameProcess(observed.listener, expected, `candidate ${instance.role}`);
    await effects.stopPid(observed.listener.pid, observed.listener.fingerprint);
  }
  for (const mode of ["migration", "normal"]) {
    const startKey = `candidate.${instance.role}.${mode}.start`;
    if (!working.runtime.intents[startKey]) continue;
    const pendingProcess = await effects.discoverIntentProcess(intentProcessToken(working, startKey));
    if (pendingProcess) await effects.stopPid(pendingProcess.pid, pendingProcess.fingerprint);
  }
  if (await effects.discoverListener(instance.candidate.backend_port)) throw new Error(`Candidate ${instance.role} remained active after stop.`);
  working = finishIntent(journalPath, working, key);
  const candidates = { ...working.runtime.candidates };
  delete candidates[instance.role];
  return persist(journalPath, working, { runtime: { ...working.runtime, candidates } });
}

async function ensureGatewayStarted(journalPath, journal, effects) {
  const key = "gateway.start.migration";
  const processToken = intentProcessToken(journal, key);
  let working = journal;
  if (intentDone(working, key)) {
    const existing = await discoverGateway(working.manifest, effects);
    if (existing) {
      assertSameProcess(existing, working.runtime.gateway ?? working.runtime.intents[key].listener, "gateway");
      return working;
    }
    working = retryIntent(journalPath, working, key);
  }
  working = beginIntent(journalPath, working, key, { mode: "migration", process_token: processToken });
  let listener = await discoverGateway(working.manifest, effects);
  if (listener && !working.runtime.gateway && !effects.matchesProcess(listener, working.manifest.gateway.process)) throw new Error("Public ports are owned by a process that does not match the gateway start intent.");
  if (!listener) {
    const pendingProcess = await effects.discoverIntentProcess(processToken);
    if (!pendingProcess) await effects.startProcess(working.manifest.gateway.process, { MANDIBLE_CUTOVER_INTENT: processToken });
    for (const instance of working.manifest.instances) await effects.waitPort(instance.public_port);
    listener = await discoverGateway(working.manifest, effects);
  }
  if (!listener) throw new Error("Migration gateway has no single discoverable listener process.");
  working = finishIntent(journalPath, working, key, { listener });
  return persist(journalPath, working, { runtime: { ...working.runtime, gateway: listener, gateway_mode: "migration" } });
}

async function ensureGatewayStopped(journalPath, journal, effects) {
  const key = "gateway.stop";
  if (intentDone(journal, key)) return journal;
  let working = beginIntent(journalPath, journal, key, { prior: journal.runtime.gateway ?? null });
  if (!working.runtime.intents["gateway.start.migration"] && !working.runtime.gateway) {
    return finishIntent(journalPath, working, key, { result: "never-started" });
  }
  const listener = await discoverGateway(working.manifest, effects, { allowPartial: true });
  if (listener) {
    const expected = working.runtime.gateway ?? working.runtime.intents["gateway.start.migration"]?.listener;
    if (expected) assertSameProcess(listener, expected, "gateway");
    else if (!effects.matchesProcess(listener, working.manifest.gateway.process)) throw new Error("Public ports are not owned by the journaled gateway process.");
    await effects.stopPid(listener.pid, listener.fingerprint);
  }
  const pendingProcess = await effects.discoverIntentProcess(intentProcessToken(working, "gateway.start.migration"));
  if (pendingProcess) await effects.stopPid(pendingProcess.pid, pendingProcess.fingerprint);
  for (const instance of working.manifest.instances) if (await effects.discoverListener(instance.public_port)) throw new Error(`Gateway public port ${instance.public_port} remained active after stop.`);
  working = finishIntent(journalPath, working, key);
  return persist(journalPath, working, { runtime: { ...working.runtime, gateway: null, gateway_mode: null } });
}

async function discoverGateway(manifest, effects, { allowPartial = false } = {}) {
  const listeners = [];
  for (const instance of manifest.instances) {
    const listener = await effects.discoverListener(instance.public_port);
    if (listener) listeners.push(listener);
  }
  if (listeners.length === 0) return null;
  if (!allowPartial && listeners.length !== manifest.instances.length) throw new Error("Gateway owns only part of the public listener set.");
  for (const listener of listeners.slice(1)) assertSameProcess(listener, listeners[0], "gateway public listeners");
  return listeners[0];
}

async function promotePreview(journalPath, journal) {
  const promotion = journal.manifest.preview_promotion;
  const key = "preview.promote";
  let working = journal;
  if (intentDone(working, key)) {
    if (previewPromotionMatches(promotion)) return working;
    working = retryIntent(journalPath, working, key);
  }
  working = beginIntent(journalPath, working, key, { desired_digest: digest(promotion) });
  writeJsonAtomic(promotion.metadata_path, promotion.metadata);
  replaceSymlink(promotion.current_db_target, promotion.current_db_path);
  if (!previewPromotionMatches(promotion)) throw new Error("Preview promotion did not materialize its exact metadata and database target.");
  return finishIntent(journalPath, working, key);
}

function previewPromotionMatches(promotion) {
  try {
    const resolvedTarget = path.resolve(path.dirname(promotion.current_db_path), fs.readlinkSync(promotion.current_db_path));
    return digest(readJson(promotion.metadata_path)) === digest(promotion.metadata) && resolvedTarget === path.resolve(promotion.current_db_target);
  } catch {
    return false;
  }
}

async function preflightCandidates(manifest, effects) {
  for (const instance of manifest.instances) {
    if (!fs.existsSync(instance.candidate.process.command)) throw new Error(`Candidate ${instance.role} executable is missing: ${instance.candidate.process.command}`);
    if (instance.candidate.process.cwd && !fs.statSync(instance.candidate.process.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Candidate ${instance.role} working directory is missing: ${instance.candidate.process.cwd}`);
    if (!fs.existsSync(instance.candidate.process.env.MANDIBLE_DB)) throw new Error(`Candidate ${instance.role} database is missing: ${instance.candidate.process.env.MANDIBLE_DB}`);
    if (!fs.existsSync(instance.legacy.credential_directory)) throw new Error(`Legacy ${instance.role} credential directory is missing: ${instance.legacy.credential_directory}`);
    if (path.resolve(instance.candidate.credential_directory) !== path.resolve(instance.legacy.credential_directory)) throw new Error(`Candidate ${instance.role} must retain the exact legacy credential directory.`);
    if (await effects.portOpen(instance.candidate.backend_port)) throw new Error(`Candidate ${instance.role} backend port ${instance.candidate.backend_port} is occupied.`);
  }
  effects.validateGateway(manifest.gateway);
}

function registrationCustody(manifest) {
  if (!fs.existsSync(manifest.authority_db)) throw new Error(`Session authority database is missing: ${manifest.authority_db}`);
  const db = new Database(manifest.authority_db, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instance_registrations'").get()) throw new Error("Session authority database has no instance_registrations table.");
    return manifest.instances.map((instance) => {
      const desired = registrationFromInstance(instance);
      const before = normalizeRegistration(db.prepare("SELECT * FROM instance_registrations WHERE instance_id = ?").get(desired.instance_id));
      if (before) for (const key of ["installation_id", "role", "public_origin"]) if (before[key] !== desired[key]) throw new Error(`Durable registration drift for ${desired.instance_id}: ${key}.`);
      return { instance_id: desired.instance_id, before, desired };
    });
  } finally { db.close(); }
}

function applyRegistrationCas(databasePath, custody, direction) {
  const db = new Database(databasePath);
  try {
    db.transaction(() => {
      for (const entry of custody) {
        const current = normalizeRegistration(db.prepare("SELECT * FROM instance_registrations WHERE instance_id = ?").get(entry.instance_id));
        const from = direction === "stage" ? entry.before : entry.desired;
        const to = direction === "stage" ? entry.desired : entry.before;
        if (sameValue(current, to)) continue;
        if (!sameValue(current, from)) throw new Error(`Registration CAS drift for ${entry.instance_id} during ${direction}.`);
        if (!to) db.prepare("DELETE FROM instance_registrations WHERE instance_id = ?").run(entry.instance_id);
        else writeRegistration(db, to);
      }
    })();
  } finally { db.close(); }
}

function writeRegistration(db, row) {
  db.prepare(`INSERT INTO instance_registrations (
    instance_id, installation_id, role, public_origin, backend_origin,
    backend_generation, effect_ceiling_json, writable_roots_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(instance_id) DO UPDATE SET
    installation_id=excluded.installation_id, role=excluded.role, public_origin=excluded.public_origin,
    backend_origin=excluded.backend_origin, backend_generation=excluded.backend_generation,
    effect_ceiling_json=excluded.effect_ceiling_json, writable_roots_json=excluded.writable_roots_json,
    updated_at=excluded.updated_at`).run(...REGISTRATION_KEYS.map((key) => row[key]), row.updated_at);
}

function registrationFromInstance(instance) {
  const env = instance.candidate.process.env;
  return { instance_id: instance.candidate.instance_id, installation_id: env.MANDIBLE_INSTALLATION_ID, role: instance.role, public_origin: env.MANDIBLE_PUBLIC_ORIGIN, backend_origin: `http://127.0.0.1:${instance.candidate.backend_port}`, backend_generation: env.MANDIBLE_BACKEND_GENERATION, effect_ceiling_json: env.MANDIBLE_ALLOWED_EFFECTS, writable_roots_json: env.MANDIBLE_WRITABLE_ROOTS, updated_at: Date.now() };
}

function normalizeRegistration(row) { return row ? Object.fromEntries([...REGISTRATION_KEYS, "updated_at"].map((key) => [key, row[key]])) : null; }

function candidateExpectation(instance, migration) {
  const env = instance.candidate.process.env;
  return { role: instance.role, instance_id: instance.candidate.instance_id, installation_id: env.MANDIBLE_INSTALLATION_ID, public_origin: env.MANDIBLE_PUBLIC_ORIGIN, backend_generation: env.MANDIBLE_BACKEND_GENERATION, allowed_effects: JSON.parse(env.MANDIBLE_ALLOWED_EFFECTS), writable_roots: JSON.parse(env.MANDIBLE_WRITABLE_ROOTS), credential_directory: instance.candidate.credential_directory, legacy_conversion: migration, startup_commit_hash: instance.candidate.commit, db_path: env.MANDIBLE_DB };
}

function stableLegacyExpectation(instance) { const { startup_epoch: _ignored, ...stable } = instance.legacy.expected; return stable; }

function healthIdentity(health) {
  return {
    startup_epoch: health.startup_epoch,
    startup_commit_hash: health.startup_commit?.hash ?? null,
    role: health.instance?.role ?? null,
    instance_id: health.instance?.instance_id ?? null,
    installation_id: health.instance?.installation_id ?? null,
    public_origin: health.instance?.public_origin ?? null,
    backend_generation: health.instance?.backend_generation ?? null,
    db_path: health.instance?.db_path ? path.resolve(health.instance.db_path) : null,
  };
}

function assertHealth(health, expected, label) {
  if (!health || health.ready !== true || health.warm !== true || health.instance?.role !== expected.role) throw new Error(`${label} is not ready and warm with role ${expected.role}.`);
  if (expected.startup_epoch && health.startup_epoch !== expected.startup_epoch) throw new Error(`${label} startup epoch changed.`);
  if (expected.startup_commit_hash && health.startup_commit?.hash !== expected.startup_commit_hash) throw new Error(`${label} startup commit does not match.`);
  for (const key of ["instance_id", "installation_id", "public_origin", "backend_generation"]) if (expected[key] !== undefined && health.instance?.[key] !== expected[key]) throw new Error(`${label} ${key} does not match.`);
  for (const key of ["allowed_effects", "writable_roots"]) if (expected[key] !== undefined && !sameValue(health.instance?.[key], expected[key])) throw new Error(`${label} ${key} does not match.`);
  if (expected.db_path && path.resolve(health.instance?.db_path ?? "") !== path.resolve(expected.db_path)) throw new Error(`${label} database does not match.`);
  if (expected.credential_directory && path.resolve(health.client_auth?.credential_directory ?? "") !== path.resolve(expected.credential_directory)) throw new Error(`${label} credential directory does not match.`);
  if (expected.legacy_conversion !== undefined && health.client_auth?.legacy_conversion !== expected.legacy_conversion) throw new Error(`${label} legacy-conversion mode does not match.`);
}

function validateManifest(manifest) {
  if (manifest?.schema !== SCHEMA || typeof manifest.id !== "string" || !manifest.id) throw new Error(`Cutover manifest must use ${SCHEMA} and have a non-empty id.`);
  if (!Array.isArray(manifest.instances) || manifest.instances.length !== 2) throw new Error("Cutover manifest must contain exactly one production and one preview instance.");
  const roles = new Set(manifest.instances.map((entry) => entry.role));
  if (roles.size !== 2 || !roles.has("main") || !roles.has("preview")) throw new Error("Cutover manifest must contain exactly the main and preview roles.");
  const backendPorts = new Set();
  for (const instance of manifest.instances) {
    if (instance.public_port !== PUBLIC_PORT[instance.role]) throw new Error(`${instance.role} public port must remain ${PUBLIC_PORT[instance.role]}.`);
    const backend = instance.candidate?.backend_port;
    if (!Number.isInteger(backend) || backend < 1024 || backend === 19420 || backend === 19421 || backendPorts.has(backend)) throw new Error("Candidate backends must use distinct non-public loopback ports.");
    backendPorts.add(backend);
    validateProcess(instance.candidate.process, `candidate ${instance.role}`);
    validateProcess(instance.legacy.restore, `legacy ${instance.role} restore`);
    if (!instance.legacy.expected?.startup_epoch || instance.legacy.expected.role !== instance.role) throw new Error(`Legacy ${instance.role} requires an exact startup epoch and role.`);
    for (const key of ["startup_commit_hash", "instance_id", "installation_id", "public_origin", "backend_generation", "db_path"]) {
      if (!instance.legacy.expected[key]) throw new Error(`Legacy ${instance.role} health proof is missing ${key}.`);
    }
    const env = instance.candidate.process.env ?? {};
    if (env.MANDIBLE_LEGACY_CONVERSION !== undefined) throw new Error("Candidate process env must not hard-code migration mode; the state machine owns it.");
    if (env.MANDIBLE_PORT !== String(backend) || env.MANDIBLE_INSTANCE_ROLE !== instance.role) throw new Error(`Candidate ${instance.role} process env does not match its backend and role.`);
    if (!instance.candidate.instance_id || env.MANDIBLE_INSTANCE_ID !== instance.candidate.instance_id) throw new Error(`Candidate ${instance.role} process env does not match its durable instance identity.`);
    if (!instance.candidate.commit || instance.candidate.commit !== env.MANDIBLE_BACKEND_GENERATION || !env.MANDIBLE_DB) throw new Error(`Candidate ${instance.role} commit, backend generation, and database must be pinned consistently.`);
    if (path.resolve(env.MANDIBLE_CLIENT_AUTH_DIR ?? "") !== path.resolve(instance.candidate.credential_directory ?? "")) throw new Error(`Candidate ${instance.role} process env does not pin its credential directory.`);
    for (const key of ["MANDIBLE_INSTALLATION_ID", "MANDIBLE_PUBLIC_ORIGIN", "MANDIBLE_BACKEND_GENERATION", "MANDIBLE_ALLOWED_EFFECTS", "MANDIBLE_WRITABLE_ROOTS"]) if (!env[key]) throw new Error(`Candidate ${instance.role} process env is missing ${key}.`);
    for (const key of ["MANDIBLE_ALLOWED_EFFECTS", "MANDIBLE_WRITABLE_ROOTS"]) if (!Array.isArray(JSON.parse(env[key]))) throw new Error(`Candidate ${instance.role} ${key} must be a JSON array.`);
    const publicOrigin = new URL(env.MANDIBLE_PUBLIC_ORIGIN);
    if (publicOrigin.protocol !== "https:" || Number(publicOrigin.port) !== instance.public_port) throw new Error(`Candidate ${instance.role} public origin must use HTTPS on ${instance.public_port}.`);
  }
  validateProcess(manifest.gateway?.process, "gateway");
  validateProcess(manifest.gateway?.configure, "gateway configure");
  validateProcess(manifest.gateway?.reload, "gateway reload");
  for (const key of ["migration_args", "normal_args"]) if (!Array.isArray(manifest.gateway?.configure?.[key])) throw new Error(`Gateway configure ${key} must be an argument array.`);
  if (!path.isAbsolute(manifest.authority_db ?? "")) throw new Error("authority_db must be absolute.");
  if (!path.isAbsolute(manifest.gateway?.config_path ?? "")) throw new Error("Gateway config_path must be absolute.");
  if (!Array.isArray(manifest.rollback_files)) throw new Error("rollback_files must be an array.");
  if (new Set(manifest.rollback_files.map((filePath) => path.resolve(filePath))).size !== manifest.rollback_files.length) throw new Error("rollback_files must not contain duplicate paths.");
  for (const filePath of manifest.rollback_files) if (!path.isAbsolute(filePath)) throw new Error(`Rollback path must be absolute: ${filePath}`);
  const promotion = manifest.preview_promotion;
  if (!promotion || !path.isAbsolute(promotion.metadata_path ?? "") || !path.isAbsolute(promotion.current_db_path ?? "") || !path.isAbsolute(promotion.current_db_target ?? "") || !promotion.metadata) throw new Error("preview_promotion must pin absolute metadata/current.db paths, target, and metadata.");
  if (!manifest.rollback_files.includes(promotion.metadata_path) || !manifest.rollback_files.includes(promotion.current_db_path)) throw new Error("Preview promotion paths must have rollback custody.");
  if (!manifest.rollback_files.includes(manifest.gateway.config_path)) throw new Error("Gateway configuration must have rollback custody.");
  const preview = manifest.instances.find((entry) => entry.role === "preview");
  if (path.resolve(preview.candidate.process.env.MANDIBLE_DB) !== path.resolve(promotion.current_db_target)) throw new Error("Preview promotion target must be the candidate preview database.");
  if (promotion.metadata.port !== preview.candidate.backend_port || path.resolve(promotion.metadata.db ?? "") !== path.resolve(promotion.current_db_target)) throw new Error("Preview promotion metadata must describe the candidate backend and database.");
  if (!preview.candidate.process.env.MANDIBLE_PID_FILE || promotion.metadata.pidFile !== preview.candidate.process.env.MANDIBLE_PID_FILE) throw new Error("Preview promotion metadata must pin the candidate PID file.");
  if (!preview.candidate.process.env.MANDIBLE_PREVIEW_ROOT || promotion.metadata.previewRoot !== preview.candidate.process.env.MANDIBLE_PREVIEW_ROOT) throw new Error("Preview promotion metadata must pin the candidate preview root.");
  for (const key of Object.keys(preview.candidate.process.env).filter((key) => key.startsWith("MANDIBLE_"))) {
    if (promotion.metadata.instanceEnv?.[key] !== preview.candidate.process.env[key]) throw new Error(`Preview promotion metadata does not pin candidate ${key}.`);
  }
}

function assertGatewayConfig(configPath, mode) {
  const config = fs.readFileSync(configPath, "utf8");
  if (!/^\{[\s\S]*?\bskip_install_trust\b/m.test(config)) throw new Error("Gateway configuration permits automatic certificate trust installation.");
  const hasMigration = config.includes("/api/client-auth/legacy-conversion/complete");
  if ((mode === "migration") !== hasMigration) throw new Error(`Gateway configuration is not in ${mode} mode.`);
}

function beginIntent(journalPath, journal, key, details = {}) {
  if (journal.runtime.intents[key]) return journal;
  return persist(journalPath, journal, { runtime: { ...journal.runtime, intents: { ...journal.runtime.intents, [key]: { status: "pending", created_at: new Date().toISOString(), ...details } } } });
}

function finishIntent(journalPath, journal, key, receipt = {}) {
  if (intentDone(journal, key)) return journal;
  return persist(journalPath, journal, { runtime: { ...journal.runtime, intents: { ...journal.runtime.intents, [key]: { ...journal.runtime.intents[key], status: "done", completed_at: new Date().toISOString(), ...receipt } } } });
}

function retryIntent(journalPath, journal, key) {
  const prior = journal.runtime.intents[key];
  return persist(journalPath, journal, { runtime: { ...journal.runtime, intents: { ...journal.runtime.intents, [key]: { ...prior, status: "pending", retry_count: (prior.retry_count ?? 0) + 1, retried_at: new Date().toISOString() } } } });
}

function intentDone(journal, key) { return journal.runtime.intents[key]?.status === "done"; }
function hasAnyStopIntent(journal) { return journal.manifest.instances.some((instance) => journal.runtime.intents[`legacy.${instance.role}.stop`]); }
function intentProcessToken(journal, key) { return digest({ cutover: journal.id, key }).slice(0, 32); }

function systemEffects() {
  return {
    health: readHealth,
    waitHealth: async (port, expected) => {
      let result = null;
      await waitUntil(async () => { const health = await readHealth(port); try { assertHealth(health, expected, `port ${port}`); result = health; return true; } catch { return false; } }, `health on port ${port}`);
      return result;
    },
    portOpen,
    waitPort: (port) => waitUntil(() => portOpen(port), `listener on port ${port}`),
    discoverListener,
    discoverIntentProcess,
    matchesProcess: (listener, spec) => listener.fingerprint.endsWith([spec.command, ...(spec.args ?? [])].join(" ")),
    validateGateway: (gateway) => { for (const spec of [gateway.configure, gateway.process, gateway.reload]) if (!fs.existsSync(spec.command)) throw new Error(`Gateway executable is missing: ${spec.command}`); },
    configureGateway: (gateway, mode) => runSync({ ...gateway.configure, args: mode === "migration" ? gateway.configure.migration_args : gateway.configure.normal_args }),
    reloadGateway: (gateway) => runSync(gateway.reload),
    startProcess: async (spec, envOverlay) => {
      const child = spawn(spec.command, spec.args ?? [], { cwd: spec.cwd, env: { ...spec.env, ...envOverlay }, detached: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
    },
    startControl: async (control) => runSync(control),
    stopPid,
  };
}

function discoverListener(port) {
  const executable = ["/usr/sbin/lsof", "/opt/homebrew/sbin/lsof", "/opt/homebrew/bin/lsof"].find(fs.existsSync);
  if (!executable) throw new Error("lsof is required to bind listener effects to exact processes.");
  const result = spawnSync(executable, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) throw new Error(`lsof failed for port ${port}: ${result.stderr.trim()}`);
  const pids = [...new Set(result.stdout.split(/\s+/).filter(Boolean).map(Number))];
  if (pids.length === 0) return null;
  if (pids.length !== 1) throw new Error(`Port ${port} has multiple listener processes.`);
  const fingerprint = processFingerprint(pids[0]);
  if (!fingerprint) throw new Error(`Port ${port} listener process vanished during discovery.`);
  return { pid: pids[0], fingerprint };
}

function discoverIntentProcess(token) {
  const result = spawnSync("ps", ["eww", "-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Process intent discovery failed: ${result.stderr.trim()}`);
  const marker = `MANDIBLE_CUTOVER_INTENT=${token}`;
  const matches = result.stdout.split("\n").flatMap((line) => {
    if (!line.includes(marker)) return [];
    const match = /^\s*(\d+)\s+/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  const pids = [...new Set(matches)];
  if (pids.length === 0) return null;
  if (pids.length !== 1) throw new Error(`Cutover process intent ${token} has multiple live processes.`);
  const fingerprint = processFingerprint(pids[0]);
  return fingerprint ? { pid: pids[0], fingerprint } : null;
}

function validateProcess(spec, label) {
  if (!spec || typeof spec.command !== "string" || !path.isAbsolute(spec.command) || !Array.isArray(spec.args ?? [])) throw new Error(`${label} requires an absolute command and argument array.`);
  if (spec.cwd !== undefined && !path.isAbsolute(spec.cwd)) throw new Error(`${label} cwd must be absolute.`);
}

function runSync(spec) { const result = spawnSync(spec.command, spec.args ?? [], { cwd: spec.cwd, env: spec.env, encoding: "utf8" }); if (result.status !== 0) throw new Error(`${spec.command} failed: ${(result.stderr || result.stdout || "no output").trim()}`); }

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
    if (snapshot.kind === "symlink") replaceSymlink(snapshot.target, snapshot.path);
    else fs.writeFileSync(snapshot.path, Buffer.from(snapshot.data, "base64"), { mode: snapshot.mode });
  }
}

function replaceSymlink(target, linkPath) { fs.mkdirSync(path.dirname(linkPath), { recursive: true }); const temporary = `${linkPath}.tmp-${process.pid}`; fs.rmSync(temporary, { force: true }); fs.symlinkSync(target, temporary); fs.renameSync(temporary, linkPath); }

function readJournal(journalPath) {
  const journal = readJson(journalPath);
  if (journal?.schema !== SCHEMA || !STATES.has(journal.state) || digest(journal.manifest) !== journal.manifest_digest || digest(journal.rollback) !== journal.rollback_digest || digest(journal.registrations) !== journal.registrations_digest) throw new Error(`Invalid or drifted cutover journal: ${journalPath}`);
  return journal;
}

function transition(journalPath, journal, state, fields = {}) { const updated = { ...journal, ...fields, state, revision: journal.revision + 1 }; writeJsonAtomic(journalPath, updated); return updated; }
function persist(journalPath, journal, fields) { return transition(journalPath, journal, journal.state, fields); }
function requireState(journal, expected) { if (journal.state !== expected) throw new Error(`Cutover is ${journal.state}; expected ${expected}.`); }
function requireOneState(journal, expected) { if (!expected.includes(journal.state)) throw new Error(`Cutover is ${journal.state}; expected one of ${expected.join(", ")}.`); }
function publicState(journalPath, journal) { return { ok: true, schema: SCHEMA, id: journal.id, state: journal.state, revision: journal.revision, journal: journalPath, gateway_mode: journal.runtime?.gateway_mode ?? null }; }
function readJson(filePath) { if (!filePath) throw new Error("A manifest or journal path is required."); return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")); }
function writeJsonAtomic(filePath, value) { const resolved = path.resolve(filePath); fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 }); const temporary = `${resolved}.tmp-${process.pid}`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, resolved); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sameValue(left, right) { return digest(left) === digest(right); }
function messageOf(error) { return error instanceof Error ? error.message : String(error); }
function defaultJournalPath() { return path.join(path.resolve(process.env.MANDIBLE_HOME || path.join(os.homedir(), ".mandible")), "config", "local-sessions", "cutover.json"); }
function assertSameProcess(actual, expected, label) { if (!actual || !expected || actual.pid !== expected.pid || actual.fingerprint !== expected.fingerprint) throw new Error(`${label} listener process identity changed.`); }

async function observeBoundListener(effects, port, expected, label) {
  const before = await effects.discoverListener(port);
  if (!before) throw new Error(`${label} has no discoverable listener process.`);
  const health = await effects.health(port);
  assertHealth(health, expected, label);
  const after = await effects.discoverListener(port);
  assertSameProcess(after, before, label);
  return { health, listener: after };
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

function portOpen(port) { return new Promise((resolve) => { const socket = net.createConnection({ host: "127.0.0.1", port }); socket.setTimeout(500); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("timeout", () => { socket.destroy(); resolve(false); }); socket.once("error", () => resolve(false)); }); }
async function waitUntil(test, label, timeoutMs = HEALTH_TIMEOUT_MS) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await test()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out waiting for ${label}.`); }

async function stopPid(pid, expectedFingerprint) {
  if (!pid) return;
  const actual = processFingerprint(pid);
  if (!actual) return;
  if (!expectedFingerprint || actual !== expectedFingerprint) throw new Error(`Refusing to stop PID ${pid}; process identity is not the health-bound receipt.`);
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; return; }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { return; } await new Promise((resolve) => setTimeout(resolve, 100)); }
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  await waitUntil(() => processFingerprint(pid) === null, `process ${pid} to exit`, 5_000);
}

function processFingerprint(pid) { const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" }); const value = result.status === 0 ? result.stdout.trim() : ""; return value || null; }

function parseArgs(argv) {
  const options = { command: argv[0] ?? "status", manifest: null, journal: null, confirmCaTrusted: false, confirmBrowserConversion: false };
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
