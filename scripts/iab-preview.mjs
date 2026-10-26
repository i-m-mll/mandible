#!/usr/bin/env bun
import fs from "node:fs";
import { withOwnedRunLock, createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun, ownedRunIdentityMatches, ownedRunHandle, ownedRunReceipt, processIdentity } from "./owned-run.mjs";
import { previewPaths, previewBaseDir, verifyPreviewConsumerStopped } from "./preview-custody.mjs";
import { previewRegistration, reconcilePreviewRegistration } from './preview-registration.mjs';
import { probeJson } from './local-runtime.mjs';
import https from 'node:https';
import { localCaPaths } from './local-ca-trust.mjs';
import { trackedSourceDigest } from './build-revision.mjs';
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
if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  await runCli();
}

async function runCli() {
  const lifecycleCommand = ['status', 'stop', 'teardown', 'refresh'].includes(process.argv[2]) ? process.argv[2] : null;
  const command = lifecycleCommand ?? (process.argv[2] === "finalize" ? "finalize" : process.argv[2] === "cleanup"
    ? "cleanup"
    : process.argv[2] === "seed-briefing-demo" ? "seed-briefing-demo"
      : process.argv[2] === "seed-agents-review" ? "seed-agents-review" : "preview");
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
    let result = command === 'refresh' ? await refreshPreview(args) : command === 'status' ? await previewStatus(args) : command === 'stop' ? await stopPreview(args)
      : command === 'teardown' || command === "finalize" ? await finalizePreview(args) : command === "cleanup"
      ? await cleanupPreviewCache(args)
      : command === "seed-briefing-demo" ? await seedBriefingDemo(args) : await main(args);
    if (args.native && result.ok && !args.dryRun) {
      const { launchNativePreview } = await import('./native-preview.mjs');
      const native = await launchNativePreview({ ...args, selected: result, project: result.ownership.project, workUnit: result.ownership.workUnit });
      result = { ...result, native };
    }
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

export async function main(options) {
  assertOrdinaryPreviewLifecycleAllowed();
  const selected = selectPreviewBranch(git(["rev-parse", "--show-toplevel"]).stdout.trim(), options).branch;
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
          if (metadata.ownership.lifecycle?.registration) await reconcileRegistration(metadata, metadata.ownership.lifecycle.registration, null, options.effects?.reloadGateway);
            metadata.ownership.lifecycle.phase = 'retired';
            saveOwnedMetadata(file, metadata);
            finalizeOwnedRun(file, { expectedRevision: metadata.ownership.revision, outcome: "failed", summary: String(error).slice(0, 2000) });
            const cleanup = cleanupOwnedRun(file, { apply: true });
            if (cleanup.action !== "delete-owned" || cleanup.remaining?.length) throw new Error(cleanup.reason);
          } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Preview failed; cleanup is pending owner action"); }
        }
      }
      throw error;
    }
  });
  return result;
}

/**
 * A non-protected checkout previews itself in place, whatever its branch;
 * the protected branch, --force-new, or an explicit other --branch previews
 * a separate integration worktree.
 */
function selectPreviewBranch(repoRoot, options) {
  const currentBranch = git(["branch", "--show-current"], { cwd: repoRoot }).stdout.trim();
  const protectedBranch = resolveProtectedBranch(repoRoot);
  if (!options.forceNew && currentBranch && currentBranch !== protectedBranch
    && (!options.branch || options.branch === currentBranch)) {
    return { branch: currentBranch, mode: "current-worktree", protectedBranch };
  }
  if (!currentBranch && !options.forceNew && !options.branch) {
    throw new Error(`HEAD is detached; check out the branch to preview, run from ${protectedBranch}, or pass --force-new.`);
  }
  const protectedHead = git(["rev-parse", "--short=7", protectedBranch], { cwd: repoRoot }).stdout.trim();
  const defaultBranch = `integration/mandible-iab-preview-${formatDateStamp(new Date())}-${protectedHead}`;
  return {
    branch: options.branch ?? (options.forceNew ? `${defaultBranch}-${formatTimeStamp(new Date())}` : defaultBranch),
    mode: currentBranch === protectedBranch ? "protected-branch" : "new-integration",
    protectedBranch,
  };
}

async function createOrReusePreview(options) {
  const cwd = process.cwd();
  const repoRoot = git(["rev-parse", "--show-toplevel"], { cwd }).stdout.trim();
  const worktreeHostRoot = resolveWorktreeHostRoot(repoRoot);
  const selection = selectPreviewBranch(repoRoot, options);
  const { branch, mode, protectedBranch } = selection;

  let worktree;

  if (mode === "current-worktree") {
    worktree = repoRoot;
    const existing = await healthyExistingPreview(branch, { worktree, verifyPublic: options.effects?.verifyPublic });
    if (existing) {
      if (options.artifactVersion) throw new Error("Refusing agents review seed: preview is already running; use --force-new for a pre-start seed.");
      const currentHead = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
      if (existing.health?.startup_commit?.hash !== currentHead
        || existing.ownership?.source?.source_digest !== trackedSourceDigest(worktree)) {
        return refreshExistingPreview(existing, { branch, worktree, mode, currentHead, options });
      }
      return {
        ...await withBrowserReadyUrl(existing, { pairBrowser: options.pairBrowser }),
        ok: true,
        status: "already-running",
        mode,
        message: "The current worktree already has a healthy preview.",
      };
    }
  } else {
    const selectedWorktree = worktreeForBranch(repoRoot, branch);
    const existing = !options.forceNew
      ? await healthyExistingPreview(branch, { worktree: selectedWorktree, verifyPublic: options.effects?.verifyPublic })
      : null;
    if (existing && !options.dryRun) {
      if (options.artifactVersion) throw new Error("Refusing agents review seed: preview is already running; use --force-new for a pre-start seed.");
      if (!selectedWorktree) {
        throw new Error(`Healthy preview metadata exists for ${branch}, but its worktree is not registered.`);
      }
      const currentHead = git(["rev-parse", "HEAD"], { cwd: selectedWorktree }).stdout.trim();
      if (existing.health?.startup_commit?.hash !== currentHead
        || existing.ownership?.source?.source_digest !== trackedSourceDigest(selectedWorktree)) {
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
    worktree = plannedWorktreePath(repoRoot, worktreeHostRoot, branch);
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

  const owner = resolvePreviewOwner(fs.existsSync(worktree) ? worktree : repoRoot,
    fs.existsSync(worktree) ? branch : git(['branch', '--show-current'], { cwd: repoRoot }).stdout.trim(), options);
  if (!fs.existsSync(sourceDb)) throw new Error(`Source database does not exist: ${sourceDb}`);
  readInstallationId();
  for (const prerequisite of [path.join(localSessionAuthorityDir(), 'sessions.db'), path.join(localSessionAuthorityDir(), 'Caddyfile'), path.join(mandibleHome(), 'runtime', 'caddy', '2.11.3', 'caddy')]) {
    if (!fs.existsSync(prerequisite)) throw new Error(`Preview gateway prerequisite is missing: ${prerequisite}`);
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

  bunRuntime(repoRoot);
  fs.mkdirSync(preview.root, { recursive: true });
  if (fs.existsSync(preview.metadata)) {
    const active = await previewConsumerReason(priorMetadata ?? {}, preview.root);
    if (active) throw new Error(`Existing preview has an active consumer but failed reuse validation: ${active}. No relaunch or cleanup occurred.`);
    throw new Error(`Stopped preview material requires finalization before relaunch: ${preview.root}`);
  }
  if (fs.readdirSync(preview.root).length) throw new Error(`Unclassified preview material prevents launch: ${preview.root}`);
  const preStartCleanup = { entries: [], reason: 'Other preview runs retain their own custody' };

  const dbCopy = path.join(preview.root, `mandible-${formatDateTimeForFile(new Date())}.db`);
  const allocation = assertPreviewAllocation(preview.root, sourceDb);
  const ownership = createOwnedRun({ root: preview.root, instanceId: `preview-${createHash("sha256").update(preview.root).digest("hex").slice(0, 16)}`, ...owner,
    disposable: options.disposableFixture, outputs: previewOwnedOutputs(path.basename(dbCopy)).map(output => ({ ...output, kind: "generated" })) });
  ownership.allocation = allocation;
  ownership.lifecycle = { phase: 'allocating', teardown: false };
  ownership.consumers = [];
  ownership.acquisition = { hostRoot: worktreeHostRoot, ownerBranch: git(['branch', '--show-current'], { cwd: fs.existsSync(worktree) ? worktree : repoRoot }).stdout.trim(),
    worktree: { path: worktree, branch, base: protectedBranch, created: !fs.existsSync(worktree), state: 'pending' } };
  saveOwnedMetadata(preview.metadata, { branch, worktree, previewRoot: preview.root, sourceDb, db: dbCopy, ownership });
  if (mode !== 'current-worktree') worktree = ensureIntegrationWorktree(repoRoot, worktreeHostRoot, branch, protectedBranch, options);
  const worktreeStat = fs.lstatSync(worktree);
  ownership.acquisition.worktree = { ...ownership.acquisition.worktree, path: worktree, state: 'acquired', identity: { dev: worktreeStat.dev, ino: worktreeStat.ino } };
  ownership.revision++;
  saveOwnedMetadata(preview.metadata, { branch, worktree, previewRoot: preview.root, sourceDb, db: dbCopy, ownership });
  if (!options.noBuild) {
    if (options.effects?.build) await options.effects.build(worktree);
    else { ensureDependencies(worktree); runBun(worktree, ["run", "--bun", "build"]); }
  }
  const build = JSON.parse(fs.readFileSync(path.join(worktree, 'dist', 'build-revision.json'), 'utf8'));
  const actualHead = git(['rev-parse', 'HEAD'], { cwd: worktree }).stdout.trim();
  if (build.commit !== actualHead || build.source_digest !== trackedSourceDigest(worktree)) throw new Error('Preview build does not match selected candidate');
  ownership.source = build;
  ownership.lifecycle.phase = 'projecting';
  ownership.revision++;
  saveOwnedMetadata(preview.metadata, { branch, worktree, previewRoot: preview.root, sourceDb, db: dbCopy, ownership });
  const projection = await (options.effects?.projectSnapshot ?? createProjectedSnapshot)({ sourceDb, dbCopy, worktree, allocation });
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
  if (currentHead !== ownership.source.commit || trackedSourceDigest(worktree) !== ownership.source.source_digest) throw new Error('Candidate source changed during preview preparation');
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
  ownership.lifecycle = { ...ownership.lifecycle, phase: 'registering', registration: previewRegistration(instanceEnv), priorRegistration: null };
  ownership.revision++;
  const creating = { branch, worktree, previewRoot: preview.root, sourceDb, db: dbCopy, pidFile, port, instanceEnv, runScript, stdoutLog, stderrLog, ownership };
  saveOwnedMetadata(preview.metadata, creating);
  let started = null;
  let health;
  try {
    await reconcileRegistration(creating, null, ownership.lifecycle.registration, options.effects?.reloadGateway);
    ownership.outputs = previewOwnedOutputs(path.basename(dbCopy), previewLogSegments(dbCopy)).map(output => ({ ...output, disposition: "pending" }));
    ownership.state = "active";
    ownership.revision += 1;
    saveOwnedMetadata(preview.metadata, creating);
    started = await startPreviewProcess({
      runScript,
      worktree,
      port,
      dbCopy,
      sourceDb,
      pidFile,
      stdoutLog,
      stderrLog,
      metadata: creating,
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
    await (options.effects?.verifyPublic ?? verifyPublicPreview)(creating);
    if (git(['rev-parse', 'HEAD'], { cwd: worktree }).stdout.trim() !== ownership.source.commit
      || trackedSourceDigest(worktree) !== ownership.source.source_digest) throw new Error('Candidate source changed during preview launch');
    ownership.lifecycle.phase = 'ready';
    ownership.revision++;
  } catch (error) {
    const recoveryFailures = [];
    if (started) {
      try { await stopPreviewProcess(creating); } catch (recoveryError) { recoveryFailures.push(recoveryError); }
    }
    ownership.lifecycle.phase = 'failed'; ownership.lifecycle.failure = String(error);
    saveOwnedMetadata(preview.metadata, creating);
    try { await reconcileRegistration(creating, ownership.lifecycle.registration, null, options.effects?.reloadGateway); ownership.lifecycle.phase = 'retired'; saveOwnedMetadata(preview.metadata, creating); } catch (recoveryError) { recoveryFailures.push(recoveryError); }
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
      import(`${pathToFileURL(path.join(custody.worktree, "src", "db.ts")).href}${cacheBust}`),
      import(`${pathToFileURL(path.join(custody.worktree, "src", "feedback", "briefings.ts")).href}${cacheBust}`),
      import(`${pathToFileURL(path.join(custody.worktree, "src", "provider-artifacts.ts")).href}${cacheBust}`),
      import(`${pathToFileURL(path.join(custody.worktree, "src", "users", "store.ts")).href}${cacheBust}`),
    ]);
    db = openDb(custody.db);
    const resolved = artifacts.resolveArtifactIdentity(db, details.artifactVersionRef, "strict-read");
    const version = resolved.status === "resolved" && resolved.target_type === "artifact_version"
      ? resolved.artifact_version : null;
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
      import(`${pathToFileURL(path.join(custody.worktree, "src", "db.ts")).href}${cacheBust}`),
      import(`${pathToFileURL(path.join(custody.worktree, "src", "feedback", "rich-briefing-demo.ts")).href}${cacheBust}`),
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
  if (!branch || branch === protectedBranch) {
    throw new Error(`Refusing demo seed: current branch must be a non-protected preview branch, got ${branch || "<detached>"}.`);
  }

  const preview = previewPaths(branch);
  if (!fs.existsSync(preview.metadata)) {
    throw new Error(`Refusing demo seed: launcher metadata is missing: ${preview.metadata}`);
  }
  const metadata = readJsonFile(preview.metadata);
  if (!metadata) throw new Error(`Refusing demo seed: launcher metadata is unreadable: ${preview.metadata}`);
  if (metadata.branch !== branch) throw new Error("Refusing demo seed: metadata branch does not match the current branch.");
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
    MANDIBLE_ALLOWED_EFFECTS: previewIsolationEnv(previewRoot, metadata.sourceDb).MANDIBLE_ALLOWED_EFFECTS,
  };
  for (const [key, value] of Object.entries(expectedPolicy)) {
    if (metadata.instanceEnv?.[key] !== value) {
      throw new Error(`Refusing demo seed: persisted ${key} does not match the preview policy.`);
    }
  }
  const persistedInstance = metadata.health?.instance;
  if (persistedInstance?.role !== "preview" || JSON.stringify(persistedInstance?.allowed_effects) !== expectedPolicy.MANDIBLE_ALLOWED_EFFECTS ||
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
  if (["finalize", 'teardown', 'stop', 'status', 'refresh'].includes(commandName)) return parseFinalizeArgs(argv);
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
      case '--native': options.native = true; break;
      case '--new-instance': options.newInstance = true; break;
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
  const fields = { '--run-id': 'runId', "--root": "root", "--revision": "revision", "--outcome": "outcome", "--disposition": "disposition", "--destination": "destination", "--summary": "summary", "--review-by": "reviewBy", "--transfer-reference": "transferReference" };
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
  if (options.revision === undefined) throw new Error('teardown requires --revision');
  const root = path.resolve(expandHome(options.root));
  if (canonicalPath(root) !== root || !isPathWithin(previewBaseDir(), root) || root === previewBaseDir()) throw new Error("Finalization root must be an exact owned preview child");
  const result = await withOwnedRunLock(root, async () => {
    const file = path.join(root, "metadata.json");
    const selected = selectedPreviewRun(options, root);
    if (selected.receipt) return { ok: selected.cleanup === 'completed', status: selected.cleanup === 'completed' ? 'cleaned' : 'cleanup-pending', ...selected };
    const metadata = selected;
    if (!metadata.ownership.lifecycle) throw new Error('Legacy owned preview lacks runtime custody; inspect and retire its registration explicitly');
    if (options.outcome !== 'investigating' && metadata.ownership.state !== 'terminal') {
      if (!['accepted', 'assessed', 'failed', 'abandoned'].includes(options.outcome) || !options.summary?.trim()
        || options.outcome === 'accepted' && !options.converged) throw new Error('Teardown requires a terminal outcome, summary and accepted convergence');
      if (!options.disposition && !metadata.ownership.disposable) throw new Error('Teardown requires explicit interactive data disposition');
      metadata.ownership.lifecycle.teardown = true;
      metadata.ownership.lifecycle.phase = 'stopping';
      persistPreview(metadata);
      await retirePreviewRuntime(metadata, { cleanupChildren: true, options });
    }
    const active = await previewConsumerReason(metadata, root);
    if (active) throw new Error(active);
    const finalized = metadata.ownership.state === 'terminal' ? metadata : finalizeOwnedRun(file, { expectedRevision: metadata.ownership.revision, outcome: options.outcome,
      converged: options.converged, disposition: options.disposition, destination: options.destination, summary: options.summary, reviewBy: options.reviewBy, transferReference: options.transferReference });
    const activeAfterDisposition = await previewConsumerReason(finalized, root);
    const cleanup = activeAfterDisposition ? { action: "skip-active", reason: activeAfterDisposition, remaining: finalized.ownership.cleanup.remaining }
      : cleanupOwnedRun(file, { apply: true });
    const complete = cleanup.action === "delete-owned" && cleanup.remaining?.length === 0;
    return { ok: complete || options.outcome === "investigating", status: options.outcome === "investigating" ? "investigating" : complete ? "cleaned" : "cleanup-pending", ...cleanup,
      outcome: options.outcome, converged: options.converged, runId: finalized.ownership.runId };
  });
  if (result.status === 'cleaned' && result.receipt) return finishPreviewWorktree(result);
  return result;
}

async function finishPreviewWorktree(result) {
  const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'));
  const acquired = receipt.acquisition?.worktree;
  let worktree = { ...acquired, retained: true, reason: 'Borrowed candidate worktree remains with its owner' };
  if (acquired?.created) {
    try {
      if (receipt.lifecycle?.phase !== 'retired' || receipt.consumers?.some(child => child.state !== 'released')) throw new Error('Runtime retirement or attached consumers remain');
      if (!fs.existsSync(acquired.path)) worktree = { ...acquired, retained: false, reason: 'Owned worktree already removed' };
      else {
        const stat = fs.lstatSync(acquired.path);
        if (!acquired.identity || stat.isSymbolicLink() || stat.dev !== acquired.identity.dev || stat.ino !== acquired.identity.ino) throw new Error('Owned worktree directory identity changed');
        if (git(['branch', '--show-current'], { cwd: acquired.path }).stdout.trim() !== acquired.branch) throw new Error('Owned worktree branch changed');
        if (git(['status', '--porcelain', '--untracked-files=all'], { cwd: acquired.path }).stdout.trim()) throw new Error('Owned worktree has modified or untracked files');
        if (git(['merge-base', '--is-ancestor', 'HEAD', acquired.base], { cwd: acquired.path, allowFailure: true }).status !== 0) throw new Error('Owned worktree has unique unmerged commits');
        const findUnits = branch => {
          const found = JSON.parse(run('mandible', ['work-unit', 'find', '--repo', receipt.project, '--branch', branch], { cwd: receipt.acquisition.hostRoot }).stdout);
          return Array.isArray(found) ? found : found.work_units ?? (found.id ? [found] : []);
        };
        const units = findUnits(receipt.acquisition.ownerBranch);
        const owner = units.find(unit => unit.id === receipt.workUnit);
        if (!owner || owner.state !== 'resolved') throw new Error('Owning delivery work unit is unresolved or cannot be verified');
        if (findUnits(acquired.branch).some(unit => !['resolved', 'abandoned'].includes(unit.state))) throw new Error('Owned worktree has unresolved delivery work');
        for (const entry of fs.readdirSync(previewBaseDir(), { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const other = readJsonFile(path.join(previewBaseDir(), entry.name, 'metadata.json'));
          if (other?.worktree && canonicalPath(other.worktree) === canonicalPath(acquired.path)) throw new Error('Another preview retains this worktree');
        }
        const removed = run('wt', ['rm', acquired.branch], { cwd: receipt.acquisition.hostRoot, allowFailure: true });
        if (removed.status !== 0 || fs.existsSync(acquired.path)) throw new Error(`wt retained owned worktree: ${removed.stderr?.trim() || removed.stdout?.trim()}`);
        worktree = { ...acquired, retained: false, reason: 'Owned clean merged worktree removed by wt' };
      }
    } catch (error) { worktree.reason = error.message; }
  }
  receipt.worktreeDisposition = worktree;
  saveOwnedMetadata(result.receipt, receipt);
  return { ...result, worktree };
}

function selectedPreviewRun(options, root) {
  if (!options.runId) throw new Error('Exact --run-id is required; use the setup run handle');
  const file = path.join(root, 'metadata.json');
  if (!fs.existsSync(file)) {
    const receipt = ownedRunReceipt({ root, runId: options.runId });
    if (!receipt) throw new Error('Owned preview run or retained receipt not found');
    return receipt;
  }
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!ownedRunIdentityMatches(root, metadata.ownership) || metadata.ownership.runId !== options.runId) {
    const receipt = ownedRunReceipt({ root, runId: options.runId });
    if (receipt?.cleanup === 'completed') return receipt;
    throw new Error('Preview run identity changed');
  }
  if (options.revision !== undefined && metadata.ownership.revision !== Number(options.revision)) throw new Error('Owned run metadata revision changed');
  return metadata;
}

export async function previewStatus(options) {
  if (!options.root) throw new Error('status requires --root and --run-id');
  const root = path.resolve(expandHome(options.root));
  return withOwnedRunLock(root, () => {
    const selected = selectedPreviewRun(options, root);
    return { ok: true, status: selected.receipt ? selected.cleanup : selected.ownership.lifecycle?.phase,
      handle: { root, runId: options.runId }, ...selected };
  });
}

function persistPreview(metadata) {
  metadata.ownership.revision++;
  saveOwnedMetadata(path.join(metadata.previewRoot, 'metadata.json'), metadata);
}

export async function stopPreview(options) {
  if (!options.root || options.revision === undefined) throw new Error('stop requires --root, --run-id and --revision');
  const root = path.resolve(expandHome(options.root));
  return withOwnedRunLock(root, async () => {
    const metadata = selectedPreviewRun(options, root);
    if (metadata.receipt) return { ok: metadata.cleanup === 'completed', status: 'cleaned', ...metadata };
    metadata.ownership.lifecycle.phase = 'stopping';
    persistPreview(metadata);
    await retirePreviewRuntime(metadata, { cleanupChildren: false });
    return { ...metadata, ok: true, status: 'stopped', handle: ownedRunHandle(metadata) };
  });
}

async function retirePreviewRuntime(metadata, { cleanupChildren = false, options = {} } = {}) {
  const run = metadata.ownership;
  for (const consumer of run.consumers ?? []) {
    if (consumer.state === 'released') continue;
    const childReceipt = ownedRunReceipt({ root: consumer.root, runId: consumer.runId });
    if (childReceipt?.cleanup === 'completed') { consumer.state = 'released'; consumer.receipt = childReceipt.receipt; persistPreview(metadata); continue; }
    if (!fs.existsSync(consumer.metadataFile)) throw new Error(`Pending native consumer ${consumer.consumerId} requires acquisition recovery`);
    const child = JSON.parse(fs.readFileSync(consumer.metadataFile, 'utf8'));
    if (child.ownership?.runId !== consumer.runId || !ownedRunIdentityMatches(consumer.root, child.ownership)
      || child.ownership.rootIdentity.dev !== consumer.rootIdentity.dev || child.ownership.rootIdentity.ino !== consumer.rootIdentity.ino) throw new Error('Attached native consumer identity changed');
    const adapter = await import('./native-preview.mjs');
    await adapter.stopNativePreview(consumer.metadataFile, { parentLockHeld: true });
    if (cleanupChildren) {
      await adapter.cleanupNativePreview(consumer.metadataFile, { parentLockHeld: true, disposition: options.disposition, outcome: options.outcome, summary: options.summary });
      const retired = ownedRunReceipt({ root: consumer.root, runId: consumer.runId });
      if (retired?.cleanup !== 'completed') throw new Error('Native child cleanup remains pending');
      consumer.state = 'released'; consumer.receipt = retired.receipt;
    }
    persistPreview(metadata);
  }
  await stopPreviewProcess(metadata);
  run.lifecycle.phase = 'retiring';
  persistPreview(metadata);
  if (run.lifecycle.registration) await reconcileRegistration(metadata, run.lifecycle.registration, null, options.effects?.reloadGateway);
  run.lifecycle.phase = 'retired';
  run.lifecycle.retiredAt = new Date().toISOString();
  run.lifecycle.worktree = { ...run.acquisition?.worktree, retained: true,
    reason: run.acquisition?.worktree?.created ? 'Owning delivery work unit must be resolved before wt removal' : 'Borrowed candidate worktree remains with its owner' };
  run.state = 'stopped';
  persistPreview(metadata);
}

function resolvePreviewOwner(worktree, branch, options) {
  if (options.ownerProject && options.ownerWorkUnit) return { project: options.ownerProject, workUnit: options.ownerWorkUnit };
  const project = JSON.parse(run("mandible", ["project", "show", worktree, "--json"], { cwd: worktree }).stdout);
  const found = JSON.parse(run("mandible", ["work-unit", "find", "--repo", worktree, "--branch", branch], { cwd: worktree }).stdout);
  const units = Array.isArray(found) ? found : found.work_units ?? (found.id ? [found] : []);
  const active = units.filter(unit => !["resolved", "abandoned"].includes(unit.state));
  if (active.length !== 1) {
    throw new Error(`Preview requires one owning delivery work unit, but ${branch} has ${active.length}. `
      + "Run the preview from the worktree of the issue-linked branch it serves (wt new <branch> --issue <id>), "
      + "or pass --owner-project and --owner-work-unit from the ledger.");
  }
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
  if (['status', 'stop', 'refresh', 'teardown', 'finalize'].includes(commandName)) {
    console.log(`Usage: bun run iab-preview -- ${commandName} --root <preview-root> --run-id <id> [--revision <n>] [--outcome accepted|assessed|failed|abandoned|investigating --summary <text>] [--converged] [--disposition discard|transferred --destination <verified-copy> --transfer-reference <accepted-output-ref>] [--review-by <ISO-time>] [--json]\nLive mutations require the current revision. Stop retains interactive data. Teardown/finalize stops exact consumers, retires the public route and removes disposed bytes. Completed teardown retries resolve the retained exact run receipt.`);
    return;
  }
  if (commandName === "seed-agents-review") {
    console.log(`Usage: bun run iab-preview -- seed-agents-review --artifact-version <exact-ref> [options]

Create a launcher-owned preview copy, bind one committed link-custody v3 review artifact,
and only then start the preview daemon. The source database and artifact are never mutated.
`);
    return;
  }
  if (commandName === "seed-briefing-demo") {
    console.log(`Usage: bun run iab-preview -- seed-briefing-demo [--json]

Seed the deterministic rich Briefing fixture into the current integration
branch's launcher-owned preview copy after validating metadata custody.
`);
    return;
  }
  if (commandName === "cleanup") {
    console.log(`Usage: bun run iab-preview -- cleanup [options]

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

  console.log(`Usage: bun run iab-preview -- [options]

Create or reuse an isolated Mandible preview instance.

From any non-protected branch, the current worktree is previewed in place and
its owning project and work unit are inferred from the worktree. From the
protected branch, or with --force-new or another --branch, a separate
integration worktree is created or reused.

Options:
  --json           Print machine-readable result JSON.
  --branch NAME    Preview a separate integration branch with this name.
  --db PATH        Source database to copy. Defaults to MANDIBLE_DB or ~/.mandible/mandible.db.
  --port PORT      Use an explicit preview port.
  --force-new      Do not preview the current worktree; create a new default integration branch/instance.
  --no-build       Skip frozen dependency installation and Bun build.
  --native         Build and open the matching isolated native application.
  --new-instance   Explicitly acquire another native consumer.
  --disposable-fixture  Explicitly declare automated fixture mutations disposable.
  --owner-project <id>  Canonical owning project.
  --owner-work-unit <id>  Exact delivery work unit.
  --pair-browser   Mint one bounded pairing URL for a new browser profile.
  --dry-run        Resolve the plan without creating a DB copy or starting a daemon.
  -h, --help       Show this help.

Default integration branch:
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
  run("wt", ["new", branch, base, '--no-issue', '--skip-setup'], { cwd: worktreeHostRoot });

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
  if (!readiness.ok) return refuseLivePreviewReuse(metadata, preview.root, readiness.reason);
  const { health } = readiness;
  if (!metadata.ownership || !ownedRunIdentityMatches(preview.root, metadata.ownership)
    || metadata.ownership.lifecycle?.teardown || metadata.ownership.lifecycle?.phase !== 'ready') return refuseLivePreviewReuse(metadata, preview.root, 'owned run lifecycle is not ready');
  const launch = metadata.ownership.lifecycle.launch;
  const identity = launch?.pid ? processIdentity(launch.pid) : null;
  if (!identity || identity.slice(0, 24) !== launch.startedAt || readPidFile(metadata.pidFile) !== launch.pid
    || !identity.includes(launch.runtime) || !identity.includes('src/index.ts')) throw new Error('Ready preview process identity does not match owned launch');
  await (expected.verifyPublic ?? verifyPublicPreview)(metadata);
  if (!hasExpectedPreviewFileRpc(metadata, health, preview.root)) return refuseLivePreviewReuse(metadata, preview.root, "file-RPC custody does not match the selected preview root");
  validatePreviewIdentity(metadata, preview, branch, expected.worktree);
  const drift = previewInstanceEnvDrift(metadata, preview.root);
  if (!hasExpectedPreviewPolicy(health) || drift.length > 0) return refuseLivePreviewReuse(metadata, preview.root, `instance policy or environment differs: ${drift.join(", ") || describePreviewPolicy(health)}`);

  return {
    ...metadata,
    health,
    freshUrl: `${metadata.instanceEnv.MANDIBLE_PUBLIC_ORIGIN}/?fresh=${Date.now()}#/timeline`,
  };
}

async function refuseLivePreviewReuse(metadata, root, reason) {
  const active = await previewConsumerReason(metadata, root);
  if (active) throw new Error(`Existing preview is active but cannot be reused: ${reason}; ${active}. No relaunch or cleanup occurred.`);
  return null;
}

export async function refreshPreview(options) {
  if (!options.root || options.revision === undefined) throw new Error("refresh requires --root, --run-id and --revision");
  const root = path.resolve(expandHome(options.root));
  return withOwnedRunLock(root, async () => {
    const existing = selectedPreviewRun(options, root);
    if (existing.receipt || existing.ownership.lifecycle.teardown) throw new Error("Retired preview cannot refresh; finish its teardown");
    return refreshExistingPreview(existing, { branch: existing.branch, worktree: existing.worktree, mode: existing.mode,
      currentHead: git(["rev-parse", "HEAD"], { cwd: existing.worktree }).stdout.trim(), options });
  });
}

async function refreshExistingPreview(existing, details) {
  const preview = previewPaths(details.branch);
  if (!existing.ownership || !ownedRunIdentityMatches(preview.root, existing.ownership)) throw new Error("Refresh requires exact owned run custody");
  for (const consumer of existing.ownership.consumers ?? []) {
    if (consumer.state !== 'released') await withOwnedRunLock(consumer.root, () => verifyPreviewConsumerStopped(consumer));
  }
  const validated = validateRefreshContract(existing, preview, details);
  const run = existing.ownership;
  if (run.lifecycle.teardown) throw new Error("Teardown intent prevents refresh");
  const previous = ['failed-stopped', 'retired'].includes(run.lifecycle.phase) ? null : run.lifecycle.registration;
  run.lifecycle.phase = "building";
  persistPreview(existing);
  if (details.options.effects?.build) await details.options.effects.build(details.worktree);
  else { ensureDependencies(details.worktree); runBun(details.worktree, ["run", "--bun", "build"]); }
  const source = JSON.parse(fs.readFileSync(path.join(details.worktree, "dist", "build-revision.json"), "utf8"));
  if (source.commit !== details.currentHead || source.source_digest !== trackedSourceDigest(details.worktree)) throw new Error("Source changed during refresh build");
  const registration = previewRegistration(validated.instanceEnv);
  run.lifecycle.refresh = { previous, desired: registration, source };
  run.lifecycle.phase = "refresh-stopping";
  persistPreview(existing);
  await stopPreviewProcess(existing);
  existing.instanceEnv = validated.instanceEnv;
  run.source = source;
  run.lifecycle.registration = registration;
  run.lifecycle.phase = "refresh-registering";
  persistPreview(existing);
  try {
    await reconcileRegistration(existing, previous, registration, details.options.effects?.reloadGateway);
    writeRunScript(validated.runScript, { ...validated, worktree: details.worktree, nodePath: bunRuntime(details.worktree), generation: details.currentHead });
    const started = await startPreviewProcess({ ...validated, worktree: details.worktree, metadata: existing });
    const health = await waitForPreviewReadiness(validated.port, { head: details.currentHead, dbCopy: validated.dbCopy,
      sourceDb: validated.sourceDb, previewRoot: preview.root }, HEALTH_TIMEOUT_MS, validated.stderrLog);
    await (details.options.effects?.verifyPublic ?? verifyPublicPreview)(existing);
    if (git(['rev-parse', 'HEAD'], { cwd: details.worktree }).stdout.trim() !== source.commit
      || trackedSourceDigest(details.worktree) !== source.source_digest) throw new Error('Candidate source changed during refresh launch');
    existing.health = health;
    existing.status = "refreshed"; existing.ok = true;
    existing.restartLifecycle = started;
    existing.refreshedAt = new Date().toISOString();
    run.lifecycle.phase = "ready"; run.state = "active";
    persistPreview(existing);
    return withBrowserReadyUrl(existing, { pairBrowser: details.options.pairBrowser });
  } catch (error) {
    run.lifecycle.phase = "refresh-failed"; run.lifecycle.failure = String(error);
    persistPreview(existing);
    const failures = [error];
    try { await stopPreviewProcess(existing); } catch (failure) { failures.push(failure); }
    try { await reconcileRegistration(existing, registration, null, details.options.effects?.reloadGateway); run.lifecycle.phase = "failed-stopped"; persistPreview(existing); } catch (failure) { failures.push(failure); }
    throw new AggregateError(failures, "Refresh failed; interactive preview material retained for exact retry or teardown");
  }
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
  if (drift.length > 0) {
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
    ...(preview.ownership ? { handle: ownedRunHandle(preview), receipt: path.join(path.dirname(preview.ownership.root), '.receipts', `${preview.ownership.runId}.json`) } : {}),
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
  if (metadata.ownership?.lifecycle?.phase !== 'retired') return { ...result, action: 'skip', reason: 'Owned runtime/gateway retirement is pending or unrecorded; use exact teardown' };
  return { ...result, ...cleanupOwnedRun(metadataPath, { apply }) };
}

async function previewConsumerReason(metadata, root) {
  if (metadata.ownership?.consumers?.some(child => child.state !== 'released')) return 'attached or pending native/build consumer requires explicit cleanup';
  const pids = [metadata.pidFile, path.join(root, "mandible.pid")].filter(Boolean).map(readPidFile);
  if (pids.some(pid => pid && isProcessAlive(pid))) return "recorded pid is live; identity or ownership may be shared";
  if (metadata.port && await isPortOpen(metadata.port)) return "recorded port has a consumer; health is not deletion authority";
  if (metadata.launchLabel) return 'recorded respawn authority requires explicit exact retirement';
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

export function bunRuntime(worktree) {
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
  const child = spawn("/bin/zsh", ['-c', 'IFS= read -r gate || exit 1; [ "$gate" = ready ] || exit 1; exec /bin/zsh "$1"', 'preview-launch', details.runScript], {
    cwd: details.worktree,
    detached: true,
    env: sanitizedLauncherEnv(),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.unref();
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const identity = processIdentity(child.pid);
  if (!identity) throw new Error('Preview launcher exited before acquisition could be recorded');
  if (!details.metadata?.ownership) throw new Error('Preview launch requires durable run metadata');
  details.metadata.ownership.lifecycle.launch = { pid: child.pid, identity, startedAt: identity.slice(0, 24),
    runScript: details.runScript, runtime: bunRuntime(details.worktree), worktree: details.worktree };
  try { persistPreview(details.metadata); }
  catch (error) { child.stdin.destroy(); throw error; }
  child.stdin.end('ready\n');
  return { mechanism: "detached-child", launcherPid: child.pid ?? null };
}

/** Stop only the recorded process lifetime and selected instance. */
export async function stopPreviewProcess(metadata, timeoutMs = 10_000) {
  const launch = metadata.ownership?.lifecycle?.launch;
  const filePid = metadata.pidFile ? readPidFile(metadata.pidFile) : null;
  if (filePid && filePid !== launch?.pid && isProcessAlive(filePid)) throw new Error('Preview pid file identity changed; refusing to signal');
  const pid = launch?.pid;
  if (!pid || processIdentity(pid) === null) {
    if (metadata.port && await isPortOpen(metadata.port)) throw new Error('Stopped preview backend port has a conflicting consumer');
    return { pid: pid ?? null, outcome: 'already-stopped' };
  }
  const verify = async () => {
    const identity = processIdentity(pid);
    if (!identity) return false;
    if (identity.slice(0, 24) !== launch.startedAt
      || !(identity.includes(launch.runScript) || identity.includes(launch.runtime) && identity.includes('src/index.ts'))) throw new Error('Preview process identity changed; refusing to signal');
    const cwd = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
    if (!cwd || canonicalPath(cwd) !== canonicalPath(launch.worktree)) throw new Error('Preview process launch context changed');
    if (metadata.port && await isPortOpen(metadata.port)) {
      const health = await readHealth(metadata.port);
      if (health?.instance?.instance_id !== metadata.instanceEnv?.MANDIBLE_INSTANCE_ID
        || health?.instance?.backend_generation !== metadata.instanceEnv?.MANDIBLE_BACKEND_GENERATION) throw new Error('Preview listener belongs to a different instance or generation');
    }
    return true;
  };
  if (!await verify()) return { pid, outcome: 'already-stopped' };

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
    if (!await verify()) return { pid, outcome: 'terminated' };
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
  ${shellQuote(details.nodePath)} src/index.ts >> ${shellQuote(details.stdoutLog)} 2>> ${shellQuote(details.stderrLog)}
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

export function previewInstanceEnv(details) {
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

async function reconcileRegistration(metadata, expected, desired, reload = reloadLocalFrontDoor) {
  return reconcilePreviewRegistration({ home: mandibleHome(), runId: metadata.ownership.runId, expected, desired,
    reload: token => reload(token) });
}

export function reloadLocalFrontDoor(token) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "local-runtime.mjs");
  const result = spawnSync(process.execPath, [script, "reload-gateway"], {
    encoding: "utf8", timeout: 20_000,
    env: { ...process.env, ...(token ? { MANDIBLE_GATEWAY_LOCK_TOKEN: token } : {}) },
  });
  if (result.error || result.status !== 0) throw new Error(`Gateway reconciliation failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}

async function verifyPublicPreview(metadata) {
  const ca = fs.readFileSync(localCaPaths(mandibleHome()).rootCert);
  const origin = metadata.instanceEnv.MANDIBLE_PUBLIC_ORIGIN;
  const response = await probeJson(new URL("/api/health", origin).href, { ca, timeoutMs: 5000 });
  const health = response.document;
  if (!response.ok || health?.instance?.instance_id !== metadata.instanceEnv.MANDIBLE_INSTANCE_ID
      || health?.instance?.backend_generation !== metadata.instanceEnv.MANDIBLE_BACKEND_GENERATION
      || health?.startup_commit?.hash !== metadata.instanceEnv.MANDIBLE_BACKEND_GENERATION
      || !health?.ready || !health?.warm) throw new Error("Public HTTPS preview route does not match selected ready generation");
  const shell = await readPublicBody(new URL("/", origin), ca);
  if (!APPLICATION_SHELL_MARKER_RE.test(shell)) throw new Error("Public preview application shell is missing");
  const assets = referencedPrimaryAssets(shell, metadata.port);
  for (const asset of assets) await readPublicBody(new URL(asset.path, origin), ca);
}

function readPublicBody(url, ca) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { ca }, response => {
      let bytes = 0; const chunks = [];
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Public preview asset returned ${response.statusCode}`)); return; }
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) request.destroy(new Error("Public asset exceeds probe limit")); else chunks.push(chunk); });
      response.on("end", () => bytes ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error("Public preview asset is empty")));
      response.on("error", reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error("Public preview probe timed out")));
    request.on("error", reject);
  });
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
export function sanitizedLauncherEnv() {
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
    timeout: options.timeout ?? 60_000,
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
    timeout: 5000,
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
