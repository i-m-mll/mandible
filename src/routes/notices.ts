import { exactAgentRef } from "../ambient-provider-identity.js";
import type { Db } from "../db.js";
import { MESSAGE_LIST_QUERY, MESSAGE_SEND_REQUEST, NOTICE_COLLECT_REQUEST, NOTICE_DELIVERED_REQUEST } from "../notices/contract.js";
import type { NoticeLog } from "../notices/log.js";
import { getMessage, listMessages, recipientSession, sendMessage, type MessageError } from "../notices/messages.js";
import type { WakeReconciler } from "../notices/wake/reconciler.js";
import { currentRequestOrigin } from "../request-origin.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
import { readBody, sendJson } from "./http.js";

const MESSAGE_ERROR_STATUS: Record<MessageError["code"], number> = { invalid_recipient: 400, too_large: 413, not_found: 404, ambiguous_id: 409 };

function sendMessageError(res: ResponseLike, error: MessageError): void {
  sendJson(res, MESSAGE_ERROR_STATUS[error.code], error);
}

/** How long `POST /api/messages` waits for the wake decision and attempt before it answers. */
export const SEND_REACH_WAIT_MS = 3_000;

export interface NoticeWakeOptions {
  reconciler: WakeReconciler;
  send_wait_ms?: number;
}

/** The hook's two requests, and agent-to-agent messages, whose rows the same hook delivers. */
export function registerNoticeRoutes(server: RouteRegistrar, notices: NoticeLog, db: Db, wake: NoticeWakeOptions): void {
  const { reconciler, send_wait_ms: sendWait = SEND_REACH_WAIT_MS } = wake;
  server.post("/api/notices/collect", (req, res) => {
    const body = NOTICE_COLLECT_REQUEST.safeParse(readBody(req));
    if (!body.success) { sendJson(res, 400, { error: "invalid_request", issues: body.error.issues }); return; }
    const { route, ...caller } = body.data;
    if (route && route.provider !== caller.provider) {
      sendJson(res, 400, { error: "invalid_request", issues: [{ path: ["route", "provider"], message: "names another provider" }] });
      return;
    }
    if (route) reconciler.register(caller.session_id, route, "hook");
    reconciler.heard(caller.provider, caller.session_id);
    sendJson(res, 200, { notices: notices.collect(caller) });
  }, { operation: { id: "post:/api/notices/collect", effects: ["ledger:write"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/notices/delivered", (req, res) => {
    const body = NOTICE_DELIVERED_REQUEST.safeParse(readBody(req));
    if (!body.success) { sendJson(res, 400, { error: "invalid_request", issues: body.error.issues }); return; }
    notices.delivered(body.data.ids);
    sendJson(res, 200, { ok: true });
  }, { operation: { id: "post:/api/notices/delivered", effects: ["ledger:write"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/messages", async (req, res) => {
    const body = MESSAGE_SEND_REQUEST.safeParse(readBody(req));
    if (!body.success) { sendJson(res, 400, { error: "invalid_request", issues: body.error.issues }); return; }
    const sent = db.transaction(() => sendMessage(db, { ...body.data, sender: exactAgentRef(currentRequestOrigin()) })).immediate();
    if (!sent.ok) { sendMessageError(res, sent.error); return; }
    const recipient = recipientSession(sent.value.recipient_agent_ref)!;
    await within(reconciler.evaluate(recipient.provider, recipient.session_id), sendWait);
    const current = getMessage(db, sent.value.id);
    if (!current.ok) throw new Error(`Message ${sent.value.id} vanished after it was stored.`);
    sendJson(res, 201, { message: current.value });
  }, { operation: { id: "post:/api/messages", effects: ["ledger:write"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  server.get("/api/messages", (req, res) => {
    const query = MESSAGE_LIST_QUERY.safeParse(req.query ?? {});
    if (!query.success) { sendJson(res, 400, { error: "invalid_request", issues: query.error.issues }); return; }
    const caller = exactAgentRef(currentRequestOrigin());
    if (!caller) { sendJson(res, 409, { code: "agent_identity_required", error: "Listing messages requires an exact calling agent." }); return; }
    sendJson(res, 200, { agent_ref: caller, messages: listMessages(db, caller, query.data.limit) });
  }, { operation: { id: "get:/api/messages", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/messages/:id", (req, res) => {
    const found = getMessage(db, req.params.id);
    if (!found.ok) { sendMessageError(res, found.error); return; }
    sendJson(res, 200, { message: found.value });
  }, { operation: { id: "get:/api/messages/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
}

/** Resolves when `work` settles or after `ms`, whichever is first. */
async function within(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}
