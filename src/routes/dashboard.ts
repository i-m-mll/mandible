import { readDashboardBadgeCounts } from "../dashboard-badges.js";
import { getDb, type Db } from "../db.js";
import type { RouteRegistrar } from "../server.js";
import { sendJson } from "./http.js";

export function registerDashboardRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  server.get("/api/dashboard/badges", (_req, res) => {
    sendJson(res, 200, readDashboardBadgeCounts(db));
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/dashboard/badges", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
}
