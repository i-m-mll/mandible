import { operatorOnlyManagedSessionRoute } from "../client-auth/authz.js";
import type { ConversationControlService } from "../conversation-control/service.js";
import type { ConversationControlError, ConversationSubmitRequest } from "../conversation-control/types.js";
import type { RouteRegistrar } from "../server.js";
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

export function registerConversationControlRoutes(server: RouteRegistrar, control: ConversationControlService): void {
  server.get("/api/conversations/:id/control", (req, res) => {
    const result = control.getSnapshot(req.params.id);
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
    const request: ConversationSubmitRequest = {
      conversation_id: req.params.id,
      operation: operation as ConversationSubmitRequest["operation"],
      expected_revision: Number(body.expected_revision),
      expected_generation: Number(body.expected_generation),
      message: typeof body.message === "string" ? body.message : "",
      message_anchor: typeof body.message_anchor === "string" ? body.message_anchor : undefined,
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
    const result = await control.stop(req.params.id, generation);
    sendJson(res, result.ok ? 200 : statusFor(result.error), result);
  }), { fileRpc: "deny" });
}
