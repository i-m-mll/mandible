#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtimeDir = path.join(os.homedir(), ".mandible", "config", "local-sessions");
const journalPath = path.join(runtimeDir, "cutover.json");
const installedRunnerPath = path.join(runtimeDir, "production-runner.mjs");
const readyPath = path.join(runtimeDir, "production-ready.json");
const originMigrationPath = path.join(runtimeDir, "origin-migration.json");

export function resolveRuntimeOrigin(candidateEnv, originMigration, protectedRoot) {
  const oldOrigin = candidateEnv.MANDIBLE_PUBLIC_ORIGIN;
  if (!originMigration) return { origin: oldOrigin, migration: false };
  if (originMigration.schema !== "mandible-local-origin-migration@1"
      || originMigration.instance_id !== "production"
      || originMigration.installation_id !== candidateEnv.MANDIBLE_INSTALLATION_ID
      || originMigration.old_origin !== oldOrigin
      || originMigration.new_origin !== "https://mandible.localhost") {
    throw new Error("Origin migration does not match the completed production cutover.");
  }
  if (originMigration.state === "prepared" || originMigration.state === "rolled_back") {
    return { origin: oldOrigin, migration: false };
  }
  if (!["staged", "complete"].includes(originMigration.state) || !protectedRoot) {
    throw new Error("Origin migration requires the exact protected production build marker.");
  }
  const canonical = JSON.parse(fs.readFileSync(path.join(protectedRoot, "config", "canonical-origin.json"), "utf8"));
  if (canonical.production_origin !== originMigration.new_origin) {
    throw new Error("Protected production origin declaration does not match migration custody.");
  }
  return { origin: originMigration.new_origin, migration: originMigration.state === "staged" };
}

function readCompletedProduction() {
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (journal.state !== "complete") throw new Error("Local-session production cutover is not complete.");
  const main = journal.manifest.instances.find((instance) => instance.role === "main");
  if (!main?.candidate?.process?.cwd || main.candidate.process.env?.MANDIBLE_INSTANCE_ROLE !== "main") {
    throw new Error("Completed cutover has no pinned production process.");
  }
  return main;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Cannot verify production checkout: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function installRunner() {
  readCompletedProduction();
  const source = fileURLToPath(import.meta.url);
  if (path.resolve(source) === path.resolve(installedRunnerPath)) return;
  const temporary = `${installedRunnerPath}.${process.pid}.tmp`;
  fs.copyFileSync(source, temporary);
  fs.chmodSync(temporary, 0o700);
  fs.renameSync(temporary, installedRunnerPath);
}

function markReady() {
  if (!fs.existsSync(journalPath)) return { skipped: "no local-session cutover" };
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (journal.state !== "complete") return { skipped: "local-session cutover is not complete" };
  const main = readCompletedProduction();
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  const expectedRoot = fs.existsSync(readyPath)
    ? JSON.parse(fs.readFileSync(readyPath, "utf8")).root
    : path.dirname(git(main.candidate.process.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  if (root !== expectedRoot) return { skipped: "not the protected production checkout" };
  const commit = git(root, "rev-parse", "HEAD");
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", main.candidate.commit, commit], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (ancestor.status !== 0 || !fs.existsSync(path.join(root, "dist", "index.js"))) {
    throw new Error("Protected checkout does not contain the cutover candidate and built daemon.");
  }
  installRunner();
  const temporary = `${readyPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ root, commit })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, readyPath);
  return { root, commit };
}

async function run() {
  const main = readCompletedProduction();
  const candidate = main.candidate.process;
  let cwd = candidate.cwd;
  let generation = candidate.env.MANDIBLE_BACKEND_GENERATION;
  if (fs.existsSync(readyPath)) {
    const ready = JSON.parse(fs.readFileSync(readyPath, "utf8"));
    if (!path.isAbsolute(ready.root) || !/^[a-f0-9]{40}$/.test(ready.commit)
      || git(ready.root, "rev-parse", "HEAD") !== ready.commit
      || !fs.existsSync(path.join(ready.root, "dist", "index.js"))) {
      throw new Error("Protected production build marker drifted; refusing a stale backend.");
    }
    cwd = ready.root;
    generation = ready.commit;
  }
  const originMigration = fs.existsSync(originMigrationPath)
    ? JSON.parse(fs.readFileSync(originMigrationPath, "utf8")) : null;
  const runtimeOrigin = resolveRuntimeOrigin(candidate.env, originMigration,
    fs.existsSync(readyPath) ? cwd : null);
  for (const [key, value] of Object.entries(candidate.env)) process.env[key] = value;
  process.env.MANDIBLE_PUBLIC_ORIGIN = runtimeOrigin.origin;
  process.env.MANDIBLE_BASE = runtimeOrigin.origin;
  if (runtimeOrigin.migration) process.env.MANDIBLE_ORIGIN_MIGRATION = "allow";
  else delete process.env.MANDIBLE_ORIGIN_MIGRATION;
  process.env.MANDIBLE_BACKEND_GENERATION = generation;
  process.env.GIT_OPTIONAL_LOCKS = "0";
  process.chdir(cwd);
  const entry = path.join(cwd, "dist", "index.js");
  process.argv[1] = entry;
  process.stderr.write(`[production-runner] starting ${cwd} generation ${generation}\n`);
  await import(pathToFileURL(entry).href);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const command = process.argv[2];
  if (command === "install-runner") installRunner();
  else if (command === "mark-ready") console.log(JSON.stringify(markReady()));
  else if (command === "run") await run();
  else throw new Error("Usage: local-session-production-runner.mjs install-runner|mark-ready|run");
}
