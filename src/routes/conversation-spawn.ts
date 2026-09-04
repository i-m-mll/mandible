import type { Db } from "../db.js";
import type { SessionManager } from "../session-manager.js";
import type { ConsoleSessionInput } from "../types.js";
import { ConversationSpawnService } from "../conversation-spawn/service.js";
import type { ConversationSpawnError, ConversationSpawnRequest } from "../conversation-spawn/types.js";
import type { RouteRegistrar } from "../server.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import { sendJson } from "./http.js";

function statusFor(error: ConversationSpawnError): number {
  switch (error.kind) {
    case "not-found": case "project-not-found": case "checkout-not-found": case "topology-target-not-found": return 404;
    case "spawn-in-progress": case "idempotency-conflict": case "checkout-project-mismatch": return 409;
    default: return 400;
  }
}

function cwdFor(db: Db, request: ConversationSpawnRequest): string {
  if (request.placement.checkout_id === null) return process.cwd();
  const row = db.prepare("SELECT root FROM ledger_project_checkouts WHERE id = ?").get(request.placement.checkout_id) as { root: string };
  return row.root;
}

export function registerConversationSpawnRoutes(server: RouteRegistrar, db: Db, manager: SessionManager): void {
  const spawns = new ConversationSpawnService(db);

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
        const recorded = spawns.recordProviderReceipt(reserved.value.reservation_id, session.id, session.provider_session_id, {
          kind: "mandible-console-session-reserved", session_id: session.id,
        });
        if (!recorded.ok) {
          sendJson(res, statusFor(recorded.error), recorded);
          return;
        }
      }
      manager.start(nativeSessionId);
      await manager.waitForInitialRunOptions(nativeSessionId);
      manager.sendPrompt(nativeSessionId, canonicalRequest.initial_message);
      const session = manager.get(nativeSessionId)?.meta ?? null;
      const delivered = spawns.delivered(reserved.value.reservation_id, session?.provider_session_id ?? null);
      sendJson(res, 201, delivered.ok ? { ok: true, spawn: delivered.value, session } : delivered);
    } catch (error) {
      const failed = spawns.failed(reserved.value.reservation_id, {
        code: "provider_spawn_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
      sendJson(res, 502, failed.ok ? { ok: false, error: failed.value.error, spawn: failed.value,
        session: nativeSessionId ? manager.get(nativeSessionId)?.meta ?? null : null } : failed);
    }
  }, { authenticated: true }), { fileRpc: "allow" });
}
