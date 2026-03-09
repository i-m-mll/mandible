import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";
import { WebSocketServer } from "ws";
import { openDb, setDb, type Db } from "./db.js";
import { NavMetadataEnricher } from "./nav-enrichment.js";
import { SessionRegistry } from "./registry.js";
import { SessionDiscovery, ReaperTimer } from "./session-discovery.js";
import { SseManager, setSseManager } from "./sse.js";
import { Router, createServer, startServer, attachWebSocketUpgrade } from "./server.js";
import { removePidFile, writePidFile } from "./lifecycle.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChatRoutes } from "./routes/chats.js";
import { registerWorkRoutes } from "./routes/work.js";
import { registerReviewRoutes } from "./routes/review.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { registerSettingsRoutes, syncReaperSettingsToConfigFile } from "./routes/settings.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerSwitchboardRoutes } from "./routes/switchboard.js";
import { registerConsoleRoutes } from "./routes/console.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { PtyManager } from "./pty-manager.js";
import { registerBackupRoutes, startBackupScheduler, stopBackupScheduler } from "./routes/backup.js";
import { startIngestion, stopIngestion } from "./ingestion.js";
import type { Logger, LogLevel, StartupCommitInfo } from "./types.js";

const DEFAULT_PORT = 19420;
const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const DOTFILES_ROOT = resolveDotfilesRoot();

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
  const port = options.port ?? getPort();
  const logger = createLogger();
  const db = openDb(options.dbPath);
  const sse = new SseManager();
  const version = resolveVersion();

  // Set singletons so partition code can use broadcast() and getDb()
  setDb(db);
  setSseManager(sse);
  sse.startHeartbeat();

  // Create router and register all partition routes
  const router = new Router();
  const sessionRegistry = new SessionRegistry(db);
  registerAuthRoutes(router);
  registerChatRoutes(router);
  const workScanner = registerWorkRoutes(router);
  registerReviewRoutes(router, workScanner);
  const issueScanner = registerIssueRoutes(router, workScanner);
  registerInboxRoutes(router, sessionRegistry, issueScanner);
  registerSettingsRoutes(router);
  // Bug: 94bba43 — sync reaper settings to config file on startup so
  // the fallback config file is always current even if Mandible was down
  // when settings were last changed.
  syncReaperSettingsToConfigFile();
  registerSystemRoutes(router, workScanner);
  registerConversationRoutes(router);
  registerSwitchboardRoutes(router);
  registerBackupRoutes(router);

  const sessionDiscovery = new SessionDiscovery(db, sessionRegistry, workScanner, logger);
  const reaperTimer = new ReaperTimer(sessionDiscovery, logger);
  registerSessionRoutes(router, sessionRegistry, sessionDiscovery, issueScanner);

  registerGraphRoutes(router, issueScanner);

  // Console routes + PTY manager (Bug: e980dd8)
  const ptyManager = new PtyManager(db, logger);
  registerConsoleRoutes(router, ptyManager);

  // GET /api/reaper/status — expose reaper state (last run, sessions reaped, etc.)
  router.get("/api/reaper/status", (_req, res) => {
    res.json(reaperTimer.getStatus());
  });

  const navEnricher = new NavMetadataEnricher(sessionRegistry, logger);
  navEnricher.start();

  const server = createServer({ db, sse, logger, version, router, getStartupInfo: () => startupInfo });

  // Attach WebSocket upgrade handler for PTY terminal sessions (Bug: e980dd8)
  const wss = new WebSocketServer({ noServer: true });
  attachWebSocketUpgrade(server, (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/terminal\/([^/]+)$/);
    if (match) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const sessionId = decodeURIComponent(match[1]);
        const added = ptyManager.addWsClient(sessionId, ws);
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

  // Initialize PTY manager: reconcile DB state, restart operator if configured (Bug: e980dd8)
  try {
    ptyManager.init();
  } catch (error) {
    logger("warn", "pty_manager_init_failed", { error: String(error) });
  }

  // Self-health-check: periodically verify the server is still accepting
  // connections. This catches the zombie state where the listen socket died
  // silently (e.g., due to an OS-level error that didn't emit an 'error'
  // event) while SSE streams keep the process alive.
  const healthCheckTimer = setInterval(() => {
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
  startupInfo = readStartupCommit(logger);
  sse.setStartupCommit(startupInfo);

  // Start conversation ingestion watchers
  try {
    startIngestion(logger);
  } catch (error) {
    logger("warn", "ingestion_start_failed", { error: String(error) });
  }

  // Startup issue scan: populate IssueScanner cache for all repos so the
  // Issues tab is ready immediately without waiting for a user request.
  // Run after a short delay to avoid blocking server startup.
  const issueStartupTimer = setTimeout(() => {
    void issueScanner.scanAllAsync()
      .then(() => {
        logger("info", "startup_issue_scan_complete");
      })
      .catch((error) => {
        logger("warn", "startup_issue_scan_failed", { error: String(error) });
      });
  }, 2_000);
  if (typeof issueStartupTimer === "object" && "unref" in issueStartupTimer) {
    issueStartupTimer.unref();
  }

  // Periodic issue rescan every 5 minutes to keep the cache fresh as
  // git-bug issues are created/closed in the background.
  const ISSUE_SCAN_INTERVAL_MS = 5 * 60 * 1_000;
  const issueRescanTimer = setInterval(() => {
    void issueScanner.scanAllAsync().catch((error) => {
      logger("warn", "periodic_issue_scan_failed", { error: String(error) });
    });
  }, ISSUE_SCAN_INTERVAL_MS);
  if (typeof issueRescanTimer === "object" && "unref" in issueRescanTimer) {
    issueRescanTimer.unref();
  }

  // Startup reconciliation: discover sessions if none are tracked yet
  try {
    const activeSessions = sessionRegistry.listSessions({ status: "active" });
    if (activeSessions.length === 0) {
      const result = sessionDiscovery.discoverSessions();
      if (result.discovered > 0 || result.dead_reaped > 0) {
        logger("info", "startup_discovery", { ...result });
      }
    }
  } catch (error) {
    logger("warn", "startup_discovery_failed", { error: String(error) });
  }

  // Start periodic reaper (marks dead sessions whose PIDs vanished)
  reaperTimer.start();

  // Start scheduled metadata backups
  startBackupScheduler();

  let closing = false;
  const close = async () => {
    if (closing) {
      // Second signal while already shutting down — force exit immediately.
      logger("warn", "force_exit", { message: "second signal during shutdown, forcing exit" });
      process.exit(1);
    }
    closing = true;

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

    // Kill all PTY processes before closing SSE (Bug: e980dd8)
    try { ptyManager.close(); } catch { /* best effort */ }
    wss.close();
    sse.closeAll();
    stopIngestion();
    stopBackupScheduler();
    reaperTimer.stop();
    navEnricher.stop();
    clearTimeout(issueStartupTimer);
    clearInterval(issueRescanTimer);
    // Bug: 737df04 — destroy all open connections (including SSE streams) before
    // calling server.close(). Without this, server.close() waits indefinitely for
    // long-lived SSE connections to drain, hits the 5s timeout, force-exits, and
    // the port lingers in CLOSE_WAIT state — causing EADDRINUSE on the next start.
    if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === "function") {
      (server as { closeAllConnections: () => void }).closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearInterval(healthCheckTimer);
    clearTimeout(shutdownTimeout);
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

function createLogger(): Logger {
  const level = (process.env.LOG_LEVEL ?? "info") as LogLevel;
  const minIndex = LEVELS.indexOf(level);
  return (msgLevel, message, details) => {
    if (LEVELS.indexOf(msgLevel) < minIndex) {
      return;
    }
    const payload = {
      level: msgLevel,
      message,
      time: new Date().toISOString(),
      ...(details ?? {})
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  };
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

function readStartupCommit(logger: Logger): StartupCommitInfo {
  try {
    // Run against the mandible repo root with no path filter — every commit
    // here is a mandible commit. The old path (.config/mcp-servers/mandible/)
    // was the pre-migration dotfiles location and no longer exists.
    const raw = execSync("git log -1 --format='%H|%s|%ci'", {
      cwd: MANDIBLE_ROOT,
      encoding: "utf8"
    }).trim();
    const parts = raw.split("|");
    const hash = parts.shift() ?? "";
    const date = parts.length > 0 ? (parts.pop() ?? "") : "";
    const summary = parts.join("|");
    if (!hash || !summary || !date) {
      throw new Error(`unexpected git log output: ${raw}`);
    }
    return { hash, summary, date };
  } catch (error) {
    logger("warn", "startup_commit_failed", { error: String(error) });
    return { hash: "unknown", summary: "unknown", date: "" };
  }
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
