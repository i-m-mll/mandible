import type { Db } from "../db.js";
import type { SessionManager } from "../session-manager.js";
import type { ConsoleSessionInput } from "../types.js";
import { ConversationSpawnService } from "../conversation-spawn/service.js";
import type { ConversationSpawnError, ConversationSpawnRequest } from "../conversation-spawn/types.js";
import type { RouteRegistrar } from "../server.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import { sendJson } from "./http.js";
import { normalizeProviderStartupError, type ProviderStartupProvenance } from "../provider-startup.js";

export const CONVERSATION_PROVIDER_STARTUP_TIMEOUT_MS = 30_000;

function statusFor(error: ConversationSpawnError): number {
  switch (error.kind) {
    case "not-found": case "project-not-found": case "checkout-not-found": case "topology-target-not-found": return 404;
    case "spawn-in-progress": case "idempotency-conflict": case "checkout-project-mismatch": case "provider-proof-required": return 409;
    default: return 400;
  }
}

function cwdFor(db: Db, request: ConversationSpawnRequest): string {
  if (request.placement.checkout_id === null) return process.cwd();
  const row = db.prepare("SELECT root FROM ledger_project_checkouts WHERE id = ?").get(request.placement.checkout_id) as { root: string };
  return row.root;
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
    const canonicalRequest = reserved.value.request;
    if (reserved.value.state === "delivered") {
      sendJson(res, 200, { ok: true, spawn: reserved.value, session: reserved.value.native_session_id ? manager.get(reserved.value.native_session_id)?.meta ?? null : null });
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
        const command = canonicalRequest.command;
        const input: ConsoleSessionInput = {
          id: reserved.value.reservation_id,
          label: canonicalRequest.label,
          command: command.name,
          args: [], cwd: cwdFor(db, canonicalRequest), env: {}, cols: 120, rows: 30,
          auto_restart: false, is_operator: false, interaction_mode: "both",
          backend_type: command.backend_type, transport_lane: command.transport_lane,
          channel_enabled: command.channel_enabled,
          runOptions: command.run_options,
        };
        const session = manager.create(input);
        nativeSessionId = session.id;
        const recorded = spawns.recordNativeSession(reserved.value.reservation_id, session.id);
        if (!recorded.ok) {
          sendJson(res, statusFor(recorded.error), recorded);
          return;
        }
      }
      provenance = manager.getStartupProvenance(nativeSessionId);
      const startup = await manager.startConversation(nativeSessionId, canonicalRequest.initial_message, {
        timeoutMs: startupTimeoutMs,
        signal: req.signal,
        provenance,
      });
      provenance = startup.provenance;
      const recorded = spawns.recordProviderReceipt(
        reserved.value.reservation_id,
        nativeSessionId,
        startup.provider_session_id,
        {
          kind: "native-provider-session",
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
      const delivered = spawns.delivered(reserved.value.reservation_id, startup.provider_session_id);
      sendJson(res, 201, delivered.ok ? { ok: true, spawn: delivered.value, session } : delivered);
    } catch (error) {
      const typed = normalizeProviderStartupError(error);
      const session = nativeSessionId ? manager.get(nativeSessionId)?.meta ?? null : null;
      const providerSessionId = session?.provider_session_id?.trim() || null;
      if (nativeSessionId) {
        try { manager.stop(nativeSessionId, "SIGTERM"); } catch { /* already terminal */ }
        if (providerSessionId) {
          spawns.recordProviderReceipt(reserved.value.reservation_id, nativeSessionId, providerSessionId, {
            kind: "native-provider-session",
            native_session_id: nativeSessionId,
            provider_session_id: providerSessionId,
            ...(provenance ? { provenance } : {}),
          });
        } else {
          try { manager.delete(nativeSessionId); } catch { /* allocation may have failed before registration */ }
        }
      }
      const failed = spawns.failed(reserved.value.reservation_id, {
        code: typed.code,
        message: typed.message,
        retryable: typed.retryable,
        phase: typed.phase,
        ...(provenance ? { provenance } : {}),
      }, { resetNativeSession: !providerSessionId });
      if (!req.signal?.aborted) {
        sendJson(res, typed.code === "client_aborted" ? 499 : 502, failed.ok ? {
          ok: false,
          error: failed.value.error,
          spawn: failed.value,
          session: providerSessionId ? session : null,
        } : failed);
      }
    }
  }, { authenticated: true }), { fileRpc: "allow" });
}
