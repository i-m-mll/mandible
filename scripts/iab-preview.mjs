#!/usr/bin/env bun
import fs from "node:fs";
import { withOwnedRunLock, createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun } from "./owned-run.mjs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

// Issue 24f0316 — the ledger database lives under the durable root now.
// Previews stay in the disposable cache root: they are regenerable copies.
const require = createRequire(import.meta.url);
const { liveDbPath } = require("../cli/mandible-paths.cjs");
import SqliteDatabase from "../src/sqlite.ts";

const DEFAULT_PORT_START = 29421;
const DEFAULT_PORT_END = 29499;
const DEFAULT_DB_PATH = liveDbPath();
const DEFAULT_PREVIEW_BASE_DIR = path.join(os.homedir(), ".cache", "mandible", "previews");
const HEALTH_TIMEOUT_MS = 30_000;
const APPLICATION_SHELL_MARKER_RE = /<script\b[^>]*\bid=["']mandible-bootstrap["'][^>]*>/i;
const APPLICATION_SHELL_MAX_BYTES = 512 * 1024;
const DB_SNAPSHOT_PATTERN = /^mandible-\d{8}-\d{6}\.db$/;
// Labels a previous version of this launcher submitted to launchd. Previews are
// plain child processes now; any surviving job under this namespace is a leak to
// be removed. Deliberately anchored so no label outside it can ever match.
const LEGACY_PREVIEW_LABEL_PATTERN = /^bio\.mll\.mandible\.preview\./;
const DB_SNAPSHOT_ARTIFACT_PATTERN = /^mandible-\d{8}-\d{6}\.db(?:-(?:wal|shm)|\.manifest\.json|\.partial-\d+(?:-(?:journal|wal|shm))?|\.manifest\.json\.partial-\d+)?$/;
const LOCAL_SESSION_CUTOVER_SCHEMA = "mandible-local-session-cutover@1";
const LOCAL_SESSION_CUTOVER_STATES = new Set(["preparing", "prepared", "activating", "migration", "completing", "normal_pending", "rolling_back", "complete", "rolled_back", "recovery_failed"]);
const LEGACY_PREVIEW_CONTRACT_DRIFT = new Set([
  "MANDIBLE_INSTANCE_ID",
  "MANDIBLE_INSTALLATION_ID",
  "MANDIBLE_PUBLIC_ORIGIN",
  "MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR",
  "MANDIBLE_CONTEXT_VERIFICATION_KEY",
  "MANDIBLE_ARTIFACT_DIR",
  "MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR",
  "MANDIBLE_USER_PREFERENCES_DIR",
  "MANDIBLE_ALLOWED_EFFECTS",
  "MANDIBLE_WRITABLE_ROOTS",
]);

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  await runCli();
}

async function runCli() {
  const command = process.argv[2] === "finalize" ? "finalize" : process.argv[2] === "cleanup"
    ? "cleanup"
    : process.argv[2] === "seed-briefing-demo" ? "seed-briefing-demo"
      : process.argv[2] === "seed-agents-review" ? "seed-agents-review" : "preview";
  const args = parseArgs(command === "preview" ? process.argv.slice(2) : process.argv.slice(3), command);

  if (args.help) {
    printUsage(command);
    return;
  }

  try {
    if (command === "seed-agents-review" && !args.artifactVersion) {
      throw new Error("seed-agents-review requires --artifact-version");
    }
    assertOrdinaryPreviewLifecycleAllowed();
    const result = command === "finalize" ? await finalizePreview(args) : command === "cleanup"
      ? await cleanupPreviewCache(args)
      : command === "seed-briefing-demo" ? await seedBriefingDemo(args) : await main(args);
    printResult(result, args.json);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    const describeError = (failure) => failure instanceof AggregateError
      ? `${failure.message}: ${failure.errors.map(describeError).join('; ')}`
      : failure instanceof Error ? failure.message : String(failure);
    const message = describeError(error);
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`iab-preview failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

async function main(options) {
  assertOrdinaryPreviewLifecycleAllowed();
  const legacyLaunchdCleanup = inspectLegacyPreviewJobs();
  if (legacyLaunchdCleanup.error || legacyLaunchdCleanup.labels.length) throw new Error("Registered preview service requires explicit retirement before launch; other instances are preserved");
  const repo = git(["rev-parse", "--show-toplevel"]).stdout.trim();
  const current = git(["branch", "--show-current"], { cwd: repo }).stdout.trim();
  const base = resolveProtectedBranch(repo);
  const selected = options.branch ?? (!options.forceNew && (current.startsWith("integration/") || current.startsWith("codex/integration/")) ? current
    : `integration/mandible-iab-preview-${formatDateStamp(new Date())}-${git(["rev-parse", "--short=7", base], { cwd: repo }).stdout.trim()}${options.forceNew ? `-${formatTimeStamp(new Date())}` : ""}`);
  const root = previewPaths(selected).root;
  const result = await withOwnedRunLock(root, async () => {
    try { return await createOrReusePreview({ ...options, branch: selected }); }
    catch (error) {
      const file = path.join(root, "metadata.json");
      const metadata = readJsonFile(file);
      if (metadata?.ownership && (metadata.ownership.state === "creating" || metadata.ownership.disposable)) {
        const active = await previewConsumerReason(metadata, root);
        if (!active) {
          try {
            finalizeOwnedRun(file, { expectedRevision: metadata.ownership.revision, outcome: "failed", summary: String(error).slice(0, 2000) });
            const cleanup = cleanupOwnedRun(file, { apply: true });
            if (cleanup.action !== "delete-owned" || cleanup.remaining?.length) throw new Error(cleanup.reason);
          } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Preview failed; cleanup is pending owner action"); }
        }
      }
      throw error;
    }
  });
  return { ...result, legacyLaunchdCleanup };
}

async function createOrReusePreview(options) {
  const cwd = process.cwd();
  const repoRoot = git(["rev-parse", "--show-toplevel"], { cwd }).stdout.trim();
  const worktreeHostRoot = resolveWorktreeHostRoot(repoRoot);
  const currentBranch = git(["branch", "--show-current"], { cwd: repoRoot }).stdout.trim();
  const protectedBranch = resolveProtectedBranch(repoRoot);
  const protectedHead = git(["rev-parse", "--short=7", protectedBranch], { cwd: repoRoot }).stdout.trim();
  const dateStamp = formatDateStamp(new Date());
  const currentIsProtected = currentBranch === protectedBranch;
  const currentIsIntegration = currentBranch.startsWith("integration/") || currentBranch.startsWith("codex/integration/");

  let branch;
  let worktree;
  let mode;

  if (!options.forceNew && currentIsIntegration && !currentIsProtected && (!options.branch || options.branch === currentBranch)) {
    branch = currentBranch;
    worktree = repoRoot;
    mode = "current-integration";
    const existing = await healthyExistingPreview(branch, { worktree });
    if (existing) {
      if (options.artifactVersion) throw new Error("Refusing agents review seed: preview is already running; use --force-new for a pre-start seed.");
      if (existing.legacyContractDrift && !existing.userPreferencesIsolationUpgrade && !existing.logIsolationUpgrade) {
        throw legacyPreviewRetirementRequired(existing);
      }
      const currentHead = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
      if (existing.userPreferencesIsolationUpgrade || existing.logIsolationUpgrade || existing.health?.startup_commit?.hash !== currentHead) {
        return refreshExistingPreview(existing, { branch, worktree, mode, currentHead, options });
      }
      return {
        ...await withBrowserReadyUrl(existing, { pairBrowser: options.pairBrowser }),
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
      if (options.artifactVersion) throw new Error("Refusing agents review seed: preview is already running; use --force-new for a pre-start seed.");
      if (existing.legacyContractDrift && !existing.userPreferencesIsolationUpgrade && !existing.logIsolationUpgrade) {
        throw legacyPreviewRetirementRequired(existing);
      }
      if (!selectedWorktree) {
        throw new Error(`Healthy preview metadata exists for ${branch}, but its worktree is not registered.`);
      }
      const currentHead = git(["rev-parse", "HEAD"], { cwd: selectedWorktree }).stdout.trim();
      if (existing.userPreferencesIsolationUpgrade || existing.logIsolationUpgrade || existing.health?.startup_commit?.hash !== currentHead) {
        return refreshExistingPreview(existing, {
          branch,
          worktree: selectedWorktree,
          mode,
          currentHead,
          options,
        });
      }
      return {
        ...await withBrowserReadyUrl(existing, { pairBrowser: options.pairBrowser }),
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
  // A dead preview is replaceable, but its port is browser identity: keeping
  // it preserves origin-scoped UI state and lets the existing IAB tab recover
  // on reload. Capture that identity before stale-cache cleanup removes bytes.
  const priorMetadata = readJsonFile(preview.metadata);
  const priorPort = priorMetadata?.branch === branch
    && priorMetadata?.worktree
    && canonicalPath(priorMetadata.worktree) === canonicalPath(worktree)
    && Number.isInteger(priorMetadata.port)
    ? priorMetadata.port
    : null;
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
      // Port, database copy, and pid file are not chosen until the preview
      // actually starts, so the dry run reports exactly the root-derived part
      // of the contract — from the same definition the launcher pins.
      instanceEnv: previewIsolationEnv(preview.root, sourceDb),
    };
  }

  fs.mkdirSync(preview.root, { recursive: true });
  if (fs.existsSync(preview.metadata)) {
    throw new Error(`Stopped preview material requires finalization before relaunch: ${preview.root}`);
  }
  if (fs.readdirSync(preview.root).length) throw new Error(`Unclassified preview material prevents launch: ${preview.root}`);
  const preStartCleanup = await cleanupPreviewCache({
    apply: true,
    previewBaseDir: options.previewBaseDir,
    excludeRoot: preview.root,
  });

  if (!options.noBuild) {
    ensureDependencies(worktree);
    runBun(worktree, ["run", "--bun", "build"]);
  }

  const port = options.port ?? (
    priorPort !== null && !await isPortOpen(priorPort)
      ? priorPort
      : await findFreePort(DEFAULT_PORT_START, DEFAULT_PORT_END)
  );
  if (await isPortOpen(port)) {
    throw new Error(
      `Refusing preview start: port ${port} is already occupied and no verified reusable preview owns it.`,
    );
  }
  if (!fs.existsSync(sourceDb)) {
    throw new Error(`Source database does not exist: ${sourceDb}`);
  }

  const dbCopy = path.join(preview.root, `mandible-${formatDateTimeForFile(new Date())}.db`);
  const allocation = assertPreviewAllocation(preview.root, sourceDb);
  const owner = resolvePreviewOwner(worktree, branch, options);
  const ownership = createOwnedRun({ root: preview.root, instanceId: `preview-${createHash("sha256").update(preview.root).digest("hex").slice(0, 16)}`, ...owner,
    disposable: options.disposableFixture, outputs: previewOwnedOutputs(path.basename(dbCopy)).map(output => ({ ...output, kind: "generated" })) });
  ownership.allocation = allocation;
  saveOwnedMetadata(preview.metadata, { branch, worktree, previewRoot: preview.root, sourceDb, db: dbCopy, ownership });
  const projection = await createProjectedSnapshot({ sourceDb, dbCopy, worktree, allocation });
  sanitizePreviewDatabase(dbCopy);
  const agentsReview = options.artifactVersion
    ? await materializeProjectedAgentsReview({ worktree, previewRoot: preview.root, db: dbCopy, sourceDb,
      artifactVersionRef: options.artifactVersion })
    : null;

  const stdoutLog = path.join(preview.root, "stdout.log");
  const stderrLog = path.join(preview.root, "stderr.log");
  const pidFile = path.join(preview.root, "mandible.pid");
  const runScript = path.join(preview.root, "run.sh");
  const currentHead = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
  const userPreferencesSeed = seedPreviewUserPreferences({
    previewRoot: preview.root,
    sourceRoot: path.join(mandibleHome(), "settings", "users"),
  });
  const instanceEnv = previewInstanceEnv({ port, dbCopy, sourceDb, pidFile, generation: currentHead });
  writeRunScript(runScript, {
    worktree,
    port,
    dbCopy,
    sourceDb,
    pidFile,
    nodePath: bunRuntime(worktree),
    stdoutLog,
    stderrLog,
    generation: currentHead,
  });

  fs.writeFileSync(stdoutLog, "");
  fs.writeFileSync(stderrLog, "");
  const priorRegistration = registerPreviewInstance(instanceEnv);
  let started = null;
  let health;
  try {
    reloadLocalFrontDoor();
    ownership.outputs = previewOwnedOutputs(path.basename(dbCopy), previewLogSegments(dbCopy)).map(output => ({ ...output, disposition: "pending" }));
    ownership.state = "active";
    ownership.revision += 1;
    saveOwnedMetadata(preview.metadata, { branch, worktree, previewRoot: preview.root, sourceDb, db: dbCopy, pidFile, port, instanceEnv, ownership });
    started = await startPreviewProcess({
      runScript,
      worktree,
      port,
      dbCopy,
      sourceDb,
      pidFile,
      stdoutLog,
      stderrLog,
    });
    health = await waitForPreviewReadiness(
      port,
      {
        head: currentHead,
        dbCopy,
        sourceDb,
        previewRoot: preview.root,
      },
      HEALTH_TIMEOUT_MS,
      stderrLog,
    );
  } catch (error) {
    const recoveryFailures = [];
    if (started) {
      try { await stopPreviewProcess(pidFile); } catch (recoveryError) { recoveryFailures.push(recoveryError); }
    }
    try { restorePreviewRegistration(instanceEnv, priorRegistration); } catch (recoveryError) { recoveryFailures.push(recoveryError); }
    try { reloadLocalFrontDoor(); } catch (recoveryError) { recoveryFailures.push(recoveryError); }
    if (recoveryFailures.length > 0) {
      throw new AggregateError([error, ...recoveryFailures], "Preview startup and registration rollback both failed.");
    }
    throw error;
  }
  replaceSymlink(dbCopy, path.join(preview.root, "current.db"));
  const metadata = {
    ok: true,
    status: "started",
    mode,
    branch,
    worktree,
    protectedBranch,
    port,
    url: `${instanceEnv.MANDIBLE_PUBLIC_ORIGIN}/#/timeline`,
    db: dbCopy,
    sourceDb,
    projection,
    userPreferencesSeed,
    agentsReview,
    preStartCleanup,
    instanceEnv,
    previewRoot: preview.root,
    pidFile,
    stdoutLog,
    stderrLog,
    runScript,
    health,
    startedAt: new Date().toISOString(),
    ownership,
  };

  saveOwnedMetadata(preview.metadata, metadata);
  return await withBrowserReadyUrl(metadata, { pairBrowser: options.pairBrowser });
}

async function seedBriefingDemo(options) {
  const custody = validateBriefingDemoCustody();
  return withOwnedRunLock(custody.previewRoot, () => seedBriefingDemoLocked(options, custody));
}

async function seedBriefingDemoLocked(options, custody) {
  if (!options.noBuild) buildServer(custody.worktree);

  const manifest = await materializeProjectedBriefingDemo(custody);
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
}

export async function materializeProjectedAgentsReview(details) {
  const custody = validateProjectedBriefingDemoCustody({
    ...details,
    artifactRoot: details.artifactRoot ?? path.join(details.previewRoot, "agents-review-artifacts"),
  });
  if (!details.artifactVersionRef || !/^artifact-version:[A-Za-z0-9._:-]{7,}$/.test(details.artifactVersionRef)) {
    throw new Error("Refusing agents review seed: artifact version ref is missing or malformed.");
  }
  const priorEnv = {};
  const seedEnv = {
    MANDIBLE_DB: custody.db,
    MANDIBLE_INSTANCE_ROLE: "preview",
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
    MANDIBLE_INSTANCE_SOURCE_DB: custody.sourceDb,
  };
  for (const [key, value] of Object.entries(seedEnv)) {
    priorEnv[key] = process.env[key]; process.env[key] = value;
  }
  let db = null;
  try {
    const cacheBust = `?iab-preview-agents-review=${Date.now()}`;
    const [{ openDb }, briefings, artifacts, users] = await Promise.all([
      import(`${pathToFileURL(path.join(custody.worktree, "dist", "db.js")).href}${cacheBust}`),
      import(`${pathToFileURL(path.join(custody.worktree, "dist", "feedback", "briefings.js")).href}${cacheBust}`),
      import(`${pathToFileURL(path.join(custody.worktree, "dist", "provider-artifacts.js")).href}${cacheBust}`),
      import(`${pathToFileURL(path.join(custody.worktree, "dist", "users", "store.js")).href}${cacheBust}`),
    ]);
    db = openDb(custody.db);
    const resolved = artifacts.resolveArtifactRefReadonlyFull(db, details.artifactVersionRef);
    const version = resolved.status === "resolved" && resolved.target_type === "artifact_version"
      ? artifacts.getCanonicalArtifactVersion(db, resolved.target_id) : null;
    if (!version || version.source_kind !== "tracked_repo" || version.custody_mode !== "git" || !version.commit_sha) {
      throw new Error("Refusing agents review seed: artifact version must be committed tracked-repo link custody.");
    }
    const operatorId = users.getOperatorId(db);
    if (!operatorId) throw new Error("Refusing agents review seed: configured human operator is unavailable.");
    const receipt = briefings.publishBriefingFromArtifactVersion(db, {
      briefing_key: "agents-incremental-review-prototype",
      title: "Incremental AGENTS review",
      artifact_version_ref: version.id,
      profile: "mandible-briefing.v3",
      responder_user_ids: [operatorId],
    });
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close(); db = null;
    return { schema: "mandible-agents-review-preview@1", result: "seeded", briefing_id: receipt.briefing_id,
      round_id: receipt.round_id, artifact_version_id: receipt.artifact_version_id };
  } finally {
    db?.close();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

export async function materializeProjectedBriefingDemo(details) {
  const custody = validateProjectedBriefingDemoCustody(details);

  const priorEnv = {};
  const seedEnv = {
    MANDIBLE_DB: custody.db,
    MANDIBLE_ARTIFACT_DIR: custody.artifactRoot,
    MANDIBLE_INSTANCE_ROLE: "preview",
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
    const [{ openDb }, { prepareRichBriefingDemoPreviewCopy }] = await Promise.all([
      import(`${pathToFileURL(path.join(custody.worktree, "dist", "db.js")).href}${cacheBust}`),
      import(`${pathToFileURL(path.join(custody.worktree, "dist", "feedback", "rich-briefing-demo.js")).href}${cacheBust}`),
    ]);
    db = openDb(custody.db);
    const manifest = prepareRichBriefingDemoPreviewCopy(db, {
      databasePath: custody.db,
      artifactRoot: custody.artifactRoot,
    });
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    return manifest;
  } finally {
    db?.close();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validateProjectedBriefingDemoCustody(details) {
  if (!details.worktree || !path.isAbsolute(details.worktree) || !fs.existsSync(details.worktree)) {
    throw new Error("Refusing demo materialization: worktree is missing or is not an absolute existing path.");
  }
  const worktree = canonicalPath(details.worktree);
  const previewRoot = canonicalFuturePath(details.previewRoot ?? path.dirname(details.db ?? ""));
  const db = canonicalPath(details.db ?? "");
  const sourceDb = canonicalPath(details.sourceDb ?? "");
  const artifactRoot = canonicalFuturePath(details.artifactRoot ?? path.join(previewRoot, "rich-briefing-demo-artifacts"));
  if (!fs.statSync(worktree).isDirectory()) {
    throw new Error("Refusing demo materialization: worktree is missing or is not a directory.");
  }
  if (!details.db || !path.isAbsolute(details.db) || !fs.existsSync(db) || !fs.statSync(db).isFile() ||
      !isPathWithin(previewRoot, db)) {
    throw new Error("Refusing demo materialization: database is missing or outside the private preview root.");
  }
  if (!details.sourceDb || !path.isAbsolute(details.sourceDb) || !fs.existsSync(sourceDb) ||
      !fs.statSync(sourceDb).isFile() || isPathWithin(previewRoot, sourceDb) || sourceDb === db) {
    throw new Error("Refusing demo materialization: source database is missing, aliases the target, or is inside preview custody.");
  }
  if (!isPathWithin(previewRoot, artifactRoot) || artifactRoot === previewRoot ||
      artifactRoot === canonicalFuturePath(`${details.sourceDb}.artifacts`)) {
    throw new Error("Refusing demo materialization: artifact custody is not isolated inside the private preview root.");
  }
  return { ...details, worktree, previewRoot, db, sourceDb, artifactRoot };
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
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
    MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(["ledger:read", "ledger:write", "files:preview"]),
  };
  for (const [key, value] of Object.entries(expectedPolicy)) {
    if (metadata.instanceEnv?.[key] !== value) {
      throw new Error(`Refusing demo seed: persisted ${key} does not match the preview policy.`);
    }
  }
  const persistedInstance = metadata.health?.instance;
  if (persistedInstance?.role !== "preview" || persistedInstance?.allowed_effects?.join(",") !== "ledger:read,ledger:write,files:preview" ||
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
  run(bunRuntime(worktree), [compiler, "-p", path.join(worktree, "tsconfig.json")], { cwd: worktree });
}

export async function cleanupPreviewCache(options) {
  const root = previewBaseDir(options.previewBaseDir);
  const legacyLaunchdCleanup = inspectLegacyPreviewJobs();
  const report = {
    ok: true,
    status: options.apply ? "applied" : "dry-run",
    previewBaseDir: root,
    apply: options.apply,
    legacyLaunchdCleanup,
    reclaimedBytes: 0,
    reclaimableBytes: 0,
    entries: [],
  };

  if (!fs.existsSync(root)) {
    return report;
  }

  const rootEntries = fs.readdirSync(root, { withFileTypes: true }).slice(0, 64);
  const passDeadline = Date.now() + 5_000;
  const protectedDbPaths = new Set();

  for (const dirent of rootEntries) {
    if (Date.now() >= passDeadline) { report.hasMore = true; break; }
    const entryPath = path.join(root, dirent.name);
    if (dirent.isDirectory()) {
      if (path.resolve(entryPath) === path.resolve(options.excludeRoot ?? "/" ) || dirent.name.startsWith(".")) continue;
      let entry;
      try { entry = await withOwnedRunLock(entryPath, () => analyzePreviewDirForCleanup(entryPath, options.apply)); }
      catch (error) { entry = { path: entryPath, action: "skip", reason: String(error), bytes: 0 }; }
      report.entries.push(entry);
      for (const dbPath of [entry.metadataDb, entry.currentDb]) {
        addProtectedSnapshotPaths(protectedDbPaths, dbPath);
      }
      report.reclaimableBytes += entry.bytes ?? 0;
      report.reclaimedBytes += entry.reclaimedBytes ?? 0;
      await new Promise(resolve => setImmediate(resolve));
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
        action: "skip",
        reason: "unowned snapshot requires explicit disposition",
        bytes: 0,
      };
      report.entries.push(entry);

    }
  }

  report.reclaimable = formatBytes(report.reclaimableBytes);
  report.reclaimed = formatBytes(report.reclaimedBytes);
  return report;
}

function parseArgs(argv, commandName) {
  if (commandName === "finalize") return parseFinalizeArgs(argv);
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
    pairBrowser: false,
    port: null,
    artifactVersion: null,
    disposableFixture: false,
    ownerProject: null,
    ownerWorkUnit: null,
  };

  if (commandName === "seed-agents-review") {
    options.artifactVersion = null;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--disposable-fixture": options.disposableFixture = true; break;
      case "--owner-project": options.ownerProject = requireValue(argv, ++index, arg); break;
      case "--owner-work-unit": options.ownerWorkUnit = requireValue(argv, ++index, arg); break;
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
      case "--pair-browser":
        options.pairBrowser = true;
        break;
      case "--port":
        options.port = Number.parseInt(requireValue(argv, ++index, arg), 10);
        if (!Number.isInteger(options.port) || options.port <= 0) {
          throw new Error(`Invalid --port value: ${argv[index]}`);
        }
        break;
      case "--artifact-version":
        options.artifactVersion = requireValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseFinalizeArgs(argv) {
  const options = { help: false, json: false, converged: false };
  const fields = { "--root": "root", "--revision": "revision", "--outcome": "outcome", "--disposition": "disposition", "--destination": "destination", "--summary": "summary", "--review-by": "reviewBy", "--transfer-reference": "transferReference" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") options.help = true;
    else if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--converged") options.converged = true;
    else if (fields[argv[i]]) options[fields[argv[i]]] = requireValue(argv, ++i, argv[i - 1]);
    else throw new Error(`Unknown finalization option: ${argv[i]}`);
  }
  return options;
}

export async function finalizePreview(options) {
  if (!options.root) throw new Error("finalize requires --root");
  const root = path.resolve(expandHome(options.root));
  if (canonicalPath(root) !== root || !isPathWithin(previewBaseDir(), root) || root === previewBaseDir()) throw new Error("Finalization root must be an exact owned preview child");
  return withOwnedRunLock(root, async () => {
    const file = path.join(root, "metadata.json");
    const metadata = readJsonFile(file);
    if (!metadata?.ownership) throw new Error("Legacy/unowned preview requires manual disposition; no ownership inferred");
    const active = await previewConsumerReason(metadata, root);
    if (active) throw new Error(active);
    const finalized = finalizeOwnedRun(file, { expectedRevision: Number(options.revision), outcome: options.outcome,
      converged: options.converged, disposition: options.disposition, destination: options.destination, summary: options.summary, reviewBy: options.reviewBy, transferReference: options.transferReference });
    const activeAfterDisposition = await previewConsumerReason(finalized, root);
    const cleanup = activeAfterDisposition ? { action: "skip-active", reason: activeAfterDisposition, remaining: finalized.ownership.cleanup.remaining }
      : cleanupOwnedRun(file, { apply: true });
    const complete = cleanup.action === "delete-owned" && cleanup.remaining?.length === 0;
    return { ok: complete || options.outcome === "investigating", status: options.outcome === "investigating" ? "investigating" : complete ? "cleaned" : "cleanup-pending", ...cleanup,
      outcome: options.outcome, converged: options.converged, runId: finalized.ownership.runId };
  });
}

function resolvePreviewOwner(worktree, branch, options) {
  if (options.ownerProject && options.ownerWorkUnit) return { project: options.ownerProject, workUnit: options.ownerWorkUnit };
  const project = JSON.parse(run("mandible", ["project", "show", worktree, "--json"], { cwd: worktree }).stdout);
  const found = JSON.parse(run("mandible", ["work-unit", "find", "--repo", worktree, "--branch", branch], { cwd: worktree }).stdout);
  const units = Array.isArray(found) ? found : found.work_units ?? (found.id ? [found] : []);
  const active = units.filter(unit => !["resolved", "abandoned"].includes(unit.state));
  if (active.length !== 1) throw new Error("Preview requires one owning delivery work unit; supply --owner-project and --owner-work-unit from the ledger");
  return { project: project.id ?? project.project?.id, workUnit: active[0].id };
}

function previewLogSegments(dbPath) {
  const db = new SqliteDatabase(dbPath, { readonly: true });
  try {
    const value = Number.parseInt(db.prepare("SELECT value FROM settings WHERE key = 'stderr_rotation_keep_segments'").get()?.value ?? "5", 10);
    return Number.isFinite(value) && value > 0 ? value : 5;
  } finally { db.close(); }
}

function previewOwnedOutputs(dbName, keepSegments = 5) {
  const interactive = [dbName, `${dbName}-wal`, `${dbName}-shm`, `${dbName}.manifest.json`, "artifacts", "rich-briefing-demo-artifacts", "agents-review-artifacts", "settings", "config", "conversations", "agent-rpc", "operational", "operational-logs.db", "operational-logs.db-wal", "operational-logs.db-shm"];
  const generated = [".snapshot-work", "stdout.log", "stderr.log", "run.sh", "mandible.pid", "cli", "preview-browser-enrollment.json", "current.db"];
  for (let segment = 1; segment <= keepSegments; segment++) generated.push(`stdout.log.${segment}`, `stderr.log.${segment}`);
  return [...interactive.map(path => ({ path, kind: "interactive" })), ...generated.map(path => ({ path, kind: "generated" }))];
}

export function assertPreviewAllocation(root, sourceDb, options = {}) {
  const policy = { schema: "mandible-preview-budget@1", reserveBytes: 512 * 1024 * 1024, maxIntermediateBytes: 2 * 1024 * 1024 * 1024 };
  if (!fs.statSync(sourceDb).isFile()) throw new Error("Preview source database must be a file");
  const estimate = 128 * 1024 * 1024;
  const volume = options.volume ?? fs.statfsSync(root);
  const available = Number(volume.bavail) * Number(volume.bsize);
  const base = path.dirname(root);
  const ownedRoots = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
  const measurementDeadline = Date.now() + 5_000;
  const currentBytes = ownedRoots.reduce((total, entry) => total + directorySize(path.join(base, entry.name), measurementDeadline), 0);
  if (estimate > available - policy.reserveBytes || currentBytes + estimate > policy.maxIntermediateBytes) {
    throw new Error(`Preview allocation refused: estimated ${formatBytes(estimate)}, available ${formatBytes(available)}, existing preview material ${formatBytes(currentBytes)}. Finalize blocked preview owners before allocating; protected material is preserved.`);
  }
  return { ...policy, estimate, available, currentBytes };
}

function parseSeedBriefingDemoArgs(argv) {
  const options = { help: false, json: false, noBuild: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-build") options.noBuild = true;
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
  if (commandName === "finalize") {
    console.log("Usage: bun scripts/iab-preview.mjs finalize --root <preview-root> --revision <n> --outcome accepted|assessed|failed|abandoned|investigating --summary <text> [--converged] [--disposition discard|transferred --destination <verified-copy> --transfer-reference <accepted-output-ref>] [--review-by <ISO-time>] [--json]\nStop the exact preview first. Accepted delivery requires convergence. Ordinary interactive material requires exact verified transfer or explicit discard. Cleanup retries never repeat transfer or publication.");
    return;
  }
  if (commandName === "seed-agents-review") {
    console.log(`Usage: bun scripts/iab-preview.mjs seed-agents-review --artifact-version <exact-ref> [options]

Create a launcher-owned preview copy, bind one committed link-custody v3 review artifact,
and only then start the preview daemon. The source database and artifact are never mutated.
`);
    return;
  }
  if (commandName === "seed-briefing-demo") {
    console.log(`Usage: bun scripts/iab-preview.mjs seed-briefing-demo [--json]

Seed the deterministic rich Briefing fixture into the current integration
branch's launcher-owned preview copy after validating metadata custody.
`);
    return;
  }
  if (commandName === "cleanup") {
    console.log(`Usage: bun scripts/iab-preview.mjs cleanup [options]

Clean stale Mandible IAB preview cache entries.

Options:
  --dry-run             Report cleanup candidates without deleting them. This is the default.
  --apply               Delete cleanup candidates.
  --json                Print machine-readable result JSON.
  --preview-base-dir P  Override the preview cache root. Defaults to MANDIBLE_PREVIEW_BASE_DIR or ~/.cache/mandible/previews.
  -h, --help            Show this help.

Cleanup removes only exact disposed outputs of a terminal owned run with a saved
compact outcome. Active, interactive, legacy and unclassified material is preserved.
Use finalize to account for stopped preview material before cleanup.
`);
    return;
  }

  console.log(`Usage: bun scripts/iab-preview.mjs [options]

Create or reuse an isolated Mandible integration preview instance.

Options:
  --json           Print machine-readable result JSON.
  --branch NAME    Use an explicit integration branch name.
  --db PATH        Source database to copy. Defaults to MANDIBLE_DB or ~/.mandible/mandible.db.
  --port PORT      Use an explicit preview port.
  --force-new      Do not reuse the current integration preview; create a new default branch/instance.
  --no-build       Skip frozen dependency installation and Bun build.
  --disposable-fixture  Explicitly declare automated fixture mutations disposable.
  --owner-project <id>  Canonical owning project.
  --owner-work-unit <id>  Exact delivery work unit.
  --pair-browser   Mint one bounded pairing URL for a new browser profile.
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
    console.log(`SqliteDatabase: ${result.db}`);
    console.log(`Source database: ${result.sourceDb}`);
    console.log(`Artifact custody: ${result.artifactRoot}`);
    console.log(`Briefing: ${result.briefing.id}`);
    return;
  }

  console.log(`Mandible IAB preview ${result.status}`);
  if (result.message) console.log(result.message);
  console.log(`URL: ${result.freshUrl ?? result.url}`);
  if (result.pairingUrl) console.log(`Pair new browser: ${result.pairingUrl}`);
  console.log(`Branch: ${result.branch}`);
  console.log(`Worktree: ${result.worktree}`);
  console.log(`DB: ${result.db ?? result.previewRoot}`);
  if (result.port) console.log(`Port: ${result.port}`);
  if (result.stderrLog) console.log(`Logs: ${result.stderrLog}`);
}

function resolveProtectedBranch(repoRoot) {
  const hasDevelop = spawnSync("git", ["--no-optional-locks", "rev-parse", "--verify", "--quiet", "develop"], {
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

  if (!commandExists("wt")) throw new Error("Mandible previews require the configured wt worktree tool");
  run("wt", ["new", branch, base], { cwd: worktreeHostRoot });

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

/**
 * Which preview-contract environment variables a recorded instance is missing or
 * has wrong.
 *
 * One comparison used two ways: as a reuse gate, where drift means the running
 * instance predates the current isolation contract and must be replaced rather
 * than refreshed, and as the refresh assertion. Keeping it in one place is what
 * makes "an isolated preview" a single definition instead of two that can drift
 * apart — which is how the conversations index came to be shared in the first
 * place.
 */
function previewInstanceEnvDrift(metadata, previewRoot) {
  if (!metadata?.db || !metadata?.sourceDb || !Number.isInteger(metadata.port)) {
    return ["<incomplete preview metadata>"];
  }
  const expected = previewInstanceEnv({
    port: metadata.port,
    dbCopy: metadata.db,
    sourceDb: metadata.sourceDb,
    pidFile: path.join(previewRoot, "mandible.pid"),
    generation: metadata.instanceEnv?.MANDIBLE_BACKEND_GENERATION,
  });
  return Object.entries(expected)
    .filter(([key, value]) => metadata.instanceEnv?.[key] !== value)
    .map(([key]) => key);
}

export async function healthyExistingPreview(branch, expected = {}) {
  const preview = previewPaths(branch);
  if (!fs.existsSync(preview.metadata)) return null;

  const metadata = JSON.parse(fs.readFileSync(preview.metadata, "utf8"));
  if (!metadata.port) return null;

  const readiness = await readPreviewReadiness(metadata.port);
  if (!readiness.ok) return null;
  const { health } = readiness;
  if (!hasExpectedPreviewFileRpc(metadata, health, preview.root)) return null;
  validatePreviewIdentity(metadata, preview, branch, expected.worktree);
  const drift = previewInstanceEnvDrift(metadata, preview.root);
  const logIsolationUpgrade = metadata.instanceEnv?.MANDIBLE_STDOUT_LOG_PATH === undefined && drift.includes("MANDIBLE_STDOUT_LOG_PATH")
    && hasExpectedPreviewPolicy(health) && drift.every(key => key === "MANDIBLE_STDOUT_LOG_PATH");
  if (!hasExpectedPreviewPolicy(health) || drift.length > 0) {
    const userPreferencesIsolationUpgrade = isUserPreferencesIsolationUpgrade(metadata, health, preview.root, drift);
    if (!userPreferencesIsolationUpgrade && !logIsolationUpgrade
        && !isExactLegacyPreview(metadata, health, preview.root, drift)
        && !isLegacyPreviewListener(health)) return null;
    return {
      ...metadata,
      health,
      legacyContractDrift: drift,
      userPreferencesIsolationUpgrade,
      logIsolationUpgrade,
    };
  }

  return {
    ...metadata,
    health,
    freshUrl: `${metadata.instanceEnv.MANDIBLE_PUBLIC_ORIGIN}/?fresh=${Date.now()}#/timeline`,
  };
}

function isLegacyPreviewListener(health) {
  return health?.ready === true && health?.warm === true &&
    health?.instance?.role === "preview" && health?.instance?.operational_mutations === "reject";
}

function isExactLegacyPreview(metadata, health, previewRoot, drift) {
  const currentDb = readSymlinkTarget(path.join(previewRoot, "current.db"));
  return health?.ready === true &&
    health?.warm === true &&
    health?.instance?.role === "preview" &&
    health?.instance?.operational_mutations === "reject" &&
    health?.instance?.db_path_source === "iab-preview-copy" &&
    canonicalPath(health?.instance?.db_path ?? "") === canonicalPath(metadata.db ?? "") &&
    canonicalPath(health?.instance?.source_db_path ?? "") === canonicalPath(metadata.sourceDb ?? "") &&
    Boolean(currentDb) &&
    canonicalPath(currentDb) === canonicalPath(metadata.db ?? "") &&
    Boolean(metadata.instanceEnv?.MANDIBLE_CLIENT_AUTH_DIR) &&
    fs.existsSync(metadata.instanceEnv.MANDIBLE_CLIENT_AUTH_DIR) &&
    drift.length > 0 &&
    drift.every((key) => LEGACY_PREVIEW_CONTRACT_DRIFT.has(key) && metadata.instanceEnv?.[key] === undefined);
}

function isUserPreferencesIsolationUpgrade(metadata, health, previewRoot, drift) {
  const allowedDrift = ["MANDIBLE_ALLOWED_EFFECTS", "MANDIBLE_USER_PREFERENCES_DIR", ...(metadata.instanceEnv?.MANDIBLE_STDOUT_LOG_PATH === undefined ? ["MANDIBLE_STDOUT_LOG_PATH"] : [])];
  if ([...drift].sort().join(",") !== [...allowedDrift].sort().join(",")) return false;
  if (metadata.instanceEnv?.MANDIBLE_ALLOWED_EFFECTS !== JSON.stringify(["ledger:read", "ledger:write", "files:preview"])) {
    return false;
  }
  if (metadata.instanceEnv?.MANDIBLE_USER_PREFERENCES_DIR !== undefined) return false;
  if (health?.instance?.allowed_effects?.join(",") !== "ledger:read,ledger:write,files:preview") return false;
  if (health?.ready !== true || health?.warm !== true || health?.instance?.role !== "preview"
      || health?.instance?.db_path_source !== "iab-preview-copy") return false;
  if (health.instance.instance_id !== metadata.instanceEnv?.MANDIBLE_INSTANCE_ID
      || health.instance.installation_id !== metadata.instanceEnv?.MANDIBLE_INSTALLATION_ID
      || health.instance.public_origin !== metadata.instanceEnv?.MANDIBLE_PUBLIC_ORIGIN) return false;
  const currentDb = readSymlinkTarget(path.join(previewRoot, "current.db"));
  if (!currentDb || !metadata.db || !metadata.sourceDb || !health.instance.db_path || !health.instance.source_db_path) return false;
  try {
    const root = canonicalPath(previewRoot);
    const db = canonicalPath(metadata.db);
    const sourceDb = canonicalPath(metadata.sourceDb);
    if (db !== canonicalPath(currentDb)
        || db !== canonicalPath(health.instance.db_path)
        || sourceDb !== canonicalPath(health.instance.source_db_path)
        || db === sourceDb
        || !isPathWithin(root, db)
        || isPathWithin(root, sourceDb)) return false;
  } catch {
    return false;
  }
  return true;
}

function legacyPreviewRetirementRequired(existing) {
  return new Error(
    `Preview port ${existing.port} is a verified legacy public listener and cannot be replaced independently. ` +
    "Inspect and retire that listener through its recorded lifecycle before an ordinary preview launch. " +
    "The launcher will not stop it or allocate a second browser origin.",
  );
}

async function refreshExistingPreview(existing, details) {
  const preview = previewPaths(details.branch);
  const validated = validateRefreshContract(existing, preview, details);

  ensureDependencies(details.worktree);
  runBun(details.worktree, ["run", "--bun", "build"]);

  const briefingDemo = await materializeProjectedBriefingDemo({
    worktree: details.worktree,
    previewRoot: preview.root,
    db: validated.dbCopy,
    sourceDb: validated.sourceDb,
  });
  const userPreferencesSeed = seedPreviewUserPreferences({
    previewRoot: preview.root,
    sourceRoot: path.join(mandibleHome(), "settings", "users"),
  });

  writeRunScript(validated.runScript, {
    worktree: details.worktree,
    port: validated.port,
    dbCopy: validated.dbCopy,
    sourceDb: validated.sourceDb,
    pidFile: validated.pidFile,
    nodePath: bunRuntime(details.worktree),
    stdoutLog: validated.stdoutLog,
    stderrLog: validated.stderrLog,
    generation: details.currentHead,
  });

  const stopped = await stopPreviewProcess(validated.pidFile);
  registerPreviewInstance(validated.instanceEnv);
  reloadLocalFrontDoor();
  const structureCache = await seedProjectedConversationStructureCache({
    sourceCache: sourceConversationStructureCachePath(),
    targetCache: validated.instanceEnv.MANDIBLE_CONVERSATION_STRUCTURE_DB,
    projectedDb: validated.dbCopy,
    preserveExisting: true,
  });
  const started = await startPreviewProcess({
    runScript: validated.runScript,
    worktree: details.worktree,
    port: validated.port,
    dbCopy: validated.dbCopy,
    sourceDb: validated.sourceDb,
    pidFile: validated.pidFile,
    stdoutLog: validated.stdoutLog,
    stderrLog: validated.stderrLog,
  });
  const restartLifecycle = { ...started, stopped };

  const health = await waitForPreviewReadiness(
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
    ...(existing.ownership ? { ownership: { ...existing.ownership, revision: existing.ownership.revision + 1 } } : {}),
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
    pidFile: validated.pidFile,
    stdoutLog: validated.stdoutLog,
    stderrLog: validated.stderrLog,
    runScript: validated.runScript,
    instanceEnv: validated.instanceEnv,
    projection: { ...existing.projection, structureCache },
    userPreferencesSeed,
    structureCache,
    briefingDemo,
    restartLifecycle,
    health,
    refreshedAt: new Date().toISOString(),
    previousStartupCommit: existing.health.startup_commit,
  };
  delete refreshed.legacyContractDrift;
  delete refreshed.userPreferencesIsolationUpgrade;
  delete refreshed.logIsolationUpgrade;
  delete refreshed.freshUrl;
  delete refreshed.browserEnrollment;
  saveOwnedMetadata(preview.metadata, refreshed);
  return await withBrowserReadyUrl(refreshed, { pairBrowser: details.options.pairBrowser });
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

  const drift = previewInstanceEnvDrift(existing, preview.root);
  const safePreferenceUpgrade = existing.userPreferencesIsolationUpgrade === true
    && isUserPreferencesIsolationUpgrade(existing, existing.health, preview.root, drift);
  const safeLogUpgrade = existing.logIsolationUpgrade === true && drift.length === 1 && drift[0] === "MANDIBLE_STDOUT_LOG_PATH" && existing.instanceEnv?.MANDIBLE_STDOUT_LOG_PATH === undefined;
  if (drift.length > 0 && !safePreferenceUpgrade && !safeLogUpgrade) {
    throw new Error(
      `Refusing preview refresh: persisted ${drift.join(", ")} does not match the required preview contract.`,
    );
  }
  const instanceEnv = previewInstanceEnv({
    port,
    dbCopy: existing.db,
    sourceDb: existing.sourceDb,
    pidFile: expectedPaths.pidFile,
    generation: details.currentHead,
  });
  if (!hasExpectedPreviewFileRpc(existing, existing.health, preview.root)) {
    throw new Error("Refusing preview refresh: preview file-RPC custody is not isolated to the selected preview root.");
  }

  return {
    port,
    ...expectedPaths,
    sourceDb: existing.sourceDb,
    instanceEnv,
  };
}

export async function withBrowserReadyUrl(preview, options = {}) {
  const origin = preview.instanceEnv?.MANDIBLE_PUBLIC_ORIGIN;
  if (!origin) throw new Error("Preview metadata has no registered public origin.");
  const clean = {
    ...preview,
    freshUrl: `${origin}/?fresh=${Date.now()}#/timeline`,
    browserEnrollment: "cookie-or-pairing",
  };
  return options.pairBrowser === true
    ? { ...clean, pairingUrl: clean.freshUrl, browserEnrollment: "interactive-pairing" }
    : clean;
}

async function analyzePreviewDirForCleanup(dirPath, apply) {
  const metadataPath = path.join(dirPath, "metadata.json");
  const metadata = readJsonFile(metadataPath);
  const result = { path: dirPath, kind: "preview-dir", metadataDb: metadata?.db, currentDb: readSymlinkTarget(path.join(dirPath, "current.db")), bytes: 0 };
  if (!metadata) return { ...result, action: "skip", reason: "missing or unreadable metadata; manual inspection required" };
  const active = await previewConsumerReason(metadata, dirPath);
  if (active) return { ...result, action: "skip-active", reason: active };
  return { ...result, ...cleanupOwnedRun(metadataPath, { apply }) };
}

async function previewConsumerReason(metadata, root) {
  const pids = [metadata.pidFile, path.join(root, "mandible.pid")].filter(Boolean).map(readPidFile);
  if (pids.some(pid => pid && isProcessAlive(pid))) return "recorded pid is live; identity or ownership may be shared";
  if (metadata.port && await isPortOpen(metadata.port)) return "recorded port has a consumer; health is not deletion authority";
  const jobs = inspectLegacyPreviewJobs();
  if (jobs.error || jobs.labels.length) return "registered preview service may respawn; explicitly retire it before cleanup";
  return null;
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

function bunRuntime(worktree) {
  return run(path.join(worktree, "scripts", "bun-runtime.sh"), [], { cwd: worktree }).stdout.trim();
}

function runBun(worktree, args) {
  const runtime = bunRuntime(worktree);
  return run(runtime, args, { cwd: worktree, env: { ...process.env, PATH: `${path.dirname(runtime)}:${process.env.PATH}` } });
}

function ensureDependencies(worktree) {
  const nodeModules = path.join(worktree, "node_modules");
  if (fs.existsSync(nodeModules) && fs.lstatSync(nodeModules).isSymbolicLink()) throw new Error(`Refusing dependency installation through shared node_modules: ${nodeModules}`);
  runBun(worktree, ["install", "--frozen-lockfile", "--backend", "clonefile"]);
}

export async function createProjectedSnapshot({ sourceDb, dbCopy, worktree, allocation }) {
  const script = path.join(worktree, "scripts", "project-db-snapshot.mjs");
  if (!fs.existsSync(script)) {
    throw new Error(`Projected database extractor does not exist: ${script}`);
  }
  const result = run(bunRuntime(worktree), [
    script,
    "--source", sourceDb,
    "--output", dbCopy,
    "--staging-dir", path.join(path.dirname(dbCopy), ".snapshot-work"),
    "--json",
    ...(allocation ? ["--reserve-bytes", String(allocation.reserveBytes), "--max-output-bytes", String(allocation.maxIntermediateBytes - allocation.currentBytes)] : []),
  ], { cwd: worktree });
  let projection;
  try {
    projection = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Projected database extractor returned invalid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  const previewRoot = path.dirname(dbCopy);
  const structureCache = await seedProjectedConversationStructureCache({
    sourceCache: sourceConversationStructureCachePath(),
    targetCache: previewIsolationEnv(previewRoot, sourceDb).MANDIBLE_CONVERSATION_STRUCTURE_DB,
    projectedDb: dbCopy,
  });
  const briefingDemo = await materializeProjectedBriefingDemo({
    worktree,
    previewRoot,
    db: dbCopy,
    sourceDb,
  });
  return { ...projection, structureCache, briefingDemo };
}

function sourceConversationStructureCachePath() {
  const override = process.env.MANDIBLE_CONVERSATION_STRUCTURE_DB?.trim();
  return path.resolve(override || path.join(os.homedir(), ".cache", "mandible", "conversations", "structure.db"));
}

/**
 * Copy the source daemon's derived coordinate index into preview custody.
 *
 * Preview creation copies the source index with its WAL, then restricts rows
 * to exact conversation/source-version pairs in the projected ledger. Existing
 * previews keep that private index across code refreshes because a selected
 * source read may have advanced it beyond main.
 */
export async function seedProjectedConversationStructureCache({ sourceCache, targetCache, projectedDb, preserveExisting = false }) {
  const preserveTarget = preserveExisting && fs.existsSync(targetCache);
  if (!preserveTarget && !fs.existsSync(sourceCache)) {
    return { status: "unavailable", source: sourceCache, target: targetCache, conversations: 0, blocks: 0 };
  }
  fs.mkdirSync(path.dirname(targetCache), { recursive: true });
  if (!preserveTarget) {
    for (const candidate of [targetCache, `${targetCache}-journal`, `${targetCache}-wal`, `${targetCache}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }

    const source = new SqliteDatabase(sourceCache, { readonly: true, fileMustExist: true });
    try {
      await source.backup(targetCache);
    } finally {
      source.close();
    }
  }

  const target = new SqliteDatabase(targetCache);
  try {
    target.pragma("foreign_keys = ON");
    target.prepare("ATTACH DATABASE ? AS projected").run(projectedDb);
    target.prepare(`
      DELETE FROM cache_conversations
       WHERE NOT EXISTS (
         SELECT 1
           FROM projected.conversations conversation
           JOIN projected.conversation_sources source
             ON source.conversation_id = conversation.id
          WHERE conversation.id = cache_conversations.conversation_id
            AND source.current_version_id = cache_conversations.source_version_id
       )
    `).run();
    target.prepare("DETACH DATABASE projected").run();
    if (!preserveTarget) target.exec("VACUUM");
    return {
      status: preserveTarget ? "preserved" : "seeded",
      source: sourceCache,
      target: targetCache,
      conversations: Number(target.prepare("SELECT COUNT(*) AS count FROM cache_conversations").get().count),
      blocks: Number(target.prepare("SELECT COUNT(*) AS count FROM cache_blocks").get().count),
    };
  } finally {
    target.close();
  }
}

/**
 * Start a preview daemon as an ordinary detached child process.
 *
 * A preview is deliberately unsupervised. It used to be submitted to launchd,
 * which made it a KeepAlive job: it survived being killed, survived deletion of
 * the worktree whose code it was executing, and was never deregistered by any
 * teardown path, because the only `launchctl remove` fired immediately before
 * re-submitting the same label. Eleven such jobs accumulated on one machine,
 * nine of them still running, four relaunch-looping on exit 127 for up to two
 * weeks against scripts that no longer existed.
 *
 * An ephemeral preview that dies should stay dead. `detached` puts it in its
 * own process group so interrupting the launcher's terminal does not take the
 * preview with it, and `unref` lets the launcher exit; neither gives anything
 * the authority to restart it.
 */
async function startPreviewProcess(details) {
  // run.sh is the single definition of how a preview daemon is launched: it
  // pins the full instance env and its own log redirection. Executing it —
  // rather than re-deriving the same spawn inline — keeps one launch contract
  // and leaves a human-runnable artifact for reproducing a preview by hand.
  const child = spawn("/bin/zsh", [details.runScript], {
    cwd: details.worktree,
    detached: true,
    env: sanitizedLauncherEnv(),
    stdio: "ignore",
  });
  child.unref();
  return { mechanism: "detached-child", launcherPid: child.pid ?? null };
}

/**
 * Stop the running preview daemon and start a replacement child process.
 *
 * There is no supervisor to hand this to any more, and that removes the whole
 * class of failure the old launchd `kickstart` path was written to work around:
 * no registration to lose, no race between deregistration and re-submission,
 * and no way for a replacement to be resurrected behind the launcher's back.
 */
async function restartPreviewProcess(details) {
  const stopped = await stopPreviewProcess(details.pidFile);
  const started = await startPreviewProcess(details);
  return { ...started, stopped };
}

/**
 * Terminate whatever the preview's pid file points at and wait for it to go.
 *
 * SIGTERM is sufficient precisely because nothing supervises a preview any
 * more. Under launchd it was not: KeepAlive respawned three of nine terminated
 * preview daemons within fourteen seconds, which made a successful-looking kill
 * actively misleading. SIGKILL remains as a bounded escalation for a daemon
 * that will not exit on its own.
 */
async function stopPreviewProcess(pidFile, timeoutMs = 10_000) {
  const pid = readPidFile(pidFile);
  if (pid === null || !isProcessAlive(pid)) {
    return { pid, outcome: pid === null ? "no-pid-file" : "already-stopped" };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return { pid, outcome: "already-stopped" };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return { pid, outcome: "terminated" };
    await delay(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return { pid, outcome: "terminated" };
  }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline) {
    if (!isProcessAlive(pid)) return { pid, outcome: "killed" };
    await delay(100);
  }
  throw new Error(`Preview daemon ${pid} did not exit after SIGTERM and SIGKILL.`);
}

function launchctlCommand() {
  return process.env.MANDIBLE_IAB_PREVIEW_LAUNCHCTL ||
    (process.platform === "darwin" && commandExists("launchctl") ? "launchctl" : null);
}

function inspectLegacyPreviewJobs() {
  const launchctl = launchctlCommand();
  if (!launchctl) return { supported: false, labels: [], booted: [] };

  const listed = run(launchctl, ["list"], { allowFailure: true });
  if (listed.status !== 0) {
    return { supported: true, labels: [], booted: [], error: "launchctl list failed" };
  }

  const labels = [];
  for (const line of String(listed.stdout ?? "").split(/\r?\n/)) {
    const label = line.trim().split(/\s+/).pop();
    if (label && LEGACY_PREVIEW_LABEL_PATTERN.test(label)) labels.push(label);
  }
  return { supported: true, labels, booted: [] };
}

function describeCommandResult(command, args, result) {
  const output = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n") || "no output";
  return `${command} ${args.join(" ")} exited ${result.status ?? "without status"}: ${output}`;
}

function writeRunScript(runScript, details) {
  const env = previewInstanceEnv(details);
  fs.mkdirSync(env.MANDIBLE_ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  const content = `#!/bin/zsh
set -euo pipefail
cd ${shellQuote(details.worktree)}
exec env \\
${Object.entries(env).map(([key, value]) => `  ${key}=${shellQuote(String(value))} \\`).join("\n")}
  ${shellQuote(details.nodePath)} dist/index.js >> ${shellQuote(details.stdoutLog)} 2>> ${shellQuote(details.stderrLog)}
`;
  fs.writeFileSync(runScript, content, { mode: 0o755 });
}

/**
 * Every part of the preview contract that follows from the preview root alone.
 * Split out because the dry run has to report the same contract before a port
 * or database copy exists: it used to hand-roll its own copy of this object,
 * which is how it came to advertise a contract missing exactly the three keys
 * whose absence was the leak.
 */
function previewIsolationEnv(previewRoot, sourceDb) {
  const conversationsDir = path.join(previewRoot, "conversations");
  const artifactRoot = path.join(previewRoot, "artifacts");
  return {
    MANDIBLE_INSTANCE_ROLE: "preview",
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
    MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
    MANDIBLE_FILE_RPC_DIR: path.join(previewRoot, "agent-rpc"),
    MANDIBLE_CONFIG_DIR: path.join(previewRoot, "config"),
    // Keep preview client-auth secrets outside disposable cache output.
    MANDIBLE_CLIENT_AUTH_DIR: path.join(
      mandibleHome(),
      "preview-authorities",
      path.basename(previewRoot),
      "client-auth",
    ),
    MANDIBLE_PREVIEW_ROOT: previewRoot,
    MANDIBLE_ARTIFACT_DIR: artifactRoot,
    MANDIBLE_USER_PREFERENCES_DIR: path.join(previewRoot, "settings", "users"),
    MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR: path.resolve(
      process.env.MANDIBLE_ARTIFACT_DIR?.trim() || path.join(mandibleHome(), "artifacts"),
    ),
    MANDIBLE_ALLOWED_EFFECTS: JSON.stringify([
      "ledger:read", "ledger:write", "files:preview", "preferences:instance",
    ]),
    MANDIBLE_WRITABLE_ROOTS: JSON.stringify([previewRoot]),
    // Recyclable writable state stays under the preview root. Client-auth is
    // the deliberate exception: its authority id, pepper, and bounded session
    // fingerprints survive stale cache reclamation in the durable authority
    // root above. The ledger copy was isolated from the start; these other
    // paths were missed, so a preview opened the live conversations index
    // read-write and rotated the live daemon's log file.
    MANDIBLE_CONVERSATION_STRUCTURE_DB: path.join(conversationsDir, "structure.db"),
    MANDIBLE_CONVERSATION_CACHE_DB: path.join(conversationsDir, "search-cache.db"),
    MANDIBLE_STDERR_LOG_PATH: path.join(previewRoot, "stderr.log"),
    MANDIBLE_STDOUT_LOG_PATH: path.join(previewRoot, "stdout.log"),
    // Found by watching a real preview's own log: it materialized 38 CLI files
    // into the shared ~/.cache/mandible/cli, overwriting every one
    // unconditionally and stamping the manifest's source_root to a preview
    // worktree that is later deleted. Same leak, fourth shared resource.
    MANDIBLE_CLI_CACHE_DIR: path.join(previewRoot, "cli"),
  };
}

function previewInstanceEnv(details) {
  const installationId = readInstallationId();
  const instanceId = `preview-${createHash("sha256").update(path.dirname(details.dbCopy)).digest("hex").slice(0, 16)}`;
  return {
    MANDIBLE_PORT: String(details.port),
    MANDIBLE_DB: details.dbCopy,
    MANDIBLE_PID_FILE: details.pidFile,
    MANDIBLE_INSTANCE_ID: instanceId,
    MANDIBLE_INSTALLATION_ID: installationId,
    MANDIBLE_PUBLIC_ORIGIN: `https://${instanceId}.mandible.localhost:19421`,
    MANDIBLE_BACKEND_GENERATION: details.generation ?? "preview-generation",
    MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR: localSessionAuthorityDir(),
    MANDIBLE_CONTEXT_VERIFICATION_KEY: path.join(localSessionAuthorityDir(), "context-verification-key.pem"),
    ...previewIsolationEnv(path.dirname(details.dbCopy), details.sourceDb),
  };
}

function mandibleHome() {
  return process.env.MANDIBLE_HOME?.trim()
    ? path.resolve(expandHome(process.env.MANDIBLE_HOME.trim()))
    : path.join(os.homedir(), ".mandible");
}

export function seedPreviewUserPreferences({ previewRoot, sourceRoot = path.join(mandibleHome(), "settings", "users") }) {
  const resolvedPreviewRoot = path.resolve(previewRoot);
  fs.mkdirSync(resolvedPreviewRoot, { recursive: true, mode: 0o700 });
  const canonicalPreviewRoot = fs.realpathSync.native(resolvedPreviewRoot);
  const settingsRoot = path.join(canonicalPreviewRoot, "settings");
  if (fs.existsSync(settingsRoot) && fs.lstatSync(settingsRoot).isSymbolicLink()) {
    throw new Error("Refusing preference seed: preview settings directory is a symlink.");
  }
  fs.mkdirSync(settingsRoot, { recursive: true, mode: 0o700 });
  const targetRoot = path.join(settingsRoot, "users");
  if (fs.existsSync(targetRoot) && fs.lstatSync(targetRoot).isSymbolicLink()) {
    throw new Error("Refusing preference seed: preview user-preferences directory is a symlink.");
  }
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(settingsRoot, 0o700);
  fs.chmodSync(targetRoot, 0o700);
  const canonicalTargetRoot = fs.realpathSync.native(targetRoot);
  if (!isPathWithin(canonicalPreviewRoot, canonicalTargetRoot)) {
    throw new Error("Refusing preference seed: preview user-preferences directory escapes its registered root.");
  }

  const resolvedSourceRoot = path.resolve(sourceRoot);
  if (!fs.existsSync(resolvedSourceRoot)) {
    return { sourceRoot: resolvedSourceRoot, targetRoot: canonicalTargetRoot, sourceMissing: true, copied: [], preserved: [] };
  }
  const canonicalSourceRoot = fs.realpathSync.native(resolvedSourceRoot);
  if (!fs.statSync(canonicalSourceRoot).isDirectory()
      || canonicalSourceRoot === canonicalPreviewRoot
      || isPathWithin(canonicalSourceRoot, canonicalPreviewRoot)
      || isPathWithin(canonicalPreviewRoot, canonicalSourceRoot)) {
    throw new Error("Refusing preference seed: source preferences must be a directory outside preview custody.");
  }

  const copied = [];
  const preserved = [];
  for (const entry of fs.readdirSync(canonicalSourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]{1,128}(?:\.sidebar-order)?\.json$/.test(entry.name)) continue;
    const sourceFile = path.join(canonicalSourceRoot, entry.name);
    const targetFile = path.join(canonicalTargetRoot, entry.name);
    let existing;
    try {
      existing = fs.lstatSync(targetFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`Refusing preference seed: existing preview preference is not a regular file: ${entry.name}`);
      }
      preserved.push(entry.name);
      continue;
    }

    const temporary = path.join(canonicalTargetRoot, `.${entry.name}.${process.pid}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, fs.readFileSync(sourceFile));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try {
        fs.linkSync(temporary, targetFile);
        copied.push(entry.name);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const raced = fs.lstatSync(targetFile);
        if (raced.isSymbolicLink() || !raced.isFile()) {
          throw new Error(`Refusing preference seed: concurrent preview preference is not a regular file: ${entry.name}`);
        }
        preserved.push(entry.name);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
  const dirFd = fs.openSync(canonicalTargetRoot, "r");
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  return {
    sourceRoot: canonicalSourceRoot,
    targetRoot: canonicalTargetRoot,
    sourceMissing: false,
    copied: copied.sort(),
    preserved: preserved.sort(),
  };
}

function localSessionAuthorityDir() {
  return path.join(mandibleHome(), "config", "local-sessions");
}

function assertOrdinaryPreviewLifecycleAllowed() {
  const journalPath = path.join(localSessionAuthorityDir(), "cutover.json");
  if (!fs.existsSync(journalPath)) return;
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch {
    throw new Error(`Local-session cutover journal is unreadable: ${journalPath}`);
  }
  if (journal.schema !== LOCAL_SESSION_CUTOVER_SCHEMA || !LOCAL_SESSION_CUTOVER_STATES.has(journal.state)) {
    throw new Error(`Local-session cutover journal has an invalid schema or state: ${journalPath}`);
  }
  if (journal.state === "complete") {
    if (journal.runtime?.gateway_mode === "normal" && journal.runtime?.intents?.["preview.promote"]?.status === "done") return;
    throw new Error(`Completed local-session cutover journal lacks its normal gateway or preview-promotion receipt: ${journalPath}`);
  }
  if (journal.state === "rolled_back") {
    if (journal.runtime?.intents?.["files.restore"]?.status === "done" && journal.runtime?.intents?.["registrations.restore"]?.status === "done") return;
    throw new Error(`Rolled-back local-session cutover journal lacks restoration receipts: ${journalPath}`);
  }
  throw new Error(
    `Local-session cutover is ${journal.state}; ordinary preview lifecycle is disabled until that historical state is explicitly reconciled.`,
  );
}

function readInstallationId() {
  const filePath = path.join(mandibleHome(), "config", "client-auth", "authority-id");
  if (!fs.existsSync(filePath)) throw new Error("Local installation authority is missing; run `bun run --bun local-front-door -- initialize` first.");
  const value = fs.readFileSync(filePath, "utf8").trim();
  if (!value) throw new Error("Local installation authority is empty.");
  return value;
}

function registerPreviewInstance(env) {
  const databasePath = path.join(localSessionAuthorityDir(), "sessions.db");
  if (!fs.existsSync(databasePath)) throw new Error("Local session authority is not initialized.");
  const db = new SqliteDatabase(databasePath);
  try {
    const existing = db.prepare("SELECT * FROM instance_registrations WHERE instance_id = ?")
      .get(env.MANDIBLE_INSTANCE_ID);
    if (existing && (existing.installation_id !== env.MANDIBLE_INSTALLATION_ID
        || existing.role !== "preview" || existing.public_origin !== env.MANDIBLE_PUBLIC_ORIGIN)) {
      throw new Error(`Conflicting preview registration for ${env.MANDIBLE_INSTANCE_ID}.`);
    }
    db.prepare(`
      INSERT INTO instance_registrations (
        instance_id, installation_id, role, public_origin, backend_origin,
        backend_generation, effect_ceiling_json, writable_roots_json, updated_at
      ) VALUES (?, ?, 'preview', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        backend_origin=excluded.backend_origin,
        backend_generation=excluded.backend_generation,
        effect_ceiling_json=excluded.effect_ceiling_json,
        writable_roots_json=excluded.writable_roots_json,
        updated_at=excluded.updated_at
    `).run(
      env.MANDIBLE_INSTANCE_ID,
      env.MANDIBLE_INSTALLATION_ID,
      env.MANDIBLE_PUBLIC_ORIGIN,
      `http://127.0.0.1:${env.MANDIBLE_PORT}`,
      env.MANDIBLE_BACKEND_GENERATION,
      env.MANDIBLE_ALLOWED_EFFECTS,
      env.MANDIBLE_WRITABLE_ROOTS,
      Date.now(),
    );
    return existing ?? null;
  } finally {
    db.close();
  }
}

function restorePreviewRegistration(env, existing) {
  const db = new SqliteDatabase(path.join(localSessionAuthorityDir(), "sessions.db"));
  try {
    db.transaction(() => {
      if (!existing) {
        db.prepare("DELETE FROM instance_registrations WHERE instance_id = ?").run(env.MANDIBLE_INSTANCE_ID);
        return;
      }
      db.prepare(`UPDATE instance_registrations SET
        installation_id=?, role=?, public_origin=?, backend_origin=?, backend_generation=?,
        effect_ceiling_json=?, writable_roots_json=?, updated_at=?
        WHERE instance_id=?`).run(
        existing.installation_id,
        existing.role,
        existing.public_origin,
        existing.backend_origin,
        existing.backend_generation,
        existing.effect_ceiling_json,
        existing.writable_roots_json,
        existing.updated_at,
        existing.instance_id,
      );
    })();
  } finally { db.close(); }
}

export function reloadLocalFrontDoor() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "local-front-door.mjs");
  const configured = spawnSync(process.execPath, [script, "configure"], { encoding: "utf8" });
  if (configured.status !== 0) {
    throw new Error(`Failed to configure the local HTTPS front door: ${configured.stderr.trim()} Open the installed desktop setup action with mandible://connections/setup, or run bun scripts/local-ca-trust.mjs setup locally. No gateway reload occurred.`);
  }
  const binary = path.join(mandibleHome(), "runtime", "caddy", "2.11.3", "caddy");
  if (!fs.existsSync(binary)) {
    throw new Error("The pinned local HTTPS front door is not installed. Run `bun run --bun local-front-door -- install`, open mandible://connections/setup for the explicit native CA action, then start it.");
  }
  const reloaded = spawnSync(binary, ["reload", "--config", path.join(localSessionAuthorityDir(), "Caddyfile"), "--adapter", "caddyfile"], { encoding: "utf8" });
  if (reloaded.status !== 0) {
    throw new Error("The local HTTPS front door is not running; start `bun run --bun local-front-door -- run` before launching a preview.");
  }
}

export function sanitizePreviewDatabase(databasePath) {
  const db = new SqliteDatabase(databasePath);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    db.transaction(() => {
      // Credential and clearance rows are immutable attribution history. Their
      // reusable secrets/private keys live outside SQLite, while retained ledger
      // rows reference these IDs with ON DELETE RESTRICT.
      if (tables.has("delegated_signing_runtime_bindings")) {
        db.prepare("DELETE FROM delegated_signing_runtime_bindings").run();
      }
      if (tables.has("settings")) {
        db.prepare("DELETE FROM settings WHERE key LIKE '%token%' OR key LIKE '%secret%' OR key LIKE '%credential%'").run();
      }
    })();
  } finally {
    db.close();
  }
}

/**
 * The launcher's own environment with every ambient MANDIBLE_* variable
 * stripped. run.sh sets the full preview contract explicitly; anything else
 * inherited from the invoking shell can only point the preview back at a shared
 * resource, which is the failure this whole path exists to prevent.
 */
function sanitizedLauncherEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("MANDIBLE_")),
  );
}

export async function waitForPreviewReadiness(port, expected, timeoutMs, stderrLog) {
  const start = Date.now();
  let lastHealth = null;
  let lastShellFailure = null;
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
      if (hasExpectedPreviewReadiness(health, expected)) {
        const shellReadiness = await probeApplicationShell(port);
        if (shellReadiness.ok) return health;
        lastShellFailure = shellReadiness.reason;
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
    `${lastShellFailure ? ` Last shell failure: ${lastShellFailure}.` : ""}` +
    `${tail ? `\nRecent stderr:\n${tail}` : ""}`,
  );
}

async function readPreviewReadiness(port) {
  const health = await readHealth(port);
  if (!health) return { ok: false, reason: "/api/health did not return valid JSON" };
  const shell = await probeApplicationShell(port);
  if (!shell.ok) return { ok: false, reason: shell.reason, health, shell };
  return { ok: true, health, shell };
}

async function probeApplicationShell(port) {
  const shell = await readHttpBody(port, "/", APPLICATION_SHELL_MAX_BYTES);
  if (!shell) return { ok: false, reason: "application root did not respond" };
  if (shell.status !== 200) return { ok: false, reason: `application root returned HTTP ${shell.status}` };
  if (!/^text\/html(?:;|$)/i.test(shell.contentType)) {
    return { ok: false, reason: `application root returned ${shell.contentType || "no content type"}, not HTML` };
  }
  if (!APPLICATION_SHELL_MARKER_RE.test(shell.body)) {
    return { ok: false, reason: "application root is missing the mandible-bootstrap marker" };
  }

  const assets = referencedPrimaryAssets(shell.body, port);
  if (!assets.some((asset) => asset.kind === "javascript")) {
    return { ok: false, reason: "application shell references no primary JavaScript asset" };
  }
  if (!assets.some((asset) => asset.kind === "css")) {
    return { ok: false, reason: "application shell references no primary CSS asset" };
  }
  for (const asset of assets) {
    const result = await readHttpStatus(port, asset.path);
    if (!result || result.status !== 200) {
      return {
        ok: false,
        reason: `${asset.kind} asset ${asset.path} returned ${result ? `HTTP ${result.status}` : "no response"}`,
      };
    }
    const expectedType = asset.kind === "javascript" ? /(?:javascript|ecmascript)/i : /^text\/css(?:;|$)/i;
    if (!expectedType.test(result.contentType)) {
      return {
        ok: false,
        reason: `${asset.kind} asset ${asset.path} returned ${result.contentType || "no content type"}`,
      };
    }
  }
  return { ok: true, marker: "mandible-bootstrap", assets };
}

function referencedPrimaryAssets(html, port) {
  const origin = `http://127.0.0.1:${port}`;
  const assets = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = htmlAttribute(match[0], "rel")?.toLowerCase().split(/\s+/) ?? [];
    const href = htmlAttribute(match[0], "href");
    if (href && rel.includes("stylesheet")) assets.push({ kind: "css", ref: href });
  }
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = htmlAttribute(match[0], "src");
    if (src) assets.push({ kind: "javascript", ref: src });
  }
  return [...new Map(assets.map((asset) => {
    let resolved;
    try {
      resolved = new URL(asset.ref, `${origin}/`);
    } catch {
      return [`invalid:${asset.kind}:${asset.ref}`, { ...asset, path: asset.ref }];
    }
    const sameOrigin = resolved.origin === origin;
    const requestPath = sameOrigin ? `${resolved.pathname}${resolved.search}` : resolved.href;
    return [`${asset.kind}:${requestPath}`, { ...asset, path: requestPath, sameOrigin }];
  })).values()].filter((asset) => asset.sameOrigin !== false);
}

function htmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

function readHttpBody(port, requestPath, maxBytes) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: requestPath, timeout: 1_000 }, (res) => {
      let body = "";
      let bytes = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          req.destroy();
          resolve(null);
          return;
        }
        body += chunk;
      });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        contentType: String(res.headers["content-type"] ?? ""),
        body,
      }));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function readHttpStatus(port, requestPath) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: requestPath, timeout: 1_000 }, (res) => {
      const result = {
        status: res.statusCode ?? 0,
        contentType: String(res.headers["content-type"] ?? ""),
      };
      res.resume();
      res.on("end", () => resolve(result));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
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
    Array.isArray(health.instance.allowed_effects) &&
    health.instance.allowed_effects.join(",") === "ledger:read,ledger:write,files:preview,preferences:instance";
}

function hasExpectedPreviewFileRpc(metadata, health, previewRoot) {
  const expected = canonicalPath(path.join(previewRoot, "agent-rpc"));
  const candidates = [
    metadata?.instanceEnv?.MANDIBLE_FILE_RPC_DIR,
    health?.file_rpc_dir,
  ].filter(Boolean).map(canonicalPath);
  return candidates.length > 0 && candidates.every((candidate) => candidate === expected);
}

function hasExpectedPreviewReadiness(health, expected) {
  return health?.ready === true &&
    health?.warm === true &&
    health?.startup_commit?.hash === expected.head &&
    hasExpectedPreviewPolicy(health) &&
    canonicalPath(health?.instance?.db_path ?? "") === canonicalPath(expected.dbCopy) &&
    health?.instance?.db_path_source === "iab-preview-copy" &&
    canonicalPath(health?.instance?.source_db_path ?? "") === canonicalPath(expected.sourceDb) &&
    canonicalPath(health?.file_rpc_dir ?? "") === canonicalPath(path.join(expected.previewRoot, "agent-rpc"));
}

function describePreviewPolicy(health) {
  const role = health?.instance?.role ?? "unknown";
  const policy = health?.instance?.allowed_effects?.join(",") ?? "unknown";
  return `role=${role}, allowed_effects=${policy}`;
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

function directorySize(targetPath, deadline = Date.now() + 5_000) {
  if (Date.now() >= deadline) throw new Error(`Preview size inspection exceeded its bound; owner inspection required: ${targetPath}`);
  let total = 0;
  for (const dirent of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, dirent.name);
    if (dirent.isDirectory()) {
      total += directorySize(entryPath, deadline);
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
  return run("git", ["--no-optional-locks", ...commandArgs], options);
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
