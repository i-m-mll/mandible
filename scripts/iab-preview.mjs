#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Issue 24f0316 — the ledger database lives under the durable root now.
// Previews stay in the disposable cache root: they are regenerable copies.
const require = createRequire(import.meta.url);
const { liveDbPath } = require("../cli/mandible-paths.cjs");

const DEFAULT_PORT_START = 19421;
const DEFAULT_PORT_END = 19499;
const DEFAULT_DB_PATH = liveDbPath();
const DEFAULT_PREVIEW_BASE_DIR = path.join(os.homedir(), ".cache", "mandible", "previews");
const HEALTH_TIMEOUT_MS = 30_000;
const DB_SNAPSHOT_PATTERN = /^mandible-\d{8}-\d{6}\.db$/;
const DB_SNAPSHOT_ARTIFACT_PATTERN = /^mandible-\d{8}-\d{6}\.db(?:-(?:wal|shm)|\.manifest\.json|\.partial-\d+(?:-(?:journal|wal|shm))?|\.manifest\.json\.partial-\d+)?$/;

const command = process.argv[2] === "cleanup"
  ? "cleanup"
  : process.argv[2] === "seed-briefing-demo" ? "seed-briefing-demo" : "preview";
const args = parseArgs(command === "preview" ? process.argv.slice(2) : process.argv.slice(3), command);

if (args.help) {
  printUsage(command);
  process.exit(0);
}

try {
  const result = command === "cleanup"
    ? await cleanupPreviewCache(args)
    : command === "seed-briefing-demo" ? await seedBriefingDemo(args) : await main(args);
  printResult(result, args.json);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(`iab-preview failed: ${message}`);
  }
  process.exit(1);
}

async function main(options) {
  const cwd = process.cwd();
  const repoRoot = git(["rev-parse", "--show-toplevel"], { cwd }).stdout.trim();
  const worktreeHostRoot = resolveWorktreeHostRoot(repoRoot);
  const currentBranch = git(["branch", "--show-current"], { cwd: repoRoot }).stdout.trim();
  const protectedBranch = resolveProtectedBranch(repoRoot);
  const protectedHead = git(["rev-parse", "--short=7", protectedBranch], { cwd: repoRoot }).stdout.trim();
  const dateStamp = formatDateStamp(new Date());
  const currentIsProtected = currentBranch === protectedBranch;
  const currentIsIntegration = currentBranch.startsWith("integration/");

  let branch;
  let worktree;
  let mode;

  if (!options.forceNew && currentIsIntegration && !currentIsProtected) {
    branch = currentBranch;
    worktree = repoRoot;
    mode = "current-integration";
    const existing = await healthyExistingPreview(branch, { worktree });
    if (existing) {
      const currentHead = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
      if (existing.health?.startup_commit?.hash !== currentHead) {
        return refreshExistingPreview(existing, { branch, worktree, mode, currentHead, options });
      }
      return {
        ...withBrowserReadyUrl(existing),
        ok: true,
        status: "already-running",
        mode,
        message: "Already on an integration branch with a healthy preview.",
      };
    }
  } else {
    const baseBranchName = options.branch ?? `integration/mandible-iab-preview-${dateStamp}-${protectedHead}`;
    branch = options.forceNew && !options.branch
      ? `${baseBranchName}-${formatTimeStamp(new Date())}`
      : baseBranchName;
    mode = currentIsProtected ? "protected-branch" : "new-integration";
    if (!currentIsProtected && !options.forceNew && !currentIsIntegration) {
      throw new Error(
        `Current branch is ${currentBranch}; run from ${protectedBranch}, run from an integration branch, or pass --force-new.`,
      );
    }
    const selectedWorktree = worktreeForBranch(repoRoot, branch);
    const existing = !options.forceNew
      ? await healthyExistingPreview(branch, { worktree: selectedWorktree })
      : null;
    if (existing && !options.dryRun) {
      if (!selectedWorktree) {
        throw new Error(`Healthy preview metadata exists for ${branch}, but its worktree is not registered.`);
      }
      const currentHead = git(["rev-parse", "HEAD"], { cwd: selectedWorktree }).stdout.trim();
      if (existing.health?.startup_commit?.hash !== currentHead) {
        return refreshExistingPreview(existing, {
          branch,
          worktree: selectedWorktree,
          mode,
          currentHead,
          options,
        });
      }
      return {
        ...withBrowserReadyUrl(existing),
        ok: true,
        status: "already-running",
        mode,
        message: "Preview metadata points to a healthy instance.",
      };
    }
    worktree = options.dryRun
      ? plannedWorktreePath(repoRoot, worktreeHostRoot, branch)
      : ensureIntegrationWorktree(repoRoot, worktreeHostRoot, branch, protectedBranch, options);
  }

  const preview = previewPaths(branch);
  const sourceDb = path.resolve(expandHome(options.db ?? process.env.MANDIBLE_DB ?? DEFAULT_DB_PATH));

  if (options.dryRun) {
    return {
      ok: true,
      status: "dry-run",
      mode,
      branch,
      worktree,
      protectedBranch,
      previewRoot: preview.root,
      wouldBuild: !options.noBuild,
      wouldCopyDb: false,
      wouldProjectDb: true,
      wouldStart: true,
      projection: {
        logs: "all rows from 24h plus warn/error rows from 7d",
        conversations: "whole 7d-active/starred/session-linked/referenced/newest-per-project conversations",
        conversationTitleConvergence: "parser-backed convergence on the private copy before daemon start",
      },
      instanceEnv: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
        MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
        MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
        MANDIBLE_FILE_RPC_DIR: path.join(preview.root, "agent-rpc"),
        MANDIBLE_CONFIG_DIR: path.join(preview.root, "config"),
      },
    };
  }

  fs.mkdirSync(preview.root, { recursive: true });

  const preStartCleanup = await cleanupPreviewCache({
    apply: true,
    previewBaseDir: options.previewBaseDir,
  });

  if (!options.noBuild) {
    ensureDependencies(worktree);
    run("npm", ["run", "build"], { cwd: worktree });
  }

  const port = options.port ?? await findFreePort(DEFAULT_PORT_START, DEFAULT_PORT_END);
  if (!fs.existsSync(sourceDb)) {
    throw new Error(`Source database does not exist: ${sourceDb}`);
  }

  const dbCopy = path.join(preview.root, `mandible-${formatDateTimeForFile(new Date())}.db`);
  const projection = createProjectedSnapshot({ sourceDb, dbCopy, worktree });
  replaceSymlink(dbCopy, path.join(preview.root, "current.db"));

  const stdoutLog = path.join(preview.root, "stdout.log");
  const stderrLog = path.join(preview.root, "stderr.log");
  const pidFile = path.join(preview.root, "mandible.pid");
  const launchLabel = previewLaunchLabel(port, branch);
  const runScript = path.join(preview.root, "run.sh");
  writeRunScript(runScript, {
    worktree,
    port,
    dbCopy,
    sourceDb,
    pidFile,
    nodePath: process.execPath,
    stdoutLog,
    stderrLog,
  });

  fs.writeFileSync(stdoutLog, "");
  fs.writeFileSync(stderrLog, "");
  await startPreviewProcess({
    launchLabel,
    runScript,
    worktree,
    port,
    dbCopy,
    sourceDb,
    pidFile,
    stdoutLog,
    stderrLog,
  });

  const health = await waitForHealth(port, HEALTH_TIMEOUT_MS, stderrLog);
  const metadata = {
    ok: true,
    status: "started",
    mode,
    branch,
    worktree,
    protectedBranch,
    port,
    url: `http://127.0.0.1:${port}/#/timeline`,
    freshUrl: `http://127.0.0.1:${port}/?fresh=${Date.now()}#/timeline`,
    db: dbCopy,
    sourceDb,
    projection,
    preStartCleanup,
    instanceEnv: previewInstanceEnv({ port, dbCopy, sourceDb, pidFile }),
    previewRoot: preview.root,
    launchLabel,
    pidFile,
    stdoutLog,
    stderrLog,
    runScript,
    health,
    startedAt: new Date().toISOString(),
  };

  fs.writeFileSync(preview.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
  metadata.cacheCleanup = prunePreviewSnapshots(preview.root, {
    apply: true,
    keepDbPaths: [dbCopy],
  });
  fs.writeFileSync(preview.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
  return withBrowserReadyUrl(metadata);
}

async function seedBriefingDemo(options) {
  const custody = validateBriefingDemoCustody();
  buildServer(custody.worktree);

  const priorEnv = {};
  const seedEnv = {
    MANDIBLE_DB: custody.db,
    MANDIBLE_ARTIFACT_DIR: custody.artifactRoot,
    MANDIBLE_INSTANCE_ROLE: "preview",
    MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
    MANDIBLE_INSTANCE_SOURCE_DB: custody.sourceDb,
  };
  for (const [key, value] of Object.entries(seedEnv)) {
    priorEnv[key] = process.env[key];
    process.env[key] = value;
  }

  let db = null;
  try {
    const cacheBust = `?iab-preview-seed=${Date.now()}`;
    const [{ openDb }, { seedRichBriefingDemo }] = await Promise.all([
      import(`${pathToFileURL(path.join(custody.worktree, "dist", "db.js")).href}${cacheBust}`),
      import(`${pathToFileURL(path.join(custody.worktree, "dist", "feedback", "rich-briefing-demo.js")).href}${cacheBust}`),
    ]);
    db = openDb(custody.db);
    const manifest = seedRichBriefingDemo(db, {
      databasePath: custody.db,
      artifactRoot: custody.artifactRoot,
    });
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    return {
      ...manifest,
      ok: true,
      status: manifest.result,
      branch: custody.branch,
      worktree: custody.worktree,
      previewRoot: custody.previewRoot,
      db: custody.db,
      sourceDb: custody.sourceDb,
      artifactRoot: custody.artifactRoot,
    };
  } finally {
    db?.close();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validateBriefingDemoCustody() {
  const cwd = process.cwd();
  const worktree = git(["rev-parse", "--show-toplevel"], { cwd }).stdout.trim();
  const branch = git(["branch", "--show-current"], { cwd: worktree }).stdout.trim();
  const protectedBranch = resolveProtectedBranch(worktree);
  if (!branch.startsWith("integration/") || branch === protectedBranch) {
    throw new Error(`Refusing demo seed: current branch must be a non-protected integration branch, got ${branch || "<detached>"}.`);
  }

  const preview = previewPaths(branch);
  if (!fs.existsSync(preview.metadata)) {
    throw new Error(`Refusing demo seed: launcher metadata is missing: ${preview.metadata}`);
  }
  const metadata = readJsonFile(preview.metadata);
  if (!metadata) throw new Error(`Refusing demo seed: launcher metadata is unreadable: ${preview.metadata}`);
  if (metadata.branch !== branch) throw new Error("Refusing demo seed: metadata branch does not match the current integration branch.");
  if (!metadata.worktree || canonicalPath(metadata.worktree) !== canonicalPath(worktree)) {
    throw new Error("Refusing demo seed: metadata worktree does not match the current worktree.");
  }
  if (!metadata.previewRoot || canonicalPath(metadata.previewRoot) !== canonicalPath(preview.root)) {
    throw new Error("Refusing demo seed: metadata previewRoot does not match the computed launcher preview root.");
  }

  if (!metadata.db || !path.isAbsolute(metadata.db) || !fs.existsSync(metadata.db)) {
    throw new Error("Refusing demo seed: metadata database is missing.");
  }
  const db = canonicalPath(metadata.db);
  const previewRoot = canonicalPath(preview.root);
  if (!isPathWithin(previewRoot, db) || !fs.statSync(db).isFile()) {
    throw new Error("Refusing demo seed: metadata database is outside the computed preview root or is not a file.");
  }
  const currentPath = path.join(previewRoot, "current.db");
  const currentTarget = readSymlinkTarget(currentPath);
  if (!currentTarget || canonicalPath(currentTarget) !== db || path.resolve(currentTarget) !== path.resolve(metadata.db)) {
    throw new Error("Refusing demo seed: current.db does not exactly select the metadata database.");
  }

  const expectedPolicy = {
    MANDIBLE_INSTANCE_ROLE: "preview",
    MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
  };
  for (const [key, value] of Object.entries(expectedPolicy)) {
    if (metadata.instanceEnv?.[key] !== value) {
      throw new Error(`Refusing demo seed: persisted ${key} does not match the preview policy.`);
    }
  }
  const persistedInstance = metadata.health?.instance;
  if (persistedInstance?.role !== "preview" || persistedInstance?.operational_mutations !== "reject" ||
      persistedInstance?.db_path_source !== "iab-preview-copy") {
    throw new Error("Refusing demo seed: metadata instance policy does not match the persisted preview contract.");
  }
  if (metadata.instanceEnv?.MANDIBLE_DB !== metadata.db) {
    throw new Error("Refusing demo seed: persisted MANDIBLE_DB does not match metadata.db.");
  }
  if (!metadata.sourceDb || !path.isAbsolute(metadata.sourceDb) || !fs.existsSync(metadata.sourceDb)) {
    throw new Error("Refusing demo seed: metadata sourceDb is missing.");
  }
  if (metadata.instanceEnv?.MANDIBLE_INSTANCE_SOURCE_DB !== metadata.sourceDb) {
    throw new Error("Refusing demo seed: persisted MANDIBLE_INSTANCE_SOURCE_DB does not match metadata.sourceDb.");
  }
  const sourceDb = canonicalPath(metadata.sourceDb);
  if (!fs.statSync(sourceDb).isFile() || isPathWithin(previewRoot, sourceDb) ||
      path.resolve(metadata.sourceDb) === path.resolve(metadata.db) || sourceDb === db) {
    throw new Error("Refusing demo seed: sourceDb aliases the target or is not isolated outside the preview root.");
  }
  if (canonicalPath(persistedInstance.db_path ?? "") !== db ||
      canonicalPath(persistedInstance.source_db_path ?? "") !== sourceDb) {
    throw new Error("Refusing demo seed: metadata instance database custody does not match db and sourceDb.");
  }

  const artifactRoot = canonicalFuturePath(path.join(previewRoot, "rich-briefing-demo-artifacts"));
  if (!isPathWithin(previewRoot, artifactRoot) || artifactRoot === previewRoot ||
      artifactRoot === canonicalFuturePath(`${metadata.sourceDb}.artifacts`)) {
    throw new Error("Refusing demo seed: demo artifact custody is not isolated inside the preview root.");
  }
  return { branch, worktree: canonicalPath(worktree), previewRoot, db, sourceDb, artifactRoot };
}

function buildServer(worktree) {
  const typescriptEntry = require.resolve("typescript");
  const compiler = path.join(path.dirname(typescriptEntry), "tsc.js");
  run(process.execPath, [compiler, "-p", path.join(worktree, "tsconfig.json")], { cwd: worktree });
}

async function cleanupPreviewCache(options) {
  const root = previewBaseDir(options.previewBaseDir);
  const report = {
    ok: true,
    status: options.apply ? "applied" : "dry-run",
    previewBaseDir: root,
    apply: options.apply,
    reclaimedBytes: 0,
    reclaimableBytes: 0,
    entries: [],
  };

  if (!fs.existsSync(root)) {
    return report;
  }

  const rootEntries = fs.readdirSync(root, { withFileTypes: true });
  const protectedDbPaths = new Set();

  for (const dirent of rootEntries) {
    const entryPath = path.join(root, dirent.name);
    if (dirent.isDirectory()) {
      const entry = await analyzePreviewDirForCleanup(entryPath, options.apply);
      report.entries.push(entry);
      for (const dbPath of [entry.metadataDb, entry.currentDb]) {
        addProtectedSnapshotPaths(protectedDbPaths, dbPath);
      }
      if (entry.action === "delete-dir") {
        report.reclaimableBytes += entry.bytes;
        if (options.apply) {
          fs.rmSync(entryPath, { recursive: true, force: true });
          report.reclaimedBytes += entry.bytes;
        }
      } else if (entry.action === "skip-active" && entry.snapshotCleanup) {
        report.reclaimableBytes += entry.snapshotCleanup.reclaimableBytes;
        report.reclaimedBytes += entry.snapshotCleanup.reclaimedBytes;
      }
    }
  }

  for (const dirent of rootEntries) {
    const entryPath = path.join(root, dirent.name);
    if (dirent.isFile() && DB_SNAPSHOT_ARTIFACT_PATTERN.test(dirent.name)) {
      const bytes = fs.statSync(entryPath).size;
      if (protectedDbPaths.has(canonicalPath(entryPath))) {
        report.entries.push({
          path: entryPath,
          kind: "root-db",
          action: "skip",
          reason: "root-level preview database is referenced by preview metadata or current.db",
          bytes: 0,
        });
        continue;
      }
      const entry = {
        path: entryPath,
        kind: "root-db",
        action: "delete-file",
        reason: "root-level preview database snapshot is not owned by a preview directory",
        bytes,
      };
      report.entries.push(entry);
      report.reclaimableBytes += bytes;
      if (options.apply) {
        fs.rmSync(entryPath, { force: true });
        report.reclaimedBytes += bytes;
      }
    }
  }

  report.reclaimable = formatBytes(report.reclaimableBytes);
  report.reclaimed = formatBytes(report.reclaimedBytes);
  return report;
}

function parseArgs(argv, commandName) {
  if (commandName === "cleanup") {
    return parseCleanupArgs(argv);
  }
  if (commandName === "seed-briefing-demo") {
    return parseSeedBriefingDemoArgs(argv);
  }

  const options = {
    branch: null,
    db: null,
    dryRun: false,
    forceNew: false,
    help: false,
    json: false,
    noBuild: false,
    port: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--branch":
        options.branch = requireValue(argv, ++index, arg);
        break;
      case "--db":
        options.db = requireValue(argv, ++index, arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force-new":
        options.forceNew = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-build":
        options.noBuild = true;
        break;
      case "--port":
        options.port = Number.parseInt(requireValue(argv, ++index, arg), 10);
        if (!Number.isInteger(options.port) || options.port <= 0) {
          throw new Error(`Invalid --port value: ${argv[index]}`);
        }
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseSeedBriefingDemoArgs(argv) {
  const options = { help: false, json: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument for seed-briefing-demo: ${arg}`);
  }
  return options;
}

function parseCleanupArgs(argv) {
  const options = {
    apply: false,
    help: false,
    json: false,
    previewBaseDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--preview-base-dir":
        options.previewBaseDir = requireValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printUsage(commandName = "preview") {
  if (commandName === "seed-briefing-demo") {
    console.log(`Usage: node scripts/iab-preview.mjs seed-briefing-demo [--json]

Seed the deterministic rich Briefing fixture into the current integration
branch's launcher-owned preview copy after validating metadata custody.
`);
    return;
  }
  if (commandName === "cleanup") {
    console.log(`Usage: node scripts/iab-preview.mjs cleanup [options]

Clean stale Mandible IAB preview cache entries.

Options:
  --dry-run             Report cleanup candidates without deleting them. This is the default.
  --apply               Delete cleanup candidates.
  --json                Print machine-readable result JSON.
  --preview-base-dir P  Override the preview cache root. Defaults to MANDIBLE_PREVIEW_BASE_DIR or ~/.cache/mandible/previews.
  -h, --help            Show this help.

Cleanup is conservative: active preview directories are never removed wholesale.
When open-file inspection is available, stale snapshot artifacts inside active
directories may still be pruned if they are not referenced by metadata/current.db
and are not held open.
`);
    return;
  }

  console.log(`Usage: node scripts/iab-preview.mjs [options]

Create or reuse an isolated Mandible integration preview instance.

Options:
  --json           Print machine-readable result JSON.
  --branch NAME    Use an explicit integration branch name.
  --db PATH        Source database to copy. Defaults to MANDIBLE_DB or ~/.mandible/mandible.db.
  --port PORT      Use an explicit preview port.
  --force-new      Do not reuse the current integration preview; create a new default branch/instance.
  --no-build       Skip dependency checks and npm run build.
  --dry-run        Resolve the plan without creating a DB copy or starting a daemon.
  -h, --help       Show this help.

Default branch from main/develop:
  integration/mandible-iab-preview-<yyyymmdd>-<protected-short-sha>
`);
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.previewBaseDir) {
    console.log(`Mandible IAB preview cleanup ${result.status}`);
    console.log(`Preview cache: ${result.previewBaseDir}`);
    console.log(`Reclaimable: ${result.reclaimable ?? formatBytes(result.reclaimableBytes ?? 0)}`);
    if (result.apply) console.log(`Reclaimed: ${result.reclaimed ?? formatBytes(result.reclaimedBytes ?? 0)}`);
    for (const entry of result.entries ?? []) {
      console.log(`${entry.action}: ${entry.path} (${formatBytes(entry.bytes ?? 0)}) - ${entry.reason}`);
    }
    return;
  }

  if (result.schema === "mandible-rich-briefing-demo@2") {
    console.log(`Mandible rich Briefing demo ${result.status}`);
    console.log(`Database: ${result.db}`);
    console.log(`Source database: ${result.sourceDb}`);
    console.log(`Artifact custody: ${result.artifactRoot}`);
    console.log(`Briefing: ${result.briefing.id}`);
    return;
  }

  console.log(`Mandible IAB preview ${result.status}`);
  if (result.message) console.log(result.message);
  console.log(`URL: ${result.freshUrl ?? result.url}`);
  console.log(`Branch: ${result.branch}`);
  console.log(`Worktree: ${result.worktree}`);
  console.log(`DB: ${result.db ?? result.previewRoot}`);
  if (result.port) console.log(`Port: ${result.port}`);
  if (result.launchLabel) console.log(`Launch label: ${result.launchLabel}`);
  if (result.stderrLog) console.log(`Logs: ${result.stderrLog}`);
}

function resolveProtectedBranch(repoRoot) {
  const hasDevelop = spawnSync("git", ["rev-parse", "--verify", "--quiet", "develop"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).status === 0;
  return hasDevelop ? "develop" : "main";
}

function resolveWorktreeHostRoot(repoRoot) {
  const commonDir = git(["rev-parse", "--git-common-dir"], { cwd: repoRoot }).stdout.trim();
  const absoluteCommonDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(repoRoot, commonDir);
  if (path.basename(absoluteCommonDir) === ".git") {
    return path.dirname(absoluteCommonDir);
  }
  return repoRoot;
}

function ensureIntegrationWorktree(repoRoot, worktreeHostRoot, branch, base, options) {
  if (!branch.startsWith("integration/")) {
    throw new Error(`Preview branch must start with integration/: ${branch}`);
  }

  const existing = worktreeForBranch(repoRoot, branch);
  if (existing) return existing;

  const target = path.join(worktreeHostRoot, "worktrees", branch.replaceAll("/", "__"));
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (branchExists(repoRoot, branch)) {
    run("git", ["worktree", "add", target, branch], { cwd: repoRoot });
    return target;
  }

  if (commandExists("wt") && !options.forceGitWorktree) {
    const result = run("wt", [branch, base], { cwd: worktreeHostRoot });
    const afterWt = worktreeForBranch(repoRoot, branch);
    if (afterWt) return afterWt;

    const lastPath = result.stdout.trim().split(/\r?\n/).reverse()
      .find((line) => line.startsWith("/"));
    if (lastPath && fs.existsSync(lastPath)) return lastPath;
  } else {
    run("git", ["worktree", "add", "-b", branch, target, base], { cwd: repoRoot });
  }

  const created = worktreeForBranch(repoRoot, branch);
  if (!created) {
    throw new Error(`Created branch ${branch}, but could not locate its worktree.`);
  }
  return created;
}

function plannedWorktreePath(repoRoot, worktreeHostRoot, branch) {
  return worktreeForBranch(repoRoot, branch) ?? path.join(worktreeHostRoot, "worktrees", branch.replaceAll("/", "__"));
}

function worktreeForBranch(repoRoot, branch) {
  const output = git(["worktree", "list", "--porcelain"], { cwd: repoRoot }).stdout;
  let currentPath = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line === `branch refs/heads/${branch}`) {
      return currentPath;
    }
  }
  return null;
}

function branchExists(repoRoot, branch) {
  return spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repoRoot,
  }).status === 0;
}

async function healthyExistingPreview(branch, expected = {}) {
  const preview = previewPaths(branch);
  if (!fs.existsSync(preview.metadata)) return null;

  const metadata = JSON.parse(fs.readFileSync(preview.metadata, "utf8"));
  if (!metadata.port) return null;

  const health = await readHealth(metadata.port);
  if (!health) return null;
  if (!hasExpectedPreviewPolicy(health)) return null;
  if (!hasExpectedPreviewFileRpc(metadata, health, preview.root)) return null;
  validatePreviewIdentity(metadata, preview, branch, expected.worktree);

  return {
    ...metadata,
    health,
    freshUrl: browserUrl(metadata.port),
  };
}

async function refreshExistingPreview(existing, details) {
  const preview = previewPaths(details.branch);
  const validated = validateRefreshContract(existing, preview, details);

  ensureDependencies(details.worktree);
  run("npm", ["run", "build"], { cwd: details.worktree });

  writeRunScript(validated.runScript, {
    worktree: details.worktree,
    port: validated.port,
    dbCopy: validated.dbCopy,
    sourceDb: validated.sourceDb,
    pidFile: validated.pidFile,
    nodePath: process.execPath,
    stdoutLog: validated.stdoutLog,
    stderrLog: validated.stderrLog,
  });

  const restartLifecycle = await restartPreviewProcess({
    launchLabel: validated.launchLabel,
    runScript: validated.runScript,
    worktree: details.worktree,
    port: validated.port,
    dbCopy: validated.dbCopy,
    sourceDb: validated.sourceDb,
    pidFile: validated.pidFile,
    stdoutLog: validated.stdoutLog,
    stderrLog: validated.stderrLog,
  });

  const health = await waitForPreviewRevision(
    validated.port,
    {
      head: details.currentHead,
      dbCopy: validated.dbCopy,
      sourceDb: validated.sourceDb,
      previewRoot: preview.root,
    },
    HEALTH_TIMEOUT_MS,
    validated.stderrLog,
  );
  const refreshed = {
    ...existing,
    ok: true,
    status: "refreshed",
    mode: details.mode,
    message: `Refreshed the existing preview from ${shortHash(existing.health.startup_commit.hash)} to ${shortHash(details.currentHead)}.`,
    branch: details.branch,
    worktree: details.worktree,
    port: validated.port,
    db: validated.dbCopy,
    sourceDb: validated.sourceDb,
    previewRoot: preview.root,
    launchLabel: validated.launchLabel,
    pidFile: validated.pidFile,
    stdoutLog: validated.stdoutLog,
    stderrLog: validated.stderrLog,
    runScript: validated.runScript,
    instanceEnv: validated.instanceEnv,
    restartLifecycle,
    health,
    refreshedAt: new Date().toISOString(),
    previousStartupCommit: existing.health.startup_commit,
  };
  delete refreshed.freshUrl;
  delete refreshed.browserEnrollment;
  fs.writeFileSync(preview.metadata, `${JSON.stringify(refreshed, null, 2)}\n`);
  return withBrowserReadyUrl(refreshed);
}

function validatePreviewIdentity(metadata, preview, branch, expectedWorktree) {
  if (metadata.branch !== branch) {
    throw new Error(`Refusing preview reuse: metadata branch ${metadata.branch ?? "<missing>"} does not match ${branch}.`);
  }
  if (expectedWorktree && (!metadata.worktree || canonicalPath(metadata.worktree) !== canonicalPath(expectedWorktree))) {
    throw new Error(
      `Refusing preview reuse: metadata worktree ${metadata.worktree ?? "<missing>"} does not match ${expectedWorktree}.`,
    );
  }
  if (metadata.previewRoot && canonicalPath(metadata.previewRoot) !== canonicalPath(preview.root)) {
    throw new Error(`Refusing preview reuse: metadata preview root does not match ${preview.root}.`);
  }
}

function validateRefreshContract(existing, preview, details) {
  validatePreviewIdentity(existing, preview, details.branch, details.worktree);
  if (!/^[0-9a-f]{40}$/.test(details.currentHead)) {
    throw new Error(`Cannot refresh preview from invalid worktree HEAD: ${details.currentHead}`);
  }
  if (!/^[0-9a-f]{40}$/.test(existing.health?.startup_commit?.hash ?? "")) {
    throw new Error("Cannot refresh preview because health.startup_commit.hash is missing or is not a full commit hash.");
  }

  const port = existing.port;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Cannot refresh preview because metadata.port is invalid.");
  }
  const expectedLabel = previewLaunchLabel(port, details.branch);
  if (existing.launchLabel !== expectedLabel) {
    throw new Error(`Refusing preview refresh: launch label ${existing.launchLabel ?? "<missing>"} does not match ${expectedLabel}.`);
  }

  const expectedPaths = {
    dbCopy: path.join(preview.root, path.basename(existing.db ?? "")),
    pidFile: path.join(preview.root, "mandible.pid"),
    stdoutLog: path.join(preview.root, "stdout.log"),
    stderrLog: path.join(preview.root, "stderr.log"),
    runScript: path.join(preview.root, "run.sh"),
  };
  if (!existing.db || canonicalPath(existing.db) !== canonicalPath(expectedPaths.dbCopy)) {
    throw new Error("Refusing preview refresh: metadata database is missing or outside the selected preview root.");
  }
  const currentDb = readSymlinkTarget(path.join(preview.root, "current.db"));
  if (!fs.existsSync(existing.db) || !currentDb || canonicalPath(currentDb) !== canonicalPath(existing.db)) {
    throw new Error("Refusing preview refresh: metadata database is missing or current.db does not select it.");
  }
  for (const [key, expectedPath] of Object.entries(expectedPaths)) {
    if (key === "dbCopy") continue;
    if (!existing[key] || canonicalPath(existing[key]) !== canonicalPath(expectedPath)) {
      throw new Error(`Refusing preview refresh: metadata ${key} does not match ${expectedPath}.`);
    }
  }
  if (!existing.sourceDb || !fs.existsSync(existing.sourceDb)) {
    throw new Error("Refusing preview refresh: metadata sourceDb is missing or unreadable.");
  }

  const instanceEnv = previewInstanceEnv({
    port,
    dbCopy: existing.db,
    sourceDb: existing.sourceDb,
    pidFile: expectedPaths.pidFile,
  });
  for (const [key, value] of Object.entries(instanceEnv)) {
    if (existing.instanceEnv?.[key] !== value) {
      throw new Error(`Refusing preview refresh: persisted ${key} does not match the required preview contract.`);
    }
  }
  if (!hasExpectedPreviewFileRpc(existing, existing.health, preview.root)) {
    throw new Error("Refusing preview refresh: preview file-RPC custody is not isolated to the selected preview root.");
  }

  return {
    port,
    launchLabel: expectedLabel,
    ...expectedPaths,
    sourceDb: existing.sourceDb,
    instanceEnv,
  };
}

function withBrowserReadyUrl(preview) {
  const tokenPath = path.join(
    preview.previewRoot ?? path.dirname(preview.db),
    "config",
    "client-auth",
    "bootstrap-token",
  );
  const token = readProtectedToken(tokenPath);
  return {
    ...preview,
    freshUrl: browserUrl(preview.port, token),
    browserEnrollment: token ? "one-time-fragment" : "existing-session",
  };
}

function browserUrl(port, token = null) {
  const hashQuery = token
    ? `?${new URLSearchParams({ mandible_auth: token }).toString()}`
    : "";
  return `http://127.0.0.1:${port}/?fresh=${Date.now()}#/timeline${hashQuery}`;
}

function readProtectedToken(tokenPath) {
  try {
    const stat = fs.statSync(tokenPath);
    if (!stat.isFile()) return null;
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error(`Preview bootstrap token has unsafe permissions: ${tokenPath}`);
    }
    return fs.readFileSync(tokenPath, "utf8").trim() || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function analyzePreviewDirForCleanup(dirPath, apply) {
  const metadataPath = path.join(dirPath, "metadata.json");
  const currentPath = path.join(dirPath, "current.db");
  const metadata = readJsonFile(metadataPath);
  const currentTarget = readSymlinkTarget(currentPath);
  const pidCandidates = [
    metadata?.pidFile,
    path.join(dirPath, "mandible.pid"),
  ].filter(Boolean);
  const livePid = pidCandidates.some((pidFile) => {
    const pid = readPidFile(pidFile);
    return pid !== null && isProcessAlive(pid);
  });
  const liveHealth = metadata?.port ? await readHealth(metadata.port) : null;

  if (!metadata) {
    return {
      path: dirPath,
      kind: "preview-dir",
      action: "skip",
      reason: "missing or unreadable metadata; manual inspection required",
      bytes: 0,
      metadataDb: null,
      currentDb: currentTarget,
    };
  }

  if (livePid || liveHealth) {
    const openFileInspection = inspectOpenSnapshotArtifacts(dirPath);
    const snapshotCleanup = prunePreviewSnapshots(dirPath, {
      apply,
      keepDbPaths: [metadata.db, currentTarget].filter(Boolean),
      keepArtifactPaths: openFileInspection.paths,
      protectAllReason: openFileInspection.available
        ? null
        : "lsof is unavailable; active preview snapshot artifacts require manual inspection",
    });
    return {
      path: dirPath,
      kind: "preview-dir",
      action: "skip-active",
      reason: liveHealth
        ? `metadata port ${metadata.port} answered /api/health`
        : "metadata or directory pid file points to a live process",
      bytes: snapshotCleanup.reclaimableBytes,
      reclaimedBytes: snapshotCleanup.reclaimedBytes,
      reclaimable: snapshotCleanup.reclaimable,
      reclaimed: snapshotCleanup.reclaimed,
      port: metadata.port ?? null,
      pidFiles: pidCandidates,
      metadataDb: metadata.db ?? null,
      currentDb: currentTarget,
      openFileInspection,
      snapshotCleanup,
    };
  }

  const bytes = directorySize(dirPath);
  return {
    path: dirPath,
    kind: "preview-dir",
    action: "delete-dir",
    reason: apply
      ? "stale preview directory removed after metadata, pid, and health checks"
      : "stale preview directory; metadata exists, no live pid, and health check failed",
    bytes,
    port: metadata.port ?? null,
    pidFiles: pidCandidates,
    metadataDb: metadata.db ?? null,
    currentDb: currentTarget,
  };
}

function prunePreviewSnapshots(previewRoot, options) {
  const keep = new Set();
  for (const candidate of options.keepDbPaths ?? []) {
    addProtectedSnapshotPaths(keep, candidate);
  }
  for (const candidate of options.keepArtifactPaths ?? []) {
    addProtectedSnapshotArtifactPaths(keep, candidate);
  }
  const currentTarget = readSymlinkTarget(path.join(previewRoot, "current.db"));
  addProtectedSnapshotPaths(keep, currentTarget);

  const entries = [];
  let reclaimableBytes = 0;
  let reclaimedBytes = 0;
  for (const dirent of fs.readdirSync(previewRoot, { withFileTypes: true })) {
    if (!dirent.isFile() || !DB_SNAPSHOT_ARTIFACT_PATTERN.test(dirent.name)) continue;

    const filePath = path.join(previewRoot, dirent.name);
    const resolved = canonicalPath(filePath);
    if (options.protectAllReason) {
      entries.push({
        path: filePath,
        action: "skip",
        reason: options.protectAllReason,
        bytes: 0,
      });
      continue;
    }
    if (keep.has(resolved)) {
      entries.push({
        path: filePath,
        action: "skip",
        reason: "preview database snapshot artifact is protected by metadata, current.db, or open file inspection",
        bytes: 0,
      });
      continue;
    }

    const bytes = fs.statSync(filePath).size;
    const entry = {
      path: filePath,
      action: "delete-file",
      reason: "older preview database snapshot artifact superseded by healthy preview start",
      bytes,
    };
    entries.push(entry);
    reclaimableBytes += bytes;
    if (options.apply) {
      fs.rmSync(filePath, { force: true });
      reclaimedBytes += bytes;
    }
  }

  return {
    status: options.apply ? "applied" : "dry-run",
    keptDbPaths: [...keep],
    reclaimableBytes,
    reclaimedBytes,
    reclaimable: formatBytes(reclaimableBytes),
    reclaimed: formatBytes(reclaimedBytes),
    entries,
  };
}

function inspectOpenSnapshotArtifacts(previewRoot) {
  if (!commandExists("lsof")) {
    return {
      available: false,
      reason: "lsof is not available",
      paths: [],
    };
  }

  const result = run("lsof", ["-F", "n", "+D", previewRoot], { allowFailure: true });
  if (result.error) {
    return {
      available: false,
      reason: result.error.message,
      paths: [],
    };
  }

  const paths = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const filePath = line.slice(1);
    if (!filePath || !DB_SNAPSHOT_ARTIFACT_PATTERN.test(path.basename(filePath))) continue;
    const resolved = canonicalPath(filePath);
    if (isPathWithin(previewRoot, resolved)) paths.add(resolved);
  }

  return {
    available: true,
    reason: paths.size > 0 ? "lsof reported open snapshot artifacts" : "lsof reported no open snapshot artifacts",
    paths: [...paths],
  };
}

function addProtectedSnapshotPaths(paths, dbPath) {
  if (!dbPath) return;
  const resolved = canonicalPath(dbPath);
  paths.add(resolved);
  if (!DB_SNAPSHOT_PATTERN.test(path.basename(resolved))) return;
  for (const sidecarPath of snapshotSidecarPaths(resolved)) {
    paths.add(sidecarPath);
  }
}

function addProtectedSnapshotArtifactPaths(paths, artifactPath) {
  if (!artifactPath) return;
  const resolved = canonicalPath(artifactPath);
  paths.add(resolved);
  const dbPath = snapshotBaseDbPath(resolved);
  if (dbPath) addProtectedSnapshotPaths(paths, dbPath);
}

function snapshotBaseDbPath(artifactPath) {
  const basename = path.basename(artifactPath);
  if (!DB_SNAPSHOT_ARTIFACT_PATTERN.test(basename)) return null;
  if (basename.endsWith(".db")) return artifactPath;
  return artifactPath.replace(
    /\.db(?:-(?:wal|shm)|\.manifest\.json|\.partial-\d+(?:-(?:journal|wal|shm))?|\.manifest\.json\.partial-\d+)$/,
    ".db",
  );
}

function snapshotSidecarPaths(dbPath) {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.manifest.json`]
    .map((candidate) => canonicalPath(candidate));
}

function isPathWithin(parentPath, candidatePath) {
  const relative = path.relative(canonicalPath(parentPath), canonicalPath(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(candidatePath) {
  try {
    return fs.realpathSync.native(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

function canonicalFuturePath(candidatePath) {
  let probe = path.resolve(candidatePath);
  const suffix = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    suffix.unshift(path.basename(probe));
    probe = parent;
  }
  return path.join(canonicalPath(probe), ...suffix);
}

function ensureDependencies(worktree) {
  const tsc = path.join(worktree, "node_modules", "typescript", "lib", "tsc.js");
  const esbuild = path.join(worktree, "node_modules", "esbuild", "bin", "esbuild");
  if (fs.existsSync(tsc) && fs.existsSync(esbuild)) return;

  const nodeModules = path.join(worktree, "node_modules");
  if (fs.existsSync(nodeModules) && fs.lstatSync(nodeModules).isSymbolicLink()) {
    throw new Error(`Refusing to install dependencies through symlinked node_modules: ${nodeModules}`);
  }

  const ci = run("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: worktree,
    allowFailure: true,
  });
  if (ci.status === 0) return;

  run("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], { cwd: worktree });
}

function createProjectedSnapshot({ sourceDb, dbCopy, worktree }) {
  const script = path.join(worktree, "scripts", "project-db-snapshot.mjs");
  if (!fs.existsSync(script)) {
    throw new Error(`Projected database extractor does not exist: ${script}`);
  }
  const result = run(process.execPath, [
    script,
    "--source", sourceDb,
    "--output", dbCopy,
    "--json",
  ], { cwd: worktree });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Projected database extractor returned invalid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function startPreviewProcess(details) {
  const launchctl = launchctlCommand();
  if (launchctl) {
    run(launchctl, ["remove", details.launchLabel], { allowFailure: true });
    run(launchctl, ["submit", "-l", details.launchLabel, "--", "/bin/zsh", details.runScript]);
    return;
  }

  const stdout = fs.openSync(details.stdoutLog, "a");
  const stderr = fs.openSync(details.stderrLog, "a");
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: details.worktree,
    detached: true,
    env: previewProcessEnv(details),
    stdio: ["ignore", stdout, stderr],
  });
  child.unref();
}

async function restartPreviewProcess(details) {
  const launchctl = launchctlCommand();
  if (!launchctl) {
    return startPreviewProcess(details);
  }

  // `launchctl remove` returns while a submitted job may still be SIGTERMed and
  // registered. An immediate `submit` can therefore race deregistration after
  // the old daemon is already down (and can also sever the session carrying
  // this command). Kickstart keeps launchd registration intact throughout.
  const serviceTarget = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/${details.launchLabel}`;
  const before = run(launchctl, ["print", serviceTarget], { allowFailure: true });
  if (before.status !== 0) {
    throw new Error(
      `Refusing preview restart because launchd service ${serviceTarget} is not registered.\n` +
      describeCommandResult(launchctl, ["print", serviceTarget], before),
    );
  }

  const replacementArgs = ["kickstart", "-kp", serviceTarget];
  const replacement = run(launchctl, replacementArgs, { allowFailure: true });
  if (replacement.status === 0) {
    const confirmed = run(launchctl, ["print", serviceTarget], { allowFailure: true });
    if (confirmed.status === 0) {
      return {
        mechanism: "launchctl-kickstart",
        serviceTarget,
        replacementPid: parseLaunchctlPid(replacement.stdout),
        recovery: "not-needed",
      };
    }
    return recoverLaunchdPreview(details, launchctl, serviceTarget, {
      reason: "replacement command succeeded but service registration could not be confirmed",
      evidence: describeCommandResult(launchctl, ["print", serviceTarget], confirmed),
    });
  }

  return recoverLaunchdPreview(details, launchctl, serviceTarget, {
    reason: "replacement kickstart failed",
    evidence: describeCommandResult(launchctl, replacementArgs, replacement),
  });
}

function recoverLaunchdPreview(details, launchctl, serviceTarget, failure) {
  const registration = run(launchctl, ["print", serviceTarget], { allowFailure: true });
  let recoveryArgs;
  if (registration.status === 0) {
    recoveryArgs = ["kickstart", "-p", serviceTarget];
  } else {
    recoveryArgs = ["submit", "-l", details.launchLabel, "--", "/bin/zsh", details.runScript];
  }
  const recovery = run(launchctl, recoveryArgs, { allowFailure: true });
  const confirmed = run(launchctl, ["print", serviceTarget], { allowFailure: true });
  if (recovery.status === 0 && confirmed.status === 0) {
    return {
      mechanism: "launchctl-kickstart",
      serviceTarget,
      replacementPid: parseLaunchctlPid(recovery.stdout),
      recovery: registration.status === 0 ? "kickstart-registered-service" : "resubmit-missing-service",
      initialFailure: failure,
    };
  }

  throw new Error([
    `Preview restart failed and recovery could not confirm launchd service ${serviceTarget}.`,
    failure.reason,
    failure.evidence,
    describeCommandResult(launchctl, recoveryArgs, recovery),
    describeCommandResult(launchctl, ["print", serviceTarget], confirmed),
    `Recovery command: ${[launchctl, ...recoveryArgs].join(" ")}`,
  ].join("\n"));
}

function launchctlCommand() {
  return process.env.MANDIBLE_IAB_PREVIEW_LAUNCHCTL ||
    (process.platform === "darwin" && commandExists("launchctl") ? "launchctl" : null);
}

function parseLaunchctlPid(stdout) {
  const value = Number.parseInt(String(stdout ?? "").trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function describeCommandResult(command, args, result) {
  const output = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n") || "no output";
  return `${command} ${args.join(" ")} exited ${result.status ?? "without status"}: ${output}`;
}

function writeRunScript(runScript, details) {
  const env = previewInstanceEnv(details);
  const content = `#!/bin/zsh
set -euo pipefail
cd ${shellQuote(details.worktree)}
exec env \\
${Object.entries(env).map(([key, value]) => `  ${key}=${shellQuote(String(value))} \\`).join("\n")}
  ${shellQuote(details.nodePath)} dist/index.js >> ${shellQuote(details.stdoutLog)} 2>> ${shellQuote(details.stderrLog)}
`;
  fs.writeFileSync(runScript, content, { mode: 0o755 });
}

function previewInstanceEnv(details) {
  const fileRpcDir = path.join(path.dirname(details.dbCopy), "agent-rpc");
  const configDir = path.join(path.dirname(details.dbCopy), "config");
  return {
    MANDIBLE_PORT: String(details.port),
    MANDIBLE_DB: details.dbCopy,
    MANDIBLE_PID_FILE: details.pidFile,
    MANDIBLE_INSTANCE_ROLE: "preview",
    MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
    MANDIBLE_INSTANCE_SOURCE_DB: details.sourceDb,
    MANDIBLE_FILE_RPC_DIR: fileRpcDir,
    MANDIBLE_CONFIG_DIR: configDir,
  };
}

function previewProcessEnv(details) {
  return {
    ...process.env,
    ...previewInstanceEnv(details),
  };
}

async function waitForHealth(port, timeoutMs, stderrLog) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await readHealth(port);
    if (health) {
      if (!hasExpectedPreviewPolicy(health)) {
        throw new Error(
          `Preview on port ${port} became healthy without preview/reject instance policy: ` +
          `${describePreviewPolicy(health)}`,
        );
      }
      return health;
    }
    await delay(500);
  }

  const tail = fs.existsSync(stderrLog)
    ? fs.readFileSync(stderrLog, "utf8").split(/\r?\n/).slice(-80).join("\n")
    : "";
  throw new Error(`Preview did not become healthy on port ${port}.${tail ? `\nRecent stderr:\n${tail}` : ""}`);
}

async function waitForPreviewRevision(port, expected, timeoutMs, stderrLog) {
  const start = Date.now();
  let lastHealth = null;
  while (Date.now() - start < timeoutMs) {
    const health = await readHealth(port);
    if (health) {
      lastHealth = health;
      if (!hasExpectedPreviewPolicy(health)) {
        throw new Error(
          `Preview on port ${port} became healthy without preview/reject instance policy: ` +
          `${describePreviewPolicy(health)}`,
        );
      }
      if (health.ready === true && health.warm === true &&
          health.startup_commit?.hash === expected.head &&
          hasExpectedRefreshHealth(health, expected)) {
        return health;
      }
    }
    await delay(500);
  }

  const tail = fs.existsSync(stderrLog)
    ? fs.readFileSync(stderrLog, "utf8").split(/\r?\n/).slice(-80).join("\n")
    : "";
  const observed = lastHealth?.startup_commit?.hash ?? "unavailable";
  throw new Error(
    `Preview on port ${port} did not become ready and warm at ${expected.head} with the persisted isolation contract; ` +
    `last startup commit was ${observed}.` +
    `${tail ? `\nRecent stderr:\n${tail}` : ""}`,
  );
}

function readHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/api/health",
      timeout: 1_000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

function hasExpectedPreviewPolicy(health) {
  return health?.instance?.role === "preview" &&
    health.instance.operational_mutations === "reject";
}

function hasExpectedPreviewFileRpc(metadata, health, previewRoot) {
  const expected = canonicalPath(path.join(previewRoot, "agent-rpc"));
  const candidates = [
    metadata?.instanceEnv?.MANDIBLE_FILE_RPC_DIR,
    health?.file_rpc_dir,
  ].filter(Boolean).map(canonicalPath);
  return candidates.length > 0 && candidates.every((candidate) => candidate === expected);
}

function hasExpectedRefreshHealth(health, expected) {
  return canonicalPath(health?.instance?.db_path ?? "") === canonicalPath(expected.dbCopy) &&
    health?.instance?.db_path_source === "iab-preview-copy" &&
    canonicalPath(health?.instance?.source_db_path ?? "") === canonicalPath(expected.sourceDb) &&
    canonicalPath(health?.file_rpc_dir ?? "") === canonicalPath(path.join(expected.previewRoot, "agent-rpc"));
}

function describePreviewPolicy(health) {
  const role = health?.instance?.role ?? "unknown";
  const policy = health?.instance?.operational_mutations ?? "unknown";
  return `role=${role}, operational_mutations=${policy}`;
}

async function findFreePort(start, end) {
  for (let port = start; port <= end; port += 1) {
    if (!await isPortOpen(port)) return port;
  }
  throw new Error(`No free TCP port found in ${start}-${end}`);
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

function previewPaths(branch) {
  const root = path.join(previewBaseDir(), slugify(branch));
  return {
    root,
    metadata: path.join(root, "metadata.json"),
  };
}

function previewBaseDir(override = null) {
  return path.resolve(expandHome(override ?? process.env.MANDIBLE_PREVIEW_BASE_DIR ?? DEFAULT_PREVIEW_BASE_DIR));
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readSymlinkTarget(linkPath) {
  try {
    const target = fs.readlinkSync(linkPath);
    return path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

function readPidFile(filePath) {
  try {
    const value = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function directorySize(targetPath) {
  let total = 0;
  for (const dirent of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, dirent.name);
    if (dirent.isDirectory()) {
      total += directorySize(entryPath);
    } else if (dirent.isFile()) {
      total += fs.statSync(entryPath).size;
    } else if (dirent.isSymbolicLink()) {
      total += fs.lstatSync(entryPath).size;
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units.shift();
  while (value >= 1024 && units.length > 0) {
    value /= 1024;
    unit = units.shift();
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });

  if (result.error && !options.allowFailure) {
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error([
      `${command} ${commandArgs.join(" ")} failed with exit ${result.status}`,
      stderr,
      stdout,
    ].filter(Boolean).join("\n"));
  }

  return result;
}

function git(commandArgs, options = {}) {
  return run("git", commandArgs, options);
}

function commandExists(command) {
  return spawnSync("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    stdio: "ignore",
  }).status === 0;
}

function replaceSymlink(target, linkPath) {
  try {
    fs.unlinkSync(linkPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  fs.symlinkSync(target, linkPath);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function slugify(value) {
  return value
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function previewLaunchLabel(port, branch) {
  return `bio.mll.mandible.preview.${port}.${slugify(branch)}`.slice(0, 240);
}

function shortHash(value) {
  return String(value).slice(0, 8);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function formatDateStamp(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
}

function formatTimeStamp(date) {
  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

function formatDateTimeForFile(date) {
  return `${formatDateStamp(date)}-${formatTimeStamp(date)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
