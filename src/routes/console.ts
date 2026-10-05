/**
 * Console session HTTP routes.
 * Bug: e980dd8
 */

import { getDb, type Db } from "../db.js";
import { AttributionReadResolver } from "../identity/read-projection.js";
import { readSessionIdentityMismatchBatch } from "../identity/session-mismatch.js";
import { SessionManager } from "../session-manager.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import type {
  ConsoleSession,
} from "../types.js";
import { sendJson } from "./http.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import {
  ClientAuthzError,
  requireOperator,
} from "../client-auth/authz.js";


// Bug: 81c9d85 — enrich ConsoleSession with is_processing from SDKBackend state
function requireTerminalMutation(res: ResponseLike, session: { meta: ConsoleSession }): boolean {
  if (session.meta.backend_type === "pty" && !session.meta.channel_enabled) return true;
  sendJson(res, 410, { error: "conversation_control_required", provider_session_id: session.meta.provider_session_id, message: "Use this conversation in Chats for managed operations." });
  return false;
}

function enrichWithProcessing(backend: { meta: ConsoleSession }): ConsoleSession {
  return { ...backend.meta, is_processing: false };
}

function requireManagedSessionAccess(
  req: RequestLike,
  res: ResponseLike,
  manager: SessionManager,
  session: { meta: Pick<ConsoleSession, "id" | "command" | "is_operator"> },
): boolean {
  if (!sessionIsCredentialBearing(manager, session)) return true;
  try {
    requireOperator(getDb(), req);
    return true;
  } catch (error) {
    if (error instanceof ClientAuthzError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return false;
    }
    throw error;
  }
}

function sessionIsCredentialBearing(
  manager: SessionManager,
  session: { meta: Pick<ConsoleSession, "id" | "is_operator"> },
): boolean {
  const classifier = (manager as SessionManager & {
    isCredentialBearing?: (id: string) => boolean;
  }).isCredentialBearing;
  // Concrete SessionManager instances always expose the pinned classifier.
  // The fallback preserves isolated route-test doubles and fails closed for
  // the historically privileged operator marker.
  return typeof classifier === "function"
    ? classifier.call(manager, session.meta.id)
    : session.meta.is_operator;
}

function requireOperatorRoute(req: RequestLike, res: ResponseLike): boolean {
  try {
    requireOperator(getDb(), req);
    return true;
  } catch (error) {
    if (error instanceof ClientAuthzError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return false;
    }
    throw error;
  }
}

function isOperatorRequest(req: RequestLike): boolean {
  try {
    requireOperator(getDb(), req);
    return true;
  } catch (error) {
    if (error instanceof ClientAuthzError) return false;
    throw error;
  }
}

type ConversationSpawnPlacement = {
  canonical_project_id: string | null;
  canonical_checkout_id: string | null;
};

export function readConversationSpawnPlacementBatch(
  db: Db,
  sessionIds: readonly string[],
): Map<string, ConversationSpawnPlacement> {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  const placements = new Map<string, ConversationSpawnPlacement>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, project_id, checkout_id
         FROM conversation_spawn_requests
        WHERE id IN (${placeholders})`,
    ).all(...batch) as Array<{
      id: string;
      project_id: string | null;
      checkout_id: string | null;
    }>;
    for (const row of rows) {
      placements.set(row.id, {
        canonical_project_id: row.project_id,
        canonical_checkout_id: row.checkout_id,
      });
    }
  }
  return placements;
}

export function registerConsoleRoutes(
  server: RouteRegistrar,
  manager: SessionManager
): void {

  // ------------------------------------------------------------------
  // GET /api/console/sessions — list all sessions
  // ------------------------------------------------------------------
  server.get("/api/console/sessions", (req, res) => {
    const db = getDb();
    const attributionResolver = new AttributionReadResolver(db);
    const visible = manager.getAll()
      .filter((session) => (
        !sessionIsCredentialBearing(manager, session) || isOperatorRequest(req)
      ))
      .map((s) => enrichWithProcessing(s));
    // Issue 499c148 — read the flags per request rather than caching them on the
    // in-memory console sessions, so a mismatch recorded long after a session was
    // created still reaches the dashboard. One batched read for the whole
    // listing: this route is polled, and a statement per session was an N+1.
    const identityMismatches = readSessionIdentityMismatchBatch(
      db,
      visible
        .map((session) => session.mandible_session_id)
        .filter((id): id is string => Boolean(id)),
    );
    // Conversation creation uses the reservation id as the console-session id.
    // Keep this projection tied to that exact authority instead of inferring a
    // canonical project from cwd, which may be shared or later relocated.
    const spawnPlacements = readConversationSpawnPlacementBatch(
      db,
      visible.map((session) => session.id),
    );
    const sessions = visible.map((session) => ({
      ...session,
      canonical_project_id: spawnPlacements.get(session.id)?.canonical_project_id ?? null,
      canonical_checkout_id: spawnPlacements.get(session.id)?.canonical_checkout_id ?? null,
      owner: session.owner ?? attributionResolver.user(session.owner_user_id),
      identity_mismatch: session.mandible_session_id
        ? identityMismatches.get(session.mandible_session_id) ?? null
        : null,
    }));
    res.status(200).json({ sessions });
  }, { operation: { id: "get:/api/console/sessions", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // GET /api/console/lane-policy — which Claude lanes this install ships
  //
  // Issue 8aadf70 — the dashboard must not offer a lane the daemon will reject.
  // The gate is resolvable from settings *and* an environment override, so the
  // UI asks the daemon rather than inferring it from the settings table.
  // ------------------------------------------------------------------
  server.get("/api/console/lane-policy", (_req, res) => {
    sendJson(res, 200, {
      terminal_backend_type: "pty",
      managed_providers: ["claude_code", "codex"],
    });
  }, { operation: { id: "get:/api/console/lane-policy", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/console/run-options", (req, res) => {
    const backendType = req.query.backend_type;
    const command = req.query.command;
    if (backendType !== "pty" || typeof command !== "string" || !command) {
      sendJson(res, 400, { error: "invalid_run_options_query" });
      return;
    }
    sendJson(res, 200, { runOptions: manager.describeRunOptions("pty", command) });
  }, { operation: { id: "get:/api/console/run-options", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // POST /api/console/sessions — create a real terminal
  // ------------------------------------------------------------------
  server.post("/api/console/sessions", globalCapabilityRoute("spawn_console", async (_req, res) => {
    const body = (_req.body ?? {}) as Record<string, unknown>;
    if (body.backend_type && body.backend_type !== "pty" || body.provider_session_id || body.channel_enabled || body.transport_lane && body.transport_lane !== "pty") {
      return sendJson(res, 422, { error: "managed_conversation_required", message: "Create Claude and Codex Chats through conversation-spawns." });
    }
    if (typeof body.command !== "string" || !body.command.trim() || body.args !== undefined && (!Array.isArray(body.args) || !body.args.every((value) => typeof value === "string"))) {
      return sendJson(res, 400, { error: "invalid_terminal_request" });
    }
    const session = manager.create({ label: typeof body.label === "string" ? body.label : "Terminal", command: body.command,
      args: body.args as string[] | undefined, cwd: typeof body.cwd === "string" ? body.cwd : undefined, backend_type: "pty", transport_lane: "pty" });
    sendJson(res, 201, { session });
  }, { authenticated: true }), { operation: { id: "post:/api/console/sessions", effects: ["ledger:write", "process:external"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });


  // ------------------------------------------------------------------
  // GET /api/console/sessions/:id — single session
  // ------------------------------------------------------------------
  server.get("/api/console/sessions/:id", (req, res) => {
    const ptySession = manager.get(req.params.id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    res.status(200).json({ session: enrichWithProcessing(ptySession) });
  }, { operation: { id: "get:/api/console/sessions/:id", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.patch("/api/console/sessions/:id", async (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    if (!requireTerminalMutation(res, ptySession)) return;

    const body = (req.body ?? {}) as { model?: unknown; label?: unknown };
    const patch: Partial<Pick<ConsoleSession, "label" | "args">> = {};
    if (typeof body.label === "string" && body.label.trim()) {
      patch.label = body.label.trim();
    }
    if (body.model !== undefined) return sendJson(res, 422, { error: "terminal_has_no_managed_model", message: "Set provider options on the conversation in Chats." });

    const session = manager.updateConfig(id, patch);
    res.status(200).json({ session });
  }, { operation: { id: "patch:/api/console/sessions/:id", effects: ["process:external"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  server.get("/api/console/sessions/:id/options", (req, res) => {
    const session = manager.get(req.params.id);
    if (!session) { sendJson(res, 404, { error: "not_found" }); return; }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    sendJson(res, 200, {
      runOptions: manager.getRunOptions(req.params.id),
      mandibleControls: manager.getSessionOptionsControls(req.params.id),
    });
  }, { operation: { id: "get:/api/console/sessions/:id/options", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.patch("/api/console/sessions/:id/options", async (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    if (!requireTerminalMutation(res, session)) return;

    sendJson(res, 422, { error: "terminal_has_no_managed_options", message: "Set provider options on the conversation in Chats." });
  }, { operation: { id: "patch:/api/console/sessions/:id/options", effects: ["ledger:read"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // DELETE /api/console/sessions/:id — stop and delete
  // ------------------------------------------------------------------
  server.delete("/api/console/sessions/:id", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    if (ptySession.meta.is_operator) {
      sendJson(res, 403, { error: "cannot_delete_operator" });
      return;
    }
    if (!requireTerminalMutation(res, ptySession)) return;
    manager.delete(id);
    res.status(200).json({ ok: true });
  }, { operation: { id: "delete:/api/console/sessions/:id", effects: ["process:external"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // POST /api/console/sessions/:id/start — start a stopped session
  // ------------------------------------------------------------------
  server.post("/api/console/sessions/:id/start", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    if (!requireTerminalMutation(res, ptySession)) return;
    if (ptySession.meta.status === "running") {
      sendJson(res, 400, { error: "already_running" });
      return;
    }
    manager.start(id);
    res.status(200).json({ session: ptySession.meta });
  }, { operation: { id: "post:/api/console/sessions/:id/start", effects: ["process:external"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // POST /api/console/sessions/:id/stop — stop a running session
  // ------------------------------------------------------------------
  server.post("/api/console/sessions/:id/stop", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    if (!requireTerminalMutation(res, ptySession)) return;
    if (ptySession.meta.status !== "running") {
      sendJson(res, 400, { error: "not_running" });
      return;
    }
    const body = (req.body ?? {}) as { signal?: string };
    manager.stop(id, typeof body.signal === "string" ? body.signal : undefined);
    res.status(200).json({ session: ptySession.meta });
  }, { operation: { id: "post:/api/console/sessions/:id/stop", effects: ["process:external"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // POST /api/console/sessions/:id/restart — stop + start
  // ------------------------------------------------------------------
  server.post("/api/console/sessions/:id/restart", async (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    if (!requireTerminalMutation(res, ptySession)) return;
    if (ptySession.meta.status === "running") {
      manager.stop(id, "SIGHUP");
    }
    // Clear ring buffer and stream events for fresh start
    ptySession.clear();
    manager.start(id);
    res.status(200).json({ session: ptySession.meta });
  }, { operation: { id: "post:/api/console/sessions/:id/restart", effects: ["process:external"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // GET /api/console/sessions/:id/events — historical stream events
  // ------------------------------------------------------------------
  server.get("/api/console/sessions/:id/events", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    const query = req.query ?? {};
    const limitRaw = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : 500;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 2000)) : 500;
    const events = ptySession.getStreamEvents();
    const sliced = events.length > limit ? events.slice(events.length - limit) : events;
    res.status(200).json({
      events: sliced,
    });
  }, { operation: { id: "get:/api/console/sessions/:id/events", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // GET /api/console/sessions/:id/params — per-message parameter snapshot
  // Bug: 790433d — keyframe lookup: returns the nearest snapshot at or before
  // the requested message_index.
  // ------------------------------------------------------------------
  server.get("/api/console/sessions/:id/params", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    const query = req.query ?? {};
    const messageIndex = typeof query.message_index === "string"
      ? Number.parseInt(query.message_index, 10)
      : null;

    const db = getDb();
    if (messageIndex !== null && Number.isFinite(messageIndex)) {
      // Keyframe lookup: find the most recent snapshot at or before this index
      const row = db.prepare(
        `SELECT * FROM message_params
         WHERE session_id = ? AND message_index <= ?
         ORDER BY message_index DESC
         LIMIT 1`,
      ).get(id, messageIndex);
      res.status(200).json({ params: row ?? null });
    } else {
      // Return all snapshots for this session
      const rows = db.prepare(
        `SELECT * FROM message_params
         WHERE session_id = ?
         ORDER BY message_index ASC`,
      ).all(id);
      res.status(200).json({ params: rows });
    }
  }, { operation: { id: "get:/api/console/sessions/:id/params", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/console/sessions/:id/permissions", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    res.status(200).json({ requests: [] });
  }, { operation: { id: "get:/api/console/sessions/:id/permissions", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.post("/api/console/sessions/:id/permission/:requestId", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    if (!requireTerminalMutation(res, session)) return;

    sendJson(res, 422, { error: "terminal_has_no_permission_protocol" });
  }, { operation: { id: "post:/api/console/sessions/:id/permission/:requestId", effects: ["ledger:read"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  server.get("/api/console/sessions/:id/usage", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    res.status(200).json({ usage: manager.getUsage(id) });
  }, { operation: { id: "get:/api/console/sessions/:id/usage", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // POST /api/console/sessions/:id/resize — resize PTY
  // ------------------------------------------------------------------
  server.post("/api/console/sessions/:id/resize", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    if (!requireTerminalMutation(res, ptySession)) return;
    const body = (req.body ?? {}) as { cols?: unknown; rows?: unknown };
    const cols = typeof body.cols === "number" ? body.cols : NaN;
    const rows = typeof body.rows === "number" ? body.rows : NaN;
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      sendJson(res, 400, { error: "invalid_dimensions" });
      return;
    }
    manager.resize(id, cols, rows);
    res.status(200).json({ ok: true });
  }, { operation: { id: "post:/api/console/sessions/:id/resize", effects: ["process:external"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // GET /api/console/sessions/:id/buffer — ring buffer snapshot
  // ------------------------------------------------------------------
  server.get("/api/console/sessions/:id/buffer", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    const buf = ptySession.getBufferSnapshot();
    res.status(200).json({
      data: buf.toString("base64"),
      bytes: buf.length,
    });
  }, { operation: { id: "get:/api/console/sessions/:id/buffer", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  server.post("/api/console/sessions/:id/prompt", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    if (!requireTerminalMutation(res, session)) return;

    const body = (req.body ?? {}) as { prompt?: unknown };
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      sendJson(res, 400, { error: "missing_prompt" });
      return;
    }

    const prompt = body.prompt.trim();
    try {
      manager.write(id, `${prompt}\r`);
    } catch (error) {
      if (String(error).includes("unsupported_prompt_backend")) {
        sendJson(res, 400, { error: "unsupported_prompt_backend" });
        return;
      }
      if (String(error).includes("pty_prompt_not_running")) {
        sendJson(res, 409, { error: "pty_prompt_not_running" });
        return;
      }
      throw error;
    }

    res.status(202).json({ ok: true });
  }, { operation: { id: "post:/api/console/sessions/:id/prompt", effects: ["process:external"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  server.post("/api/console/sessions/:id/cancel", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    if (!requireTerminalMutation(res, session)) return;

    sendJson(res, 422, { error: "terminal_has_no_managed_turn", message: "Use terminal input to interrupt a shell process." });
  }, { operation: { id: "post:/api/console/sessions/:id/cancel", effects: ["ledger:read"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // GET /api/console/pinned — ordered list of pinned session IDs
  // ------------------------------------------------------------------
  server.get("/api/console/pinned", (req, res) => {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'console_pinned_sessions'")
      .get() as { value: string } | undefined;
    let ids: string[] = [];
    try {
      ids = JSON.parse(row?.value ?? "[]") as string[];
    } catch {
      ids = [];
    }
    const operatorId = db.prepare(
      "SELECT value FROM settings WHERE key = 'console_operator_session_id'",
    ).get()?.value as string | undefined;
    if (operatorId && !isOperatorRequest(req)) {
      ids = ids.filter((id) => id !== operatorId);
    }
    res.status(200).json({ ids });
  }, { operation: { id: "get:/api/console/pinned", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // PUT /api/console/pinned — replace pinned session list
  // ------------------------------------------------------------------
  server.put("/api/console/pinned", (req, res) => {
    const body = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids)) {
      sendJson(res, 400, { error: "missing_ids_array" });
      return;
    }
    const requestedIds = (body.ids as unknown[]).filter((id) => typeof id === "string") as string[];
    const db = getDb();
    const operatorId = db.prepare(
      "SELECT value FROM settings WHERE key = 'console_operator_session_id'",
    ).get()?.value as string | undefined;
    let responseIds = requestedIds;
    let persistedIds = requestedIds;
    if (operatorId && !isOperatorRequest(req)) {
      // Non-operators never see the operator pin. Preserve its current shared
      // membership when they replace their visible list, and do not let them
      // add it by guessing the hidden ID.
      const currentRow = db.prepare(
        "SELECT value FROM settings WHERE key = 'console_pinned_sessions'",
      ).get() as { value: string } | undefined;
      let operatorWasPinned = false;
      try {
        operatorWasPinned = (JSON.parse(currentRow?.value ?? "[]") as unknown[])
          .includes(operatorId);
      } catch {
        operatorWasPinned = false;
      }
      responseIds = requestedIds.filter((id) => id !== operatorId);
      persistedIds = operatorWasPinned ? [...responseIds, operatorId] : responseIds;
    }
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run("console_pinned_sessions", JSON.stringify(persistedIds), Date.now());
    res.status(200).json({ ids: responseIds });
  }, { operation: { id: "put:/api/console/pinned", effects: ["ledger:write"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // GET /api/console/operator — operator session details
  // ------------------------------------------------------------------
  server.get("/api/console/operator", (req, res) => {
    if (!requireOperatorRoute(req, res)) return;
    const operatorSession = manager.operator();
    res.status(200).json({ session: operatorSession?.meta ?? null });
  }, { operation: { id: "get:/api/console/operator", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // ------------------------------------------------------------------
  // POST /api/console/operator/restart — kill and restart operator
  // ------------------------------------------------------------------
  server.post("/api/console/operator/restart", async (req, res) => {
    if (!requireOperatorRoute(req, res)) return;
    const operatorSession = manager.operator();
    if (!operatorSession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    await manager.restart(operatorSession.id);
    res.status(200).json({ session: operatorSession.meta });
  }, { operation: { id: "post:/api/console/operator/restart", effects: ["process:external"], requestSchema: null, reportingCategory: "console" }, fileRpc: "deny" });
}

