import fs from "node:fs";
import type { Db } from "../db.js";
import type { SessionManager } from "../session-manager.js";
import type { ConsoleSession, ConsoleSessionInput } from "../types.js";
import { ConversationSpawnService } from "../conversation-spawn/service.js";
import type { ConversationSpawnError, ConversationSpawnRequest } from "../conversation-spawn/types.js";
import type { RouteRegistrar } from "../server.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import { sendJson } from "./http.js";
import { ProviderStartupError, normalizeProviderStartupError, type ProviderStartupProvenance } from "../provider-startup.js";
import { getMandibleHomePath } from "../platform-paths.js";
import { broadcast } from "../sse.js";

export const CONVERSATION_PROVIDER_STARTUP_TIMEOUT_MS = 30_000;

function statusFor(error: ConversationSpawnError): number {
  switch (error.kind) {
    case "not-found": case "project-not-found": case "checkout-not-found": return 404;
    case "spawn-in-progress": case "stale-generation": case "idempotency-conflict": case "checkout-project-mismatch": return 409;
    default: return 400;
  }
}

function cwdFor(db: Db, request: ConversationSpawnRequest): string {
  if (request.placement.kind === "project") {
    const row = db.prepare("SELECT root FROM ledger_project_checkouts WHERE id = ?")
      .get(request.placement.checkout_id) as { root: string };
    return row.root;
  }
  const root = getMandibleHomePath("chats", "workspace");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function sessionInput(db: Db, request: ConversationSpawnRequest): ConsoleSessionInput {
  const codex = request.provider === "codex";
  return {
    id: request.idempotency_key,
    label: codex ? "New Codex chat" : "New Claude chat",
    command: codex ? "codex" : "claude",
    args: [],
    cwd: cwdFor(db, request),
    env: {},
    cols: 120,
    rows: 30,
    auto_restart: false,
    is_operator: false,
    interaction_mode: "both",
    backend_type: codex ? "acp" : "sdk",
    transport_lane: codex ? "acp" : "sdk",
    channel_enabled: false,
    runOptions: codex
      ? { model: "gpt-5.6-sol", mode: "agent-full-access" }
      : { model: "claude-opus-5", permission_mode: "bypassPermissions" },
  };
}

function sessionWithPlacement(
  session: ConsoleSession | null,
  request: ConversationSpawnRequest,
): (ConsoleSession & {
  canonical_project_id: string | null;
  canonical_checkout_id: string | null;
}) | null {
  return session ? {
    ...session,
    canonical_project_id: request.placement.kind === "project" ? request.placement.project_id : null,
    canonical_checkout_id: request.placement.kind === "project" ? request.placement.checkout_id : null,
  } : null;
}

export function registerConversationSpawnRoutes(
  server: RouteRegistrar,
  db: Db,
  manager: SessionManager,
  options: { startupTimeoutMs?: number } = {},
): void {
  const spawns = new ConversationSpawnService(db);
  const startupTimeoutMs = options.startupTimeoutMs ?? CONVERSATION_PROVIDER_STARTUP_TIMEOUT_MS;
  const attempts = new Map<string, { generation: number; controller: AbortController; nativeSessionId: string | null }>();

  const publish = (reservationId: string) => {
    const result = spawns.get(reservationId);
    if (result.ok) broadcast("conversation-spawn:updated", { spawn: result.value });
    return result;
  };

  const runAttempt = async (request: ConversationSpawnRequest, generation: number): Promise<void> => {
    const reservationId = request.idempotency_key;
    const controller = new AbortController();
    const attempt = { generation, controller, nativeSessionId: null as string | null };
    attempts.set(reservationId, attempt);
    let provenance: ProviderStartupProvenance | undefined;
    try {
      const session = manager.create(sessionInput(db, request));
      attempt.nativeSessionId = session.id;
      const assigned = spawns.assignRuntime(reservationId, generation, session.id);
      if (!assigned.ok) return;
      publish(reservationId);
      provenance = manager.getStartupProvenance(session.id);
      const startup = await manager.startConversation(session.id, {
        timeoutMs: startupTimeoutMs,
        signal: controller.signal,
        provenance,
      });
      if (controller.signal.aborted) return;
      provenance = startup.provenance;
      spawns.observeProviderSession(session.id, startup.provider_session_id ?? "");
      spawns.ready(reservationId, generation, session.id, startup.provider_session_id, {
        kind: startup.provider_session_id ? "native-provider-session" : "provider-transport-ready",
        native_session_id: session.id,
        provider_session_id: startup.provider_session_id,
        provenance,
      });
      publish(reservationId);
    } catch (error) {
      if (controller.signal.aborted) return;
      let typed = normalizeProviderStartupError(error);
      if (attempt.nativeSessionId) {
        try {
          manager.delete(attempt.nativeSessionId);
        } catch {
          typed = new ProviderStartupError(
            "provider_startup_failed",
            "Provider startup failed and its temporary session cleanup did not complete.",
            typed.phase,
            false,
          );
        }
      }
      spawns.failed(reservationId, generation, {
        code: typed.code,
        message: typed.message,
        retryable: typed.retryable,
        phase: typed.phase,
        ...(provenance ? { provenance } : {}),
      });
      publish(reservationId);
    } finally {
      if (attempts.get(reservationId) === attempt) attempts.delete(reservationId);
    }
  };

  server.get("/api/conversation-spawns", (_req, res) => {
    sendJson(res, 200, { spawns: spawns.listCurrent() });
  }, { fileRpc: "allow" });

  server.get("/api/conversation-spawns/:id", (req, res) => {
    const result = spawns.get(req.params.id);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }, { fileRpc: "allow" });

  server.post("/api/conversation-spawns", globalCapabilityRoute("spawn_console", async (req, res) => {
    const request = req.body as ConversationSpawnRequest;
    const reserved = spawns.reserve(request);
    if (!reserved.ok) {
      sendJson(res, statusFor(reserved.error), reserved);
      return;
    }
    const canonicalRequest = reserved.value.request as ConversationSpawnRequest;
    if (reserved.value.state !== "reserved") {
      const session = reserved.value.native_session_id
        ? manager.get(reserved.value.native_session_id)?.meta ?? null
        : null;
      const terminalFailure = reserved.value.state === "failed" || reserved.value.state === "cancelled";
      sendJson(res, terminalFailure ? 409 : reserved.value.state === "starting" || reserved.value.state === "stopping" ? 202 : 200, {
        ok: !terminalFailure,
        ...(terminalFailure ? { error: reserved.value.error } : {}),
        spawn: reserved.value,
        session: sessionWithPlacement(session, canonicalRequest),
      });
      return;
    }
    const begun = spawns.begin(reserved.value.reservation_id);
    if (!begun.ok) {
      sendJson(res, statusFor(begun.error), begun);
      return;
    }
    publish(reserved.value.reservation_id);
    void runAttempt(canonicalRequest, begun.value.attempt_count);
    const current = spawns.get(reserved.value.reservation_id);
    const currentSpawn = current.ok ? current.value : begun.value;
    const session = currentSpawn.native_session_id
      ? manager.get(currentSpawn.native_session_id)?.meta ?? null
      : null;
    sendJson(res, 202, {
      ok: true,
      spawn: currentSpawn,
      session: sessionWithPlacement(session, canonicalRequest),
    });
  }, { authenticated: true }), { fileRpc: "allow" });

  server.post("/api/conversation-spawns/:id/retry", globalCapabilityRoute("spawn_console", async (req, res) => {
    const expectedGeneration = Number((req.body as { expected_generation?: unknown })?.expected_generation);
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
      sendJson(res, 400, { error: "invalid_expected_generation" });
      return;
    }
    const begun = spawns.begin(req.params.id, expectedGeneration);
    if (!begun.ok) {
      sendJson(res, statusFor(begun.error), begun);
      return;
    }
    const request = begun.value.request as ConversationSpawnRequest;
    publish(req.params.id);
    void runAttempt(request, begun.value.attempt_count);
    const current = spawns.get(req.params.id);
    const currentSpawn = current.ok ? current.value : begun.value;
    const session = currentSpawn.native_session_id
      ? manager.get(currentSpawn.native_session_id)?.meta ?? null
      : null;
    sendJson(res, 202, { ok: true, spawn: currentSpawn, session: sessionWithPlacement(session, request) });
  }, { authenticated: true }), { fileRpc: "allow" });

  server.delete("/api/conversation-spawns/:id", globalCapabilityRoute("spawn_console", async (req, res) => {
    const expectedGeneration = Number((req.body as { expected_generation?: unknown })?.expected_generation);
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
      sendJson(res, 400, { error: "invalid_expected_generation" });
      return;
    }
    const stopping = spawns.stopping(req.params.id, expectedGeneration);
    if (!stopping.ok) {
      sendJson(res, statusFor(stopping.error), stopping);
      return;
    }
    publish(req.params.id);
    const attempt = attempts.get(req.params.id);
    if (attempt?.generation === expectedGeneration) {
      attempt.controller.abort(new ProviderStartupError(
        "client_aborted",
        "Chat creation was cancelled.",
        "readiness",
      ));
      if (attempt.nativeSessionId) {
        try {
          manager.delete(attempt.nativeSessionId);
        } catch {
          const failed = spawns.failed(req.params.id, expectedGeneration, {
            code: "provider_startup_failed",
            message: "Chat cancellation could not stop its provider runtime.",
            retryable: false,
          });
          publish(req.params.id);
          sendJson(res, 502, failed.ok ? { ok: false, error: failed.value.error, spawn: failed.value } : failed);
          return;
        }
      }
    }
    const cancelled = spawns.cancelled(req.params.id, expectedGeneration);
    publish(req.params.id);
    sendJson(res, cancelled.ok ? 200 : statusFor(cancelled.error), cancelled);
  }, { authenticated: true }), { fileRpc: "allow" });
}
