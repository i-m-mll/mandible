import { NOTICE_COLLECT_REQUEST, NOTICE_DELIVERED_REQUEST } from "../notices/contract.js";
import type { NoticeLog } from "../notices/log.js";
import type { RouteRegistrar } from "../server.js";
import { readBody, sendJson } from "./http.js";

/** The turn-start hook's two requests, at the paths of `NOTICE_ROUTES`. */
export function registerNoticeRoutes(server: RouteRegistrar, notices: NoticeLog): void {
  server.post("/api/notices/collect", (req, res) => {
    const body = NOTICE_COLLECT_REQUEST.safeParse(readBody(req));
    if (!body.success) { sendJson(res, 400, { error: "invalid_request", issues: body.error.issues }); return; }
    sendJson(res, 200, { notices: notices.collect(body.data.provider, body.data.session_id) });
  }, { operation: { id: "post:/api/notices/collect", effects: ["ledger:write"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/notices/delivered", (req, res) => {
    const body = NOTICE_DELIVERED_REQUEST.safeParse(readBody(req));
    if (!body.success) { sendJson(res, 400, { error: "invalid_request", issues: body.error.issues }); return; }
    notices.delivered(body.data.ids);
    sendJson(res, 200, { ok: true });
  }, { operation: { id: "post:/api/notices/delivered", effects: ["ledger:write"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
}
