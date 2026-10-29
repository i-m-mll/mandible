import { getDb, type Db } from "../db.js";
import {
  LedgerChangeFeedError,
  readLedgerChangeFeed,
} from "../ledger/change-feed.js";
import { resolveProjectRef, suggestProjectRefs } from "../ledger/project-registry.js";
import { PermissionError, requireProjectAccess, sendPermissionError } from "../permissions/store.js";
import type { RouteRegistrar } from "../server.js";
import { sendJson } from "./http.js";

export function registerLedgerChangeRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  server.get("/api/ledger/changes", (req, res) => {
    const projectRef = req.query?.project;
    if (!projectRef) {
      sendJson(res, 400, { error: "project is required", code: "missing_project" });
      return;
    }
    const resolution = resolveProjectRef(db, projectRef);
    if (!resolution.ok) {
      sendJson(res, (!resolution.ok && resolution.reason === "ambiguous") ? 409 : 404, {
        error: (!resolution.ok && resolution.reason === "ambiguous") ? "project reference is ambiguous" : "project not found",
        code: (!resolution.ok && resolution.reason === "ambiguous") ? "ambiguous_project" : "project_not_found",
        candidates: suggestProjectRefs(db, projectRef),
      });
      return;
    }
    try {
      requireProjectAccess(db, req, resolution.project.id, "read");
      const rawLimit = req.query?.limit;
      const limit = rawLimit === undefined ? undefined : Number(rawLimit);
      sendJson(res, 200, readLedgerChangeFeed(db, {
        project_id: resolution.project.id,
        project_key: resolution.project.project_key,
        cursor: req.query?.cursor,
        limit,
        schema: req.query?.schema,
      }));
    } catch (error) {
      if (error instanceof PermissionError) {
        sendPermissionError(res, error);
        return;
      }
      if (error instanceof LedgerChangeFeedError) {
        sendJson(res, error.status, {
          error: error.message,
          code: error.code,
          resync_required: error.resyncRequired,
        });
        return;
      }
      throw error;
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/ledger/changes", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
}
