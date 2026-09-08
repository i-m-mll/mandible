import type { Db } from "../db.js";
import type { SessionManager } from "../session-manager.js";
import type { ConsoleSession, ConsoleSessionInput } from "../types.js";
import { ConversationSpawnService } from "../conversation-spawn/service.js";
import type { ConversationSpawnError, ConversationSpawnRequest } from "../conversation-spawn/types.js";
import type { RouteRegistrar } from "../server.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import { sendJson } from "./http.js";
import { ProviderStartupError, normalizeProviderStartupError, type ProviderStartupProvenance } from "../provider-startup.js";

export const CONVERSATION_PROVIDER_STARTUP_TIMEOUT_MS = 30_000;

function statusFor(error: ConversationSpawnError): number {
  switch (error.kind) {
    case "not-found": case "project-not-found": case "checkout-not-found": return 404;
    case "spawn-in-progress": case "idempotency-conflict": case "checkout-project-mismatch": return 409;
    default: return 400;
  }
}

function cwdFor(db: Db, request: ConversationSpawnRequest): string {
  const row = db.prepare("SELECT root FROM ledger_project_checkouts WHERE id = ?").get(request.placement.checkout_id) as { root: string };
  return row.root;
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
      : { model: "opus", permission_mode: "bypassPermissions" },
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
    canonical_project_id: request.placement.project_id,
    canonical_checkout_id: request.placement.checkout_id,
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
    if (reserved.value.state === "ready") {
      const session = reserved.value.native_session_id
        ? manager.get(reserved.value.native_session_id)?.meta ?? null
        : null;
      sendJson(res, 200, {
        ok: true,
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
    let nativeSessionId = begun.value.native_session_id;
    let provenance: ProviderStartupProvenance | undefined;
    try {
      if (nativeSessionId === null) {
        const input = sessionInput(db, canonicalRequest);
        const session = manager.create(input);
        nativeSessionId = session.id;
      }
      provenance = manager.getStartupProvenance(nativeSessionId);
      const startup = await manager.startConversation(nativeSessionId, {
        timeoutMs: startupTimeoutMs,
        signal: req.signal,
        provenance,
      });
      provenance = startup.provenance;
      const recorded = spawns.ready(
        reserved.value.reservation_id,
        nativeSessionId,
        startup.provider_session_id,
        {
          kind: startup.provider_session_id ? "native-provider-session" : "provider-transport-ready",
          native_session_id: nativeSessionId,
          provider_session_id: startup.provider_session_id,
          provenance,
        },
      );
      if (!recorded.ok) {
        sendJson(res, statusFor(recorded.error), recorded);
        return;
      }
      const session = manager.get(nativeSessionId)?.meta ?? null;
      sendJson(res, 201, {
        ok: true,
        spawn: recorded.value,
        session: sessionWithPlacement(session, canonicalRequest),
      });
    } catch (error) {
      let typed = normalizeProviderStartupError(error);
      if (nativeSessionId) {
        try {
          manager.delete(nativeSessionId);
        } catch {
          typed = new ProviderStartupError(
            "provider_startup_failed",
            "Provider startup failed and its temporary session cleanup did not complete.",
            typed.phase,
            false,
          );
        }
      }
      const failed = spawns.failed(reserved.value.reservation_id, {
        code: typed.code,
        message: typed.message,
        retryable: typed.retryable,
        phase: typed.phase,
        ...(provenance ? { provenance } : {}),
      });
      if (!req.signal?.aborted) {
        sendJson(res, typed.code === "client_aborted" ? 499 : 502, failed.ok ? {
          ok: false,
          error: failed.value.error,
          spawn: failed.value,
          session: null,
        } : failed);
      }
    }
  }, { authenticated: true }), { fileRpc: "allow" });
}
