// Briefing review HTTP surface (umbrella 99b74d6 / issue ce22a3a).
//
// Two credential classes meet here and are deliberately separated:
//
//   - The PUBLISHER class (agent/system identities such as the scheduled
//     `agent-schedule` publisher) may POST batches to /api/briefing/ingest, and
//     only within the source namespace its identity is mapped to. fileRpc is
//     allowed so a sandboxed publisher can reach it over the file transport.
//   - The HUMAN class (the local operator and other `human` users) is the only
//     class that may decide or comment. Those routes are fileRpc-denied,
//     attribute strictly to the authenticated user, and are blocked on
//     read-only instances by the central operational-mutation gate in
//     src/instance-policy.ts (category `briefing`).
//
// Reads (queue, history) are open like the rest of the dashboard read surface.

import {
  addBriefingComment,
  BriefingValidationError,
  getBriefingCandidateHistory,
  ingestBriefingBatch,
  listBriefingQueue,
  parseBriefingIngestRequest,
  publisherMayIngest,
  recordBriefingDecision,
} from "../briefing.js";
import { requireIdentity, ClientAuthzError, isOperator } from "../client-auth/authz.js";
import { BRIEFING_EVENTS, type BriefingReviewAction } from "../contracts.js";
import { getDb, type Db } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { getUserById } from "../users/store.js";
import { sendJson } from "./http.js";

const REVIEW_ACTIONS: readonly BriefingReviewAction[] = ["keep", "dismiss", "undo"];

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof BriefingValidationError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

/**
 * Admit only a human principal. Publisher and agent credentials are rejected
 * here rather than at the store, so no ingestion path can ever synthesize a
 * review decision, and `agent_session` hints are irrelevant: attribution comes
 * from the authenticated user id alone.
 */
function requireHumanReviewer(db: Db, req: RequestLike): string {
  const identity = requireIdentity(req);
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active") {
    throw new ClientAuthzError(403, "forbidden", "The authenticated user is not active.");
  }
  if (user.kind !== "human") {
    throw new ClientAuthzError(
      403,
      "human_reviewer_required",
      "Briefing review decisions require a human credential; publisher and agent "
        + "credentials may only ingest candidates.",
    );
  }
  return user.id;
}

/** Admit a publisher mapped to the batch's task-identity namespace. */
function requirePublisher(db: Db, req: RequestLike, taskIdentity: string): string {
  const identity = requireIdentity(req);
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active") {
    throw new ClientAuthzError(403, "forbidden", "The authenticated user is not active.");
  }
  // The local operator is the administrative principal for every namespace; a
  // non-operator must be explicitly mapped in `briefing.ingest.publishers`.
  if (isOperator(db, identity)) return user.id;
  if (!publisherMayIngest(db, user.slug, taskIdentity)) {
    throw new ClientAuthzError(
      403,
      "source_namespace_forbidden",
      `Identity '${user.slug}' is not permitted to publish '${taskIdentity}'.`,
    );
  }
  return user.id;
}

function bodyRecord(req: RequestLike): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

export function registerBriefingRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  // Ingestion: publisher class, atomic per batch, idempotent per batch_key.
  server.post("/api/briefing/ingest", (req, res) => {
    try {
      // Authenticate before parsing so an anonymous caller learns nothing about
      // batch validation; the namespace check needs the parsed task identity.
      requireIdentity(req);
      const batch = parseBriefingIngestRequest(req.body);
      requirePublisher(db, req, batch.task_identity);
      const result = ingestBriefingBatch(db, batch);
      broadcast(BRIEFING_EVENTS.ingested, {
        task_identity: batch.task_identity,
        batch_key: batch.batch_key,
        ...result,
      });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.get("/api/briefing/queue", (req, res) => {
    try {
      const source = typeof req.query?.source === "string" && req.query.source.trim()
        ? req.query.source.trim()
        : undefined;
      const limitRaw = typeof req.query?.limit === "string" ? Number(req.query.limit) : Number.NaN;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : undefined;
      sendJson(res, 200, listBriefingQueue(db, { source, limit }));
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.get("/api/briefing/candidates/:id/history", (req, res) => {
    try {
      const history = getBriefingCandidateHistory(db, req.params.id);
      if (!history) {
        sendJson(res, 404, { error: "candidate not found" });
        return;
      }
      sendJson(res, 200, history);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.post("/api/briefing/candidates/:id/decision", (req, res) => {
    try {
      const actorUserId = requireHumanReviewer(db, req);
      const body = bodyRecord(req);
      const action = body.action;
      if (typeof action !== "string" || !REVIEW_ACTIONS.includes(action as BriefingReviewAction)) {
        throw new BriefingValidationError(
          `action must be one of: ${REVIEW_ACTIONS.join(", ")}`,
        );
      }
      // Optional, but the only way a caller can bind a judgment to the revision
      // it displayed. Absent means the current revision (see the store).
      const revisionId = body.revision_id;
      if (revisionId !== undefined && (typeof revisionId !== "string" || !revisionId.trim())) {
        throw new BriefingValidationError("revision_id must be a non-empty string");
      }
      // Optional compare-and-set token for undo: the decision event the caller
      // is undoing. Validated like revision_id, so a malformed value is a 400
      // that writes nothing rather than an undo that silently skips the check.
      const expectedEventId = body.expected_event_id;
      if (
        expectedEventId !== undefined
        && (typeof expectedEventId !== "string" || !expectedEventId.trim())
      ) {
        throw new BriefingValidationError("expected_event_id must be a non-empty string");
      }
      const outcome = recordBriefingDecision(db, {
        candidateId: req.params.id,
        action: action as BriefingReviewAction,
        actorUserId,
        ...(typeof revisionId === "string" ? { revisionId } : {}),
        ...(typeof expectedEventId === "string" ? { expectedEventId } : {}),
      });
      broadcast(BRIEFING_EVENTS.decided, outcome);
      sendJson(res, 200, outcome);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny" });

  server.post("/api/briefing/candidates/:id/comments", (req, res) => {
    try {
      const actorUserId = requireHumanReviewer(db, req);
      const record = bodyRecord(req);
      const body = record.body;
      if (typeof body !== "string" || !body.trim()) {
        throw new BriefingValidationError("body is required");
      }
      // Optional, but the only way a caller can bind the note to the revision
      // it displayed. Absent means the current revision (see the store).
      const revisionId = record.revision_id;
      if (revisionId !== undefined && (typeof revisionId !== "string" || !revisionId.trim())) {
        throw new BriefingValidationError("revision_id must be a non-empty string");
      }
      const comment = addBriefingComment(db, {
        candidateId: req.params.id,
        body,
        actorUserId,
        ...(typeof revisionId === "string" ? { revisionId } : {}),
      });
      broadcast(BRIEFING_EVENTS.commented, {
        candidate_id: comment.candidate_id,
        revision_id: comment.revision_id,
        comment_id: comment.id,
      });
      sendJson(res, 200, { comment });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny" });
}
