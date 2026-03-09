/**
 * Console session HTTP routes.
 * Bug: e980dd8
 */

import { spawn } from "node:child_process";
import { getDb } from "../db.js";
import { PtyManager } from "../pty-manager.js";
import type { RouteRegistrar } from "../server.js";
import type { ConsoleSessionInput, ConsoleInteractionMode } from "../types.js";

function sendJson(res: { status(c: number): { json(p: unknown): void }; json(p: unknown): void }, code: number, payload: unknown): void {
  res.status(code).json(payload);
}

export function registerConsoleRoutes(
  server: RouteRegistrar,
  manager: PtyManager
): void {

  // ------------------------------------------------------------------
  // GET /api/console/sessions — list all sessions
  // ------------------------------------------------------------------
  server.get("/api/console/sessions", (_req, res) => {
    const sessions = manager.getAll().map((s) => s.meta);
    res.status(200).json({ sessions });
  });

  // ------------------------------------------------------------------
  // POST /api/console/sessions — create and start a new session
  // ------------------------------------------------------------------
  server.post("/api/console/sessions", (req, res) => {
    const body = (req.body ?? {}) as Partial<ConsoleSessionInput & { interaction_mode?: string }>;

    if (!body.label || typeof body.label !== "string") {
      sendJson(res, 400, { error: "missing_label" });
      return;
    }
    if (!body.command || typeof body.command !== "string") {
      sendJson(res, 400, { error: "missing_command" });
      return;
    }

    const input: ConsoleSessionInput = {
      label: body.label,
      command: body.command,
      args: Array.isArray(body.args) ? body.args as string[] : [],
      cwd: typeof body.cwd === "string" ? body.cwd : (process.env.HOME ?? null),
      env: body.env && typeof body.env === "object" ? body.env as Record<string, string> : {},
      cols: typeof body.cols === "number" ? body.cols : 120,
      rows: typeof body.rows === "number" ? body.rows : 30,
      auto_restart: body.auto_restart === true,
      is_operator: body.is_operator === true,
      interaction_mode: (["inbox_only", "direct", "both"].includes(body.interaction_mode ?? ""))
        ? body.interaction_mode as ConsoleInteractionMode
        : "both",
    };

    const session = manager.create(input);
    manager.start(session.id);
    // Refresh meta after start
    const ptySession = manager.get(session.id);
    res.status(201).json({ session: ptySession?.meta ?? session });
  });

  // ------------------------------------------------------------------
  // GET /api/console/sessions/:id — single session
  // ------------------------------------------------------------------
  server.get("/api/console/sessions/:id", (req, res) => {
    const ptySession = manager.get(req.params.id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    res.status(200).json({ session: ptySession.meta });
  });

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
    if (ptySession.meta.is_operator) {
      sendJson(res, 403, { error: "cannot_delete_operator" });
      return;
    }
    manager.delete(id);
    res.status(200).json({ ok: true });
  });

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
    if (ptySession.meta.status === "running") {
      sendJson(res, 400, { error: "already_running" });
      return;
    }
    manager.start(id);
    res.status(200).json({ session: ptySession.meta });
  });

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
    if (ptySession.meta.status !== "running") {
      sendJson(res, 400, { error: "not_running" });
      return;
    }
    const body = (req.body ?? {}) as { signal?: string };
    manager.stop(id, typeof body.signal === "string" ? body.signal : undefined);
    res.status(200).json({ session: ptySession.meta });
  });

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
    if (ptySession.meta.status === "running") {
      manager.stop(id, "SIGHUP");
    }
    // Clear ring buffer and stream events for fresh start
    ptySession.clear();
    manager.start(id);
    res.status(200).json({ session: ptySession.meta });
  });

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
    const query = req.query ?? {};
    const limitRaw = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : 500;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 2000)) : 500;
    const events = ptySession.getStreamEvents();
    const sliced = events.length > limit ? events.slice(events.length - limit) : events;
    res.status(200).json({
      events: sliced,
    });
  });

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
    const body = (req.body ?? {}) as { cols?: unknown; rows?: unknown };
    const cols = typeof body.cols === "number" ? body.cols : NaN;
    const rows = typeof body.rows === "number" ? body.rows : NaN;
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      sendJson(res, 400, { error: "invalid_dimensions" });
      return;
    }
    manager.resize(id, cols, rows);
    res.status(200).json({ ok: true });
  });

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
    const buf = ptySession.getBufferSnapshot();
    res.status(200).json({
      data: buf.toString("base64"),
      bytes: buf.length,
    });
  });

  // ------------------------------------------------------------------
  // POST /api/console/sessions/:id/prompt — send a prompt via non-PTY subprocess
  //
  // Bug: a97f54b — --output-format stream-json only works with -p (non-interactive).
  // The PTY session runs Claude in full TUI mode and emits no JSON to stdout.
  // This endpoint spawns a separate `claude -p --continue --output-format stream-json`
  // subprocess to capture structured stream events for the rich view, while the
  // PTY session continues providing the terminal view unchanged.
  //
  // The subprocess stdout is fed through PtySession.ingestText() which runs the
  // same line parser and broadcasts console:stream_event via SSE.
  //
  // Returns 202 immediately; events arrive asynchronously via SSE.
  // ------------------------------------------------------------------
  server.post("/api/console/sessions/:id/prompt", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const body = (req.body ?? {}) as { prompt?: unknown };
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      sendJson(res, 400, { error: "missing_prompt" });
      return;
    }

    const prompt = body.prompt.trim();
    const cwd = ptySession.meta.cwd ?? process.env.HOME ?? "/tmp";

    // Clean env: strip agent signing keys just like buildPtyEnv does for PTY
    const POLLUTED_EXACT = new Set(["CLAUDECODE", "GIT_CONFIG_COUNT"]);
    const POLLUTED_PREFIX = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (POLLUTED_EXACT.has(k)) continue;
      if (POLLUTED_PREFIX.some((p) => k.startsWith(p))) continue;
      env[k] = v;
    }
    // Merge session-level env overrides
    Object.assign(env, ptySession.meta.env ?? {});

    // Spawn non-PTY subprocess: claude -p --continue --output-format stream-json
    const child = spawn(
      ptySession.meta.command === "claude" ? ptySession.meta.command : "claude",
      ["-p", prompt, "--continue", "--output-format", "stream-json", "--dangerously-skip-permissions"],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] }
    );

    let lineBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          ptySession.ingestText(line + "\n");
        }
      }
    });

    // stderr is discarded (Claude's TUI diagnostics are not stream-json)
    child.stderr.on("data", () => {});

    child.on("close", () => {
      // Flush any remaining partial line
      if (lineBuffer.trim()) {
        ptySession.ingestText(lineBuffer + "\n");
      }
      lineBuffer = "";
    });

    child.on("error", () => {
      // Best-effort: subprocess failed (e.g. claude not in PATH). Nothing to emit.
    });

    // Respond immediately; events arrive via SSE
    res.status(202).json({ ok: true });
  });

  // ------------------------------------------------------------------
  // GET /api/console/pinned — ordered list of pinned session IDs
  // ------------------------------------------------------------------
  server.get("/api/console/pinned", (_req, res) => {
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
    res.status(200).json({ ids });
  });

  // ------------------------------------------------------------------
  // PUT /api/console/pinned — replace pinned session list
  // ------------------------------------------------------------------
  server.put("/api/console/pinned", (req, res) => {
    const body = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids)) {
      sendJson(res, 400, { error: "missing_ids_array" });
      return;
    }
    const ids = (body.ids as unknown[]).filter((id) => typeof id === "string") as string[];
    const db = getDb();
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run("console_pinned_sessions", JSON.stringify(ids), Date.now());
    res.status(200).json({ ids });
  });

  // ------------------------------------------------------------------
  // GET /api/console/operator — operator session details
  // ------------------------------------------------------------------
  server.get("/api/console/operator", (_req, res) => {
    const operatorSession = manager.getAll().find((s) => s.meta.is_operator);
    res.status(200).json({ session: operatorSession?.meta ?? null });
  });

  // ------------------------------------------------------------------
  // POST /api/console/operator/restart — kill and restart operator
  // ------------------------------------------------------------------
  server.post("/api/console/operator/restart", (_req, res) => {
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
  });
}
