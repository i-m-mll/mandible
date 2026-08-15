import { ClientAuthzError, isOperator, requireIdentity } from "../client-auth/authz.js";
import type { FeedbackCollectionListState } from "../contracts.js";
import {
  feedbackCollectionAudienceAllows,
  FeedbackCollectionStoreError,
  listFeedbackCollections,
  setFeedbackCollectionExpiry,
} from "../feedback/collections.js";
import { getDb, type Db } from "../db.js";
import { evaluateGlobalCapability } from "../permissions/store.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { getUserById } from "../users/store.js";
import { sendJson } from "./http.js";

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError || error instanceof FeedbackCollectionStoreError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
}

function activeHuman(db: Db, req: RequestLike) {
  const identity = requireIdentity(req);
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active") {
    throw new ClientAuthzError(403, "forbidden", "The authenticated user is not active.");
  }
  if (user.kind !== "human") {
    throw new ClientAuthzError(
      403,
      "human_responder_required",
      "Feedback collection updates require an active human credential.",
    );
  }
  return { identity, user, operator: isOperator(db, identity) };
}

function collectionReadScope(db: Db, req: RequestLike): {
  requesterUserId: string | null;
  responderUserId: string | null;
  operator: boolean;
} {
  const identity = req.client_identity;
  if (!identity) {
    return { requesterUserId: null, responderUserId: null, operator: false };
  }
  if (isOperator(db, identity)) {
    return { requesterUserId: null, responderUserId: null, operator: true };
  }
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active") {
    return { requesterUserId: null, responderUserId: null, operator: false };
  }
  if (user.kind === "human") {
    return { requesterUserId: null, responderUserId: user.id, operator: false };
  }
  if (user.kind === "agent") {
    const decision = evaluateGlobalCapability(db, { identity, capability: "ask.create" });
    if (decision.allowed && decision.reason !== "operator_implicit_admin") {
      return { requesterUserId: user.id, responderUserId: null, operator: false };
    }
  }
  return { requesterUserId: null, responderUserId: null, operator: false };
}

function parseState(req: RequestLike): FeedbackCollectionListState {
  const values = new URL(req.url, "http://localhost").searchParams.getAll("state");
  if (values.length === 0) return "all";
  if (values.length !== 1 || !["all", "open", "expired"].includes(values[0])) {
    throw new FeedbackCollectionStoreError("state must be one of all, open, or expired");
  }
  return values[0] as FeedbackCollectionListState;
}

function expiryBody(req: RequestLike): number | null {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new FeedbackCollectionStoreError("request body must be an object");
  }
  const body = req.body as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "expires_at")) {
    throw new FeedbackCollectionStoreError("request body must contain only expires_at");
  }
  if (body.expires_at !== null && !Number.isSafeInteger(body.expires_at)) {
    throw new FeedbackCollectionStoreError("expires_at must be an integer or null");
  }
  return body.expires_at as number | null;
}

export function registerFeedbackRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  server.get("/api/feedback/collections", (req, res) => {
    try {
      const scope = collectionReadScope(db, req);
      const state = parseState(req);
      sendJson(res, 200, {
        state,
        collections: listFeedbackCollections(db, {
          ...scope,
          state,
        }),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.patch("/api/feedback/collections/:id", (req, res) => {
    try {
      const actor = activeHuman(db, req);
      if (!actor.operator && !feedbackCollectionAudienceAllows(db, req.params.id, actor.user.id)) {
        throw new FeedbackCollectionStoreError("feedback collection not found", 404, "not_found");
      }
      const collection = setFeedbackCollectionExpiry(db, req.params.id, expiryBody(req), {
        actorUserId: actor.user.id,
      });
      broadcast("feedback:collection-updated", {
        collection_id: collection.id,
        state: collection.state,
        expires_at: collection.expires_at,
        updated_at: collection.updated_at,
      });
      sendJson(res, 200, collection);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny" });
}
