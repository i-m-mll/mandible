import {
  applyAskAnnotations,
  applyAskAnswers,
  askAudience,
  AskStoreError,
  cancelAsk,
  createAsk,
  observeAsk,
  readAsk,
  submitAsk,
  type AskLifecycleTransition,
} from "../feedback/asks.js";
import { requireIdentity, ClientAuthzError, isOperator, requireOperator } from "../client-auth/authz.js";
import { ASK_EVENTS, type MandibleAskResult } from "../contracts.js";
import { getDb, type Db } from "../db.js";
import { evaluateGlobalCapability } from "../permissions/store.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { getUserById } from "../users/store.js";
import { sendJson } from "./http.js";

const DEFAULT_WAIT_MS = 25_000;
const MAX_WAIT_MS = 55_000;
const WAIT_POLL_MS = 75;

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError || error instanceof AskStoreError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

function activeUser(db: Db, req: RequestLike, kind?: "agent" | "human") {
  const identity = requireIdentity(req);
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active") {
    throw new ClientAuthzError(403, "forbidden", "The authenticated user is not active.");
  }
  if (kind && user.kind !== kind) {
    throw new ClientAuthzError(
      403,
      kind === "agent" ? "active_agent_required" : "human_responder_required",
      kind === "agent"
        ? "Ask creation requires an active agent credential."
        : "Ask responses require an active human credential.",
    );
  }
  return { identity, user };
}

function agentMayCreate(db: Db, req: RequestLike): string {
  const { identity, user } = activeUser(db, req, "agent");
  const decision = evaluateGlobalCapability(db, { identity, capability: "ask.create" });
  if (!decision.allowed || decision.reason === "operator_implicit_admin") {
    throw new ClientAuthzError(403, "global_capability_required", "Global capability 'ask.create' is required.");
  }
  return user.id;
}

function requesterOrOperator(db: Db, req: RequestLike, askId: string): string {
  const identity = requireIdentity(req);
  if (isOperator(db, identity)) return identity.user_id;
  const ask = askAudience(db, askId);
  if (!ask || ask.requester_user_id !== identity.user_id) {
    throw new AskStoreError("ask not found", 404, "not_found");
  }
  agentMayCreate(db, req);
  return identity.user_id;
}

function emitTransition(transition: AskLifecycleTransition | null): void {
  if (!transition) return;
  broadcast(transition.state === "expired" ? ASK_EVENTS.expired : ASK_EVENTS.cancelled, {
    ask_id: transition.ask_id,
    state: transition.state,
    requester_user_id: transition.requester_user_id,
    requester_session_id: transition.requester_session_id,
    lifecycle_event_id: transition.lifecycle_event_id,
    created_at: transition.created_at,
  });
}

function observeAndEmit(db: Db, askId: string, now = Date.now()): ReturnType<typeof observeAsk> {
  const observed = observeAsk(db, askId, now);
  emitTransition(observed?.transition ?? null);
  return observed;
}

function parseWaitTimeout(req: RequestLike): number {
  const url = new URL(req.url, "http://localhost");
  const values = url.searchParams.getAll("timeout_ms");
  if (values.length === 0) return DEFAULT_WAIT_MS;
  if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0])) {
    throw new AskStoreError("timeout_ms must be one integer from 0 through 55000");
  }
  const timeout = Number(values[0]);
  if (!Number.isSafeInteger(timeout) || timeout > MAX_WAIT_MS) {
    throw new AskStoreError("timeout_ms must be one integer from 0 through 55000");
  }
  return timeout;
}

async function waitForResult(db: Db, askId: string, timeoutMs: number): Promise<MandibleAskResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const observed = observeAndEmit(db, askId);
    if (!observed) return null;
    if (observed.result.state !== "open") return observed.result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...observed.result, wait_timed_out: true };
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, remaining)));
  }
}

function bodyRecord(req: RequestLike): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new AskStoreError("request body must be an object");
  }
  return req.body as Record<string, unknown>;
}

export function registerAskRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  server.post("/api/asks", (req, res) => {
    try {
      const requesterUserId = agentMayCreate(db, req);
      const result = createAsk(db, req.body, { requesterUserId });
      if (!result.replay) {
        broadcast(ASK_EVENTS.created, {
          ask_id: result.ask_id,
          state: "open",
          requester_user_id: result.requester_user_id,
          requester_session_id: result.requester_session_id,
          created_at: result.created_at,
        });
      }
      sendJson(res, result.replay ? 200 : 201, {
        ask_id: result.ask_id,
        request_digest: result.request_digest,
        replay: result.replay,
        dashboard_url: result.dashboard_url,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.get("/api/asks/:id", (req, res) => {
    try {
      const identity = requireIdentity(req);
      const ask = askAudience(db, req.params.id);
      if (!ask) throw new AskStoreError("ask not found", 404, "not_found");
      const operator = isOperator(db, identity);
      const responderIds = JSON.parse(ask.responder_user_ids_json) as string[];
      let answerActorUserId: string | undefined;
      if (ask.requester_user_id === identity.user_id) {
        agentMayCreate(db, req);
      } else if (responderIds.includes(identity.user_id)) {
        activeUser(db, req, "human");
        answerActorUserId = identity.user_id;
      } else if (!operator) {
        throw new AskStoreError("ask not found", 404, "not_found");
      }
      const projection = readAsk(db, req.params.id, {
        answerActorUserId,
        viewerUserId: identity.user_id,
        viewerIsOperator: operator,
      });
      if (!projection) throw new AskStoreError("ask not found", 404, "not_found");
      emitTransition(projection.transition);
      sendJson(res, 200, projection.ask);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.get("/api/asks/:id/result", (req, res) => {
    try {
      requesterOrOperator(db, req, req.params.id);
      const observed = observeAndEmit(db, req.params.id);
      if (!observed) throw new AskStoreError("ask not found", 404, "not_found");
      sendJson(res, 200, observed.result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.get("/api/asks/:id/wait", async (req, res) => {
    try {
      requesterOrOperator(db, req, req.params.id);
      const result = await waitForResult(db, req.params.id, parseWaitTimeout(req));
      if (!result) throw new AskStoreError("ask not found", 404, "not_found");
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.post("/api/asks/:id/answers", (req, res) => {
    try {
      const actorUserId = activeUser(db, req, "human").user.id;
      const now = Date.now();
      const observed = observeAndEmit(db, req.params.id, now);
      if (!observed) throw new AskStoreError("ask not found", 404, "not_found");
      const body = bodyRecord(req);
      const result = applyAskAnswers(db, req.params.id, actorUserId, body.answers as never[], now);
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny" });

  server.post("/api/asks/:id/annotations", (req, res) => {
    try {
      const actorUserId = activeUser(db, req, "human").user.id;
      const now = Date.now();
      const observed = observeAndEmit(db, req.params.id, now);
      if (!observed) throw new AskStoreError("ask not found", 404, "not_found");
      const body = bodyRecord(req);
      const result = applyAskAnnotations(db, req.params.id, actorUserId, body.annotations as never[], now);
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny" });

  server.post("/api/asks/:id/submit", (req, res) => {
    try {
      const actorUserId = activeUser(db, req, "human").user.id;
      const now = Date.now();
      const observed = observeAndEmit(db, req.params.id, now);
      if (!observed) throw new AskStoreError("ask not found", 404, "not_found");
      const body = bodyRecord(req);
      if (typeof body.expected_lifecycle_event_id !== "string" || !body.expected_lifecycle_event_id) {
        throw new AskStoreError("expected_lifecycle_event_id must be a nonblank string");
      }
      if (body.supersedes_submission_id !== undefined && body.supersedes_submission_id !== null
          && (typeof body.supersedes_submission_id !== "string" || !body.supersedes_submission_id)) {
        throw new AskStoreError("supersedes_submission_id must be a string or null");
      }
      const outcome = submitAsk(db, req.params.id, actorUserId, {
        expected_lifecycle_event_id: body.expected_lifecycle_event_id,
        supersedes_submission_id: body.supersedes_submission_id as string | null | undefined,
        answers: body.answers as never[],
        annotations: body.annotations as never[] | undefined,
      }, now);
      const ask = askAudience(db, req.params.id)!;
      broadcast(ASK_EVENTS.submitted, {
        ask_id: req.params.id,
        state: "submitted",
        requester_user_id: ask.requester_user_id,
        requester_session_id: ask.requester_session_id,
        submission_id: outcome.submission_id,
        ordinal: outcome.ordinal,
        lifecycle_event_id: outcome.lifecycle_event_id,
        created_at: outcome.result.submissions.find((submission) => submission.id === outcome.submission_id)?.created_at,
      });
      sendJson(res, 200, outcome.result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny" });

  server.delete("/api/asks/:id", (req, res) => {
    try {
      const actorUserId = requireOperator(db, req).user_id;
      const now = Date.now();
      const observed = observeAndEmit(db, req.params.id, now);
      if (!observed) throw new AskStoreError("ask not found", 404, "not_found");
      const transition = cancelAsk(db, req.params.id, actorUserId, now);
      emitTransition(transition);
      sendJson(res, 200, observeAsk(db, req.params.id)!.result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny" });
}
