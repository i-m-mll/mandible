/**
 * Console session HTTP routes.
 * Bug: e980dd8
 */

import { spawn } from "node:child_process";
import { getDb } from "../db.js";
import { PtyManager } from "../pty-manager.js";
import type { RouteRegistrar } from "../server.js";
import type { ConsoleSession, ConsoleSessionInput, ConsoleInteractionMode, ConsoleStreamEvent } from "../types.js";
import { broadcast } from "../sse.js";

function sendJson(res: { status(c: number): { json(p: unknown): void }; json(p: unknown): void }, code: number, payload: unknown): void {
  res.status(code).json(payload);
}

function extractModelArg(args: string[]): string | null {
  for (let i = args.length - 2; i >= 0; i -= 1) {
    const arg = args[i];
    if ((arg === "--model" || arg === "-m") && typeof args[i + 1] === "string" && args[i + 1].trim()) {
      return args[i + 1].trim();
    }
  }
  return null;
}

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

function makeUserEvent(prompt: string, sessionId: string): ConsoleStreamEvent {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  };
}

function buildPromptInvocation(meta: ConsoleSession, prompt: string, cwd: string): {
  command: string;
  args: string[];
  injectUserEvent: boolean;
  normalize: "claude" | "codex" | "gemini";
} | null {
  const model = extractModelArg(meta.args);

  if (meta.command === "claude") {
    const args = ["-p", prompt, "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"];
    if (meta.provider_session_id) {
      args.splice(2, 0, "--resume", meta.provider_session_id);
    }
    if (model) {
      args.push("--model", model);
    }
    return { command: "claude", args, injectUserEvent: true, normalize: "claude" };
  }

  if (meta.command === "gemini") {
    const args = ["-p", prompt, "--output-format", "stream-json", "-y"];
    if (meta.provider_session_id) {
      args.push("--resume", meta.provider_session_id);
    }
    if (model) {
      args.push("--model", model);
    }
    return { command: "gemini", args, injectUserEvent: false, normalize: "gemini" };
  }

  if (meta.command === "codex") {
    const args = meta.provider_session_id
      ? ["exec", "resume", meta.provider_session_id, prompt]
      : ["exec", prompt];
    args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", cwd);
    if (model) {
      args.push("--model", model);
    }
    return { command: "codex", args, injectUserEvent: true, normalize: "codex" };
  }

  return null;
}

function normalizeGeminiStreamLine(
  line: string,
): ConsoleStreamEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "";
  if (type === "init") {
    return {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  }
  if (type === "message") {
    const role = parsed.role === "assistant" ? "assistant" : "user";
    return {
      type: role,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role,
        content: [{ type: "text", text: typeof parsed.content === "string" ? parsed.content : "" }],
        ...(role === "assistant" && typeof parsed.model === "string" ? { model: parsed.model } : {}),
      },
    };
  }
  if (type === "result") {
    const stats = (parsed.stats && typeof parsed.stats === "object") ? parsed.stats as Record<string, unknown> : {};
    const status = parsed.status === "success" ? "success" : "error_during_execution";
    return {
      type: "result",
      subtype: status,
      session_id: sessionId,
      duration_ms: typeof stats.duration_ms === "number" ? stats.duration_ms : 0,
      num_turns: 1,
      total_cost_usd: 0,
      is_error: status !== "success",
      ...(status !== "success" ? { errors: [typeof parsed.status === "string" ? parsed.status : "Gemini request failed"] } : {}),
    };
  }
  return null;
}

function normalizeCodexStreamLine(
  line: string,
  state: { threadId: string | null; turnCount: number; model: string | null },
): ConsoleStreamEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "thread.started") {
    state.threadId = typeof parsed.thread_id === "string" ? parsed.thread_id : state.threadId;
    return {
      type: "system",
      subtype: "init",
      session_id: state.threadId ?? "",
      ...(state.model ? { model: state.model } : {}),
    };
  }
  if (type === "item.completed") {
    const item = (parsed.item && typeof parsed.item === "object") ? parsed.item as Record<string, unknown> : null;
    if (!item) return null;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "agent_message") {
      return {
        type: "assistant",
        session_id: state.threadId ?? "",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          ...(state.model ? { model: state.model } : {}),
          content: [{ type: "text", text: typeof item.text === "string" ? item.text : "" }],
        },
      };
    }
    return null;
  }
  if (type === "turn.completed") {
    state.turnCount += 1;
    const usage = (parsed.usage && typeof parsed.usage === "object") ? parsed.usage as Record<string, unknown> : {};
    return {
      type: "result",
      subtype: "success",
      session_id: state.threadId ?? "",
      duration_ms: 0,
      num_turns: state.turnCount,
      total_cost_usd: 0,
      is_error: false,
      usage,
    };
  }
  if (type === "error" || type === "turn.failed") {
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null;
    const message =
      typeof parsed.message === "string" ? parsed.message
        : typeof error?.message === "string" ? error.message
          : "Codex request failed";
    return {
      type: "result",
      subtype: "error_during_execution",
      session_id: state.threadId ?? "",
      duration_ms: 0,
      num_turns: state.turnCount,
      total_cost_usd: 0,
      is_error: true,
      errors: [message],
    };
  }
  return null;
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
  // POST /api/console/sessions — create a new session
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
      cwd: typeof body.cwd === "string" ? body.cwd : process.cwd(),
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
    const structuredChat = input.command === "claude" || input.command === "codex" || input.command === "gemini";
    if (input.is_operator || !structuredChat) {
      manager.start(session.id);
    }
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

  server.patch("/api/console/sessions/:id", (req, res) => {
    const id = req.params.id;
    const ptySession = manager.get(id);
    if (!ptySession) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

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
  // This endpoint spawns a separate `claude -p --output-format stream-json`
  // subprocess to capture structured stream events for the rich view, while the
  // PTY session continues providing the terminal view unchanged.
  //
  // Bug: f2e6a46 — use --resume <session_id> instead of --continue. The old
  // --continue flag races with the running PTY process for directory-based session
  // detection. We extract the session_id from prior stream events and use
  // --resume for precise continuation; fall back to no continuation flag if none found.
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
    const invocation = buildPromptInvocation(ptySession.meta, prompt, cwd);
    if (!invocation) {
      sendJson(res, 400, { error: "unsupported_prompt_backend" });
      return;
    }

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

    const existingSessionId = ptySession.meta.provider_session_id ?? ptySession.meta.id;
    if (invocation.injectUserEvent) {
      ptySession.ingestStructuredEvent(makeUserEvent(prompt, existingSessionId));
    }

    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let sawResult = false;
    const codexState = {
      threadId: ptySession.meta.provider_session_id,
      turnCount: 0,
      model: extractModelArg(ptySession.meta.args),
    };

    child.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          if (invocation.normalize === "claude") {
            ptySession.ingestText(line + "\n");
            if (line.includes("\"type\":\"result\"")) {
              sawResult = true;
            }
          } else if (invocation.normalize === "gemini") {
            const event = normalizeGeminiStreamLine(line);
            if (event) {
              if (event.type === "result") {
                sawResult = true;
              }
              ptySession.ingestStructuredEvent(event);
            }
          } else {
            const event = normalizeCodexStreamLine(line, codexState);
            if (event) {
              if (event.type === "result") {
                sawResult = true;
              }
              ptySession.ingestStructuredEvent(event);
              if (codexState.threadId && codexState.threadId !== ptySession.meta.provider_session_id) {
                manager.updateConfig(ptySession.id, { provider_session_id: codexState.threadId });
              }
            }
          }
        }
      }
    });

    let stderrBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on("close", (code) => {
      // Flush any remaining partial line
      if (lineBuffer.trim()) {
        if (invocation.normalize === "claude") {
          ptySession.ingestText(lineBuffer + "\n");
        } else if (invocation.normalize === "gemini") {
          const event = normalizeGeminiStreamLine(lineBuffer);
          if (event) {
            if (event.type === "result") {
              sawResult = true;
            }
            ptySession.ingestStructuredEvent(event);
          }
        } else {
          const event = normalizeCodexStreamLine(lineBuffer, codexState);
          if (event) {
            if (event.type === "result") {
              sawResult = true;
            }
            ptySession.ingestStructuredEvent(event);
          }
        }
      }
      lineBuffer = "";
      // If subprocess failed and produced no stream events, emit a synthetic error
      if (code !== 0 && stderrBuf.trim() && !sawResult) {
        const errMsg = stderrBuf.trim().slice(0, 500);
        ptySession.ingestStructuredEvent({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [errMsg],
          session_id: ptySession.meta.provider_session_id ?? codexState.threadId ?? existingSessionId,
          duration_ms: 0,
          num_turns: 0,
          total_cost_usd: 0,
        });
      }
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
