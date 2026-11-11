import { requireIdentity, requireOperator } from "../client-auth/authz.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import type { Db } from "../db.js";
import { NOTIFICATION_LIST_QUERY } from "../notices/contract.js";
import { listNotifications, markUserNotificationRead } from "../notices/notification-log.js";
import type { RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { sendJson } from "./http.js";

export function registerNotificationRoutes(server: RouteRegistrar, db: Db): void {
  server.get("/api/notifications", (req, res) => {
    requireIdentity(req);
    const query = NOTIFICATION_LIST_QUERY.safeParse(req.query);
    if (!query.success) return sendJson(res, 400, { error: "invalid_query", issues: query.error.issues });
    sendJson(res, 200, listNotifications(db, query.data));
  }, { operation: { id: "get:/api/notifications", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/notifications/:id/read", (req, res) => {
    requireOperator(db, req);
    const result = markUserNotificationRead(db, String(req.params.id ?? ""));
    if (!result.ok) return sendJson(res, result.error === "not_found" ? 404 : 409, { error: result.error });
    if (result.changed) broadcast(DOMAIN_EVENTS.NOTIFICATION_CHANGED, { id: result.notification.id });
    sendJson(res, 200, result.notification);
  }, { operation: { id: "post:/api/notifications/:id/read", effects: ["ledger:write"], requestSchema: null, reportingCategory: "notifications" }, fileRpc: "deny" });
}
