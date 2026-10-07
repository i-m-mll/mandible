import { operatorOnlyManagedSessionRoute } from "../client-auth/authz.js";
import { canonicalConversationRoutes } from '../conversations/identity.js';
import { AttachmentValidationError, ChatAttachmentStore } from "../conversation-control/attachment-store.js";
import type { ConversationControlService } from "../conversation-control/service.js";
import type { ConversationControlError, ConversationSubmitRequest } from "../conversation-control/types.js";
import type { Db } from "../db.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
import type { InstanceInfo } from "../types.js";
import { parseConversationRuntimeOptions } from "../conversation-control/runtime-options.js";
import { bodyRecord, sendJson } from "./http.js";

function statusFor(error: ConversationControlError): number {
  switch (error.kind) {
    case "conversation-not-found": return 404;
    case "invalid-request": return 400;
    case "adapter-unavailable":
    case "unsupported-operation": return 422;
    case "adapter-failure": return error.retryable ? 503 : 502;
    case "adapter-contract-violation": return 502;
    case "capability-drift":
    case "ownership-conflict":
    case "stale-generation":
    case "delivery-uncertain": return 409;
  }
}

export function registerConversationControlRoutes(
  server: RouteRegistrar,
  control: ConversationControlService,
  options: { db?: Db; instance?: InstanceInfo } = {},
): void {
  if (options.db) server = canonicalConversationRoutes(server, options.db);
  const discoverModels = options.instance?.role !== "preview"
    && (options.instance?.allowed_effects.includes("provider:send") ?? true);
  const attachmentStore = options.db ? new ChatAttachmentStore(options.db) : null;
  const previewControlAllowed = async (conversationId: string, generation: number): Promise<boolean> => {
    if (options.instance?.role !== "preview") return true;
    if (!options.db || options.instance.role !== "preview") return false;
    const spawn = options.db.prepare(`SELECT attempt_count, state FROM conversation_spawn_requests
      WHERE id = ? AND schema_version = 'mandible-conversation-spawn-request@3'`).get(conversationId) as
      | { attempt_count: number; state: string }
      | undefined;
    if (!spawn || spawn.attempt_count !== generation || spawn.state !== "ready") return false;
    return control.ownsController(conversationId, generation);
  };
  const rejectIneligiblePreviewControl = (res: ResponseLike) => {
    sendJson(res, 403, {
      error: "preview_conversation_control_forbidden",
      message: "This preview can control only a Chat created and still owned by this preview.",
    });
  };

  server.post("/api/chat-attachments", operatorOnlyManagedSessionRoute((req, res) => {
    if (!attachmentStore) return sendJson(res, 503, { error: "attachment_store_unavailable" });
    const body = bodyRecord(req);
    try {
      const file = attachmentStore.put(body as { name: string; media_type: string; data_base64: string });
      sendJson(res, 201, file);
    } catch (error) {
      if (!(error instanceof AttachmentValidationError)) throw error;
      sendJson(res, 400, { error: "invalid_attachment", message: error.message });
    }
  }), { operation: { id: "post:/api/chat-attachments", effects: ["ledger:write"], requestSchema: null, reportingCategory: "api" }, fileRpc: "deny" });

  server.get("/api/chat-attachments/:id/content", operatorOnlyManagedSessionRoute((req, res) => {
    if (!attachmentStore) return sendJson(res, 503, { error: "attachment_store_unavailable" });
    const file = attachmentStore.get(req.params.id);
    if (!file) return sendJson(res, 404, { error: "attachment_not_found" });
    res.binary?.(attachmentStore.content(file), file.media_type);
  }), { operation: { id: "get:/api/chat-attachments/:id/content", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/conversations/:id/control/attachments", operatorOnlyManagedSessionRoute((req, res) => {
    if (!options.db) return sendJson(res, 503, { error: "attachment_store_unavailable" });
    const snapshot = control.getSnapshot(req.params.id);
    if (!snapshot.ok) return sendJson(res, statusFor(snapshot.error), snapshot);
    const rows = options.db.prepare(`SELECT id AS delivery_id, turn_id, attachments_json, state, created_at
      FROM conversation_control_outbox WHERE conversation_id = ? AND attachments_json != '[]' ORDER BY created_at, id`)
      .all(req.params.id) as { delivery_id: string; turn_id: string; attachments_json: string; state: string; created_at: number }[];
    sendJson(res, 200, rows.map(({ attachments_json, ...row }) => ({ ...row, attachments: JSON.parse(attachments_json) })));
  }), { operation: { id: "get:/api/conversations/:id/control/attachments", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/conversations/:id/control", (req, res) => {
    const result = control.getSnapshot(req.params.id);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }, { operation: { id: "get:/api/conversations/:id/control", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/conversations/:id/control/live", (req, res) => {
    const result = control.getLiveProjection(req.params.id);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }, { operation: { id: "get:/api/conversations/:id/control/live", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/conversations/:id/control/submit", operatorOnlyManagedSessionRoute(async (req, res) => {
    const body = bodyRecord(req);
    const operation = typeof body.operation === "string" ? body.operation : "";
    if (!["send", "steer", "queue", "resume-provider-session", "resume-message-anchor"].includes(operation)) {
      const error: ConversationControlError = { kind: "invalid-request", field: "operation", message: "Operation is not part of the conversation control contract" };
      sendJson(res, statusFor(error), { ok: false, error });
      return;
    }
    let parsedRuntimeOptions: ConversationSubmitRequest["runtime_options"];
    try {
      parsedRuntimeOptions = parseConversationRuntimeOptions(body.runtime_options);
    } catch (error) {
      const invalid: ConversationControlError = { kind: "invalid-request", field: "runtime_options", message: error instanceof Error ? error.message : String(error) };
      sendJson(res, statusFor(invalid), { ok: false, error: invalid });
      return;
    }
    const request: ConversationSubmitRequest = {
      conversation_id: req.params.id,
      operation: operation as ConversationSubmitRequest["operation"],
      expected_revision: Number(body.expected_revision),
      expected_generation: Number(body.expected_generation),
      message: typeof body.message === "string" ? body.message : "",
      attachments: body.attachments as ConversationSubmitRequest["attachments"],
      message_anchor: typeof body.message_anchor === "string" ? body.message_anchor : undefined,
      runtime_options: parsedRuntimeOptions,
      idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : "",
    };
    if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 0) {
      const error: ConversationControlError = { kind: "invalid-request", field: "expected_revision", message: "Expected revision must be a non-negative integer" };
      sendJson(res, statusFor(error), { ok: false, error });
      return;
    }
    if (!Number.isSafeInteger(request.expected_generation) || request.expected_generation < 0) {
      const error: ConversationControlError = { kind: "invalid-request", field: "expected_generation", message: "Expected generation must be a non-negative integer" };
      sendJson(res, statusFor(error), { ok: false, error });
      return;
    }
    if (!request.idempotency_key.trim()) {
      const error: ConversationControlError = { kind: "invalid-request", field: "idempotency_key", message: "Idempotency key is required" };
      sendJson(res, statusFor(error), { ok: false, error });
      return;
    }
    if (!await previewControlAllowed(request.conversation_id, request.expected_generation)) {
      rejectIneligiblePreviewControl(res);
      return;
    }
    const result = await control.submit(request);
    if (!result.ok && result.error.kind === "capability-drift") {
      const refreshed = control.getSnapshot(request.conversation_id);
      sendJson(res, statusFor(result.error), { ...result, snapshot: refreshed.ok ? refreshed.value : null });
      return;
    }
    sendJson(res, result.ok ? 202 : statusFor(result.error), result);
  }), { operation: { id: "post:/api/conversations/:id/control/submit", effects: ["provider:send"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "deny" });

  server.get("/api/conversations/:id/control/permissions", operatorOnlyManagedSessionRoute((req, res) => {
    const result = control.permissions(req.params.id);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }), { operation: { id: "get:/api/conversations/:id/control/permissions", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/conversations/:id/control/options", operatorOnlyManagedSessionRoute(async (req, res) => {
    const result = await control.runOptions(req.params.id, { discoverModels });
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }), { operation: { id: "get:/api/conversations/:id/control/options", effects: discoverModels ? ["ledger:read", "provider:send"] : ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/conversations/:id/control/settings", operatorOnlyManagedSessionRoute((req, res) => {
    const result = control.getRuntimeSettings(req.params.id);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }), { operation: { id: "get:/api/conversations/:id/control/settings", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.patch("/api/conversations/:id/control/settings", operatorOnlyManagedSessionRoute(async (req, res) => {
    const body = bodyRecord(req);
    const revision = Number(body.expected_revision);
    if (!Number.isSafeInteger(revision) || revision < 0) return sendJson(res, 400, { error: "invalid_revision" });
    const snapshot = control.getSnapshot(req.params.id);
    if (!snapshot.ok) return sendJson(res, statusFor(snapshot.error), snapshot);
    if (!await previewControlAllowed(req.params.id, snapshot.value.ownership.generation)) return rejectIneligiblePreviewControl(res);
    try {
      const result = control.saveRuntimeSettings(req.params.id, revision, parseConversationRuntimeOptions(body.runtime_options));
      sendJson(res, result.ok ? 200 : statusFor(result.error), result);
    } catch (error) {
      sendJson(res, 400, { error: "invalid_runtime_options", message: error instanceof Error ? error.message : String(error) });
    }
  }), { operation: { id: "patch:/api/conversations/:id/control/settings", effects: ["ledger:write"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "deny" });

  server.post("/api/conversations/:id/control/permission/:requestId", operatorOnlyManagedSessionRoute(async (req, res) => {
    const body = bodyRecord(req);
    const generation = Number(body.generation);
    const decision = body.decision;
    if (!Number.isSafeInteger(generation) || generation < 1 || !["allow", "deny", "allow_always", "answer"].includes(String(decision))) {
      return sendJson(res, 400, { ok: false, error: { kind: "invalid-request", field: "permission", message: "A generation and supported decision are required" } });
    }
    if (!await previewControlAllowed(req.params.id, generation)) return rejectIneligiblePreviewControl(res);
    const result = await control.decidePermission({ conversation_id: req.params.id, generation, request_id: req.params.requestId, decision: decision as import("../conversation-control/types.js").ManagedRequestResponse["decision"], answers: body.answers as Record<string, string[]> | undefined });
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }), { operation: { id: "post:/api/conversations/:id/control/permission/:requestId", effects: ["ledger:write", "provider:send"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "deny" });

  server.post("/api/conversations/:id/control/interrupt", operatorOnlyManagedSessionRoute(async (req, res) => {
    const body = bodyRecord(req);
    const generation = Number(body.generation);
    if (body.turn_id !== undefined && (typeof body.turn_id !== "string" || !body.turn_id)) return sendJson(res, 400, { error: "invalid_turn_id" });
    if (!Number.isSafeInteger(generation) || generation < 1) return sendJson(res, 400, { error: "invalid_generation" });
    if (!await previewControlAllowed(req.params.id, generation)) return rejectIneligiblePreviewControl(res);
    const result = await control.interrupt(req.params.id, generation, body.turn_id as string | undefined);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }), { operation: { id: "post:/api/conversations/:id/control/interrupt", effects: ["provider:send"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "deny" });

  server.post("/api/conversations/:id/control/stop", operatorOnlyManagedSessionRoute(async (req, res) => {
    const body = bodyRecord(req);
    const generation = Number(body.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      const error: ConversationControlError = { kind: "invalid-request", field: "generation", message: "Generation must be a positive integer" };
      sendJson(res, statusFor(error), { ok: false, error });
      return;
    }
    if (!await previewControlAllowed(req.params.id, generation)) {
      rejectIneligiblePreviewControl(res);
      return;
    }
    const result = await control.stop(req.params.id, generation);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }), { operation: { id: "post:/api/conversations/:id/control/stop", effects: ["provider:send"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "deny" });
}
