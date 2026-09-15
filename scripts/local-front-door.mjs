#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const CADDY_VERSION = "2.11.3";
const RELEASES = Object.freeze({
  "darwin-x64": {
    name: `caddy_${CADDY_VERSION}_mac_amd64.tar.gz`,
    sha256: "9e6f08758f2a4677d0f3acd3e3ccc541b0475217800325b5e5f4ef56668e4c88",
  },
  "darwin-arm64": {
    name: `caddy_${CADDY_VERSION}_mac_arm64.tar.gz`,
    sha256: "b37757be82ef630dddf359e6f1685731a1c657576ce80c469e0e3e6a8fb49e9d",
  },
});

const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.homedir(), ".mandible"));
const authorityDir = path.join(home, "config", "local-sessions");
const authorityDb = path.join(authorityDir, "sessions.db");
const installationAuthorityDir = path.join(home, "config", "client-auth");
const installationAuthorityFile = path.join(installationAuthorityDir, "authority-id");
const runtimeDir = path.join(home, "runtime", "caddy", CADDY_VERSION);
const binary = path.join(runtimeDir, "caddy");
const configPath = path.join(authorityDir, "Caddyfile");
const command = process.argv[2] ?? "status";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readInstances() {
  if (!fs.existsSync(authorityDb)) fail(`Local session authority is not initialized: ${authorityDb}`);
  const db = new Database(authorityDb, { readonly: true, fileMustExist: true });
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

function caddyfile(instances, { legacyConversion = false } = {}) {
  const production = instances.find((entry) => entry.role === "main");
  if (!production) fail("The production instance is not registered.");
  const previews = instances.filter((entry) => entry.role === "preview");
  if (legacyConversion && previews.length > 1) fail("Legacy port 19421 is ambiguous across registered previews.");
  const productionBackend = new URL(production.backend_origin);
  const productionPublic = new URL(production.public_origin);
  const globalOptions = "{\n  admin 127.0.0.1:2019\n  local_certs\n  skip_install_trust\n  auto_https disable_redirects\n}";
  const migrationIngress = instances.map((entry) => {
    const publicUrl = new URL(entry.public_origin);
    const legacyPort = entry.role === "preview" ? "19421" : "19420";
    return [
    `https://${publicUrl.hostname}:19419 {`,
    "  bind 127.0.0.1 ::1",
    "  tls internal",
    "  header -Server",
    "  @verified_legacy_completion {",
    "    method POST",
    "    path /api/client-auth/legacy-conversion/complete",
    `    header Origin http://127.0.0.1:${legacyPort} http://localhost:${legacyPort}`,
    "    header Sec-Fetch-Site cross-site",
    "  }",
    "  handle @verified_legacy_completion {",
    `    reverse_proxy ${productionBackend.origin} {`,
    `      header_up Host ${productionPublic.host}`,
    `      header_up Origin ${productionPublic.origin}`,
    "      header_up -Authorization",
    "      header_up -Cookie",
    "      header_up -X-Mandible-Session-Context",
    `      header_up X-Mandible-Target-Instance ${entry.instance_id}`,
    "      header_up -X-Mandible-Legacy-Migration",
    "      header_up X-Mandible-Legacy-Migration complete-v1",
    "      header_up X-Mandible-Legacy-Origin {http.request.header.Origin}",
    "    }",
    "  }",
    "  respond 404",
    "}",
  ].join("\n");
  }).join("\n\n");
  const legacyOrigin = [production, ...previews].map((entry) => {
    const legacyPort = entry.role === "preview" ? "19421" : "19420";
    const backend = new URL(entry.backend_origin);
    return [
    `http://127.0.0.1:${legacyPort}, http://localhost:${legacyPort} {`,
    "  bind 127.0.0.1 ::1",
    "  header -Server",
    "  handle /api/client-auth/legacy-conversion/prepare {",
    `    reverse_proxy ${backend.origin} {`,
    "      header_up Host {http.request.host}",
    "      header_up Origin {http.request.header.Origin}",
    `      header_up X-Mandible-Target-Instance ${entry.instance_id}`,
    "      header_up -Cookie",
    "      header_up -X-Mandible-Session-Context",
    "    }",
    "  }",
    "  handle {",
    `    reverse_proxy ${backend.origin} {`,
    `      header_up Host ${new URL(entry.public_origin).host}`,
    "      header_up -Origin",
    "      header_up -Authorization",
    "      header_up -Cookie",
    "      header_up -X-Mandible-Session-Context",
    "      header_up -X-Mandible-Target-Instance",
    "    }",
    "  }",
    "}",
    ].join("\n");
  }).join("\n\n");
  if (legacyConversion) return `${globalOptions}\n\n${migrationIngress}\n\n${legacyOrigin}\n`;
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
        "  @preview_bootstrap {",
        "    path /",
        "    not header Cookie *__Host-mandible-session=*",
        "  }",
        "  handle @preview_bootstrap {",
        "    rewrite * /api/client-auth/preview-bootstrap",
        `    reverse_proxy ${productionBackend.origin} {`,
        `      header_up Host ${new URL(production.public_origin).host}`,
        `      header_up Origin ${new URL(production.public_origin).origin}`,
        `      header_up X-Mandible-Target-Instance ${entry.instance_id}`,
        "      header_up -Authorization",
        "      header_up -Cookie",
        "      header_up -X-Mandible-Session-Context",
        "    }",
        "  }",
        "  handle /api/client-auth/* {",
        `    reverse_proxy ${productionBackend.origin} {`,
        `      header_up Host ${new URL(production.public_origin).host}`,
        `      header_up Origin ${new URL(production.public_origin).origin}`,
        `      header_up X-Mandible-Target-Instance ${entry.instance_id}`,
        "      header_up -Authorization",
        "      header_up -X-Mandible-Session-Context",
        "    }",
        "  }",
        "  handle {",
        `    forward_auth ${productionBackend.origin} {`,
        "      uri /api/client-auth/forward-auth",
        `      header_up Host ${new URL(production.public_origin).host}`,
        `      header_up Origin ${new URL(production.public_origin).origin}`,
        `      header_up X-Mandible-Target-Instance ${entry.instance_id}`,
        "      copy_headers X-Mandible-Session-Context",
        "    }",
        `    reverse_proxy ${backendUrl.origin} {`,
        "      header_up -Authorization",
        "      header_up -Cookie",
        "      header_up -X-Mandible-Target-Instance",
        "      header_up -X-Mandible-Session-Context",
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
  if (fs.existsSync(binary)) return;
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) fail(`No pinned Caddy build for ${process.platform}-${process.arch}.`);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const archive = path.join(os.tmpdir(), `mandible-caddy-${randomUUID()}.tar.gz`);
  const url = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${release.name}`;
  const fetched = spawnSync("curl", ["--fail", "--location", "--silent", "--show-error", "--output", archive, url], { stdio: "inherit" });
  if (fetched.status !== 0) fail("Failed to download the pinned Caddy release.");
  const actual = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (actual !== release.sha256) fail(`Caddy archive digest mismatch: ${actual}`);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", runtimeDir, "caddy"], { stdio: "inherit" });
  fs.rmSync(archive, { force: true });
  if (extracted.status !== 0) fail("Failed to extract the pinned Caddy binary.");
  fs.chmodSync(binary, 0o755);
}

function configure({ legacyConversion = false } = {}) {
  fs.mkdirSync(authorityDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, caddyfile(readInstances(), { legacyConversion }), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

if (command === "initialize") {
  initializeInstallationAuthority();
} else if (command === "install") {
  install();
  configure();
} else if (command === "configure") {
  configure();
} else if (command === "configure-migration") {
  configure({ legacyConversion: true });
} else if (command === "run") {
  install();
  configure();
  const result = spawnSync(binary, ["run", "--config", configPath, "--adapter", "caddyfile"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
} else if (command === "run-migration") {
  install();
  configure({ legacyConversion: true });
  const result = spawnSync(binary, ["run", "--config", configPath, "--adapter", "caddyfile"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
} else if (command === "status") {
  process.stdout.write(`${JSON.stringify({ version: CADDY_VERSION, binary, config: configPath, installed: fs.existsSync(binary), instances: fs.existsSync(authorityDb) ? readInstances().length : 0 })}\n`);
} else {
  fail("Usage: local-front-door.mjs initialize|install|configure|configure-migration|run|run-migration|status");
}
