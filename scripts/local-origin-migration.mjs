#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { PRODUCTION_ORIGIN } from "./canonical-origin.mjs";
import { assertLocalCaIdentity, localCaPaths } from "./local-ca-trust.mjs";

const OLD_ORIGIN = "https://app.mandible.localhost:19420";
const SCHEMA = "mandible-local-origin-migration@1";
const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.homedir(), ".mandible"));
const authorityDir = path.join(home, "config", "local-sessions");
const authorityDb = path.join(authorityDir, "sessions.db");
const journalPath = path.join(authorityDir, "origin-migration.json");
const authorityIdPath = path.join(home, "config", "client-auth", "authority-id");
const command = process.argv[2] ?? "inspect";

function readJournal() {
  if (!fs.existsSync(journalPath)) return null;
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (journal.schema !== SCHEMA || journal.old_origin !== OLD_ORIGIN
      || journal.new_origin !== PRODUCTION_ORIGIN || journal.instance_id !== "production"
      || !["prepared", "staged", "rolled_back", "complete"].includes(journal.state)) {
    throw new Error("Origin migration journal is incompatible; preserve it for inspection.");
  }
  return journal;
}

function writeJournal(journal) {
  fs.mkdirSync(authorityDir, { recursive: true, mode: 0o700 });
  const temporary = `${journalPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, journalPath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

function registeredProduction(db) {
  const row = db.prepare("SELECT * FROM instance_registrations WHERE instance_id = 'production'").get();
  if (!row || row.role !== "main") throw new Error("Production session registration is missing or not main.");
  const installationId = fs.readFileSync(authorityIdPath, "utf8").trim();
  if (!installationId || row.installation_id !== installationId) {
    throw new Error("Production registration does not match the installation authority.");
  }
  return row;
}

function requireStopped(row) {
  const ports = new Set([443, 19420, Number(new URL(row.backend_origin).port)]);
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Registered backend port is invalid.");
    const result = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    if (result.status === 0 || result.stdout.trim()) throw new Error(`Port ${port} still has a listener; stop the exact daemon and gateway before changing registration.`);
    if (result.status !== 1) throw new Error(`Could not inspect port ${port}: ${result.stderr.trim()}`);
  }
}

export function updateOrigin(db, from, to, expected) {
  const result = db.prepare(`UPDATE instance_registrations SET public_origin = ?, updated_at = ?
    WHERE instance_id = 'production' AND public_origin = ? AND installation_id = ?
      AND role = 'main' AND backend_origin = ? AND backend_generation = ?
      AND effect_ceiling_json = ? AND writable_roots_json = ?`)
    .run(to, Date.now(), from, expected.installation_id, expected.backend_origin,
      expected.backend_generation, expected.effect_ceiling_json, expected.writable_roots_json);
  if (result.changes !== 1) throw new Error("Production origin changed during the guarded update.");
}

function verifyFinalOrigin(journal) {
  const ca = assertLocalCaIdentity(localCaPaths(home));
  if (ca.state !== "trusted") throw new Error("The installation-owned local CA is not trusted.");
  const rootCert = localCaPaths(home).rootCert;
  const response = spawnSync("/usr/bin/curl", [
    "--silent", "--show-error", "--fail", "--connect-timeout", "2", "--max-time", "5",
    "--cacert", rootCert, "--resolve", "mandible.localhost:443:127.0.0.1",
    `${PRODUCTION_ORIGIN}/api/health`,
  ], { encoding: "utf8" });
  if (response.status !== 0) throw new Error(`Final HTTPS health check failed: ${response.stderr.trim()}`);
  const health = JSON.parse(response.stdout);
  if (health?.instance?.instance_id !== journal.instance_id
      || health?.instance?.installation_id !== journal.installation_id
      || health?.instance?.public_origin !== PRODUCTION_ORIGIN || health.ready !== true) {
    throw new Error("Final HTTPS health is not ready under the retained production identity.");
  }
  const configPath = path.join(authorityDir, "Caddyfile");
  const config = fs.readFileSync(configPath, "utf8");
  if (config.includes("X-Mandible-Origin-Migration")
      || config.includes(`${OLD_ORIGIN} {`)) {
    throw new Error("The temporary old-origin gateway route is still configured.");
  }
  const old = spawnSync("/usr/bin/curl", [
    "--silent", "--show-error", "--connect-timeout", "2", "--max-time", "5",
    "--cacert", rootCert, "--resolve", "app.mandible.localhost:19420:127.0.0.1",
    OLD_ORIGIN,
  ], { encoding: "utf8" });
  if (old.status === 0 && old.stdout.includes("Move this browser to Mandible")) {
    throw new Error("The temporary old-origin page is still live.");
  }
}

function inspect(db, journal) {
  const row = registeredProduction(db);
  return { journal: journal?.state ?? "none", origin: row.public_origin,
    installation_id: row.installation_id, backend_origin: row.backend_origin,
    effect_ceiling: JSON.parse(row.effect_ceiling_json), writable_roots: JSON.parse(row.writable_roots_json) };
}

function runCli() {
if (!fs.existsSync(authorityDb)) throw new Error(`Session authority database is missing: ${authorityDb}`);
const db = new Database(authorityDb, { readonly: command === "inspect", fileMustExist: true });
try {
  const journal = readJournal();
  const row = registeredProduction(db);
  if (command === "inspect") {
    process.stdout.write(`${JSON.stringify(inspect(db, journal))}\n`);
  } else if (command === "stage") {
    if (journal?.state === "complete" || journal?.state === "rolled_back") throw new Error("This origin migration is terminal.");
    requireStopped(row);
    if (!journal) {
      if (row.public_origin !== OLD_ORIGIN) throw new Error("Production is not registered at the exact old origin.");
      if (assertLocalCaIdentity(localCaPaths(home)).state !== "trusted") {
        throw new Error("The installation-owned local CA is not trusted.");
      }
      writeJournal({ schema: SCHEMA, state: "prepared", old_origin: OLD_ORIGIN,
        new_origin: PRODUCTION_ORIGIN, instance_id: "production",
        installation_id: row.installation_id, prepared_at: Date.now() });
    } else if (journal.installation_id !== row.installation_id) {
      throw new Error("Installation authority drifted after migration preparation.");
    }
    if (row.public_origin === OLD_ORIGIN) updateOrigin(db, OLD_ORIGIN, PRODUCTION_ORIGIN, row);
    else if (row.public_origin !== PRODUCTION_ORIGIN) throw new Error("Production origin drifted during migration.");
    writeJournal({ ...readJournal(), state: "staged", staged_at: Date.now() });
    process.stdout.write(`${JSON.stringify(inspect(db, readJournal()))}\n`);
  } else if (command === "rollback") {
    if (!journal || !["prepared", "staged", "rolled_back"].includes(journal.state)) throw new Error("No rollbackable origin migration exists.");
    if (journal.installation_id !== row.installation_id) throw new Error("Installation authority drifted; rollback refused.");
    requireStopped(row);
    if (row.public_origin === PRODUCTION_ORIGIN) updateOrigin(db, PRODUCTION_ORIGIN, OLD_ORIGIN, row);
    else if (row.public_origin !== OLD_ORIGIN) throw new Error("Production origin drifted; rollback refused.");
    writeJournal({ ...journal, state: "rolled_back", rolled_back_at: Date.now() });
    process.stdout.write(`${JSON.stringify(inspect(db, readJournal()))}\n`);
  } else if (command === "complete") {
    if (!journal || journal.state !== "staged" || row.public_origin !== PRODUCTION_ORIGIN) {
      throw new Error("Only a staged matching origin migration can complete.");
    }
    if (!process.argv.includes("--confirm-browser-conversion")) {
      throw new Error("Completion requires --confirm-browser-conversion after saved browser state has been restored.");
    }
    verifyFinalOrigin(journal);
    writeJournal({ ...journal, state: "complete", completed_at: Date.now() });
    process.stdout.write(`${JSON.stringify(inspect(db, readJournal()))}\n`);
  } else {
    throw new Error("Usage: local-origin-migration.mjs inspect|stage|rollback|complete [--confirm-browser-conversion]");
  }
} finally {
  db.close();
}

}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) runCli();
