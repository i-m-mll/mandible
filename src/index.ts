import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";
import { WebSocketServer } from "ws";
import { getDbPath, openDb, setDb, type Db } from "./db.js";
import {
  configureDaemonLogger,
  flushDaemonLogger,
  getDaemonLogger,
  startDaemonLogRetention,
} from "./daemon-log.js";
import { resolveInstanceInfo } from "./instance-policy.js";
import { NavMetadataEnricher } from "./nav-enrichment.js";
import { SessionRegistry } from "./registry.js";
import { SessionDiscovery, ReaperTimer } from "./session-discovery.js";
import { broadcast, SseManager, setSseManager } from "./sse.js";
import { Router, createServer, startServer, attachWebSocketUpgrade } from "./server.js";
import { FileRpcTransport } from "./file-rpc-transport.js";
import {
  isDaemonReady,
  isDaemonWarm,
  removePidFile,
  setDaemonReady,
  setDaemonWarm,
  writePidFile,
} from "./lifecycle.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChatRoutes } from "./routes/chats.js";
import { registerWorkRoutes } from "./routes/work.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { WorkScanner } from "./work-scanner.js";
import { registerConsoleRoutes } from "./routes/console.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { registerHookRoutes } from "./routes/hooks.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerWorkUnitRoutes } from "./routes/work-units.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { SessionManager } from "./session-manager.js";
import { registerBackupRoutes, startBackupScheduler, stopBackupScheduler } from "./routes/backup.js";
import { registerPresetRoutes } from "./routes/presets.js";
import { registerAuthHookRoutes } from "./routes/auth-hooks.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
import { registerTimelineRoutes } from "./routes/timeline.js";
import { registerSpacesRoutes } from "./routes/spaces.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRedirectRoutes } from "./routes/redirects.js";
import { registerTrashRoutes } from "./routes/trash.js";
import { startTrashGcScheduler, stopTrashGcScheduler } from "./trash-service.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { importClaudeMd, computeContentHash } from "./presets.js";
import { startIngestion, stopIngestionGracefully } from "./ingestion.js";
import { WorkUnitReconciler } from "./work-unit-reconciler.js";
import { getChannelRegistry } from "./channel-registry.js";
import { materializeCoworkCliCache } from "./cowork-cli-cache.js";
import type { Logger, StartupCommitInfo } from "./types.js";
import { DaemonMemoryDiagnostics, memoryWarningFractionFromEnv } from "./daemon-memory.js";
import { EventLoopLagDiagnostics } from "./daemon-event-loop.js";

const DEFAULT_PORT = 19420;
const DOTFILES_ROOT = resolveDotfilesRoot();
const STARTUP_DISCOVERY_DELAY_MS = 1_000;

let startupInfo: StartupCommitInfo | null = null;

export interface DaemonHandle {
  port: number;
  server: http.Server;
  db: Db;
  sse: SseManager;
  close: () => Promise<void>;
}

export interface StartOptions {
  port?: number;
  dbPath?: string;
  pidFilePath?: string;
  handleSignals?: boolean;
}

export async function startDaemon(options: StartOptions = {}): Promise<DaemonHandle> {
  // Bug: 645f8a8 — arm the readiness gate before any startup work. Health
  // reports ready:false from the moment the listener accepts connections until
  // critical init completes below, so a page loaded mid-startup keeps the
  // splash up and auth/dashboard mutations are blocked.
  setDaemonReady(false);
  setDaemonWarm(false);
  startupInfo = null;
  const port = options.port ?? getPort();
  let logger = getDaemonLogger();
  const memoryDiagnostics = new DaemonMemoryDiagnostics({
    logger: (level, message, details) => logger(level, message, details),
    warningFraction: memoryWarningFractionFromEnv(),
  });
  memoryDiagnostics.sample();
  const dbPath = options.dbPath ?? getDbPath();
  const db = openDb(dbPath);
  // Synchronous lock waits happen on the request thread. Clients already retry
  // transient contention, so keep this bounded while the ingestion actor uses
  // its own connection and explicit backoff.
  db.pragma("busy_timeout = 250");
  logger = configureDaemonLogger(db);
  const eventLoopDiagnostics = new EventLoopLagDiagnostics(
    (level, message, details) => logger(level, message, details),
  );
  // Seed the snapshot so health and ingestion-backoff reads (which no longer
  // sample directly) have a value before the first periodic tick.
  eventLoopDiagnostics.sample();
  const instance = resolveInstanceInfo({
    dbPath,
    dbPathSource: options.dbPath
      ? "start_options"
      : process.env.MANDIBLE_INSTANCE_DB_PATH_SOURCE
        ?? (process.env.MANDIBLE_DB ? "env" : "default"),
  });
  const sse = new SseManager();
  const version = resolveVersion();
  const startupEpoch = randomUUID();
  let startupWorkScanComplete = false;
  let startupSessionDiscoveryComplete = false;
  const updateWarmReadiness = () => {
    if (!startupWorkScanComplete || !startupSessionDiscoveryComplete) return;
    setDaemonWarm(true);
    logger("info", "daemon_warm", { port });
  };

  // Set singletons so partition code can use broadcast() and getDb()
  setDb(db);
  setSseManager(sse);
  sse.startHeartbeat();

  // Create router and register all partition routes
  const router = new Router({ logger, instance });
  const sessionRegistry = new SessionRegistry(db);
  // Bug: 4e32923 — capture the auth queue so the inbox route can mark
  // auth_requests as delivered when the channel server forwards the event.
  const authQueue = registerAuthRoutes(router);
  registerChatRoutes(router);
  const workScanner = registerWorkRoutes(router, new WorkScanner({
    on_event: (event) => {
      broadcast(event);
      if (event.type === "work:scan:completed") {
        startupWorkScanComplete = true;
        updateWarmReadiness();
      }
    },
  }));
  registerTrashRoutes(router, db);
  // Bug: f3dbb3e — pass sessionRegistry immediately; sessionManager is set after creation via issueDeps ref
  const issueDeps: { sessionRegistry?: import("./registry.js").SessionRegistry; sessionManager?: import("./session-manager.js").SessionManager } = { sessionRegistry };
  const issueScanner = registerIssueRoutes(router, workScanner, issueDeps);
  // Bug: 8a281b3 — inbox routes moved after sessionManager creation for liveness overlay
  registerSettingsRoutes(router);
  registerSystemRoutes(router, workScanner, db);
  registerBackupRoutes(router);

  const sessionDiscovery = new SessionDiscovery(db, sessionRegistry, workScanner, logger);
  const reaperTimer = new ReaperTimer(sessionDiscovery, logger);
  registerSessionRoutes(router, sessionRegistry, sessionDiscovery, issueScanner);

  registerGraphRoutes(router, issueScanner);
  registerProviderRoutes(router);
  // Bug: 8a281b3 — work-unit routes need sessionRegistry + sessionManager for liveness overlay
  // sessionManager is declared below; registerWorkUnitRoutes is called after it's created.

  const sessionManager = new SessionManager(db, logger, sessionRegistry);
  // Bug: f3dbb3e — late-bind sessionManager into issue route deps for canonical liveness
  issueDeps.sessionManager = sessionManager;
  registerWorkUnitRoutes(router, sessionRegistry, sessionManager);
  registerInboxRoutes(router, sessionRegistry, issueScanner, sessionManager, authQueue, workScanner);
  registerDashboardRoutes(router, authQueue, db);
  registerConsoleRoutes(router, sessionManager);
  registerHookRoutes(router);
  // Bug: 61bee4e — preset routes for convention management
  registerPresetRoutes(router);
  // Bug: 4afab83 — auth hooks CRUD routes
  registerAuthHookRoutes(router);
  // Bug: 9f66ad9 — webhook ingestion endpoint with session routing
  registerWebhookRoutes(router, sessionRegistry, sessionManager);
  // Bug: cc4688b — Zone 2 mutable runtime routes
  registerRuntimeRoutes(router);
  registerTimelineRoutes(router);
  registerSpacesRoutes(router);
  // Issue: 3d85f43 — canonical project registry CLI/API
  registerProjectRoutes(router);
  registerWorkflowRoutes(router);
  registerRedirectRoutes(router);
  // Bug: 40f0298 — conversation routes need sessionManager for resume endpoint
  registerConversationRoutes(router, sessionManager);

  try {
    materializeCoworkCliCache({
      sourceRoot: MANDIBLE_ROOT,
      version,
      logger,
      generatedFiles: [
        {
          path: "route-mutation-categories.json",
          contents: routeMutationCategoriesJson(router),
        },
      ],
    });
  } catch (error) {
    logger("warn", "cowork_cli_cache_materialize_failed", { error: String(error) });
  }

  // GET /api/reaper/status — expose reaper state (last run, sessions reaped, etc.)
  router.get("/api/reaper/status", (_req, res) => {
    res.json(reaperTimer.getStatus());
  }, { fileRpc: "deny" });

  const navEnricher = new NavMetadataEnricher(sessionRegistry, logger);
  navEnricher.start();

  // Bug: 4db692a — expose auth queue's rebuilding state to the health endpoint
  // so the UI doesn't reload while the daemon is still alive but about to restart.
  const fileRpcTransport = new FileRpcTransport({ router, logger, instance });
  const server = createServer({
    db, sse, logger, version, router,
    startupEpoch,
    getStartupInfo: () => startupInfo,
    isRebuilding: () => authQueue.isRebuilding,
    // Bug: 645f8a8 — report lifecycle-owned readiness in health.
    isReady: () => isDaemonReady(),
    isWarm: () => isDaemonWarm(),
    // Health reads the last periodic sample instead of collecting a fresh one.
    // A per-request eventLoopDiagnostics.sample() reset the underlying interval
    // histogram on every /api/health poll, discarding the window the 30 s timer
    // relies on for lag detection. Issue: 0d81726.
    getMemoryDiagnostics: () => memoryDiagnostics.snapshot(),
    getEventLoopDiagnostics: () => eventLoopDiagnostics.snapshot(),
    instance,
    fileRpcDir: fileRpcTransport.dir,
  });
  fileRpcTransport.start();

  // Attach WebSocket upgrade handler for console backend sessions (Bug: e980dd8)
  const wss = new WebSocketServer({ noServer: true });
  attachWebSocketUpgrade(server, (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/terminal\/([^/]+)$/);
    if (match) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const sessionId = decodeURIComponent(match[1]);
        const added = sessionManager.addWsClient(sessionId, ws);
        if (!added) {
          ws.close(1008, "session not found");
        }
      });
    } else {
      socket.destroy();
    }
  });

  const actualPort = await startServer(server, port, { logger });
  writePidFile(process.pid, options.pidFilePath);
  logger("info", "server_started", { port: actualPort });

  // Initialize console session manager: reconcile DB state, restart operator if configured.
  try {
    sessionManager.init();
  } catch (error) {
    logger("warn", "session_manager_init_failed", { error: String(error) });
  }

  // Self-health-check: periodically verify the server is still accepting
  // connections. This catches the zombie state where the listen socket died
  // silently (e.g., due to an OS-level error that didn't emit an 'error'
  // event) while SSE streams keep the process alive.
  const healthCheckTimer = setInterval(() => {
    memoryDiagnostics.sample();
    eventLoopDiagnostics.sample();
    if (!server.listening) {
      logger("error", "self_health_check_failed", {
        message: "server.listening is false, exiting for supervisor restart"
      });
      process.exit(1);
    }
  }, 30_000);
  if (typeof healthCheckTimer === "object" && "unref" in healthCheckTimer) {
    healthCheckTimer.unref();
  }
  // Bug: 645f8a8 — critical startup work is complete: the server is listening,
  // routes are registered, the DB is open, the pid file is written, the session
  // manager has initialized. Normal dashboard
  // mutations (auth approve/reject, etc.) are now safe. Flip the readiness gate
  // so health reports ready:true and the UI can drop the splash / re-enable
  // mutation controls. Deferred background scans (issue scan, session
  // discovery) run after this point and intentionally do NOT gate readiness.
  setDaemonReady(true);
  logger("info", "daemon_ready", { port: actualPort });

  // Visible-first boot no longer requests /api/work/repos on every route, so
  // start the yielding scanner explicitly. Its completion event advances the
  // warm tier after the first reconciliation pass, even when a recent scan is
  // reused from the persisted skip window.
  void workScanner.scanAllAsync({ skip_recent: true }).catch((error) => {
    logger("warn", "startup_work_scan_failed", { error: String(error) });
  });

  // Resolve the startup epoch after critical readiness. A slow git process must
  // not delay mutation safety; health temporarily reports an unknown epoch and
  // rebuild clients continue polling until the real commit is available.
  void readStartupCommit(logger).then((commit) => {
    startupInfo = commit;
    sse.setStartupCommit(commit);
  });

  // Start conversation ingestion watchers
  try {
    startIngestion(logger, {
      dbPath,
      // Read the last periodic sample so ingestion backoff does not reset the
      // shared lag histogram between batches. Issue: 0d81726.
      getBackgroundBackoffMs: () => eventLoopDiagnostics.snapshot().backgroundBackoffMs,
    });
  } catch (error) {
    logger("warn", "ingestion_start_failed", { error: String(error) });
  }

  // Startup reconciliation can shell out to inspect many local processes and
  // worktrees. Run it after the daemon is healthy so startup callers are not
  // blocked by machine-size-dependent discovery latency.
  const startupDiscoveryTimer = setTimeout(() => {
    void (async () => {
      try {
        const activeSessions = sessionRegistry.listSessions({ status: "active" });
        if (activeSessions.length === 0) {
          const result = await sessionDiscovery.discoverSessions();
          if (result.discovered > 0 || result.dead_reaped > 0) {
            logger("info", "startup_discovery", { ...result });
          }
        }
      } catch (error) {
        logger("warn", "startup_discovery_failed", { error: String(error) });
      } finally {
        startupSessionDiscoveryComplete = true;
        updateWarmReadiness();
      }
    })();
  }, STARTUP_DISCOVERY_DELAY_MS);
  if (typeof startupDiscoveryTimer === "object" && "unref" in startupDiscoveryTimer) {
    startupDiscoveryTimer.unref();
  }

  // Bug: 73e0adf — clear stale channel_connected_at on daemon startup.
  // Sessions that were channel-connected when the daemon last stopped are
  // no longer live; clear their channel metadata so the dashboard doesn't
  // show phantom channel badges.
  try {
    db.prepare(
      `UPDATE sessions SET channel_connected_at = NULL, channel_last_tool_call = NULL
       WHERE channel_connected_at IS NOT NULL AND status NOT IN ('active', 'idle')`
    ).run();
  } catch (error) {
    logger("warn", "channel_startup_cleanup_failed", { error: String(error) });
  }

  // Bug: 1a85d82 — Auto-import global CLAUDE.md into presets on startup.
  // Bug: 52b75c0 — Re-import if content has changed (hash comparison), not just if missing.
  try {
    const globalClaudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
    if (fs.existsSync(globalClaudeMd)) {
      const content = fs.readFileSync(globalClaudeMd, "utf8");
      const currentHash = computeContentHash(content);
      const existingPreset = db.prepare(
        "SELECT id, content_hash FROM presets WHERE source_path = ? LIMIT 1"
      ).get(globalClaudeMd) as { id: string; content_hash: string } | undefined;

      if (existingPreset) {
        if (existingPreset.content_hash !== currentHash) {
          // Content changed — delete old nodes and preset, then re-import
          db.prepare("DELETE FROM preset_nodes WHERE preset_id = ?").run(existingPreset.id);
          db.prepare("DELETE FROM presets WHERE id = ?").run(existingPreset.id);
          importClaudeMd(globalClaudeMd, db);
          logger("info", "startup_preset_reimport", { path: globalClaudeMd, reason: "content_changed" });
        }
        // else: hashes match, skip (no change)
      } else {
        // No preset exists for this path — import fresh
        importClaudeMd(globalClaudeMd, db);
        logger("info", "startup_preset_import", { path: globalClaudeMd });
      }
    }
  } catch (error) {
    logger("warn", "startup_preset_import_failed", { error: String(error) });
  }

  // Start periodic reaper (marks dead sessions whose PIDs vanished)
  reaperTimer.start();

  // Bug: 73e0adf — periodic channel registry pruning (every 5 minutes).
  // Removes in-memory entries for channel sessions that haven't called
  // any tool within the staleness window.
  const CHANNEL_PRUNE_INTERVAL_MS = 5 * 60 * 1_000;
  const channelPruneTimer = setInterval(() => {
    try {
      const pruned = getChannelRegistry().pruneStale();
      if (pruned.length > 0) {
        logger("info", "channel_prune", { pruned_count: pruned.length, session_ids: pruned });
      }
    } catch (error) {
      logger("warn", "channel_prune_failed", { error: String(error) });
    }
  }, CHANNEL_PRUNE_INTERVAL_MS);
  if (typeof channelPruneTimer === "object" && "unref" in channelPruneTimer) {
    channelPruneTimer.unref();
  }

  // Bug: 8a281b3 — periodic work-unit reconciler (dead sessions, abandoned branches, auto-commit)
  const workUnitReconciler = new WorkUnitReconciler(logger);
  workUnitReconciler.start();

  // Start scheduled metadata backups
  startBackupScheduler();
  startTrashGcScheduler(db, (level, event, fields) => logger(level, event, fields));

  // Issue: a8d8a31 — prune persisted daemon logs after readiness in bounded,
  // paced passes. Disk-reclaiming VACUUM remains an explicit maintenance task.
  const daemonLogRetention = startDaemonLogRetention(db, logger);

  let closing = false;
  const close = async () => {
    if (closing) {
      // Second signal while already shutting down — force exit immediately.
      logger("warn", "force_exit", { message: "second signal during shutdown, forcing exit" });
      process.exit(1);
    }
    closing = true;
    // Bug: 645f8a8 — a draining daemon is no longer ready for mutations.
    setDaemonReady(false);
    setDaemonWarm(false);

    // Hard deadline: if graceful shutdown hasn't completed in 5 seconds,
    // force exit so we don't become a zombie.
    const shutdownTimeout = setTimeout(() => {
      logger("error", "shutdown_timeout", { message: "graceful shutdown timed out after 5s, forcing exit" });
      process.exit(1);
    }, 5_000);
    // Prevent the timeout itself from keeping the process alive if close()
    // finishes before it fires.
    if (typeof shutdownTimeout === "object" && "unref" in shutdownTimeout) {
      shutdownTimeout.unref();
    }

    try { sessionManager.close(); } catch { /* best effort */ }
    wss.close();
    sse.closeAll();
    await stopIngestionGracefully();
    stopBackupScheduler();
    stopTrashGcScheduler();
    daemonLogRetention.stop();
    reaperTimer.stop();
    workUnitReconciler.stop();
    navEnricher.stop();
    fileRpcTransport.stop();
    authQueue.dispose();
    clearTimeout(startupDiscoveryTimer);
    clearInterval(channelPruneTimer);
    // Bug: 737df04 — destroy all open connections (including SSE streams) before
    // calling server.close(). Without this, server.close() waits indefinitely for
    // long-lived SSE connections to drain, hits the 5s timeout, force-exits, and
    // the port lingers in CLOSE_WAIT state — causing EADDRINUSE on the next start.
    if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === "function") {
      (server as { closeAllConnections: () => void }).closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearInterval(healthCheckTimer);
    eventLoopDiagnostics.close();
    clearTimeout(shutdownTimeout);
    // Persist the final batch of queued daemon_log rows before the connection
    // closes so recent activity is not lost on a clean shutdown.
    flushDaemonLogger();
    db.close();
    removePidFile(options.pidFilePath);
    logger("info", "server_stopped");
  };

  if (options.handleSignals !== false) {
    const handle = (signal: string) => {
      logger("info", "signal", { signal });
      void close();
    };
    process.on("SIGINT", handle);
    process.on("SIGTERM", handle);
  }

  return { port: actualPort, server, db, sse, close };
}

function getPort(): number {
  const raw = process.env.MANDIBLE_PORT;
  if (!raw) {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
}

function resolveVersion(): string {
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(currentDir, "..");
    const pkgPath = path.join(rootDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveDotfilesRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(currentDir, "../../..");
  if (fs.existsSync(path.join(candidate, ".git"))) {
    return candidate;
  }
  return path.resolve(currentDir, "../../../..");
}

function resolveMandibleRoot(): string {
  // Walk up from dist/index.js (compiled output) to reach the repo root.
  // __dirname in the compiled file is <repo>/dist/, so two levels up is the repo.
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..");
}

const MANDIBLE_ROOT = resolveMandibleRoot();

function routeMutationCategoriesJson(router: Router): string {
  const routes = router.listRoutePolicies()
    .filter((route) => route.operationalMutationCategory)
    .map((route) => ({
      method: route.method,
      path: route.path,
      category: route.operationalMutationCategory,
    }));
  return `${JSON.stringify({
    schema: 1,
    source: "Router.listRoutePolicies",
    routes,
    fallbackCategory: "api",
  }, null, 2)}\n`;
}

function readStartupCommit(logger: Logger): Promise<StartupCommitInfo> {
  return new Promise((resolve) => {
    // Run against the mandible repo root with no path filter — every commit
    // here is a mandible commit. The old path (.config/mcp-servers/mandible/)
    // was the pre-migration dotfiles location and no longer exists.
    execFile("git", ["log", "-1", "--format=%H|%s|%ci"], {
      cwd: MANDIBLE_ROOT,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout) => {
      const raw = stdout.trim();
      const parts = raw.split("|");
      const hash = parts.shift() ?? "";
      const date = parts.length > 0 ? (parts.pop() ?? "") : "";
      const summary = parts.join("|");
      if (error || !hash || !summary || !date) {
        logger("warn", "startup_commit_failed", {
          error: error ? String(error) : `unexpected git log output: ${raw}`,
        });
        resolve({ hash: "unknown", summary: "unknown", date: "" });
        return;
      }
      resolve({ hash, summary, date });
    });
  });
}

function isMain(): boolean {
  const entry = fileURLToPath(import.meta.url);
  return process.argv[1] === entry;
}

if (isMain()) {
  // Catch unhandled promise rejections — these can silently swallow errors
  // (e.g., in async route handlers) that would otherwise go unnoticed while
  // the process stays alive in a degraded state.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`${JSON.stringify({
      level: "error",
      message: "unhandled_rejection",
      error: String(reason),
      time: new Date().toISOString()
    })}\n`);
  });

  startDaemon().catch((error) => {
    process.stderr.write(`${JSON.stringify({ level: "error", message: "fatal", error: String(error) })}\n`);
    process.exit(1);
  });
}
