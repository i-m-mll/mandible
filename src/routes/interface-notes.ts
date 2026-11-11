import { attributionForRequest, requireIdentity, requireOperator } from "../client-auth/authz.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import type { Db } from "../db.js";
import { INTERFACE_NOTE_ERRORS } from "../interface-notes/contract.js";
import { listIssueInterfaceNotes } from "../interface-notes/read.js";
import { forwardToSource, type InterfaceNotesHome } from "../interface-notes/source.js";
import { InterfaceNoteStore, type InterfaceNoteResult, type InterfaceNoteWriteActor } from "../interface-notes/store.js";
import { resolveOperationalIssueRef } from "../ledger/operational-links.js";
import { interfaceNoteEffects } from "../security/operation-policy.js";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { bodyRecord, queryString, sendJson } from "./http.js";

function sendFailure(res: ResponseLike, error: { code: keyof typeof INTERFACE_NOTE_ERRORS; message?: string }): void {
  sendJson(res, INTERFACE_NOTE_ERRORS[error.code], { error: error.code, ...(error.message ? { message: error.message } : {}) });
}

function send<T>(res: ResponseLike, result: InterfaceNoteResult<T>, status: number): void {
  if (!result.ok) return sendFailure(res, result.error);
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

/**
 * In a preview whose notes live in its source instance, each route checks the
 * requester here exactly as the local route would, then sends the request on.
 * The source sees the operator, so the check here is what keeps an agent of the
 * preview from writing notes in the operator's name.
 */
function forwarded(db: Db, socketPath: string, access: "read" | "write"): RouteHandler {
  return async (req, res) => {
    if (access === "read") requireIdentity(req);
    else requireOperator(db, req);
    const result = await forwardToSource(socketPath, req.method, req.url, req.body);
    if (!result.ok) return sendFailure(res, result.error);
    const { status, body } = result.value;
    if (body === "") {
      res.status(status).empty?.();
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return sendFailure(res, { code: "source_unavailable", message: `source instance answered ${status} without JSON` });
    }
    sendJson(res, status, payload);
  };
}

export function registerInterfaceNoteRoutes(server: RouteRegistrar, db: Db, home: InterfaceNotesHome): void {
  const store = new InterfaceNoteStore(db, (payload) => broadcast(DOMAIN_EVENTS.INTERFACE_NOTE_CHANGED, payload));
  const source = home.kind === "source" ? home.socketPath : null;
  const route = (access: "read" | "write", local: RouteHandler): RouteHandler => source === null ? local : forwarded(db, source, access);

  server.get("/api/interface-notes", route("read", (req, res) => {
    requireIdentity(req);
    const issueRef = queryString(req, "issue");
    if (issueRef === undefined) return sendJson(res, 200, { notes: store.listUnfiled() });
    const resolved = resolveOperationalIssueRef(db, issueRef);
    if (!resolved.ok) return sendJson(res, INTERFACE_NOTE_ERRORS.issue_not_found, { error: "issue_not_found" });
    sendJson(res, 200, { notes: listIssueInterfaceNotes(db, resolved.issue_id) });
  }), { operation: { id: "get:/api/interface-notes", effects: (context) => interfaceNoteEffects(context, "ledger:read"), requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/interface-notes", route("write", (req, res) => {
    requireOperator(db, req);
    send(res, store.create(req.body), 201);
  }), { operation: { id: "post:/api/interface-notes", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.post("/api/interface-notes/file", route("write", (req, res) => {
    send(res, store.file(req.body, operatorActor(db, req)), 201);
  }), { operation: { id: "post:/api/interface-notes/file", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.patch("/api/interface-notes/:id", route("write", (req, res) => {
    send(res, store.updateText(req.params.id, bodyRecord(req).text, operatorActor(db, req)), 200);
  }), { operation: { id: "patch:/api/interface-notes/:id", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.delete("/api/interface-notes/:id", route("write", (req, res) => {
    const actor = operatorActor(db, req);
    const commentId = queryString(req, "comment");
    send(res, commentId === undefined ? store.deleteUnfiled(req.params.id) : store.removeFromComment(req.params.id, commentId, actor), 204);
  }), { operation: { id: "delete:/api/interface-notes/:id", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });
}
