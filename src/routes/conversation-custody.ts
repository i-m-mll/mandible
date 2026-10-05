import type { Db } from "../db.js";
import { getDb } from "../db.js";
import { ClientAuthzError, requireOperator } from "../client-auth/authz.js";
import { ConversationCustodyStore, CustodyError } from "../conversations/custody-store.js";
import type { CustodyProvider } from "../conversations/custody-types.js";
import { ConversationSourceStore } from "../conversations/source-store.js";
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

function isMissingSourceSchema(error: unknown): boolean {
  return error instanceof Error && /no such table: conversation_sources/i.test(error.message);
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
  const sourceStore = new ConversationSourceStore(db);

  router.get("/api/conversations/:id/custody", (req, res) => {
    try {
      requireConversation(db, req.params.id);
      sendJson(res, 200, { status: store.status(req.params.id) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/conversations/:id/custody", effects: ["files:production"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/conversations/:id/custody/capture", (req, res) => {
    try {
      requireOperator(db, req);
      const conversation = requireConversation(db, req.params.id);
      const source = (() => {
        try {
          return sourceStore.resolveConversation(conversation.id);
        } catch (error) {
          if (!isMissingSourceSchema(error)) throw error;
          // Narrow pre-v140 fixtures retain the conversation-row fallback.
          return null;
        }
      })();
      if (!source?.currentVersionId) {
        throw new CustodyError("conversation has no current sealed source version", "source_version_mismatch", 409);
      }
      const sourceVersion = sourceStore.resolveVersion(source.currentVersionId);
      if (
        !sourceVersion
        || sourceVersion.sourceId !== source.sourceId
        || sourceVersion.generation !== "sealed_sha256"
        || sourceVersion.availability !== "available"
        || !/^[0-9a-f]{64}$/.test(sourceVersion.contentSha256)
      ) {
        throw new CustodyError("current conversation source version is not sealed and available", "source_version_mismatch", 409);
      }
      const availableAlias = source
        ? sourceStore.listAliases(source.sourceId).find((alias) => alias.availability === "available")
        : null;
      const body = bodyRecord(req);
      const result = store.capture({
        conversation_id: conversation.id,
        provider: conversation.source as CustodyProvider,
        source_path: availableAlias?.path ?? conversation.source_path,
        session_id: conversation.session_id,
        native_identities: source
          ? [source.nativeSessionId, ...(source.currentVersionId ? [source.currentVersionId] : [])]
          : undefined,
        expected_source_version_id: sourceVersion.id,
        expected_source_sha256: sourceVersion.contentSha256,
      }, {
        rewind: body.rewind === true,
        seal: body.seal !== false,
      });
      const currentSource = sourceStore.resolveConversation(conversation.id);
      if (currentSource?.currentVersionId !== sourceVersion.id) {
        throw new CustodyError("conversation source version changed during custody capture", "source_version_mismatch", 409);
      }
      const currentVersion = sourceStore.resolveVersion(currentSource.currentVersionId);
      if (
        !currentVersion
        || currentVersion.sourceId !== currentSource.sourceId
        || currentVersion.generation !== "sealed_sha256"
        || currentVersion.contentSha256 !== sourceVersion.contentSha256
      ) {
        throw new CustodyError("conversation source version changed during custody capture", "source_version_mismatch", 409);
      }
      if (currentSource.currentVersionId) {
        const attached = sourceStore.updateVersionCustody({
          sourceId: currentSource.sourceId,
          sourceVersionId: currentSource.currentVersionId,
          sourceContentSha256: currentVersion.contentSha256,
          custodyState: result.status.state,
          custodyRef: result.version_path,
          captureConsistency: result.manifest.capture_consistency,
          verification: {
            custody_version: result.manifest.custody_version,
            provider_adapter_version: result.manifest.provider_adapter_version,
            restore_capability: result.manifest.restore.capability,
          },
        });
        if (!attached) {
          throw new CustodyError("conversation source version changed before custody evidence attachment", "source_version_mismatch", 409);
        }
      }
      sendJson(res, result.reused ? 200 : 201, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/conversations/:id/custody/capture", effects: ["files:production"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow" });

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
  }, { operation: { id: "post:/api/conversations/:id/custody/verify", effects: ["files:production"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow" });

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
  }, { operation: { id: "post:/api/conversations/:id/custody/archive", effects: ["files:production"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow" });

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
  }, { operation: { id: "post:/api/conversations/:id/custody/stage-restore", effects: ["files:production"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow" });

  router.post("/api/conversation-custody/import", (req, res) => {
    try {
      requireOperator(db, req);
      const body = bodyRecord(req);
      if (typeof body.archive_root !== "string" || !body.archive_root) throw new CustodyError("archive_root is required", "invalid_request");
      sendJson(res, 201, store.importArchive(body.archive_root));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/conversation-custody/import", effects: ["files:production"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow" });
}
