import { attributionForRequest, requireIdentity, requireOperator } from "../client-auth/authz.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import type { Db } from "../db.js";
import { INTERFACE_NOTE_ERRORS, INTERFACE_NOTES_EMBED, type InterfaceNoteDestinations } from "../interface-notes/contract.js";
import { EmbedGrants } from "../interface-notes/embed-grants.js";
import type { EmbedProcessProbe } from "../interface-notes/embed-identity.js";
import { listIssueInterfaceNotes, listOpenIssuesWithInterfaceNotes } from "../interface-notes/read.js";
import { receivingProject, type MandibleBuild } from "../interface-notes/receiving-project.js";
import { forwardToSource, type InterfaceNotesHome } from "../interface-notes/source.js";
import { InterfaceNoteStore, interfaceNotesApp, type EmbedWriteScope, type InterfaceNoteResult, type InterfaceNoteWriteActor } from "../interface-notes/store.js";
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
    // The path this router matched, so the source can only ever be asked for an interface-notes route.
    const { pathname, search } = new URL(req.url, "http://localhost");
    const result = await forwardToSource(socketPath, req.method, pathname + search, req.body);
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

export function registerInterfaceNoteRoutes(server: RouteRegistrar, db: Db, home: InterfaceNotesHome, build: MandibleBuild, probe?: EmbedProcessProbe): void {
  const receiving = (app: string) => receivingProject(db, build, app);
  const store = new InterfaceNoteStore(db, (payload) => broadcast(DOMAIN_EVENTS.INTERFACE_NOTE_CHANGED, payload), receiving);
  const grants = new EmbedGrants(db, probe);
  const source = home.kind === "source" ? home.socketPath : null;
  const route = (access: "read" | "write", local: RouteHandler): RouteHandler => source === null ? local : forwarded(db, source, access);
  /** The bridge's writes name the embedding page's origin; the grant is read again for each one. */
  const embedScope = (req: RequestLike): EmbedWriteScope | null => {
    const origin = queryString(req, INTERFACE_NOTES_EMBED.originParam);
    return origin === undefined ? null : { origin, granted: (app) => grants.isGranted(app) };
  };

  server.get("/api/interface-notes", route("read", (req, res) => {
    requireIdentity(req);
    const issueRef = queryString(req, "issue");
    if (issueRef === undefined) {
      const app = interfaceNotesApp(queryString(req, "app"));
      if (app === null) return sendJson(res, INTERFACE_NOTE_ERRORS.invalid_note, { error: "invalid_note", message: "app is mandible, or a project key followed by : and a path" });
      return sendJson(res, 200, { notes: store.listUnfiled(app) });
    }
    const resolved = resolveOperationalIssueRef(db, issueRef);
    if (!resolved.ok) return sendJson(res, INTERFACE_NOTE_ERRORS.issue_not_found, { error: "issue_not_found" });
    sendJson(res, 200, { notes: listIssueInterfaceNotes(db, resolved.issue_id) });
  }), { operation: { id: "get:/api/interface-notes", effects: (context) => interfaceNoteEffects(context, "ledger:read"), requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/interface-notes/destinations", route("read", (req, res) => {
    requireIdentity(req);
    const app = interfaceNotesApp(queryString(req, "app"));
    if (app === null) return sendJson(res, INTERFACE_NOTE_ERRORS.invalid_note, { error: "invalid_note", message: "app is mandible, or a project key followed by : and a path" });
    const project = receiving(app);
    const destinations: InterfaceNoteDestinations = project
      ? { project: project.key, issues: listOpenIssuesWithInterfaceNotes(db, project) }
      : { project: null, issues: [] };
    sendJson(res, 200, destinations);
  }), { operation: { id: "get:/api/interface-notes/destinations", effects: (context) => interfaceNoteEffects(context, "ledger:read"), requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/interface-notes/embed-identity", route("write", async (req, res) => {
    requireOperator(db, req);
    const origin = bodyRecord(req).origin;
    const result = await grants.access(typeof origin === "string" ? origin : "");
    if (result.ok) return sendJson(res, 200, result.value);
    if (result.error === "origin_not_granted") {
      return sendJson(res, INTERFACE_NOTE_ERRORS.origin_not_granted, { error: result.error, grant: result.grant });
    }
    sendFailure(res, { code: result.error });
  }), { operation: { id: "post:/api/interface-notes/embed-identity", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/interface-notes/embed-grants", route("read", (req, res) => {
    requireOperator(db, req);
    sendJson(res, 200, { grants: grants.list() });
  }), { operation: { id: "get:/api/interface-notes/embed-grants", effects: (context) => interfaceNoteEffects(context, "ledger:read"), requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.put("/api/interface-notes/embed-grants", route("write", (req, res) => {
    requireOperator(db, req);
    const { project, app } = bodyRecord(req);
    const grant = typeof project === "string" && typeof app === "string" ? grants.allow({ project_id: project, app }) : null;
    if (!grant) return sendFailure(res, { code: "grant_not_found" });
    sendJson(res, 200, grant);
  }), { operation: { id: "put:/api/interface-notes/embed-grants", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.delete("/api/interface-notes/embed-grants", route("write", (req, res) => {
    requireOperator(db, req);
    if (!grants.remove({ project_id: queryString(req, "project") ?? "", app: queryString(req, "app") ?? "" })) return sendFailure(res, { code: "grant_not_found" });
    res.status(204).empty?.();
  }), { operation: { id: "delete:/api/interface-notes/embed-grants", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.post("/api/interface-notes", route("write", (req, res) => {
    requireOperator(db, req);
    send(res, store.create(req.body, embedScope(req)), 201);
  }), { operation: { id: "post:/api/interface-notes", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.post("/api/interface-notes/file", route("write", (req, res) => {
    send(res, store.file(req.body, operatorActor(db, req), embedScope(req)), 201);
  }), { operation: { id: "post:/api/interface-notes/file", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.patch("/api/interface-notes/:id", route("write", (req, res) => {
    send(res, store.updateText(req.params.id, bodyRecord(req).text, operatorActor(db, req), embedScope(req)), 200);
  }), { operation: { id: "patch:/api/interface-notes/:id", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });

  server.delete("/api/interface-notes/:id", route("write", (req, res) => {
    const actor = operatorActor(db, req);
    const commentId = queryString(req, "comment");
    const scope = embedScope(req);
    send(res, commentId === undefined ? store.deleteUnfiled(req.params.id, scope) : store.removeFromComment(req.params.id, commentId, actor, scope), 204);
  }), { operation: { id: "delete:/api/interface-notes/:id", effects: (context) => interfaceNoteEffects(context, "ledger:write"), requestSchema: null, reportingCategory: "ledger" }, fileRpc: "deny" });
}
