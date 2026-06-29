#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_PORT_START = 19421;
const DEFAULT_PORT_END = 19499;
const DEFAULT_DB_PATH = path.join(os.homedir(), ".cache", "mandible", "mandible.db");
const DEFAULT_PREVIEW_BASE_DIR = path.join(os.homedir(), ".cache", "mandible", "previews");
const HEALTH_TIMEOUT_MS = 30_000;
const DB_SNAPSHOT_PATTERN = /^mandible-\d{8}-\d{6}\.db$/;

const command = process.argv[2] === "cleanup" ? "cleanup" : "preview";
const args = parseArgs(command === "cleanup" ? process.argv.slice(3) : process.argv.slice(2), command);

if (args.help) {
  printUsage(command);
  process.exit(0);
}

try {
  const result = command === "cleanup" ? await cleanupPreviewCache(args) : await main(args);
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
    const existing = await healthyExistingPreview(branch);
    if (existing) {
      return {
        ok: true,
        status: "already-running",
        mode,
        message: "Already on an integration branch with a healthy preview.",
        ...existing,
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
    const existing = !options.forceNew ? await healthyExistingPreview(branch) : null;
    if (existing && !options.dryRun) {
      return {
        ok: true,
        status: "already-running",
        mode,
        message: "Preview metadata points to a healthy instance.",
        ...existing,
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
      wouldCopyDb: true,
      wouldStart: true,
      instanceEnv: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
        MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
        MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
      },
    };
  }

  fs.mkdirSync(preview.root, { recursive: true });

  if (!options.noBuild) {
    ensureDependencies(worktree);
    run("npm", ["run", "build"], { cwd: worktree });
  }

  const port = options.port ?? await findFreePort(DEFAULT_PORT_START, DEFAULT_PORT_END);
  if (!fs.existsSync(sourceDb)) {
    throw new Error(`Source database does not exist: ${sourceDb}`);
  }

  const dbCopy = path.join(preview.root, `mandible-${formatDateTimeForFile(new Date())}.db`);
  run("sqlite3", [sourceDb, `.backup '${dbCopy.replaceAll("'", "''")}'`], { cwd: worktree });
  replaceSymlink(dbCopy, path.join(preview.root, "current.db"));

  const stdoutLog = path.join(preview.root, "stdout.log");
  const stderrLog = path.join(preview.root, "stderr.log");
  const pidFile = path.join(preview.root, "mandible.pid");
  const launchLabel = `bio.mll.mandible.preview.${port}.${slugify(branch)}`.slice(0, 240);
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
  return metadata;
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
        if (dbPath) protectedDbPaths.add(path.resolve(dbPath));
      }
      if (entry.action === "delete-dir") {
        report.reclaimableBytes += entry.bytes;
        if (options.apply) {
          fs.rmSync(entryPath, { recursive: true, force: true });
          report.reclaimedBytes += entry.bytes;
        }
      }
    }
  }

  for (const dirent of rootEntries) {
    const entryPath = path.join(root, dirent.name);
    if (dirent.isFile() && DB_SNAPSHOT_PATTERN.test(dirent.name)) {
      const bytes = fs.statSync(entryPath).size;
      if (protectedDbPaths.has(path.resolve(entryPath))) {
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
  if (commandName === "cleanup") {
    console.log(`Usage: node scripts/iab-preview.mjs cleanup [options]

Clean stale Mandible IAB preview cache entries.

Options:
  --dry-run             Report cleanup candidates without deleting them. This is the default.
  --apply               Delete cleanup candidates.
  --json                Print machine-readable result JSON.
  --preview-base-dir P  Override the preview cache root. Defaults to MANDIBLE_PREVIEW_BASE_DIR or ~/.cache/mandible/previews.
  -h, --help            Show this help.

Cleanup is conservative: active preview directories are skipped when metadata,
current.db, pid files, or live health checks indicate the preview may still be in use.
`);
    return;
  }

  console.log(`Usage: node scripts/iab-preview.mjs [options]

Create or reuse an isolated Mandible integration preview instance.

Options:
  --json           Print machine-readable result JSON.
  --branch NAME    Use an explicit integration branch name.
  --db PATH        Source database to copy. Defaults to MANDIBLE_DB or ~/.cache/mandible/mandible.db.
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

async function healthyExistingPreview(branch) {
  const preview = previewPaths(branch);
  if (!fs.existsSync(preview.metadata)) return null;

  const metadata = JSON.parse(fs.readFileSync(preview.metadata, "utf8"));
  if (!metadata.port) return null;

  const health = await readHealth(metadata.port);
  if (!health) return null;

  return {
    ...metadata,
    health,
    freshUrl: `http://127.0.0.1:${metadata.port}/?fresh=${Date.now()}#/timeline`,
  };
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
    return {
      path: dirPath,
      kind: "preview-dir",
      action: "skip-active",
      reason: liveHealth
        ? `metadata port ${metadata.port} answered /api/health`
        : "metadata or directory pid file points to a live process",
      bytes: 0,
      port: metadata.port ?? null,
      pidFiles: pidCandidates,
      metadataDb: metadata.db ?? null,
      currentDb: currentTarget,
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
  const keep = new Set((options.keepDbPaths ?? []).map((candidate) => path.resolve(candidate)));
  const currentTarget = readSymlinkTarget(path.join(previewRoot, "current.db"));
  if (currentTarget) keep.add(path.resolve(currentTarget));

  const entries = [];
  let reclaimableBytes = 0;
  let reclaimedBytes = 0;
  for (const dirent of fs.readdirSync(previewRoot, { withFileTypes: true })) {
    if (!dirent.isFile() || !DB_SNAPSHOT_PATTERN.test(dirent.name)) continue;

    const filePath = path.join(previewRoot, dirent.name);
    const resolved = path.resolve(filePath);
    if (keep.has(resolved)) continue;

    const bytes = fs.statSync(filePath).size;
    const entry = {
      path: filePath,
      action: "delete-file",
      reason: "older preview database snapshot superseded by healthy preview start",
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

async function startPreviewProcess(details) {
  if (process.platform === "darwin" && commandExists("launchctl")) {
    run("launchctl", ["remove", details.launchLabel], { allowFailure: true });
    run("launchctl", ["submit", "-l", details.launchLabel, "--", "/bin/zsh", details.runScript]);
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
  return {
    MANDIBLE_PORT: String(details.port),
    MANDIBLE_DB: details.dbCopy,
    MANDIBLE_PID_FILE: details.pidFile,
    MANDIBLE_INSTANCE_ROLE: "preview",
    MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
    MANDIBLE_INSTANCE_SOURCE_DB: details.sourceDb,
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
    if (health) return health;
    await delay(500);
  }

  const tail = fs.existsSync(stderrLog)
    ? fs.readFileSync(stderrLog, "utf8").split(/\r?\n/).slice(-80).join("\n")
    : "";
  throw new Error(`Preview did not become healthy on port ${port}.${tail ? `\nRecent stderr:\n${tail}` : ""}`);
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
