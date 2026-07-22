/**
 * Console session HTTP routes.
 * Bug: e980dd8
 */

import { getDb } from "../db.js";
import { AttributionReadResolver } from "../identity/read-projection.js";
import type { PermissionDecision } from "../agentic-backend.js";
import { SessionManager } from "../session-manager.js";
import { SDKBackend, type SDKBackendOptions } from "../backends/sdk-backend.js";
import { AcpBackend } from "../backends/acp-backend.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import type {
  ConsoleInteractionMode,
  ConsoleSession,
  ConsoleSessionInput,
  ConsoleTransportLane,
} from "../types.js";
import { sendJson } from "./http.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import {
  ClientAuthzError,
  requireOperator,
} from "../client-auth/authz.js";

const SDK_THINKING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SDK_PERMISSION_MODES = new Set(["default", "acceptEdits", "bypassPermissions"]);

function stripModelArgs(args: string[]): string[] {
  const next: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--model" || args[i] === "-m") {
      i += 1;
      continue;
    }
    next.push(args[i]);
  }
  return next;
}

function parseTransportLane(value: unknown): ConsoleTransportLane | undefined {
  return value === "sdk"
    || value === "pty"
    || value === "channel"
    || value === "acp"
    || value === "spawn"
    ? value
    : undefined;
}

function parseStringArray(value: unknown): { ok: true; value: string[] } | { ok: false } | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return { ok: false };
  }
  return { ok: true, value };
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseSessionOptionsBody(
  backendType: ConsoleSession["backend_type"],
  body: unknown,
): { ok: true; options: SDKBackendOptions } | { ok: false; error: string } {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const options: SDKBackendOptions = {};

  if (typeof record.model === "string") {
    options.model = record.model;
  } else if (record.model !== undefined) {
    return { ok: false, error: "invalid_model" };
  }

  const allowedTools = parseStringArray(record.allowedTools);
  if (allowedTools?.ok) {
    options.allowedTools = allowedTools.value;
  } else if (allowedTools !== undefined) {
    return { ok: false, error: "invalid_allowed_tools" };
  }

  const presetIds = parseStringArray(record.presetIds);
  if (presetIds?.ok) {
    options.presetIds = presetIds.value;
  } else if (presetIds !== undefined) {
    return { ok: false, error: "invalid_preset_ids" };
  }

  if (backendType === "sdk") {
    if (record.thinkingEffort !== undefined) {
      if (typeof record.thinkingEffort !== "string" || !SDK_THINKING_EFFORTS.has(record.thinkingEffort)) {
        return { ok: false, error: "invalid_thinking_effort" };
      }
      options.thinkingEffort = record.thinkingEffort as SDKBackendOptions["thinkingEffort"];
    }

    if (record.permissionMode !== undefined) {
      if (typeof record.permissionMode !== "string" || !SDK_PERMISSION_MODES.has(record.permissionMode)) {
        return { ok: false, error: "invalid_permission_mode" };
      }
      options.permissionMode = record.permissionMode as SDKBackendOptions["permissionMode"];
    }

    const maxTurns = parsePositiveInteger(record.maxTurns);
    if (maxTurns !== undefined) {
      options.maxTurns = maxTurns;
    } else if (record.maxTurns !== undefined) {
      return { ok: false, error: "invalid_max_turns" };
    }

    const maxCostUsd = parseNonNegativeNumber(record.maxCostUsd);
    if (maxCostUsd !== undefined) {
      options.maxCostUsd = maxCostUsd;
    } else if (record.maxCostUsd !== undefined) {
      return { ok: false, error: "invalid_max_cost_usd" };
    }

    if (typeof record.systemPrompt === "string") {
      options.systemPrompt = record.systemPrompt;
    } else if (record.systemPrompt !== undefined) {
      return { ok: false, error: "invalid_system_prompt" };
    }

    const settingSourcesOverride = parseStringArray(record.settingSourcesOverride);
    if (settingSourcesOverride?.ok) {
      options.settingSourcesOverride = settingSourcesOverride.value;
    } else if (settingSourcesOverride !== undefined) {
      return { ok: false, error: "invalid_setting_sources" };
    }
  } else {
    const sdkOnlyKeys = [
      "thinkingEffort",
      "permissionMode",
      "maxTurns",
      "maxCostUsd",
      "systemPrompt",
      "settingSourcesOverride",
      "presetIds",
    ];
    if (sdkOnlyKeys.some((key) => record[key] !== undefined)) {
      return { ok: false, error: "unsupported_session_option" };
    }
  }

  return { ok: true, options };
}

// Bug: 81c9d85 — enrich ConsoleSession with is_processing from SDKBackend state
function enrichWithProcessing(backend: { meta: ConsoleSession }): ConsoleSession {
  const meta = backend.meta;
  if (backend instanceof SDKBackend) {
    return { ...meta, is_processing: backend.isProcessing };
  }
  if (backend instanceof AcpBackend) {
    return { ...meta, is_processing: backend.isProcessing };
  }
  return { ...meta, is_processing: false };
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

export function registerConsoleRoutes(
  server: RouteRegistrar,
  manager: SessionManager
): void {

  // ------------------------------------------------------------------
  // GET /api/console/sessions — list all sessions
  // ------------------------------------------------------------------
  server.get("/api/console/sessions", (req, res) => {
    const attributionResolver = new AttributionReadResolver(getDb());
    const sessions = manager.getAll()
      .filter((session) => (
        !sessionIsCredentialBearing(manager, session) || isOperatorRequest(req)
      ))
      .map((s) => {
        const session = enrichWithProcessing(s);
        return {
          ...session,
          owner: session.owner ?? attributionResolver.user(session.owner_user_id),
        };
      });
    res.status(200).json({ sessions });
  }, { fileRpc: "deny" });

  // ------------------------------------------------------------------
  // POST /api/console/sessions — create a new session
  // ------------------------------------------------------------------
  server.post("/api/console/sessions", globalCapabilityRoute("spawn_console", (req, res) => {
    const body = (req.body ?? {}) as Partial<ConsoleSessionInput & { interaction_mode?: string }>;

    if (!body.label || typeof body.label !== "string") {
      sendJson(res, 400, { error: "missing_label" });
      return;
    }
    if (!body.command || typeof body.command !== "string") {
      sendJson(res, 400, { error: "missing_command" });
      return;
    }
    // Issue 708dc4c — operator-session identity is an internal daemon role,
    // never a caller-selectable console flag. Otherwise an anonymous compat
    // caller or ordinary strict identity could make the spawner inject the
    // operator credential into an arbitrary child process.
    if (body.is_operator === true) {
      sendJson(res, 403, { error: "operator_session_reserved" });
      return;
    }
    const input: ConsoleSessionInput = {
      label: body.label,
      command: body.command,
      args: Array.isArray(body.args) ? body.args as string[] : [],
      cwd: typeof body.cwd === "string" ? body.cwd : process.cwd(),
      env: body.env && typeof body.env === "object" ? body.env as Record<string, string> : {},
      cols: typeof body.cols === "number" ? body.cols : 120,
      rows: typeof body.rows === "number" ? body.rows : 30,
      auto_restart: body.auto_restart === true,
      is_operator: false,
      interaction_mode: (["inbox_only", "direct", "both"].includes(body.interaction_mode ?? ""))
        ? body.interaction_mode as ConsoleInteractionMode
        : "both",
      backend_type: body.backend_type === "pty"
        || body.backend_type === "sdk"
        || body.backend_type === "spawn"
        || body.backend_type === "acp"
        ? body.backend_type
        : (body.command === "claude" ? "pty" : (body.command === "gemini" || body.command === "codex") ? "acp" : "spawn"),
      transport_lane: parseTransportLane((body as Record<string, unknown>).transport_lane),
      // Bug: b5aba0e — channel-enabled PTY: launch with MCP channel server connectivity
      channel_enabled: (body as Record<string, unknown>).channel_enabled === true,
      // Bug: 61bee4e — Accept presetIds for convention presets
      presetIds: Array.isArray((body as Record<string, unknown>).presetIds)
        ? ((body as Record<string, unknown>).presetIds as unknown[]).filter(
            (id): id is string => typeof id === "string",
          )
        : undefined,
    };

    const session = manager.create(input);
    const structuredChat = input.command === "claude" || input.command === "codex" || input.command === "gemini";
    // Start immediately for: operators, non-structured-chat (shell), and structured
    // sessions (they just wait for the first prompt — no process to allocate).
    if (input.is_operator || !structuredChat || input.backend_type === "sdk" || input.backend_type === "spawn" || input.backend_type === "acp") {
      manager.start(session.id);
    }
    const ptySession = manager.get(session.id);
    res.status(201).json({ session: ptySession?.meta ?? session });
  }, { authenticated: true }), { fileRpc: "deny" });

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
  }, { fileRpc: "deny" });

  server.patch("/api/console/sessions/:id", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;

    const body = (req.body ?? {}) as { model?: unknown; label?: unknown };
    const patch: Partial<Pick<ConsoleSession, "label" | "args">> = {};
    if (typeof body.label === "string" && body.label.trim()) {
      patch.label = body.label.trim();
    }
    if (typeof body.model === "string") {
      const nextArgs = stripModelArgs(ptySession.meta.args);
      const model = body.model.trim();
      if (model) {
        nextArgs.push("--model", model);
      }
      patch.args = nextArgs;
    }

    const session = manager.updateConfig(id, patch);
    res.status(200).json({ session });
  }, { fileRpc: "deny" });

  server.patch("/api/console/sessions/:id/options", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;

    const parsed = parseSessionOptionsBody(session.meta.backend_type, req.body ?? {});
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    const body = parsed.options;

    const nextSession = manager.updateOptions(id, body);
    res.status(200).json({ session: nextSession });
  }, { fileRpc: "deny" });

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
    manager.delete(id);
    res.status(200).json({ ok: true });
  }, { fileRpc: "deny" });

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
    if (ptySession.meta.status === "running") {
      sendJson(res, 400, { error: "already_running" });
      return;
    }
    manager.start(id);
    res.status(200).json({ session: ptySession.meta });
  }, { fileRpc: "deny" });

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
    if (ptySession.meta.status !== "running") {
      sendJson(res, 400, { error: "not_running" });
      return;
    }
    const body = (req.body ?? {}) as { signal?: string };
    manager.stop(id, typeof body.signal === "string" ? body.signal : undefined);
    res.status(200).json({ session: ptySession.meta });
  }, { fileRpc: "deny" });

  // ------------------------------------------------------------------
  // POST /api/console/sessions/:id/restart — stop + start
  // ------------------------------------------------------------------
  server.post("/api/console/sessions/:id/restart", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, ptySession)) return;
    if (ptySession.meta.status === "running") {
      manager.stop(id, "SIGHUP");
    }
    // Clear ring buffer and stream events for fresh start
    ptySession.clear();
    manager.start(id);
    res.status(200).json({ session: ptySession.meta });
  }, { fileRpc: "deny" });

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
  }, { fileRpc: "deny" });

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
  }, { fileRpc: "deny" });

  server.get("/api/console/sessions/:id/permissions", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    res.status(200).json({ requests: manager.getPermissions(id) });
  }, { fileRpc: "deny" });

  server.post("/api/console/sessions/:id/permission/:requestId", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;

    const decision = (req.body ?? {}) as { decision?: unknown };
    if (!isPermissionDecision(decision.decision)) {
      sendJson(res, 400, { error: "invalid_decision" });
      return;
    }

    const resolved = manager.resolvePermission(
      id,
      req.params.requestId,
      decision.decision as PermissionDecision,
    );
    if (!resolved) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    res.status(200).json({ ok: true });
  }, { fileRpc: "deny" });

  server.get("/api/console/sessions/:id/usage", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;
    res.status(200).json({ usage: manager.getUsage(id) });
  }, { fileRpc: "deny" });

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
    const body = (req.body ?? {}) as { cols?: unknown; rows?: unknown };
    const cols = typeof body.cols === "number" ? body.cols : NaN;
    const rows = typeof body.rows === "number" ? body.rows : NaN;
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      sendJson(res, 400, { error: "invalid_dimensions" });
      return;
    }
    manager.resize(id, cols, rows);
    res.status(200).json({ ok: true });
  }, { fileRpc: "deny" });

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
  }, { fileRpc: "deny" });

  // ------------------------------------------------------------------
  server.post("/api/console/sessions/:id/prompt", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;

    const body = (req.body ?? {}) as { prompt?: unknown };
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      sendJson(res, 400, { error: "missing_prompt" });
      return;
    }

    const prompt = body.prompt.trim();
    try {
      manager.sendPrompt(id, prompt);
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
  }, { fileRpc: "deny" });

  server.post("/api/console/sessions/:id/cancel", (req, res) => {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!requireManagedSessionAccess(req, res, manager, session)) return;

    const cancelled = manager.cancelPrompt(id);
    if (!cancelled) {
      sendJson(res, 409, { error: "cancel_not_supported_or_idle" });
      return;
    }

    res.status(202).json({ ok: true });
  }, { fileRpc: "deny" });

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
    ).pluck().get() as string | undefined;
    if (operatorId && !isOperatorRequest(req)) {
      ids = ids.filter((id) => id !== operatorId);
    }
    res.status(200).json({ ids });
  }, { fileRpc: "deny" });

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
    ).pluck().get() as string | undefined;
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
  }, { fileRpc: "deny" });

  // ------------------------------------------------------------------
  // GET /api/console/operator — operator session details
  // ------------------------------------------------------------------
  server.get("/api/console/operator", (req, res) => {
    if (!requireOperatorRoute(req, res)) return;
    const operatorSession = manager.getAll().find((s) => s.meta.is_operator);
    res.status(200).json({ session: operatorSession?.meta ?? null });
  }, { fileRpc: "deny" });

  // ------------------------------------------------------------------
  // POST /api/console/operator/restart — kill and restart operator
  // ------------------------------------------------------------------
  server.post("/api/console/operator/restart", (req, res) => {
    if (!requireOperatorRoute(req, res)) return;
    const operatorSession = manager.getAll().find((s) => s.meta.is_operator);
    if (!operatorSession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (operatorSession.meta.status === "running") {
      manager.stop(operatorSession.id, "SIGHUP");
    }
    manager.start(operatorSession.id);
    res.status(200).json({ session: operatorSession.meta });
  }, { fileRpc: "deny" });
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return (
    value === "deny" ||
    value === "allow" ||
    value === "allow_always" ||
    value === "reject_once" ||
    value === "reject_always" ||
    (typeof value === "string" && /^option:[0-9A-Za-z_-]+$/.test(value))
  );
}
