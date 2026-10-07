import { DEFAULT_CLAUDE_CODE_MODEL } from "../provider-run-option-catalog.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import fs from "node:fs";
import type { Db } from "../db.js";
import type { ConversationControlService, NewConversationControllerLease } from "../conversation-control/service.js";
import { ConversationSpawnService } from "../conversation-spawn/service.js";
import type { ConversationSpawnError, ConversationSpawnRequest } from "../conversation-spawn/types.js";
import type { RouteRegistrar } from "../server.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import { sendJson } from "./http.js";
import { ProviderStartupError, normalizeProviderStartupError } from "../provider-startup.js";
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

function runtimeOptions(request: ConversationSpawnRequest) {
  return request.provider === "codex"
    ? { model: "gpt-5.6-sol", permission_mode: "agent-full-access" as const }
    : { model: DEFAULT_CLAUDE_CODE_MODEL, permission_mode: "bypassPermissions" as const };
}

export function registerConversationSpawnRoutes(
  server: RouteRegistrar,
  db: Db,
  control: ConversationControlService,
  options: { startupTimeoutMs?: number } = {},
): void {
  const spawns = new ConversationSpawnService(db);
  const startupTimeoutMs = options.startupTimeoutMs ?? CONVERSATION_PROVIDER_STARTUP_TIMEOUT_MS;
  const attempts = new Map<string, { generation: number; controller: AbortController }>();

  const publish = (reservationId: string) => {
    const result = spawns.get(reservationId);
    if (result.ok) broadcast(DOMAIN_EVENTS.CONVERSATION_SPAWN_UPDATED, { spawn: result.value });
    return result;
  };

  const runAttempt = async (request: ConversationSpawnRequest, generation: number): Promise<void> => {
    const reservationId = request.idempotency_key;
    const controller = new AbortController();
    const attempt = { generation, controller };
    attempts.set(reservationId, attempt);
    const timeout = setTimeout(() => controller.abort(new ProviderStartupError(
      "provider_startup_timeout",
      `Provider startup exceeded ${startupTimeoutMs}ms.`,
      "readiness",
    )), startupTimeoutMs);
    timeout.unref();
    try {
      const cwd = cwdFor(db, request);
      const acquired = await control.acquireNew({
        conversation_id: reservationId,
        provider: request.provider,
        generation,
        cwd,
        runtime_options: runtimeOptions(request),
        signal: controller.signal,
      }, (lease: NewConversationControllerLease) => {
        const assigned = spawns.assignRuntime(reservationId, generation, lease.controller_instance_id);
        if (!assigned.ok) throw new Error(JSON.stringify(assigned.error));
        const materialized = spawns.materializeConversationShell(
          reservationId,
          generation,
          cwd,
          lease.provider_session_id,
        );
        if (!materialized.ok) throw new Error(JSON.stringify(materialized.error));
        const ready = spawns.ready(reservationId, generation, lease.controller_instance_id, lease.provider_session_id, {
          kind: lease.provider_session_id ? "native-conversation-controller-ready" : "controller-ready-awaiting-native-identity",
          adapter_id: lease.adapter_id,
          controller_instance_id: lease.controller_instance_id,
          provider_session_id: lease.provider_session_id,
        });
        if (!ready.ok) throw new Error(JSON.stringify(ready.error));
      });
      if (!acquired.ok) {
        if (controller.signal.aborted && controller.signal.reason instanceof ProviderStartupError) {
          throw controller.signal.reason;
        }
        throw new ProviderStartupError(
          "provider_startup_failed",
          "The native conversation controller failed before readiness.",
          "readiness",
          acquired.error.kind === "adapter-failure" ? acquired.error.retryable : false,
        );
      }
      publish(reservationId);
    } catch (error) {
      const abortReason = controller.signal.aborted && controller.signal.reason instanceof ProviderStartupError
        ? controller.signal.reason
        : null;
      if (abortReason?.code === "client_aborted") return;
      const typed = abortReason ?? normalizeProviderStartupError(error);
      spawns.failed(reservationId, generation, {
        code: typed.code,
        message: typed.message,
        retryable: typed.retryable,
        phase: typed.phase,
      });
      publish(reservationId);
    } finally {
      clearTimeout(timeout);
      if (attempts.get(reservationId) === attempt) attempts.delete(reservationId);
    }
  };

  server.get("/api/conversation-spawns", (_req, res) => {
    sendJson(res, 200, { spawns: spawns.listCurrent() });
  }, { operation: { id: "get:/api/conversation-spawns", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/conversation-spawns/:id", (req, res) => {
    const result = spawns.get(req.params.id);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }, { operation: { id: "get:/api/conversation-spawns/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/conversation-spawns", globalCapabilityRoute("spawn_console", async (req, res) => {
    const request = req.body as ConversationSpawnRequest;
    const reserved = spawns.reserve(request);
    if (!reserved.ok) {
      sendJson(res, statusFor(reserved.error), reserved);
      return;
    }
    const canonicalRequest = reserved.value.request as ConversationSpawnRequest;
    if (reserved.value.state !== "reserved") {
      const terminalFailure = reserved.value.state === "failed" || reserved.value.state === "cancelled";
      sendJson(res, terminalFailure ? 409 : reserved.value.state === "starting" || reserved.value.state === "stopping" ? 202 : 200, {
        ok: !terminalFailure,
        ...(terminalFailure ? { error: reserved.value.error } : {}),
        spawn: reserved.value,
        conversation_id: reserved.value.reservation_id,
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
    sendJson(res, 202, {
      ok: true,
      spawn: currentSpawn,
      conversation_id: currentSpawn.reservation_id,
    });
  }, { authenticated: true }), { operation: { id: "post:/api/conversation-spawns", effects: ["provider:send"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow" });

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
    sendJson(res, 202, { ok: true, spawn: currentSpawn, conversation_id: currentSpawn.reservation_id });
  }, { authenticated: true }), { operation: { id: "post:/api/conversation-spawns/:id/retry", effects: ["provider:send"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow" });

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
    }
    const cancelled = spawns.cancelled(req.params.id, expectedGeneration);
    publish(req.params.id);
    sendJson(res, cancelled.ok ? 200 : statusFor(cancelled.error), cancelled);
  }, { authenticated: true }), { operation: { id: "delete:/api/conversation-spawns/:id", effects: ["provider:send"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow" });
}
