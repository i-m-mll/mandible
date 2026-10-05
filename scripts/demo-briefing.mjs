#!/usr/bin/env bun

import { runSupervisedCommand } from './process-group-supervisor.mjs';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PRODUCTION_DB_PATHS, resolvesToAnyProductionDbPath } = require("../cli/production-db-guard.cjs");
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

function canonicalFuturePath(target) {
  let probe = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    suffix.unshift(path.basename(probe));
    probe = parent;
  }
  let existing;
  try {
    existing = fs.realpathSync.native(probe);
  } catch {
    existing = path.resolve(probe);
  }
  return path.join(existing, ...suffix);
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function resolveFreshDemoPaths(dbArgument, env = process.env) {
  if (!dbArgument) throw new Error("--db requires an explicit absolute fresh database path.");
  if (!path.isAbsolute(dbArgument)) throw new Error("--db must be an absolute path.");
  const databasePath = canonicalFuturePath(dbArgument);
  const production = resolvesToAnyProductionDbPath(databasePath, PRODUCTION_DB_PATHS);
  if (production) throw new Error(`Refusing production database path: ${production}`);
  const configuredPreviewRoot = env.MANDIBLE_PREVIEW_BASE_DIR?.trim();
  const previewRoots = [
    path.join(os.homedir(), ".cache", "mandible", "previews"),
    ...(configuredPreviewRoot ? [configuredPreviewRoot] : []),
  ].map(canonicalFuturePath);
  if (previewRoots.some((root) => inside(databasePath, root))) {
    throw new Error(`Refusing database path inside a managed preview root: ${databasePath}`);
  }
  const artifactRoot = `${databasePath}.artifacts`;
  const occupied = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`, artifactRoot]
    .find((candidate) => fs.existsSync(candidate));
  if (occupied) throw new Error(`Refusing non-fresh demo target; path already exists: ${occupied}`);
  return { databasePath, artifactRoot };
}

export function parseArguments(argv) {
  let db = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--db") {
      db = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, db: null, json };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { help: false, db, json };
}

function usage() {
  return "Usage: bun run demo:briefing -- --db <absolute-fresh-path> [--json]";
}

async function buildServer() {
  await runSupervisedCommand(process.execPath, ['--smol', '--no-install', path.join(repoRoot, 'scripts/run-tsc.js')], {
    cwd: repoRoot, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: 'inherit', timeout: 180000,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const paths = resolveFreshDemoPaths(args.db);
  await buildServer();
  const [{ openDb }, { seedRichBriefingDemo }] = await Promise.all([
    import("../dist/db.js"),
    import("../dist/feedback/rich-briefing-demo.js"),
  ]);
  fs.mkdirSync(path.dirname(paths.databasePath), { recursive: true });
  let db = null;
  try {
    db = openDb(paths.databasePath);
    const manifest = seedRichBriefingDemo(db, paths);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    if (args.json) console.log(JSON.stringify(manifest, null, 2));
    else {
      console.log(`Seeded ${manifest.briefing.title}`);
      console.log(`Database: ${manifest.database_path}`);
      console.log(`Briefing: ${manifest.briefing.id}`);
      for (const round of manifest.rounds) {
        console.log(`Round ${round.ordinal}: ${round.id} (${round.artifact_version_id})`);
      }
    }
  } catch (error) {
    db?.close();
    for (const target of [paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`, `${paths.databasePath}-journal`]) {
      fs.rmSync(target, { force: true });
    }
    fs.rmSync(paths.artifactRoot, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && canonicalFuturePath(process.argv[1]) === canonicalFuturePath(scriptPath)) {
  main().catch((error) => {
    console.error(`demo:briefing failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
