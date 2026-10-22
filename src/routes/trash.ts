import { getDb, type Db } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import {
  gcTrashEntries,
  listTrashEntries,
  restoreTrashEntry,
  TrashServiceError,
  trashBranch,
  type TrashCreateInput,
  type TrashRestoreInput,
  type TrashState,
} from "../trash-service.js";
import { bodyRecord, queryString, sendJson } from "./http.js";
import { entityRefs } from "../entity-refs.js";
function handleError(res: ResponseLike, error: unknown, removal = false): void {
  if (error instanceof TrashServiceError) {
    sendJson(res, error.status, {
      ...(removal ? { result: error.code === "remove_failed" ? "remove_failed" : "refused" } : {}),
      error: error.message,
      code: error.code,
      ...(error.detail ? { detail: error.detail } : {}),
    });
    return;
  }
  sendJson(res, 500, {
    error: error instanceof Error ? error.message : String(error),
    code: "trash_internal_error",
  });
}

function createInput(req: RequestLike): TrashCreateInput {
  const body = bodyRecord(req);
  return {
    project: typeof body.project === "string" ? body.project : "",
    branch: typeof body.branch === "string" ? body.branch : "",
    reason: typeof body.reason === "string" ? body.reason as TrashCreateInput["reason"] : "manual",
    actor: typeof body.actor === "string" ? body.actor : undefined,
    issue_refs: Array.isArray(body.issue_refs)
      ? body.issue_refs.filter((value): value is string => typeof value === "string")
      : undefined,
    checkout_root: typeof body.checkout_root === "string" ? body.checkout_root : undefined,
    retention_days: typeof body.retention_days === "number" ? body.retention_days : undefined,
    merged_into: typeof body.merged_into === "string" ? body.merged_into : undefined,
  };
}

function restoreInput(req: RequestLike): TrashRestoreInput {
  const body = bodyRecord(req);
  return {
    worktree_path: typeof body.worktree_path === "string" ? body.worktree_path : undefined,
    actor: typeof body.actor === "string" ? body.actor : undefined,
  };
}

export function registerTrashRoutes(router: RouteRegistrar, db: Db = getDb()): void {
  router.get("/api/v1/trash", (req, res) => {
    try {
      const project = queryString(req, "project");
      const rawState = queryString(req, "state");
      const validStates = new Set<TrashState>([
        "active", "remove_failed", "restored", "expired", "restore_failed", "gc_pending", "gc_failed",
      ]);
      if (rawState && !validStates.has(rawState as TrashState)) {
        sendJson(res, 400, { error: `invalid trash state: ${rawState}`, code: "invalid_state" });
        return;
      }
      sendJson(res, 200, {
        entries: listTrashEntries(db, {
          project,
          state: rawState ? rawState as TrashState : undefined,
        }),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/v1/trash", effects: ["files:production"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/v1/trash", (req, res) => {
    try {
      const removal = trashBranch(db, createInput(req));
      sendJson(res, removal.result === "trashed" ? 201 : 200, removal);
    } catch (error) {
      handleError(res, error, true);
    }
  }, { operation: { id: "post:/api/v1/trash", effects: ["files:production"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  // Register the literal gc route before the parameter route.
  router.post("/api/v1/trash/gc", (req, res) => {
    try {
      const body = bodyRecord(req);
      sendJson(res, 200, gcTrashEntries(db, {
        now: typeof body.now === "number" ? body.now : undefined,
        limit: typeof body.limit === "number" ? body.limit : undefined,
        actor: typeof body.actor === "string" ? body.actor : undefined,
      }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/v1/trash/gc", effects: ["files:production"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.post("/api/v1/trash/:id/restore", (req, res) => {
    try {
      sendJson(res, 200, restoreTrashEntry(db, req.params.id, restoreInput(req)));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/v1/trash/:id/restore", effects: ["files:production"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow",
    refs: { params: { id: entityRefs.trashEntry } } });
}
