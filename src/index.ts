import { DOMAIN_EVENTS } from "./contracts.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
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
  stopDaemonLogger,
} from "./daemon-log.js";
import {
  openOperationalLogStore,
  startOperationalLogCopyForward,
  type OperationalLogStore,
} from "./operational-log-db.js";
import { allowsOperationalMutations, resolveInstanceInfo } from "./instance-policy.js";
import { AuthAutoApproveManager } from "./auth-auto-approve.js";
import { AuthClearanceManager } from "./auth-clearance.js";
import { DelegatedSigningResource } from "./delegated-signing-resource.js";
import { AuthQueue } from "./auth-queue.js";
import { NavMetadataEnricher } from "./nav-enrichment.js";
import { SessionRegistry } from "./registry.js";
import { SessionDiscovery, ReaperTimer } from "./session-discovery.js";
import { broadcast, SseManager, setSseManager } from "./sse.js";
import { Router, createServer, createLocalSocketServer, startServer, attachWebSocketUpgrade } from "./server.js";
import { localApiSocketPath, startLocalApiSocket } from "./local-api-socket.js";
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
import { registerWorkRoutes } from "./routes/work.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerLedgerChangeRoutes } from "./routes/ledger-changes.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerUserSettingsRoutes } from "./routes/user-settings.js";
import { registerHostUserPreferencesRoutes } from "./routes/host-user-preferences.js";
import { HostUserPreferencesStore } from "./host-user-preferences.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerConversationControlRoutes } from "./routes/conversation-control.js";
import { registerConversationSpawnRoutes } from "./routes/conversation-spawn.js";
import { ConversationControlService } from "./conversation-control/service.js";
import { registerDefaultConversationControllers } from "./conversation-control/default-adapters.js";
import { registerConversationCustodyRoutes } from "./routes/conversation-custody.js";
import { WorkScanner } from "./work-scanner.js";
import { registerConsoleRoutes } from "./routes/console.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { registerHookRoutes } from "./routes/hooks.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerWorkUnitRoutes } from "./routes/work-units.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { SessionManager } from "./session-manager.js";
import { registerBackupRoutes, startBackupScheduler, stopBackupScheduler } from "./routes/backup.js";
import { registerAuthHookRoutes } from "./routes/auth-hooks.js";
import { registerTimelineRoutes } from "./routes/timeline.js";
import { registerSpacesRoutes } from "./routes/spaces.js";
// Umbrella 99b74d6 / issue ce22a3a — briefing review store, ingest, and sweep.
import { registerBriefingRoutes } from "./routes/briefing.js";
// Umbrella 99b74d6 / issue ce83a84 — human-initiated agent dispatch.
import { registerAgentDispatchRoutes } from "./routes/agent-dispatch.js";
// Issue 0bc2279 — executor task inventory receipts and read-only projection.
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerOperationalIncidentRoutes } from "./routes/operational-incidents.js";
import { registerManagedReminderRoutes } from "./routes/reminders.js";
import {
  startManagedReminderScheduler,
  stopManagedReminderScheduler,
} from "./managed-reminder-scheduler.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerClientAuthRoutes } from "./routes/client-auth.js";
import { ClientAuthenticator } from "./client-auth/index.js";
import { validatePreviewWritableRoots } from "./security/effect-policy.js";
import {
  authorizeManagedSessionWebSocket,
} from "./client-auth/authz.js";
import { registerRedirectRoutes } from "./routes/redirects.js";
import { registerTrashRoutes } from "./routes/trash.js";
import { startTrashGcScheduler, stopTrashGcScheduler } from "./trash-service.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { startIngestion, stopIngestionGracefully, triggerTargetedIngest } from "./ingestion.js";
import { ensureExactConversationFresh } from "./conversations/freshness.js";
import { WorkUnitReconciler } from "./work-unit-reconciler.js";
import { getChannelRegistry } from "./channel-registry.js";
import { materializeCoworkCliCache } from "./cowork-cli-cache.js";
import type { Logger, StartupCommitInfo } from "./types.js";
import { DaemonMemoryDiagnostics, memoryWarningFractionFromEnv } from "./daemon-memory.js";
import { EventLoopLagDiagnostics } from "./daemon-event-loop.js";
import { auditOperatorSigningCredential } from "./signing-credential-audit.js";
import {
  RestartAvailabilityStore,
  restartAvailabilityInstanceKey,
} from "./restart-availability.js";
import { DEFAULT_BACKEND_PORT } from "./canonical-origin.js";

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
  operationalLogDbPath?: string;
  /** Isolated client-auth state root for embedded runtimes and tests. */
  clientAuthDir?: string;
}

export function startIngestionAfterStartupWorkScan(
  scan: Promise<unknown>,
  start: () => void,
  logger: Logger,
): () => void {
  let cancelled = false;
  const startAfterScan = () => {
    if (cancelled) return;
    try {
      start();
    } catch (error) {
      logger("warn", "ingestion_start_failed", { error: String(error) });
    }
  };
  void scan.then(
    startAfterScan,
    (error) => {
      logger("warn", "startup_work_scan_failed", { error: String(error) });
      startAfterScan();
    },
  );
  return () => { cancelled = true; };
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
  const instance = resolveInstanceInfo({
    dbPath,
    dbPathSource: options.dbPath
      ? "start_options"
      : process.env.MANDIBLE_INSTANCE_DB_PATH_SOURCE
        ?? (process.env.MANDIBLE_DB ? "env" : "default"),
  });
  validatePreviewWritableRoots(instance);
  const operationalMutationsAllowed = allowsOperationalMutations(instance);
  const restartAvailability = operationalMutationsAllowed
    ? new RestartAvailabilityStore({ instanceKey: restartAvailabilityInstanceKey(port) })
    : null;
  const db = openDb(dbPath);
  // Synchronous lock waits happen on the request thread. Clients already retry
  // transient contention, so keep this bounded while the ingestion actor uses
  // its own connection and explicit backoff.
  db.pragma("busy_timeout = 250");
  let operationalLogStore: OperationalLogStore | null = null;
  if (operationalMutationsAllowed) {
    try {
      operationalLogStore = openOperationalLogStore(dbPath, {
        dbPath: options.operationalLogDbPath,
      });
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        level: "error",
        event: "operational_log_db_open_failed",
        time: new Date().toISOString(),
        error: String(error),
      })}\n`);
    }
  }
  logger = configureDaemonLogger(operationalLogStore?.db ?? db, {
    persist: Boolean(operationalLogStore),
    settingsDb: db,
  });
  const eventLoopDiagnostics = new EventLoopLagDiagnostics(
    (level, message, details) => logger(level, message, details),
  );
  // Seed the snapshot so health and ingestion-backoff reads (which no longer
  // sample directly) have a value before the first periodic tick.
  eventLoopDiagnostics.sample();
  const sse = new SseManager();
  const version = resolveVersion();
  const startupEpoch = randomUUID();
  let readyRestartGeneration: string | null = null;
  let startupWorkScanComplete = false;
  let startupSessionDiscoveryComplete = false;
  const updateWarmReadiness = () => {
    if (!startupWorkScanComplete || !startupSessionDiscoveryComplete) return;
    setDaemonWarm(true);
    if (readyRestartGeneration) {
      restartAvailability?.markWarm(readyRestartGeneration);
    }
    logger("info", "daemon_warm", { port });
  };

  // Set singletons so partition code can use broadcast() and getDb()
  setDb(db);
  setSseManager(sse);
  sse.startHeartbeat();

  // Issue 708dc4c — client-authentication gate. Wired into the router boundary
  // so token-bearing requests resolve to a user identity (compat mode by
  // default: unauthenticated loopback still works and unattributed writes are
  // counted; strict mode rejects anonymous mutations).
  const clientAuth = new ClientAuthenticator(db, {
    instance,
    startupEpoch,
    secretsDir: options.clientAuthDir,
    sessionAuthorityDir: process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR?.trim() || undefined,
  });
  // Create router and register all partition routes
  const router = new Router({ logger, instance, clientAuth });
  const sessionRegistry = new SessionRegistry(db, logger);
  // Bug: 4e32923 — capture the auth queue so the inbox route can mark
  // auth_requests as delivered when the channel server forwards the event.
  const autoApproveManager = new AuthAutoApproveManager({
    seedDefaultDurationSetting: operationalMutationsAllowed,
  });
  const delegatedSigningResource = new DelegatedSigningResource(autoApproveManager, {
    db,
    runtimeEpoch: startupEpoch,
    allowRuntimeAuthority: instance.role === "main" && operationalMutationsAllowed,
  });
  const clearanceManager = new AuthClearanceManager(
    db,
    delegatedSigningResource,
    startupEpoch,
  );
  const reconnect = delegatedSigningResource.attachAvailable();
  if (reconnect.attached > 0 || reconnect.refused > 0) {
    logger(reconnect.refused > 0 ? "warn" : "info", "delegated_signer_reconnect", reconnect);
  }
  const authQueue = new AuthQueue({
    autoApprover: autoApproveManager,
    clearanceManager,
    backgroundMaintenance: operationalMutationsAllowed,
    allowExternalEffects: operationalMutationsAllowed,
    restartAvailability: restartAvailability ?? undefined,
  });
  registerAuthRoutes(router, authQueue, autoApproveManager, clearanceManager);
  const workScanner = registerWorkRoutes(router, new WorkScanner({
    config_path: instance.role === "preview"
      ? path.join(instance.preview_root!, "work", "repos.json")
      : undefined,
    config_root: instance.role === "preview" ? instance.preview_root! : undefined,
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
  registerIssueRoutes(router, workScanner, issueDeps);
  registerLedgerChangeRoutes(router, db);
  // Bug: 8a281b3 — inbox routes moved after sessionManager creation for liveness overlay
  registerSettingsRoutes(router, instance.role);
  registerUserSettingsRoutes(router, db);
  registerHostUserPreferencesRoutes(router, new HostUserPreferencesStore(instance.user_preferences_root));
  registerSystemRoutes(router, workScanner, operationalLogStore?.db ?? db);
  registerBackupRoutes(router);

  const sessionDiscovery = new SessionDiscovery(db, sessionRegistry, workScanner, logger);
  const reaperTimer = new ReaperTimer(sessionDiscovery, logger);
  registerSessionRoutes(router, sessionRegistry, sessionDiscovery, workScanner);

  registerGraphRoutes(router);
  registerProviderRoutes(router);
  // Bug: 8a281b3 — work-unit routes need sessionRegistry + sessionManager for liveness overlay
  // sessionManager is declared below; registerWorkUnitRoutes is called after it's created.

  const sessionManager = new SessionManager(
    db,
    logger,
    sessionRegistry,
    undefined,
    clientAuth,
  );
  const conversationControl = new ConversationControlService(db, {
    onChange: (snapshot) => broadcast({
      type: DOMAIN_EVENTS.CONVERSATION_CONTROL_UPDATED,
      event: DOMAIN_EVENTS.CONVERSATION_CONTROL_UPDATED,
      data: snapshot,
    }),
    onProviderEvent: (event) => broadcast({
      type: DOMAIN_EVENTS.CONVERSATION_PROVIDER_EVENT,
      event: DOMAIN_EVENTS.CONVERSATION_PROVIDER_EVENT,
      data: event,
    }),
    onTerminalTurn: async ({ conversation_id, provider_session_id }) => {
      const result = await triggerTargetedIngest({ sessionRef: provider_session_id });
      try {
        await ensureExactConversationFresh(db, conversation_id);
        return { status: `${result.status}:fresh` };
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "freshness_error";
        return { status: `${result.status}:${code}` };
      }
    },
    onReconciliationDiagnostic: (details) => logger("info", "conversation_terminal_reconciliation", details),
  });
  registerDefaultConversationControllers(conversationControl);
  // Bug: f3dbb3e — late-bind sessionManager into issue route deps for canonical liveness
  issueDeps.sessionManager = sessionManager;
  registerWorkUnitRoutes(router, sessionRegistry, sessionManager, logger);
  registerInboxRoutes(router, sessionRegistry, sessionManager, authQueue, workScanner);
  registerDashboardRoutes(router, authQueue, db);
  registerConsoleRoutes(router, sessionManager);
  registerConversationSpawnRoutes(router, db, conversationControl);
  registerHookRoutes(router);
  // Bug: 4afab83 — auth hooks CRUD routes
  registerAuthHookRoutes(router);
  // Bug: 9f66ad9 — webhook ingestion endpoint with session routing
  registerWebhookRoutes(router, sessionManager);
  registerTimelineRoutes(router);
  registerSpacesRoutes(router);
  // Issue: ce22a3a — briefing ingestion, review queue, and decision routes
  registerBriefingRoutes(router, db);
  // Issue: ce83a84 — human-only agent dispatch (preview, dispatch, events)
  registerAgentDispatchRoutes(router, db);
  // Issue: 0bc2279 — executor task inventory (registered-publisher POST, read projection)
  registerTaskRoutes(router, db);
  // Issue 5308097 — durable executor-reported operational incident ledger.
  registerOperationalIncidentRoutes(router, db);
  // Issue e257e5c — bounded, attributable, first-party reminder mutations.
  registerManagedReminderRoutes(router, db);
  // Issue: 3d85f43 — canonical project registry CLI/API
  registerProjectRoutes(router);
  // Issue: e89c2b0 — user registry core (users, credentials, bindings, evidence)
  registerUserRoutes(router);
  // Issue: 708dc4c — client-auth token mint/list, mode toggle, and telemetry.
  registerClientAuthRoutes(router, clientAuth);
  registerWorkflowRoutes(router);
  registerRedirectRoutes(router);
  registerConversationRoutes(router, sessionRegistry);
  registerConversationControlRoutes(router, conversationControl, { db, instance });
  registerConversationCustodyRoutes(router, db);

  try {
    materializeCoworkCliCache({
      sourceRoot: MANDIBLE_ROOT,
      version,
      logger,
      generatedFiles: [
        {
          path: "route-mutation-categories.json",
          contents: routeMutationCategoriesJson(router, version),
        },
      ],
    });
  } catch (error) {
    logger("warn", "cowork_cli_cache_materialize_failed", { error: String(error) });
  }

  const navEnricher = new NavMetadataEnricher(sessionRegistry, logger);
  if (operationalMutationsAllowed) {
    navEnricher.start();
  }

  // Bug: 4db692a — expose auth queue's rebuilding state to the health endpoint
  // so the UI doesn't reload while the daemon is still alive but about to restart.
  const fileRpcTransport = new FileRpcTransport({ router, logger, instance });
  const socketPath = localApiSocketPath(instance);
  const serverOptions: Parameters<typeof createServer>[0] = {
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
    localSocketPath: socketPath,
    clientAuth,
  };
  const server = createServer(serverOptions);

  // Attach WebSocket upgrade handler for console backend sessions (Bug: e980dd8)
  const wss = new WebSocketServer({ noServer: true });
  attachWebSocketUpgrade(server, (req, socket, head) => {
    void (async () => {
      // A WebSocket is a cross-origin write-capable channel. Browsers send an
      // Origin header here, but no CSRF header, so bind it to this instance's
      // exact registered origin before resolving the OS-owned human.
      if (req.headers.origin !== instance.public_origin
          || req.headers.host !== new URL(instance.public_origin).host
          || req.headers["sec-fetch-site"] === "cross-site") {
        socket.destroy();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const match = url.pathname.match(/^\/terminal\/([^/]+)$/);
      if (!match) {
        socket.destroy();
        return;
      }
      const sessionId = decodeURIComponent(match[1]);
      const session = sessionManager.get(sessionId);
      if (!session) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      const contextHeader = req.headers["x-mandible-session-context"];
      const compact = Array.isArray(contextHeader) ? contextHeader[0] : contextHeader;
      const identity = compact
        ? await clientAuth.authenticateInternalContext(compact)
        : clientAuth.localBrowserIdentity();
      if (!identity || !authorizeManagedSessionWebSocket(
        db,
        identity,
        session.meta.owner_user_id,
        sessionManager.isCredentialBearing(sessionId),
      )) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          socket.destroy();
          return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const added = sessionManager.addWsClient(sessionId, ws);
        if (!added) {
          ws.close(1008, "session not found");
          return;
        }

      });
    })().catch(() => socket.destroy());
  }, instance);

  const actualPort = await startServer(server, port, { logger });
  const localServer = createLocalSocketServer(serverOptions);
  let closeLocalSocket: () => Promise<void>;
  try {
    closeLocalSocket = await startLocalApiSocket(localServer, socketPath);
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  try {
    fileRpcTransport.start();
  } catch (error) {
    await closeLocalSocket();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  // A failed bind must not replace the healthy daemon's gateway target.
  // Register the port the listener actually owns, including when port 0 was requested.
  if (instance.role === "main") {
    clientAuth.registerInstance({
      instance_id: instance.instance_id,
      installation_id: instance.installation_id,
      role: "main",
      public_origin: instance.public_origin,
      backend_origin: `http://127.0.0.1:${actualPort}`,
      backend_generation: instance.backend_generation,
      effect_ceiling: instance.allowed_effects,
      writable_roots: instance.writable_roots,
    });
  }
  writePidFile(process.pid, options.pidFilePath);
  logger("info", "server_started", { port: actualPort });

  // Initialize console session manager: reconcile DB state, restart operator if configured.
  try {
    sessionManager.init({ readOnly: !operationalMutationsAllowed });
  } catch (error) {
    logger("warn", "session_manager_init_failed", { error: String(error) });
  }
  if (operationalMutationsAllowed) {
    const reconciliation = await conversationControl.reconcileAfterRestart();
    if (reconciliation.errors.length > 0) {
      logger("warn", "conversation_control_reconciliation_errors", reconciliation);
    }
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
  readyRestartGeneration = restartAvailability?.markReady() ?? null;
  logger("info", "daemon_ready", { port: actualPort });

  // Visible-first boot no longer requests /api/work/repos on every route, so
  // start the yielding scanner explicitly. Its completion event advances the
  // warm tier after the first reconciliation pass, even when a recent scan is
  // reused from the persisted skip window.
  const startupWorkScan = operationalMutationsAllowed
    ? workScanner.scanAllAsync({ skip_recent: true })
    : null;
  const startInstanceIngestion = () => {
    try {
      startIngestion(logger, {
        dbPath,
        background: instance.role !== "preview",
        // Read the last periodic sample so ingestion backoff does not reset the
        // shared lag histogram between batches. Issue: 0d81726.
        getBackgroundBackoffMs: () => eventLoopDiagnostics.snapshot().backgroundBackoffMs,
      });
    } catch (error) {
      logger("warn", "ingestion_start_failed", { error: String(error) });
    }
  };
  const cancelStartupIngestion = startupWorkScan
    ? startIngestionAfterStartupWorkScan(startupWorkScan, startInstanceIngestion, logger)
    : () => undefined;
  if (!startupWorkScan) {
    startupWorkScanComplete = true;
    if (instance.role === "preview") startInstanceIngestion();
  }

  // Resolve the startup epoch after critical readiness. A slow git process must
  // not delay mutation safety; health temporarily reports an unknown epoch and
  // rebuild clients continue polling until the real commit is available.
  void readStartupCommit(logger).then((commit) => {
    startupInfo = commit;
    sse.setStartupCommit(commit);
  });

  // Startup reconciliation can shell out to inspect many local processes and
  // worktrees. Run it after the daemon is healthy so startup callers are not
  // blocked by machine-size-dependent discovery latency.
  const startupDiscoveryTimer = operationalMutationsAllowed
    ? setTimeout(() => {
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
    }, STARTUP_DISCOVERY_DELAY_MS)
    : null;
  if (startupDiscoveryTimer && typeof startupDiscoveryTimer === "object" && "unref" in startupDiscoveryTimer) {
    startupDiscoveryTimer.unref();
  }
  if (!operationalMutationsAllowed) {
    startupSessionDiscoveryComplete = true;
    updateWarmReadiness();
    logger("info", "background_operational_mutations_disabled", {
      instance_role: instance.role,
      allowed_effects: instance.allowed_effects,
    });
  }

  // Bug: 73e0adf — clear stale channel_connected_at on daemon startup.
  // Sessions that were channel-connected when the daemon last stopped are
  // no longer live; clear their channel metadata so the dashboard doesn't
  // show phantom channel badges.
  if (operationalMutationsAllowed) {
    try {
      db.prepare(
        `UPDATE sessions SET channel_connected_at = NULL, channel_last_tool_call = NULL
         WHERE channel_connected_at IS NOT NULL AND status NOT IN ('active', 'idle')`
      ).run();
    } catch (error) {
      logger("warn", "channel_startup_cleanup_failed", { error: String(error) });
    }
  }

  // Issue 2205073 — audit the protected-merge signing credential at startup.
  // An unregistered `git user.signingkey` is invisible until base-transition
  // provenance verification refuses an approval with no visible cause, so the
  // misconfiguration is surfaced here instead. Read-only; never blocks startup.
  try {
    const signingAudit = auditOperatorSigningCredential(db);
    if (signingAudit.status === "missing_credential") {
      logger("warn", "signing_credential_unregistered", {
        subsystem: "auth",
        operator: signingAudit.operator_slug,
        fingerprint: signingAudit.fingerprint,
        detail:
          "The configured git user.signingkey is not an active registered signing credential. " +
          "Protected-branch merges signed with it cannot be attested when a later approval " +
          "recomputes a stale merge candidate.",
        fix: signingAudit.hint,
      });
    } else if (signingAudit.status === "unresolvable") {
      logger("warn", "signing_credential_unresolvable", {
        subsystem: "auth",
        operator: signingAudit.operator_slug,
        configured_key: signingAudit.configured_key,
        reason: signingAudit.reason,
      });
    }
  } catch (error) {
    logger("warn", "signing_credential_audit_failed", { error: String(error) });
  }

  // Start periodic reaper (marks dead sessions whose PIDs vanished)
  if (operationalMutationsAllowed) {
    reaperTimer.start();
  }

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
  if (operationalMutationsAllowed) {
    workUnitReconciler.start();
  }

  // Start scheduled metadata backups
  if (operationalMutationsAllowed) {
    startBackupScheduler();
    startTrashGcScheduler(db, (level, event, fields) => logger(level, event, fields));
    // Issue ce22a3a — retire unreviewed briefing candidates on a slow cadence.
    startManagedReminderScheduler(db, (level, event, fields) => logger(level, event, fields));
  }

  // Issue: a8d8a31 — prune persisted daemon logs after readiness in bounded,
  // paced passes. Disk-reclaiming VACUUM remains an explicit maintenance task.
  const daemonLogCopyForward = operationalLogStore
    ? startOperationalLogCopyForward(operationalLogStore, logger)
    : { stop: () => undefined };
  const daemonLogRetention = operationalLogStore
    ? startDaemonLogRetention(operationalLogStore.db, logger, { settingsDb: db })
    : { stop: () => undefined };

  let closing = false;
  const close = async () => {
    if (closing) {
      // Second signal while already shutting down — force exit immediately.
      logger("warn", "force_exit", { message: "second signal during shutdown, forcing exit" });
      process.exit(1);
    }
    closing = true;
    cancelStartupIngestion();
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
    try {
      await conversationControl.close();
    } catch (error) {
      logger("warn", "conversation_control_close_failed", { error: String(error) });
    }
    wss.close();
    sse.closeAll();
    await stopIngestionGracefully();
    stopBackupScheduler();
    stopTrashGcScheduler();
    stopManagedReminderScheduler();
    daemonLogCopyForward.stop();
    daemonLogRetention.stop();
    reaperTimer.stop();
    workUnitReconciler.stop();
    navEnricher.stop();
    fileRpcTransport.stop();
    await closeLocalSocket();
    authQueue.dispose();
    if (startupDiscoveryTimer) clearTimeout(startupDiscoveryTimer);
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
    stopDaemonLogger();
    operationalLogStore?.close();
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
    return DEFAULT_BACKEND_PORT;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_BACKEND_PORT;
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

function resolveMandibleRoot(): string {
  // Walk up from dist/index.js (compiled output) to reach the repo root.
  // __dirname in the compiled file is <repo>/dist/, so two levels up is the repo.
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..");
}

const MANDIBLE_ROOT = resolveMandibleRoot();

function routeMutationCategoriesJson(router: Router, version: string): string {
  return `${JSON.stringify(router.operationCatalog(version), null, 2)}\n`;
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
