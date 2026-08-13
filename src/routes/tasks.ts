// Executor task inventory HTTP surface (issue 0bc2279).
//
// One credential class writes here: a REGISTERED EXECUTOR — an active agent (or
// the local operator, the administrative principal for every namespace) that is
// explicitly mapped to the executor name it posts under. This is the same trust
// shape as briefing publishers, and deliberately not a capability an arbitrary
// authenticated session inherits: an unmapped identity is a 403 even though it
// authenticated fine. fileRpc is allowed so a sandboxed publisher can reach the
// route over the file transport.
//
// Reads are open like the rest of the dashboard read surface, and there is no
// write surface beyond ingestion: this slice has no commands, no edits, and no
// creation route, because Mandible does not manage these tasks yet.

import { requireIdentity, ClientAuthzError, isOperator } from "../client-auth/authz.js";
import { TASK_INVENTORY_EVENTS } from "../contracts.js";
import { getDb, type Db } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import {
  getTaskInventoryView,
  parseTaskInventoryGeneration,
  publisherMayPostInventory,
  recordTaskInventoryGeneration,
  TaskInventoryValidationError,
} from "../task-inventory.js";
import { getUserById } from "../users/store.js";
import { sendJson } from "./http.js";

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof TaskInventoryValidationError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

/**
 * Admit an active principal mapped to this executor name, and return the user
 * id that will be recorded on the generation. Attribution comes from the
 * authenticated identity alone — nothing in the payload can name a publisher.
 */
function requireExecutorPublisher(db: Db, req: RequestLike, executorName: string): string {
  const identity = requireIdentity(req);
  if (identity.method !== "api_token") {
    throw new ClientAuthzError(
      403,
      "executor_credential_required",
      "Executor inventory publication requires a durable API token, not a session credential.",
    );
  }
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active") {
    throw new ClientAuthzError(403, "forbidden", "The authenticated user is not active.");
  }
  if (isOperator(db, identity)) return user.id;
  if (user.kind !== "agent") {
    throw new ClientAuthzError(
      403,
      "executor_agent_required",
      "Executor inventory publication requires an agent identity.",
    );
  }
  if (!publisherMayPostInventory(db, user.slug, executorName)) {
    throw new ClientAuthzError(
      403,
      "executor_identity_forbidden",
      `Identity '${user.slug}' is not a registered publisher for executor '${executorName}'.`,
    );
  }
  return user.id;
}

export function registerTaskRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  // Ingestion: registered-executor class, atomic per generation, idempotent per
  // content digest.
  server.post("/api/tasks/inventory", (req, res) => {
    try {
      // Authenticate before parsing so an anonymous caller learns nothing about
      // payload validation; the mapping check needs the parsed executor name.
      requireIdentity(req);
      const generation = parseTaskInventoryGeneration(req.body);
      const postedByUserId = requireExecutorPublisher(db, req, generation.executor.name);
      const result = recordTaskInventoryGeneration(db, generation, { postedByUserId });
      if (result.stored) {
        broadcast(TASK_INVENTORY_EVENTS.posted, {
          executor: result.executor,
          generation_id: result.generation_id,
          digest: result.digest,
          task_count: result.task_count,
          observed_at: result.observed_at,
        });
      }
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  // The whole read surface: latest generation per executor, projected.
  server.get("/api/tasks", (_req, res) => {
    try {
      sendJson(res, 200, getTaskInventoryView(db));
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });
}
