#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import SqliteDatabase from "../src/sqlite.ts";
import { fileURLToPath } from "node:url";
import { CADDY_VERSION, installPinnedCaddy, pinnedCaddyBinary } from "./pinned-caddy.mjs";
import { assertLocalCaIdentity, localCaPaths, probeCurrentMacOsTrust } from "./local-ca-trust.mjs";
import { withInstallationGatewayLock, assertLifecycleLockHeld } from './lifecycle-lock.mjs';
import { prepareGatewayAdmin } from './gateway-admin.mjs';
import { gatewayCaddyfile } from './gateway-config.mjs';
import { RuntimeObservationError, runRuntimeCommand } from './runtime-observation.mjs';

const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.homedir(), ".mandible"));
const caPaths = localCaPaths(home);
const authorityDir = path.join(home, "config", "local-sessions");
const authorityDb = path.join(authorityDir, "sessions.db");
const installationAuthorityDir = path.join(home, "config", "client-auth");
const installationAuthorityFile = path.join(installationAuthorityDir, "authority-id");
const defaultBinary = () => pinnedCaddyBinary(home);
const configPath = path.join(authorityDir, "Caddyfile");
const command = process.argv[2] ?? "status";

function fail(message) {
  throw new Error(message);
}

function readInstances(file = authorityDb) {
  if (!fs.existsSync(file)) fail(`Local session authority is not initialized: ${file}`);
  const db = new SqliteDatabase(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT * FROM instance_registrations ORDER BY role, instance_id").all();
  } finally {
    db.close();
  }
}

function initializeInstallationAuthority() {
  fs.mkdirSync(installationAuthorityDir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(
      installationAuthorityFile,
      `authority_${randomBytes(18).toString("base64url")}`,
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  fs.chmodSync(installationAuthorityFile, 0o600);
  const authorityId = fs.readFileSync(installationAuthorityFile, "utf8").trim();
  if (!authorityId) fail(`Installation authority is empty: ${installationAuthorityFile}`);
  process.stdout.write(`${JSON.stringify({ installation_authority: installationAuthorityFile, authority_id: authorityId })}\n`);
}


function install() {
  try { installPinnedCaddy(home); } catch (error) { fail(error.message); }
}

/** The gateway configuration this installation's registrations generate now. */
export function gatewayConfiguration(home) {
  const paths = localCaPaths(home);
  return gatewayCaddyfile(readInstances(path.join(paths.authorityDir, 'sessions.db')), {
    adminAddress: prepareGatewayAdmin(home).address, storageRoot: paths.storageRoot });
}
export const gatewayConfigurationDigest = config => createHash('sha256').update(config).digest('hex');

/**
 * Caddy's own verdict on a generated configuration, returning its digest. Only
 * a nonzero exit is invalid; a run that does not answer within the current
 * budget is pending.
 */
export function validateGatewayConfiguration(binary, config, { until } = {}) {
  const adapted = runRuntimeCommand(binary, ['adapt', '--config', '-', '--adapter', 'caddyfile'], { input: config, until });
  if (adapted.status !== 0) throw new RuntimeObservationError('gateway_config_invalid',
    `Local HTTPS configuration is invalid: ${adapted.stderr.trim() || `caddy adapt exited ${adapted.status}`}`, { status: adapted.status });
  return gatewayConfigurationDigest(config);
}

/** `validated` is the digest of bytes already validated with this binary; only different bytes are validated again. */
export function configureLocalFrontDoor(context, { binary = pinnedCaddyBinary(context.home), assertHeld, validated, until } = {}) {
  if (typeof assertHeld !== 'function') throw new Error('Gateway configuration requires explicit mutation ownership.');
  assertHeld();
  const paths = localCaPaths(context.home);
  const ca = assertLocalCaIdentity(paths);
  if (ca.state !== 'trusted') fail('Secure local connections are not set up.');
  fs.mkdirSync(paths.authorityDir, { recursive: true, mode: 0o700 });
  const config = gatewayConfiguration(context.home);
  if (fs.existsSync(binary) && validated !== gatewayConfigurationDigest(config)) validateGatewayConfiguration(binary, config, { until });
  assertHeld();
  const destination = path.join(paths.authorityDir, 'Caddyfile');
  fs.writeFileSync(destination, config, { mode: 0o600 });
  fs.chmodSync(destination, 0o600);
}

function requireTrustedCa({ verifyNative = true } = {}) {
  let ca;
  try { ca = assertLocalCaIdentity(caPaths); } catch (error) { fail(error.message); }
  if (ca.state !== "trusted") fail("Secure local connections are not set up. Choose the desktop Connections setup action or run bun scripts/local-ca-trust.mjs setup before starting the front door.");
  if (verifyNative) {
    try { probeCurrentMacOsTrust(caPaths); } catch (error) { fail(error.message); }
  }
}

function runLocalRuntime(commandName, args = []) {
  const script = fileURLToPath(new URL("./local-runtime.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, commandName, ...args], {
    env: process.env, encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail((result.stderr || result.error?.message || "local runtime command failed").trim());
  if (result.stdout) process.stdout.write(result.stdout);
}

async function main() {
if (command === "initialize") {
  initializeInstallationAuthority();
} else if (command === "install") {
  install();
} else if (command === "configure") {
  configureLocalFrontDoor({ home }, { binary: defaultBinary(), assertHeld: assertLifecycleLockHeld });
} else if (command === "reload") {
  runLocalRuntime("reload-gateway", process.argv.slice(3));
} else if (command === "run") {
  requireTrustedCa();
  runLocalRuntime("start");
} else if (command === "status") {
  let ca;
  try { ca = assertLocalCaIdentity(caPaths); } catch (error) { fail(error.message); }
  process.stdout.write(`${JSON.stringify({ version: CADDY_VERSION, binary: defaultBinary(), config: configPath, installed: fs.existsSync(defaultBinary()), instances: fs.existsSync(authorityDb) ? readInstances().length : 0, ca })}\n`);
} else {
  fail("Usage: local-front-door.mjs initialize|install|configure|reload [--if-configured]|run|status");
}
}

if (process.argv[1] && path.basename(process.argv[1]) === 'local-front-door.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  if (['initialize', 'install', 'configure'].includes(command)) await withInstallationGatewayLock(home, () => main());
  else await main();
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }

}
