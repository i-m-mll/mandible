#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BACKEND_PORT, PRODUCTION_ORIGIN } from "./canonical-origin.mjs";
import { readBuildRevision } from "./build-revision.mjs";

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

const mandibleHome = expandHome(process.env.MANDIBLE_HOME?.trim() || path.join(os.homedir(), ".mandible"));
const runtimeDir = path.join(mandibleHome, "config", "local-sessions");
const installationAuthorityPath = path.join(mandibleHome, "config", "client-auth", "authority-id");
const defaultHome = path.join(os.homedir(), ".mandible");
const suffix = mandibleHome === defaultHome ? "" : `.${createHash("sha256").update(mandibleHome).digest("hex").slice(0, 8)}`;
const backendLabel = `bio.mll.mandible.local-session-production${suffix}`;
const launchAgentPaths = [
  path.join(os.homedir(), "Library", "LaunchAgents", `${backendLabel}.plist`),
  path.join(runtimeDir, "launch-agents", `${backendLabel}.plist`),
];

function launchAgentRecord() {
  const files = launchAgentPaths.filter((file) => fs.existsSync(file));
  if (files.length !== 1) {
    throw new Error(files.length === 0
      ? "Mandible's production LaunchAgent is not installed."
      : "Multiple Mandible production LaunchAgents are installed; refusing to guess.");
  }
  const [file] = files;
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], {
    encoding: "utf8", timeout: 1500,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not read Mandible's production LaunchAgent ${file}: ${(result.stderr || result.error?.message || "unknown failure").trim()}`);
  }
  let record;
  try { record = JSON.parse(result.stdout); }
  catch { throw new Error(`Mandible's production LaunchAgent is malformed: ${file}`); }
  if (record.Label !== backendLabel) throw new Error("The production LaunchAgent label does not match this Mandible installation.");
  const args = record.ProgramArguments ?? [];
  if (args.length !== 3 || path.resolve(args[1]) !== path.join(runtimeDir, "production-runner.mjs") || args[2] !== "run") {
    throw new Error("The production LaunchAgent does not use Mandible's managed runner.");
  }
  return record;
}

function configuredRoot() {
  const root = launchAgentRecord().EnvironmentVariables?.MANDIBLE_PRODUCTION_ROOT;
  if (!path.isAbsolute(root ?? "") || !fs.existsSync(path.join(root, "package.json"))
    || !fs.existsSync(path.join(root, "dist", "index.js"))) {
    throw new Error("The production LaunchAgent does not provide a built Mandible checkout.");
  }
  return path.resolve(root);
}

function mainRegistration(root) {
  const requireFromProject = createRequire(path.join(root, "package.json"));
  const Database = requireFromProject("./dist/sqlite.js").default;
  const db = new Database(path.join(runtimeDir, "sessions.db"), { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT instance_id, installation_id, role, public_origin, backend_origin,
      effect_ceiling_json, writable_roots_json FROM instance_registrations WHERE role = 'main'`).all();
    if (rows.length !== 1) throw new Error(`Expected one registered production instance, found ${rows.length}.`);
    const main = rows[0];
    const authorityId = fs.readFileSync(installationAuthorityPath, "utf8").trim();
    if (main.instance_id !== "production" || main.installation_id !== authorityId || main.public_origin !== PRODUCTION_ORIGIN) {
      throw new Error("The registered production instance does not match this installation's canonical identity.");
    }
    const backend = new URL(main.backend_origin);
    if (backend.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname)
      || !backend.port || Number(backend.port) === Number(new URL(PRODUCTION_ORIGIN).port)) {
      throw new Error("The registered production backend is not an isolated loopback HTTP listener.");
    }
    return {
      ...main,
      backendUrl: backend,
      effectCeiling: JSON.parse(main.effect_ceiling_json),
      writableRoots: JSON.parse(main.writable_roots_json),
    };
  } finally {
    db.close();
  }
}

async function run() {
  const root = configuredRoot();
  const generation = readBuildRevision(root);
  const main = mainRegistration(root);
  const entry = path.join(root, "dist", "index.js");

  process.env.HOME = os.homedir();
  process.env.MANDIBLE_HOME = mandibleHome;
  process.env.MANDIBLE_PRODUCTION_ROOT = root;
  process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR = runtimeDir;
  process.env.MANDIBLE_CLIENT_AUTH_DIR = path.join(mandibleHome, "config", "client-auth");
  process.env.MANDIBLE_CONTEXT_VERIFICATION_KEY = path.join(runtimeDir, "context-verification-key.pem");
  process.env.MANDIBLE_INSTANCE_ROLE = "main";
  process.env.MANDIBLE_INSTANCE_ID = main.instance_id;
  process.env.MANDIBLE_INSTALLATION_ID = main.installation_id;
  process.env.MANDIBLE_PUBLIC_ORIGIN = main.public_origin;
  process.env.MANDIBLE_BACKEND_GENERATION = generation;
  process.env.MANDIBLE_ALLOWED_EFFECTS = JSON.stringify(main.effectCeiling);
  process.env.MANDIBLE_WRITABLE_ROOTS = JSON.stringify(main.writableRoots);
  process.env.MANDIBLE_BASE = PRODUCTION_ORIGIN;
  process.env.MANDIBLE_PORT = String(Number(main.backendUrl.port) || DEFAULT_BACKEND_PORT);
  process.env.GIT_OPTIONAL_LOCKS = "0";

  process.chdir(root);
  process.argv[1] = entry;
  process.stderr.write(`[production-runner] starting ${root} build ${generation}\n`);
  await import(pathToFileURL(entry).href);
}

const command = process.argv[2];
if (command !== "run") throw new Error("Usage: local-session-production-runner.mjs run");
await run();
