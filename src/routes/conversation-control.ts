import { operatorOnlyManagedSessionRoute } from "../client-auth/authz.js";
import { AttachmentValidationError, ChatAttachmentStore } from "../conversation-control/attachment-store.js";
import type { ConversationControlService } from "../conversation-control/service.js";
import type { ConversationControlError, ConversationSubmitRequest } from "../conversation-control/types.js";
import type { Db } from "../db.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
import type { InstanceInfo } from "../types.js";
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

function runtimeOptions(value: unknown): ConversationSubmitRequest["runtime_options"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime options must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["model", "effort", "permission_mode"]);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Unsupported runtime option '${unexpected}'`);
  const result: NonNullable<ConversationSubmitRequest["runtime_options"]> = {};
  for (const key of ["model", "effort"] as const) {
    const option = input[key];
    if (option === undefined || option === null || option === "") continue;
    if (typeof option !== "string" || !option.trim()) throw new Error(`${key} must be a nonblank string`);
    result[key] = option.trim();
  }
  const permission = input.permission_mode;
  if (permission !== undefined && permission !== null && permission !== "") {
    const values = ["read-only", "agent", "agent-full-access", "default", "acceptEdits", "bypassPermissions"] as const;
    if (!values.includes(permission as typeof values[number])) throw new Error("permission_mode is not supported");
    result.permission_mode = permission as NonNullable<typeof result.permission_mode>;
  }
  return result;
}

export function registerConversationControlRoutes(
  server: RouteRegistrar,
  control: ConversationControlService,
  options: { db?: Db; instance?: InstanceInfo } = {},
): void {
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
  }), { fileRpc: "deny" });

  server.get("/api/chat-attachments/:id/content", operatorOnlyManagedSessionRoute((req, res) => {
    if (!attachmentStore) return sendJson(res, 503, { error: "attachment_store_unavailable" });
    const file = attachmentStore.get(req.params.id);
    if (!file) return sendJson(res, 404, { error: "attachment_not_found" });
    res.binary?.(attachmentStore.content(file), file.media_type);
  }), { fileRpc: "deny" });

  server.get("/api/conversations/:id/control/attachments", operatorOnlyManagedSessionRoute((req, res) => {
    if (!options.db) return sendJson(res, 503, { error: "attachment_store_unavailable" });
    const snapshot = control.getSnapshot(req.params.id);
    if (!snapshot.ok) return sendJson(res, statusFor(snapshot.error), snapshot);
    const rows = options.db.prepare(`SELECT id AS delivery_id, turn_id, attachments_json, state, created_at
      FROM conversation_control_outbox WHERE conversation_id = ? AND attachments_json != '[]' ORDER BY created_at, id`)
      .all(req.params.id) as { delivery_id: string; turn_id: string; attachments_json: string; state: string; created_at: number }[];
    sendJson(res, 200, rows.map(({ attachments_json, ...row }) => ({ ...row, attachments: JSON.parse(attachments_json) })));
  }), { fileRpc: "deny" });

  server.get("/api/conversations/:id/control", (req, res) => {
    const result = control.getSnapshot(req.params.id);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }, { fileRpc: "allow" });

  server.get("/api/conversations/:id/control/live", (req, res) => {
    const result = control.getLiveProjection(req.params.id);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }, { fileRpc: "allow" });

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
      parsedRuntimeOptions = runtimeOptions(body.runtime_options);
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
  }), { fileRpc: "deny" });

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
  }), { fileRpc: "deny" });
}
