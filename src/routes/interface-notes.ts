import { attributionForRequest, requireIdentity, requireOperator } from "../client-auth/authz.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import type { Db } from "../db.js";
import { INTERFACE_NOTE_ERRORS } from "../interface-notes/contract.js";
import { listIssueInterfaceNotes } from "../interface-notes/read.js";
import { InterfaceNoteStore, type InterfaceNoteResult, type InterfaceNoteWriteActor } from "../interface-notes/store.js";
import { resolveOperationalIssueRef } from "../ledger/operational-links.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { bodyRecord, queryString, sendJson } from "./http.js";

function send<T>(res: ResponseLike, result: InterfaceNoteResult<T>, status: number): void {
  if (!result.ok) return sendJson(res, INTERFACE_NOTE_ERRORS[result.error.code], { error: result.error.code, ...(result.error.message ? { message: result.error.message } : {}) });
  if (result.value === undefined) {
    res.status(204).empty?.();
    return;
  }
  sendJson(res, status, result.value);
}

function operatorActor(db: Db, req: RequestLike): InterfaceNoteWriteActor {
  requireOperator(db, req);
  return { actor_type: "mandible_user", author_display: "Mandible", attribution: attributionForRequest(db, req) };
}

export function registerInterfaceNoteRoutes(server: RouteRegistrar, db: Db): void {
  const store = new InterfaceNoteStore(db, (payload) => broadcast(DOMAIN_EVENTS.INTERFACE_NOTE_CHANGED, payload));
  server.get("/api/interface-notes", (req, res) => {
    requireIdentity(req);
    const issueRef = queryString(req, "issue");
    if (issueRef === undefined) return sendJson(res, 200, { notes: store.listUnfiled() });
    const resolved = resolveOperationalIssueRef(db, issueRef);
    if (!resolved.ok) return sendJson(res, INTERFACE_NOTE_ERRORS.issue_not_found, { error: "issue_not_found" });
    sendJson(res, 200, { notes: listIssueInterfaceNotes(db, resolved.issue_id) });
  }, { operation: { id: "get:/api/interface-notes", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/interface-notes", (req, res) => {
    requireOperator(db, req);
    send(res, store.create(req.body), 201);
  }, { operation: { id: "post:/api/interface-notes", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.post("/api/interface-notes/file", (req, res) => {
    send(res, store.file(req.body, operatorActor(db, req)), 201);
  }, { operation: { id: "post:/api/interface-notes/file", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.patch("/api/interface-notes/:id", (req, res) => {
    send(res, store.updateText(req.params.id, bodyRecord(req).text, operatorActor(db, req)), 200);
  }, { operation: { id: "patch:/api/interface-notes/:id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.delete("/api/interface-notes/:id", (req, res) => {
    const actor = operatorActor(db, req);
    const commentId = queryString(req, "comment");
    send(res, commentId === undefined ? store.deleteUnfiled(req.params.id) : store.removeFromComment(req.params.id, commentId, actor), 204);
  }, { operation: { id: "delete:/api/interface-notes/:id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });
}
