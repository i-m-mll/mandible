import type { Db } from "../db.js";
import { getDb } from "../db.js";
import { ClientAuthzError, requireOperator } from "../client-auth/authz.js";
import { ConversationCustodyStore, CustodyError } from "../conversations/custody-store.js";
import type { CustodyProvider } from "../conversations/custody-types.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { readBody, sendJson } from "./http.js";

interface ConversationCustodyRow {
  id: string;
  source: string;
  source_path: string;
  session_id: string;
  starred: number;
  tags: string;
  notes: string | null;
}

function bodyRecord(req: RequestLike): Record<string, unknown> {
  return readBody<Record<string, unknown>>(req);
}

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError || error instanceof CustodyError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  sendJson(res, 500, { error: error instanceof Error ? error.message : String(error), code: "custody_internal_error" });
}

function requireConversation(db: Db, id: string): ConversationCustodyRow {
  const row = db.prepare("SELECT id, source, source_path, session_id, starred, tags, notes FROM conversations WHERE id = ?")
    .get(id) as ConversationCustodyRow | undefined;
  if (!row) throw new CustodyError("conversation not found", "conversation_not_found", 404);
  if (!new Set(["claude_code", "codex", "gemini"]).has(row.source)) {
    throw new CustodyError(`provider does not support custody capture: ${row.source}`, "unsupported_provider", 422);
  }
  return row;
}

/**
 * Exact-byte custody endpoints. Raw files are only returned as filesystem
 * archive/staging paths; no endpoint streams custody bytes into the browser,
 * ordinary conversation export, or SSE.
 */
export function registerConversationCustodyRoutes(
  router: RouteRegistrar,
  db: Db = getDb(),
  store = new ConversationCustodyStore(),
): void {
  router.get("/api/conversations/:id/custody", (req, res) => {
    try {
      requireConversation(db, req.params.id);
      sendJson(res, 200, { status: store.status(req.params.id) });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/conversations/:id/custody/capture", (req, res) => {
    try {
      requireOperator(db, req);
      const conversation = requireConversation(db, req.params.id);
      const body = bodyRecord(req);
      const result = store.capture({
        conversation_id: conversation.id,
        provider: conversation.source as CustodyProvider,
        source_path: conversation.source_path,
        session_id: conversation.session_id,
      }, {
        rewind: body.rewind === true,
        seal: body.seal !== false,
      });
      sendJson(res, result.reused ? 200 : 201, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/conversations/:id/custody/verify", (req, res) => {
    try {
      requireOperator(db, req);
      requireConversation(db, req.params.id);
      const body = bodyRecord(req);
      const result = store.verifyVersion(req.params.id, typeof body.version === "string" ? body.version : undefined);
      sendJson(res, result.ok ? 200 : 409, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/conversations/:id/custody/archive", (req, res) => {
    try {
      requireOperator(db, req);
      const conversation = requireConversation(db, req.params.id);
      const body = bodyRecord(req);
      if (typeof body.destination !== "string" || !body.destination) throw new CustodyError("destination is required", "invalid_request");
      const annotations = {
        starred: conversation.starred === 1,
        tags: JSON.parse(conversation.tags) as unknown,
        notes: conversation.notes,
      };
      sendJson(res, 201, { archive_path: store.exportArchive(conversation.id, body.destination, annotations) });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/conversations/:id/custody/stage-restore", (req, res) => {
    try {
      requireOperator(db, req);
      requireConversation(db, req.params.id);
      const body = bodyRecord(req);
      if (typeof body.staging_root !== "string" || typeof body.provider_root !== "string") {
        throw new CustodyError("staging_root and provider_root are required", "invalid_request");
      }
      sendJson(res, 201, store.stageProviderRestore(req.params.id, body.staging_root, body.provider_root));
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/conversation-custody/import", (req, res) => {
    try {
      requireOperator(db, req);
      const body = bodyRecord(req);
      if (typeof body.archive_root !== "string" || !body.archive_root) throw new CustodyError("archive_root is required", "invalid_request");
      sendJson(res, 201, store.importArchive(body.archive_root));
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });
}

