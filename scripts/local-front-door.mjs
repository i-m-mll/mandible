#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import SqliteDatabase from "../src/sqlite.ts";
import { fileURLToPath } from "node:url";
import { CADDY_VERSION, installPinnedCaddy, pinnedCaddyBinary } from "./pinned-caddy.mjs";
import { assertLocalCaIdentity, localCaPaths, probeCurrentMacOsTrust } from "./local-ca-trust.mjs";
import { withInstallationGatewayLock } from './lifecycle-lock.mjs';

const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.homedir(), ".mandible"));
const caPaths = localCaPaths(home);
const authorityDir = path.join(home, "config", "local-sessions");
const authorityDb = path.join(authorityDir, "sessions.db");
const installationAuthorityDir = path.join(home, "config", "client-auth");
const installationAuthorityFile = path.join(installationAuthorityDir, "authority-id");
const binary = pinnedCaddyBinary(home);
const configPath = path.join(authorityDir, "Caddyfile");
const command = process.argv[2] ?? "status";

function fail(message) {
  throw new Error(message);
}

function readInstances() {
  if (!fs.existsSync(authorityDb)) fail(`Local session authority is not initialized: ${authorityDb}`);
  const db = new SqliteDatabase(authorityDb, { readonly: true, fileMustExist: true });
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

function caddyfile(instances) {
  const production = instances.find((entry) => entry.role === "main");
  if (!production) fail("The production instance is not registered.");
  const effectivePort = (url) => url.port || (url.protocol === "https:" ? "443" : "80");
  const publicPorts = new Set(instances.map((entry) => effectivePort(new URL(entry.public_origin))));
  for (const entry of instances) {
    const backendPort = effectivePort(new URL(entry.backend_origin));
    if (publicPorts.has(backendPort)) {
      fail(`Refusing gateway self-route: ${entry.instance_id} backend port ${backendPort} is a public listener port.`);
    }
  }
  const productionBackend = new URL(production.backend_origin);
  const productionPublic = new URL(production.public_origin);
  const globalOptions = `{\n  admin 127.0.0.1:2019\n  storage file_system ${JSON.stringify(caPaths.storageRoot)}\n  local_certs\n  skip_install_trust\n  auto_https disable_redirects\n}`;
  const blocks = instances.map((entry) => {
    const publicUrl = new URL(entry.public_origin);
    const backendUrl = new URL(entry.backend_origin);
    const shared = [
      `${publicUrl.origin} {`,
      "  bind 127.0.0.1 ::1",
      "  tls internal",
      "  header -Server",
    ];
    if (entry.role === "preview") {
      shared.push(
        "  handle {",
        `    forward_auth ${productionBackend.origin} {`,
        "      uri /api/client-auth/forward-auth",
        `      header_up Host ${productionPublic.host}`,
        `      header_up Origin ${productionPublic.origin}`,
        `      header_up X-Mandible-Target-Instance ${entry.instance_id}`,
        "      header_up -Authorization",
        "      header_up -Cookie",
        "      copy_headers X-Mandible-Session-Context",
        "    }",
        `    reverse_proxy ${backendUrl.origin} {`,
        "      header_up -Authorization",
        "      header_up -Cookie",
        "      header_up -X-Mandible-Target-Instance",
        "      header_up X-Mandible-Session-Context {http.request.header.X-Mandible-Session-Context}",
        "    }",
        "  }",
      );
    } else {
      shared.push(
        `  reverse_proxy ${backendUrl.origin} {`,
        "    header_up -X-Mandible-Target-Instance",
        "    header_up -X-Mandible-Session-Context",
        "  }",
      );
    }
    shared.push("}");
    return shared.join("\n");
  });
  return `${globalOptions}\n\n${blocks.join("\n\n")}\n`;
}

function install() {
  try { installPinnedCaddy(home); } catch (error) { fail(error.message); }
}

function configure() {
  requireTrustedCa({ verifyNative: false });
  fs.mkdirSync(authorityDir, { recursive: true, mode: 0o700 });
  const config = caddyfile(readInstances());
  if (fs.existsSync(binary)) {
    const adapted = spawnSync(binary, ["adapt", "--config", "-", "--adapter", "caddyfile"], {
      input: config, encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    });
    if (adapted.status !== 0) fail(`Local HTTPS configuration is invalid: ${adapted.stderr.trim()}`);
  }
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

function requireTrustedCa({ verifyNative = true } = {}) {
  let ca;
  try { ca = assertLocalCaIdentity(caPaths); } catch (error) { fail(error.message); }
  if (ca.state !== "trusted") fail("Secure local connections are not set up. Choose the desktop Connections setup action or run bun scripts/local-ca-trust.mjs setup before starting the front door.");
  if (verifyNative) {
    try { probeCurrentMacOsTrust(caPaths); } catch (error) { fail(error.message); }
  }
}

function runRuntimeCommand(commandName, args = []) {
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
  configure();
} else if (command === "reload") {
  runRuntimeCommand("reload-gateway", process.argv.slice(3));
} else if (command === "run") {
  requireTrustedCa();
  runRuntimeCommand("start");
} else if (command === "status") {
  let ca;
  try { ca = assertLocalCaIdentity(caPaths); } catch (error) { fail(error.message); }
  process.stdout.write(`${JSON.stringify({ version: CADDY_VERSION, binary, config: configPath, installed: fs.existsSync(binary), instances: fs.existsSync(authorityDb) ? readInstances().length : 0, ca })}\n`);
} else {
  fail("Usage: local-front-door.mjs initialize|install|configure|reload [--if-configured]|run|status");
}
}

try {
  if (['initialize', 'install', 'configure'].includes(command)) await withInstallationGatewayLock(home, () => main());
  else await main();
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
