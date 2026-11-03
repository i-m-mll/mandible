import { captureReadingPublication, readConversationReadingManifest, readReadingRowBatch, type ReadingRowBatchRequest } from '../conversations/reading-materialization.js';
import { projectDisplayBlock } from '../conversations/display-block.js';
import { packReadingContext, readingMemberKeys } from '../conversations/reading-context.js';
import { DISPLAY_CONTEXT_VERSION, type ConversationDisplayContext } from '../conversations/display-context.js';
import { readDisplayContext } from '../conversations/display-context-read.js';
import type { ConversationSourceEpochs } from "../conversations/source-types.js";
import { updateConversationMetadata } from "../conversations/metadata.js";
import { mapConversation, maskSourceBackedConversationRow } from "../conversations/response-mapping.js";
import { parseSinceQuery, sourceFromQuery } from "../conversations/search-query.js";
import type { LedgerReader } from "../ledger-reads/index.js";
import type { ConversationRow } from "../ledger-reads/conversations.js";
// API routes for the chat log / conversation system.

import { getDb } from "../db.js";
import { entityRefs, resolveSessionRef } from "../entity-refs.js";
import { sessionConversationTarget } from "../session-summary.js";
import {
  ClientAuthzError,
  attributionForRequest,
  managedSessionRoute,
  requireOperator,
} from "../client-auth/authz.js";
import {
  remediationFor,
  scanBlocksForCredentialLeaks,
  hasActiveApiTokenCredentials,
  type CredentialLeakDetection,
} from "../credential-leak-scan.js";
import { triggerFullIngest } from "../ingestion.js";
import { transformContent } from "../transform.js";


import type { RouteRegistrar } from "../server.js";
import { readBody, sendJson } from "./http.js";
import { ConversationSourceReader } from "../conversations/source-reader.js";
import {
  getConversationStructureCache,
  sparseConversationBlockId,
  sparseConversationBlockPosition,
} from "../conversations/structure-cache.js";
import type { SourceBackedConversationBlock } from "../conversations/source-types.js";
import {
  ConversationFreshnessError,
  ensureExactConversationFresh,
  resolveExactConversation,
  type ExactConversationFreshnessOptions,
} from "../conversations/freshness.js";
import type { ResponseLike } from "../server.js";
import { childrenOfConversationSql } from "../conversation-lineage.js";
import type { SessionRegistry } from "../registry.js";
import {
  executeConversationExternalNavigation,
  projectConversationExternalNavigation,
  type ExternalNavigationConversation,
} from "../conversation-external-navigation.js";

// --- Row mapping helpers ---


type PositionTargetKind = "initial" | "latest" | "position" | "block" | "turn";

async function readAllBlocks(
  reader: ConversationSourceReader,
  conversationId: string,
): Promise<{ blocks: SourceBackedConversationBlock[]; bodySource: "source" }> {
  const result = await reader.readAll(conversationId);
  if (result.status !== "source") {
    throw new ConversationFreshnessError("source_unavailable", result.reason);
  }
  return { blocks: result.value, bodySource: result.status };
}

export function sendFreshnessError(res: ResponseLike, error: unknown): boolean {
  if (!(error instanceof ConversationFreshnessError)) return false;
  if (error.code === "freshness_pending") {
    res.header?.("Retry-After", "1");
    sendJson(res, error.status, { error: error.code, code: error.code, message: error.message });
    return true;
  }
  sendJson(res, error.status, {
    error: error.code,
    message: error.message,
    ...(error.candidates.length > 0 ? { candidates: error.candidates } : {}),
  });
  return true;
}

// --- Export helpers ---

function exportToMarkdown(
  conversation: ConversationRow,
  blocks: SourceBackedConversationBlock[],
  blockTypes?: Set<string>,
): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.title}`);
  lines.push("");
  lines.push(`**Source:** ${conversation.source} | **Date:** ${conversation.started_at} | **Model:** ${conversation.model || "unknown"}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const block of blocks) {
    if (blockTypes && !blockTypes.has(block.type)) continue;
    const label = block.role === "user" ? "**User:**" : block.role === "assistant" ? "**Assistant:**" : `**${block.role}:**`;
    if (block.type === "thinking") {
      lines.push(`<details><summary>Thinking</summary>\n\n${block.content}\n\n</details>`);
    } else if (block.type === "tool_use" || block.type === "tool_result") {
      lines.push(`<details><summary>${block.type === "tool_use" ? "Tool Use" : "Tool Result"}</summary>\n\n\`\`\`\n${block.content}\n\`\`\`\n\n</details>`);
    } else {
      lines.push(`${label}\n\n${block.content}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function exportToMdx(
  conversation: ConversationRow,
  blocks: SourceBackedConversationBlock[],
  blockTypes?: Set<string>,
): string {
  const lines: string[] = [];
  lines.push(`<ChatLog source="${conversation.source}" date="${conversation.started_at}">`);

  for (const block of blocks) {
    if (blockTypes && !blockTypes.has(block.type)) continue;

    if (block.type === "user_message") {
      lines.push(`<ChatMessage role="user">`);
      lines.push(block.content);
      lines.push(`</ChatMessage>`);
    } else if (block.type === "assistant_message") {
      const modelAttr = conversation.model ? ` model="${conversation.model}"` : "";
      lines.push(`<ChatMessage role="assistant"${modelAttr}>`);
      lines.push(block.content);
      lines.push(`</ChatMessage>`);
    } else if (block.type === "thinking") {
      lines.push(`<ChatThinking>`);
      lines.push(block.content);
      lines.push(`</ChatThinking>`);
    } else if (block.type === "tool_use") {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(block.metadata_json); } catch { /* ignore */ }
      const nameAttr = metadata.tool_name ? ` name="${metadata.tool_name}"` : "";
      lines.push(`<ToolUse${nameAttr}>`);
      lines.push(block.content);
      lines.push(`</ToolUse>`);
    } else if (block.type === "tool_result") {
      lines.push(`<ToolResult>`);
      lines.push(block.content);
      lines.push(`</ToolResult>`);
    } else if (block.type === "system") {
      lines.push(`<ChatMessage role="system">`);
      lines.push(block.content);
      lines.push(`</ChatMessage>`);
    }
  }

  lines.push(`</ChatLog>`);
  return lines.join("\n");
}

function exportToJson(
  conversation: ConversationRow,
  blocks: SourceBackedConversationBlock[],
  blockTypes?: Set<string>,
): string {
  const filteredBlocks = blockTypes
    ? blocks.filter((b) => blockTypes.has(b.type))
    : blocks;
  return JSON.stringify(
    {
      conversation: mapConversation(conversation),
      blocks: filteredBlocks,
    },
    null,
    2,
  );
}

// --- Route registration ---

export function registerConversationRoutes(
  server: RouteRegistrar,
  reader: LedgerReader,
  sessionRegistry?: SessionRegistry,
  sourceFreshness: Pick<ExactConversationFreshnessOptions, "ingest" | "scheduleReparse"> = {},
): void {
  const db = getDb();
  const sourceReader = new ConversationSourceReader(db);
  const displaySourceReader = new ConversationSourceReader(db, {});
  const ensureFresh = (ref: string, waitForFresh?: boolean) => ensureExactConversationFresh(db, ref, {
    ...sourceFreshness,
    ...(waitForFresh === undefined ? {} : { waitForFresh }),
  });
  const activeDisplayConversations = new Set<string>();
  const freshnessChecksInFlight = new Set<string>();
  const freshnessFailureLoggedAt = new Map<string, number>();
  let selectedConversationFreshnessTimer: ReturnType<typeof setInterval> | null = null;
  let selectedConversationFreshnessTickRunning = false;
  const trackSelectedConversation = (conversationId: string) => {
    if (process.env.MANDIBLE_INSTANCE_ROLE !== "preview") return;
    activeDisplayConversations.delete(conversationId);
    activeDisplayConversations.add(conversationId);
    while (activeDisplayConversations.size > 16) {
      const oldest = activeDisplayConversations.keys().next().value;
      if (oldest === undefined) break;
      activeDisplayConversations.delete(oldest);
      freshnessFailureLoggedAt.delete(oldest);
    }
    if (selectedConversationFreshnessTimer) return;
    // Preview instances intentionally skip root watchers and full reconciliation.
    // Keep recently selected display views fresh with the same bounded extent
    // check and exact-path scheduler used by the request path. This reads source
    // metadata and its tail, never the whole transcript or every source root.
    selectedConversationFreshnessTimer = setInterval(() => {
      if (selectedConversationFreshnessTickRunning) return;
      selectedConversationFreshnessTickRunning = true;
      const activeIds = [...activeDisplayConversations.keys()];
      void Promise.all(activeIds.map(async (activeId) => {
        if (freshnessChecksInFlight.has(activeId)) return;
        freshnessChecksInFlight.add(activeId);
        try {
          await ensureFresh(activeId, false);
          freshnessFailureLoggedAt.delete(activeId);
        } catch (error) {
          const now = Date.now();
          if (now - (freshnessFailureLoggedAt.get(activeId) ?? 0) >= 60_000) {
            freshnessFailureLoggedAt.set(activeId, now);
            console.warn("selected conversation freshness check failed", {
              conversation_id: activeId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          freshnessChecksInFlight.delete(activeId);
        }
      })).catch((error) => {
        console.error("selected conversation freshness tick failed", error);
      }).finally(() => {
        selectedConversationFreshnessTickRunning = false;
      });
    }, 2_000);
    if (typeof selectedConversationFreshnessTimer === "object" && "unref" in selectedConversationFreshnessTimer) {
      selectedConversationFreshnessTimer.unref();
    }
  };

  // --- Static routes MUST be registered before parameterized :id routes ---

  server.get("/api/conversations/resolve-target", (req, res) => {
    const { conversation, session } = req.query;
    if (Boolean(conversation) === Boolean(session)) {
      return sendJson(res, 400, { error: "Supply one conversation or session reference" });
    }
    if (conversation) {
      try {
        const resolved = entityRefs.conversation(conversation, null);
        if (!resolved.ok) return sendJson(res, 200, { status: resolved.error });
        const id = resolveExactConversation(db, resolved.id).conversationId;
        return sendJson(res, 200, { status: "resolved", selection: { type: "conversation", id } });
      } catch (error) {
        if (error instanceof ConversationFreshnessError && error.code === "ambiguous_ref") {
          return sendJson(res, 200, { status: "ambiguous" });
        }
        if (sendFreshnessError(res, error)) return;
        throw error;
      }
    }
    const resolved = resolveSessionRef(db, session!);
    if (resolved.status !== "resolved") return sendJson(res, 200, { status: resolved.status });
    const target = sessionConversationTarget(resolved.resolution.agent_ref ?? resolved.resolution.provider_session_id ?? session!);
    const candidates = db.prepare(`SELECT DISTINCT c.id FROM conversations c WHERE ${target.where} LIMIT 2`)
      .all(...target.params) as Array<{ id: string }>;
    if (candidates.length > 1) return sendJson(res, 200, { status: "ambiguous" });
    if (candidates.length === 1) {
      return sendJson(res, 200, { status: "resolved", selection: { type: "conversation", id: candidates[0].id } });
    }
    const consoleId = resolved.resolution.console_session_id;
    return sendJson(res, 200, consoleId
      ? { status: "resolved", selection: { type: "session", id: consoleId } }
      : { status: "not_found" });
  }, { operation: { id: "get:/api/conversations/resolve-target", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // GET /api/conversations/sources — List ingestion sources with status
  server.get("/api/conversations/sources", (_req, res) => {
    const sources = db
      .prepare(
        `SELECT source,
                COUNT(*) as count,
                MAX(started_at) as latest_started,
                MAX(updated_at) as latest_updated,
                SUM(block_count) as total_blocks,
                SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) as starred_count
         FROM conversations
         GROUP BY source
         ORDER BY count DESC`,
      )
      .all() as Array<{
        source: string;
        count: number;
        latest_started: string;
        latest_updated: string;
        total_blocks: number;
        starred_count: number;
      }>;

    sendJson(res, 200, { sources });
  }, { operation: { id: "get:/api/conversations/sources", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // GET /api/conversations/lineage-gaps — issue 061c5d6. Conversations that
  // are children without a trustworthy parent, optionally only those started
  // since `since`.
  server.get("/api/conversations/lineage-gaps", async (req, res) => {
    const query = req.query ?? {};
    const since = parseSinceQuery(query.since);
    const source = sourceFromQuery(query.provider);
    if (source !== null && source !== "claude_code" && source !== "codex" && source !== "gemini") {
      sendJson(res, 400, { error: "provider must be claude, codex, gemini, or all" });
      return;
    }
    sendJson(res, 200, await reader.run("lineage_gaps", { since, source }));
  }, { operation: { id: "get:/api/conversations/lineage-gaps", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // POST /api/conversations/ingest — Manually trigger re-ingestion
  server.post("/api/conversations/ingest", async (_req, res) => {
    try {
      const result = await triggerFullIngest();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        error: "Ingestion failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, { operation: { id: "post:/api/conversations/ingest", effects: ["ledger:write"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "deny" });

  // POST /api/conversations/scan-credentials — issue 71a287e.
  // On-demand sweep of native transcripts for leaked Mandible credentials.
  // Operator-only: it reports which credentials leaked where and applies the
  // guarded auto-revoke policy to future persisted session-scoped credentials.
  // Current in-memory wrap-session tokens are intentionally invisible here and
  // expire through session liveness plus TTL. The response never contains token
  // material — only credential ids, labels, locations, and remediation.
  server.post("/api/conversations/scan-credentials", async (req, res) => {
    try {
      requireOperator(getDb(), req);
      const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {}) as Record<string, unknown>;
      const scanDb = getDb();
      const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;
      const requestedLimit = typeof body.limit === "number" && body.limit > 0
        ? body.limit : Number.POSITIVE_INFINITY;
      const skipped = hasActiveApiTokenCredentials(scanDb) ? null : "no_active_api_tokens";
      const detections = new Map<string, CredentialLeakDetection>();
      const sourceErrors: Array<{ conversation_id: string; error: string }> = [];
      let scannedSourceBlocks = 0;
      let scannedSourceConversations = 0;
      let sourceTruncated = false;
      if (!skipped) {
        const params: unknown[] = [];
        const where = ["EXISTS (SELECT 1 FROM conversation_sources source WHERE source.conversation_id = c.id)"];
        if (conversationId) {
          where.push("c.id = ?");
          params.push(conversationId);
        }
        const sourceConversations = scanDb.prepare(`
          SELECT c.id, c.title, c.session_id, c.source, c.branch
            FROM conversations c
           WHERE ${where.join(" AND ")}
           ORDER BY c.id
        `).all(...params) as Array<Pick<ConversationRow, "id" | "title" | "session_id" | "source" | "branch">>;
        const rawReader = new ConversationSourceReader(scanDb, { maskCredentials: false });
        for (const conversation of sourceConversations) {
          let offset = 0;
          let scannedConversation = false;
          while (scannedSourceBlocks < requestedLimit) {
            const take = Math.min(100, requestedLimit - scannedSourceBlocks);
            const page = await rawReader.readPage(conversation.id, { offset, limit: take });
            if (page.status !== "source") {
              sourceErrors.push({ conversation_id: conversation.id, error: page.reason });
              break;
            }
            if (page.value.blocks.length === 0) break;
            const scanned = scanBlocksForCredentialLeaks(
              scanDb,
              page.value.blocks.map((block) => ({
                id: block.id,
                position: block.position,
                content: block.content,
                metadata: (() => {
                  try { return JSON.parse(block.metadata_json) as unknown; } catch { return block.metadata_json; }
                })(),
              })),
              {
                conversation_id: conversation.id,
                conversation_title: conversation.title,
                session_id: conversation.session_id,
                source: conversation.source,
                branch: conversation.branch,
              },
              { record: body.record !== false },
            );
            for (const detection of scanned.detections) detections.set(detection.event_id, detection);
            sourceTruncated ||= scanned.truncated;
            scannedSourceBlocks += page.value.blocks.length;
            scannedConversation = true;
            offset += page.value.blocks.length;
            if (offset >= page.value.total) break;
          }
          if (scannedConversation) scannedSourceConversations += 1;
          if (scannedSourceBlocks >= requestedLimit) break;
        }
      }
      sendJson(res, 200, {
        scanned_blocks: scannedSourceBlocks,
        scanned_conversations: scannedSourceConversations,
        truncated: sourceTruncated,
        skipped: skipped,
        source_errors: sourceErrors,
        detections: [...detections.values()].map((detection) => ({
          event_id: detection.event_id,
          detected_at: detection.detected_at,
          credential_id: detection.credential.credential_id,
          credential_label: detection.credential.label,
          user_slug: detection.credential.user_slug,
          session_scoped: detection.credential.session_scoped,
          auto_revoked: detection.revoked,
          new_alert: detection.new_event,
          conversation_id: detection.location.conversation_id,
          conversation_title: detection.location.conversation_title ?? null,
          session_id: detection.location.session_id ?? null,
          provider: detection.location.source ?? null,
          block_position: detection.location.block_position ?? null,
          remediation: remediationFor(detection.credential),
        })),
      });
    } catch (error) {
      if (error instanceof ClientAuthzError) {
        sendJson(res, error.status, { error: error.code, message: error.message });
        return;
      }
      sendJson(res, 500, {
        error: "credential_scan_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  // File RPC is the only daemon transport available to sandboxed CLI callers,
  // and the daemon alone holds the pepper required for verified matching.
  }, { operation: { id: "post:/api/conversations/scan-credentials", effects: ["files:production"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow" });

  // POST /api/conversations/export/transform — AI transform via Claude CLI
  server.post("/api/conversations/export/transform", async (req, res) => {
    const body = readBody<{
      content: string;
      prompt: string;
      timeout_ms?: number;
    }>(req);

    if (!body.content || !body.prompt) {
      sendJson(res, 400, { error: "Missing content or prompt" });
      return;
    }

    try {
      const result = await transformContent({
        content: body.content,
        prompt: body.prompt,
        timeoutMs: body.timeout_ms,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        error: "Transform failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, { operation: { id: "post:/api/conversations/export/transform", effects: ["files:production"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "deny" });

  // GET /api/conversations/sidebar — all matching pins and independently paged Projects and Chats.
  server.get("/api/conversations/sidebar", async (req, res) => {
    const result = await reader.run("conversation_sidebar", { query: req.query ?? {} }, { signal: req.signal });
    if (res.jsonText) res.status(result.status).jsonText!(result.json);
    else sendJson(res, result.status, JSON.parse(result.json));
  }, { operation: { id: "get:/api/conversations/sidebar", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // --- Parameterized routes ---

  // GET /api/conversations — List with pagination, filtering, sorting
  // Query params:
  //   ?exclude_subagents=true — hide conversations that have a parent (sub-agents)
  //   ?group=true — same as exclude_subagents but also includes children_count on parents
  //   ?parent_id=<id> — list only children of a specific parent conversation
  server.get("/api/conversations", async (req, res) => {
    const result = await reader.run("conversation_list", { query: req.query ?? {} }, { signal: req.signal });
    if (res.jsonText) res.status(result.status).jsonText!(result.json);
    else sendJson(res, result.status, JSON.parse(result.json));
  }, { operation: { id: "get:/api/conversations", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // GET /api/conversations/search — Search the normalized conversation index.
  server.get("/api/conversations/search", async (req, res) => {
    const result = await reader.run("conversation_search", { query: req.query ?? {} }, { signal: req.signal });
    if (res.jsonText) res.status(result.status).jsonText!(result.json);
    else sendJson(res, result.status, JSON.parse(result.json));
  }, { operation: { id: "get:/api/conversations/search", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // Exact, server-projected external focus. The destination is re-derived at
  // action time so stale UI capability bytes cannot redirect navigation.
  server.post("/api/conversations/:id/open-external", (req, res) => {
    if (!sessionRegistry) {
      sendJson(res, 503, { error: "External navigation is unavailable" });
      return;
    }
    const id = req.params.id;
    const conversation = id
      ? db.prepare("SELECT id, source, session_id FROM conversations WHERE id = ?").get(id) as ExternalNavigationConversation | undefined
      : undefined;
    if (!conversation) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }
    const result = executeConversationExternalNavigation(db, sessionRegistry, conversation);
    sendJson(res, result.ok ? 200 : 409, result.ok ? result : { error: result.message });
  }, { operation: { id: "post:/api/conversations/:id/open-external", effects: ["process:external"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "deny", refs: { params: { id: entityRefs.conversation } } });

  server.get("/api/conversations/:id/structure", async (req, res) => {
    const requestedRef = req.params.id;
    if (!requestedRef) return sendJson(res, 400, { error: "Missing conversation id" });
    let id: string;
    try {
      id = (await ensureFresh(requestedRef, false)).conversationId;
    } catch (error) {
      if (sendFreshnessError(res, error)) return;
      return sendJson(res, 503, { error: "freshness_error", message: error instanceof Error ? error.message : String(error) });
    }
    const source = db.prepare(`
      SELECT current_version_id, position_space_id, publication_revision, parser_format AS parserFormat, parser_version AS parserVersion,
             normalization_version AS normalizationVersion, redaction_epoch AS redactionEpoch FROM conversation_sources
       WHERE conversation_id = ? AND current_version_id IS NOT NULL
       ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1
    `).get(id) as ({ current_version_id: string; position_space_id: string | null; publication_revision: number } & ConversationSourceEpochs) | undefined;
    if (req.query?.expected_position_space_id && req.query.expected_position_space_id !== source?.position_space_id) {
      return sendJson(res, 409, { error: 'position_space_changed', code: 'position_space_changed', position_space_id: source?.position_space_id ?? null });
    }
    const version = source?.current_version_id ?? null;
    const cached = version === null ? null : getConversationStructureCache(db).readStructure(id, version, source);
    const rows = cached ?? [];
    const expected = db.prepare("SELECT block_count FROM conversations WHERE id = ?")
      .get(id) as { block_count: number } | undefined;
    if (!expected) return sendJson(res, 404, { error: "Conversation not found" });
    if (rows.length !== expected.block_count) {
      return sendJson(res, 409, { error: "freshness_pending", code: "freshness_pending",
        message: "conversation structure is incomplete; retry after indexing" });
    }
    const current = db.prepare(`SELECT current_version_id, position_space_id, publication_revision, parser_format AS parserFormat, parser_version AS parserVersion,
             normalization_version AS normalizationVersion, redaction_epoch AS redactionEpoch FROM conversation_sources
      WHERE conversation_id = ? AND current_version_id IS NOT NULL
      ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`
    ).get(id) as ({ current_version_id: string; position_space_id: string | null; publication_revision: number } & ConversationSourceEpochs) | undefined;
    if ((current?.current_version_id ?? null) !== version
        || current?.publication_revision !== source?.publication_revision
        || current?.position_space_id !== source?.position_space_id) {
      return sendJson(res, 409, { error: "freshness_pending", code: "freshness_pending",
        message: "conversation source changed during structure read" });
    }
    sendJson(res, 200, { conversation_id: id, source_version_id: version,
      position_space_id: source?.position_space_id ?? null, publication_revision: source?.publication_revision ?? 0, total: rows.length,
      rows: rows.map((row) => ({
        id: sparseConversationBlockId(id, row.position),
        position: row.position, type: row.type, role: row.role,
        parent_position: row.parentPosition,
        record_offset: row.recordOffset,
        record_length: row.recordLength,
      })) });
  }, { operation: { id: "get:/api/conversations/:id/structure", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow", refs: { params: { id: entityRefs.conversation } } });

  server.get('/api/conversations/:id/reading-manifest', async (req, res) => {
    let id: string;
    try { id = (await ensureFresh(req.params.id, false)).conversationId; }
    catch (error) {
      if (sendFreshnessError(res, error)) return;
      return sendJson(res, 503, { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) });
    }
    const source = captureReadingPublication(db, id);
    if (!source) return sendJson(res, 409, { status: 'unavailable', reason: 'Source presentation is not published.' });
    if (req.query.expected_position_space_id && req.query.expected_position_space_id !== source.position_space_id) {
      return sendJson(res, 409, { status: 'position-space-changed', positionSpaceId: source.position_space_id });
    }
    const manifest = readConversationReadingManifest(db, id, source);
    if (!manifest) return sendJson(res, 409, { status: 'unavailable', reason: 'Complete presentation index is not available.' });
    return sendJson(res, 200, { status: 'source', manifest });
  }, { operation: { id: 'get:/api/conversations/:id/reading-manifest', effects: ['ledger:read'], requestSchema: null, reportingCategory: null },
    fileRpc: 'allow', refs: { params: { id: entityRefs.conversation } } });

  server.post('/api/conversations/:id/reading-rows', async (req, res) => {
    const request = readBody<ReadingRowBatchRequest>(req);
    if (!request || typeof request.positionSpaceId !== 'string' || !Array.isArray(request.rows)
        || !request.rows.every(row => row && typeof row.key === 'string' && typeof row.revision === 'string')
        || !request.expanded || typeof request.expanded !== 'object' || Array.isArray(request.expanded)
        || !Object.values(request.expanded).every(value => typeof value === 'boolean')
        || (request.streaming !== undefined && typeof request.streaming !== 'boolean')) {
      return sendJson(res, 400, { error: 'Expected a position space, row descriptor identities and disclosure state.' });
    }
    let id: string;
    try { id = (await ensureFresh(req.params.id, false)).conversationId; }
    catch (error) {
      if (sendFreshnessError(res, error)) return;
      return sendJson(res, 503, { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) });
    }
    const result = await readReadingRowBatch({ db, conversationId: id, reader: sourceReader, request });
    return sendJson(res, result.status === 'source' ? 200 : result.status === 'resource-limit' ? 413 : 409, result);
  }, { operation: { id: 'post:/api/conversations/:id/reading-rows', effects: ['ledger:read'], requestSchema: null, reportingCategory: null },
    fileRpc: 'allow', refs: { params: { id: entityRefs.conversation } } });

  // GET /api/conversations/:id — bounded, indexed conversation-position window.
  server.get("/api/conversations/:id", async (req, res) => {
    const requestedRef = req.params.id;
    if (!requestedRef) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    let id: string;
    try {
      id = (await ensureFresh(requestedRef, false)).conversationId;
    } catch (error) {
      if (sendFreshnessError(res, error)) return;
      sendJson(res, 503, { error: "freshness_error", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    const conv = db
      .prepare(`SELECT conversations.*,
        (SELECT archived_at FROM conversation_archive_states archive
          WHERE archive.conversation_id = conversations.id) AS archived_at
        FROM conversations WHERE id = ?`)
      .get(id) as ConversationRow | undefined;
    if (!conv) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }

    const query = req.query ?? {};
    const displayView = query.view === "display";
    if (query.view !== undefined && !displayView) {
      sendJson(res, 400, { error: "view must be display when provided" });
      return;
    }
    if (displayView) trackSelectedConversation(id);

    const requestedLimit = Math.max(1, parseInt(query.limit || "160", 10) || 160);
    let limit = Math.min(500, requestedLimit);
    if (query.target && query.target !== "initial" && query.target !== "latest") {
      sendJson(res, 400, { error: "target must be initial or latest" });
      return;
    }
    const explicitAnchors = [query.block, query.turn, query.position].filter((value) => value !== undefined);
    if (explicitAnchors.length > 1) {
      sendJson(res, 400, { error: "Choose exactly one of block, turn, or position" });
      return;
    }
    let targetKind: PositionTargetKind = query.target === "latest" ? "latest" : "initial";
    let requestedValue: string | number | null = null;
    if (query.block) {
      targetKind = "block";
      requestedValue = query.block;
    } else if (query.turn) {
      targetKind = "turn";
      requestedValue = query.turn;
    } else if (query.position !== undefined) {
      const position = Number(query.position);
      if (!Number.isSafeInteger(position) || position < 0) {
        sendJson(res, 400, { error: "position must be a non-negative integer" });
        return;
      }
      targetKind = "position";
      requestedValue = position;
    }
    let total = conv.block_count;
    let windowOffset = 0;
    let readableBlocks: Array<SourceBackedConversationBlock> = [];
    let bodySource: "source" = "source";
    let resolvedBlock: SourceBackedConversationBlock | null = null;
    let resolvedTurnId: string | null = null;
    let sourceVersionId: string | null = null;
    let positionSpaceId: string | null = null;
    let publicationRevision = 0;
    let readingContext: import("../conversations/reading-context.js").ReadingContextEntry[] = [];
    let displayContext: ConversationDisplayContext = { version: DISPLAY_CONTEXT_VERSION, fragments: [], activity_runs: [], aliases: [], owners: [] };
    {
      const source = db.prepare(`
        SELECT current_version_id, position_space_id, publication_revision, parser_format AS parserFormat, parser_version AS parserVersion,
             normalization_version AS normalizationVersion, redaction_epoch AS redactionEpoch FROM conversation_sources
         WHERE conversation_id = ? AND current_version_id IS NOT NULL
         ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1
      `).get(id) as ({ current_version_id: string; position_space_id: string | null; publication_revision: number } & ConversationSourceEpochs) | undefined;
      sourceVersionId = source?.current_version_id ?? null;
      positionSpaceId = source?.position_space_id ?? null;
      publicationRevision = source?.publication_revision ?? 0;
      if (query.expected_position_space_id && query.expected_position_space_id !== positionSpaceId) {
        return sendJson(res, 409, { error: 'position_space_changed', code: 'position_space_changed', position_space_id: positionSpaceId });
      }
      const structureCache = getConversationStructureCache(db);
      const cachedTotal = source
        ? structureCache.blockCount(id, source.current_version_id, source)
        : null;
      const retainedTotal = cachedTotal ?? 0;
      if (cachedTotal !== null) total = cachedTotal;
      if (query.limit === undefined && (targetKind === "initial" || targetKind === "latest")
          && source && cachedTotal !== null && cachedTotal === retainedTotal && total > 0) {
        const turnStart = structureCache.turnWindowStart(id, source.current_version_id, total - 1, source);
        const completeTurnSize = turnStart === null ? null : total - turnStart;
        if (completeTurnSize !== null && completeTurnSize <= 500) {
          limit = Math.max(limit, completeTurnSize);
        }
      }
      let anchorPosition = targetKind === "initial" || targetKind === "latest"
        ? null
        : total > 0 ? total - 1 : null;
      if (targetKind === "position") {
        anchorPosition = Number(requestedValue);
      } else if (targetKind === "block" || targetKind === "turn") {
        const sparsePosition = typeof requestedValue === "string"
          ? sparseConversationBlockPosition(id, requestedValue)
          : null;
        anchorPosition = sparsePosition;
      }
      const emptyInitial = retainedTotal === 0 && (targetKind === "initial" || targetKind === "latest");
      if (!emptyInitial && targetKind !== "initial" && targetKind !== "latest"
          && (anchorPosition === null || anchorPosition < 0 || anchorPosition >= total)) {
        sendJson(res, 404, { error: `${targetKind === "turn" ? "Turn" : targetKind === "block" ? "Block" : "Position"} anchor not found` });
        return;
      }
      windowOffset = emptyInitial
        ? 0
        : targetKind === "initial" || targetKind === "latest"
        ? Math.max(0, retainedTotal - limit)
        : Math.max(0, anchorPosition! - Math.floor((limit - 1) / 2));
      const sourcePage = await (displayView && source ? displaySourceReader : sourceReader)
        .readPage(id, { offset: windowOffset, limit, expectedSourceVersionId: sourceVersionId ?? undefined });
      if (sourcePage.status !== "source") {
        if (sourcePage.status === "stale") {
          // The source can append after the pre-read extent check. Reconcile
          // that race through the same exact-path freshness boundary instead
          // of exposing a raw reader 409 for a normal active Chat.
          try {
            await ensureFresh(id, false);
            // An exact-path actor may finish between the failed page read and
            // this check. The request's window/anchor was computed against the
            // prior version, so let the client retry the whole selected read.
            sendFreshnessError(res, new ConversationFreshnessError(
              "freshness_pending", "conversation source refreshed; retry selected window",
            ));
            return;
          } catch (error) {
            if (sendFreshnessError(res, error)) return;
            sendJson(res, 503, { error: "freshness_error", message: error instanceof Error ? error.message : String(error) });
            return;
          }
        }
        sendJson(res, sourcePage.status === "not_found" ? 404 : 409, {
          error: sourcePage.reason,
          status: sourcePage.status,
        });
        return;
      }
      const currentPublication = db.prepare(`SELECT current_version_id, position_space_id, publication_revision FROM conversation_sources WHERE conversation_id = ? ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`).get(id) as { current_version_id: string; position_space_id: string; publication_revision: number } | undefined;
      if (sourcePage.sourceVersionId !== sourceVersionId || currentPublication?.publication_revision !== publicationRevision
          || currentPublication?.position_space_id !== positionSpaceId) {
        const changed = currentPublication?.position_space_id !== positionSpaceId;
        return sendJson(res, 409, { error: changed ? 'position_space_changed' : 'freshness_pending',
          code: changed ? 'position_space_changed' : 'freshness_pending', position_space_id: currentPublication?.position_space_id ?? null });
      }
      readableBlocks = sourcePage.value.blocks;
      if (source && readableBlocks.length) {
        const context = structureCache.readReadingContext(id, source.current_version_id, readableBlocks[0].position, readableBlocks[readableBlocks.length - 1].position, source);
        if (!context || context.length !== readableBlocks.length) return sendJson(res, 409, { error: 'freshness_pending', code: 'freshness_pending', message: 'Source reading context is incomplete.' });
        readingContext = context;
        const plan = structureCache.readDisplayContext(id, source.current_version_id, readableBlocks.map(block => block.position), source);
        if (!plan) return sendJson(res, 409, { error: 'freshness_pending', code: 'freshness_pending', message: 'Source display context is incomplete.' });
        const display = await readDisplayContext({ plan, conversationId: id, sourceVersionId: source.current_version_id,
          blockCount: sourcePage.value.total, reader: sourceReader,
          actionScope: position => {
            const scope = structureCache.readReadingContext(id, source.current_version_id, position, position, source)?.[0]?.action_scope;
            if (!scope) throw new Error('Display owner omitted its canonical action scope.');
            return scope;
          } });
        if (display.status !== 'source') return sendJson(res, 409, { error: display.reason, code: 'freshness_pending' });
        const finalPublication = db.prepare(`SELECT current_version_id,position_space_id,publication_revision FROM conversation_sources
          WHERE conversation_id = ? ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`)
          .get(id) as { current_version_id: string; position_space_id: string; publication_revision: number } | undefined;
        if (!finalPublication || finalPublication.current_version_id !== source.current_version_id
            || finalPublication.position_space_id !== positionSpaceId || finalPublication.publication_revision !== publicationRevision) {
          const changed = finalPublication?.position_space_id !== positionSpaceId;
          return sendJson(res, 409, { error: changed ? 'position_space_changed' : 'freshness_pending',
            code: changed ? 'position_space_changed' : 'freshness_pending', position_space_id: finalPublication?.position_space_id ?? null,
            message: 'Source changed during display context read.' });
        }
        displayContext = display.value;
      }
      bodySource = sourcePage.status;
      if (sourcePage.status === "source" && sourcePage.sourceVersionId) {
        sourceVersionId = sourcePage.sourceVersionId;
      }
      total = sourcePage.value.total;
      if (targetKind === "initial" || targetKind === "latest") {
        anchorPosition = readableBlocks[readableBlocks.length - 1]?.position ?? null;
      }
      resolvedBlock = anchorPosition === null
        ? null
        : readableBlocks.find((block) => block.position === anchorPosition) ?? null;
      if (!resolvedBlock && total > 0) {
        sendJson(res, 404, { error: `${targetKind === "turn" ? "Turn" : targetKind === "block" ? "Block" : "Position"} anchor not found` });
        return;
      }
      const cachedTurnPosition = anchorPosition !== null && source && cachedTotal !== null
        ? structureCache.turnPosition(id, source.current_version_id, anchorPosition, source)
        : null;
      if (cachedTurnPosition !== null) {
        resolvedTurnId = sparseConversationBlockId(id, cachedTurnPosition);
      } else if (resolvedBlock?.type === "user_message") {
        resolvedTurnId = resolvedBlock.id;
      } else if (anchorPosition !== null) {
        const preceding = readableBlocks.filter((block) => block.position <= anchorPosition);
        const previousUser = [...preceding].reverse()
          .find((block) => block.type === "user_message")?.position ?? -1;
        resolvedTurnId = preceding.find((block) =>
          block.position > previousUser && block.type !== "user_message"
        )?.id ?? resolvedBlock?.id ?? null;
      }
      if (targetKind === "turn" && resolvedTurnId !== requestedValue) {
        sendJson(res, 404, { error: "Turn anchor not found" });
        return;
      }
    }

    // Fetch sub-agent (child) conversations — Bug: d0759d1
    const children = db
      .prepare(
        `SELECT id, title, block_count, started_at, ended_at, source, model,
                agent_id, is_sidechain, source_mtime, updated_at
         FROM conversations child
         WHERE ${childrenOfConversationSql("child")}
         ORDER BY started_at ASC`
      )
      .all(id) as Array<{
        id: string;
        title: string;
        block_count: number;
        started_at: string;
        ended_at: string | null;
        source: string;
        model: string | null;
        agent_id: string | null;
        is_sidechain: number;
        source_mtime: number;
        updated_at: string;
      }>;

    // Compute duration for each child
    const childrenWithDuration = children.map((child) => {
      let duration_seconds: number | null = null;
      if (child.started_at && child.ended_at) {
        const start = Date.parse(child.started_at);
        const end = Date.parse(child.ended_at);
        if (!Number.isNaN(start) && !Number.isNaN(end)) {
          duration_seconds = Math.round((end - start) / 1000);
        }
      }
      const activeCutoff = Date.now() - 30_000;
      return {
        id: child.id,
        title: child.title,
        block_count: child.block_count,
        started_at: child.started_at,
        ended_at: child.ended_at,
        source: child.source,
        model: child.model,
        agent_id: child.agent_id ?? null,
        is_sidechain: child.is_sidechain === 1,
        status: child.source_mtime >= activeCutoff ? "active" : "finished",
        duration_seconds,
      };
    });

    const parent = conv.parent_conversation_id
      ? db
        .prepare("SELECT id, title FROM conversations WHERE id = ?")
        .get(conv.parent_conversation_id) as { id: string; title: string } | undefined
      : undefined;

    const startPosition = readableBlocks[0]?.position ?? null;
    const endPosition = readableBlocks[readableBlocks.length - 1]?.position ?? null;
    const externalNavigation = projectConversationExternalNavigation(db, [conv]).get(conv.id);
    const mapped = mapConversation(maskSourceBackedConversationRow(conv), externalNavigation);
    mapped.children_count = children.length;
    const hasBefore = startPosition !== null && startPosition > 0;
    const afterCount = endPosition === null ? 0 : Math.max(0, total - endPosition - 1);

    sendJson(res, 200, {
      conversation: mapped,
      body_source: bodySource,
      source_version_id: sourceVersionId,
      position_space_id: positionSpaceId,
      publication_revision: publicationRevision,
      reading_context: packReadingContext(readingContext),
      display_context: displayContext,
      children: childrenWithDuration,
      parent: parent ?? null,
      revision: conv.block_count,
      total,
      target: {
        kind: targetKind,
        requested_value: requestedValue,
        position: resolvedBlock?.position ?? null,
        block_id: resolvedBlock?.id ?? null,
        turn_id: resolvedTurnId,
      },
      window: {
        start_position: startPosition,
        end_position: endPosition,
        has_before: hasBefore,
        has_after: afterCount > 0,
        after_count: afterCount,
        limit,
      },
      blocks: readableBlocks.map((block) => displayView
        ? projectDisplayBlock(block)
        : block),
    });
  }, { operation: { id: "get:/api/conversations/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow", refs: { params: { id: entityRefs.conversation } } });

  // GET /api/conversations/:id/forks — Fork points in the conversation DAG
  // Bug: 40f0298 — DAG branching: identify points where the conversation branches
  server.get("/api/conversations/:id/forks", async (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    const conv = db
      .prepare("SELECT id FROM conversations WHERE id = ?")
      .get(id) as { id: string } | undefined;
    if (!conv) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }

    {
      const read = await sourceReader.readAll(id);
      if (read.status !== "source") {
        sendJson(res, read.status === "not_found" ? 404 : 409, {
          error: read.reason,
          status: read.status,
        });
        return;
      }
      const blocks = read.value;
      const childrenByParent = new Map<string, string[]>();
      const counts = new Map<string, number>();
      const previews = new Map<string, string>();
      for (const block of blocks) {
        if (block.dag_uuid) counts.set(block.dag_uuid, (counts.get(block.dag_uuid) ?? 0) + 1);
        if (!block.dag_parent_uuid || !block.dag_uuid) continue;
        const children = childrenByParent.get(block.dag_parent_uuid) ?? [];
        if (!children.includes(block.dag_uuid)) children.push(block.dag_uuid);
        childrenByParent.set(block.dag_parent_uuid, children);
        const previewKey = `${block.dag_parent_uuid}\0${block.dag_uuid}`;
        if (!previews.has(previewKey)
            && (block.type === "assistant_message" || block.role === "assistant")) {
          previews.set(previewKey, block.content.slice(0, 60));
        }
      }
      const forks = [...childrenByParent.entries()]
        .filter(([, children]) => children.length > 1)
        .map(([parent, children]) => ({
          parent_dag_uuid: parent,
          branches: children.map((dagUuid) => ({
            dag_uuid: dagUuid,
            first_text: previews.get(`${parent}\0${dagUuid}`) ?? "",
            block_count: counts.get(dagUuid) ?? 0,
          })),
        }));
      sendJson(res, 200, { forks });
      return;
    }

  }, { operation: { id: "get:/api/conversations/:id/forks", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow", refs: { params: { id: entityRefs.conversation } } });

  // POST /api/conversations/:id/fork — Fork a conversation at a specific message
  // Bug: 40f0298 — DAG branching: create a new session by forking at a message
  server.post("/api/conversations/:id/fork", managedSessionRoute(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    const body = readBody<{ message_dag_uuid: string }>(req);
    if (!body.message_dag_uuid) {
      sendJson(res, 400, { error: "Missing message_dag_uuid" });
      return;
    }

    const conv = db
      .prepare("SELECT session_id FROM conversations WHERE id = ?")
      .get(id) as { session_id: string | null } | undefined;
    if (!conv) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }
    if (!conv.session_id) {
      sendJson(res, 400, { error: "Conversation has no session_id" });
      return;
    }

    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      if (typeof sdk.forkSession !== "function") {
        sendJson(res, 501, { error: "SDK does not support forkSession" });
        return;
      }
      const result = await sdk.forkSession(conv.session_id, {
        upToMessageId: body.message_dag_uuid,
      });
      sendJson(res, 200, { session_id: result.sessionId });
    } catch (error) {
      sendJson(res, 500, {
        error: "Fork failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }), { operation: { id: "post:/api/conversations/:id/fork", effects: ["provider:send"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "deny", refs: { params: { id: entityRefs.conversation } } });

  // GET /api/conversations/:id/blocks — Blocks with type filtering and pagination
  server.get("/api/conversations/:id/blocks", async (req, res) => {
    const requestedRef = req.params.id;
    if (!requestedRef) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    let id: string;
    try {
      id = (await ensureFresh(requestedRef)).conversationId;
    } catch (error) {
      if (sendFreshnessError(res, error)) return;
      sendJson(res, 503, { error: "freshness_error", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    // Verify conversation exists
    const conv = db
      .prepare("SELECT id FROM conversations WHERE id = ?")
      .get(id) as { id: string } | undefined;
    if (!conv) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }

    const query = req.query ?? {};
    const page = Math.max(1, parseInt(query.page || "1", 10) || 1);
    const requestedLimit = Math.max(1, parseInt(query.limit || "100", 10) || 100);
    const limit = Math.min(500, requestedLimit);
    const offsetRaw = parseInt(query.offset || "", 10);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0
      ? offsetRaw
      : (page - 1) * limit;

    // Filter by block type(s)
    let types: string[] | undefined;
    if (query.type) {
      types = query.type.split(",").map((t) => t.trim()).filter(Boolean);
    }
    const result = await sourceReader.readPage(id, { offset, limit, types });
    if (result.status !== "source") {
      sendJson(res, result.status === "not_found" ? 404 : 409, { error: result.reason, status: result.status });
      return;
    }
    const blocks = result.value.blocks;
    const total = result.value.total;

    sendJson(res, 200, {
      blocks,
      body_source: result.status,
      total,
      offset,
      page: Math.floor(offset / limit) + 1,
      limit,
      requested_limit: requestedLimit,
      cap: 500,
      pages: Math.ceil(total / limit),
      truncated: offset + blocks.length < total,
    });
  }, { operation: { id: "get:/api/conversations/:id/blocks", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow", refs: { params: { id: entityRefs.conversation } } });

  // PATCH /api/conversations/:id — Update durable Mandible-owned metadata.
  server.patch("/api/conversations/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    const body = readBody<Record<string, unknown>>(req);
    try {
      const result = updateConversationMetadata(db, id, body, { actor: { actor_type: "mandible_user", attribution: attributionForRequest(db, req) } });
      if (!result) {
        sendJson(res, 404, { error: "Conversation not found" });
        return;
      }
      sendJson(res, 200, result.updated ? mapConversation(result.updated) : { id, archived_at: result.archivedAt });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid metadata update" });
    }
  }, { operation: { id: "patch:/api/conversations/:id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow", refs: { params: { id: entityRefs.conversation } } });

  // POST /api/conversations/:id/export — Export selected blocks to markdown/MDX/JSON.
  // File RPC is allowed only on this exact read-only projection; POST carries
  // formatting/filter input and does not authorize adjacent conversation mutations.
  server.post("/api/conversations/:id/export", async (req, res) => {
    const requestedRef = req.params.id;
    if (!requestedRef) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    let id: string;
    try {
      id = (await ensureFresh(requestedRef)).conversationId;
    } catch (error) {
      if (sendFreshnessError(res, error)) return;
      sendJson(res, 503, { error: "freshness_error", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    const body = readBody<{
      format?: "markdown" | "mdx" | "json";
      block_types?: string[];
      block_ids?: string[];
      speaker_run_start?: number;
      expected_position_space_id?: string;
    }>(req);

    const format = body.format || "markdown";
    if (!["markdown", "mdx", "json"].includes(format)) {
      sendJson(res, 400, { error: "Invalid format. Use: markdown, mdx, json" });
      return;
    }

    const conv = db
      .prepare(`SELECT conversations.*,
        (SELECT archived_at FROM conversation_archive_states archive
          WHERE archive.conversation_id = conversations.id) AS archived_at
        FROM conversations WHERE id = ?`)
      .get(id) as ConversationRow | undefined;
    if (!conv) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }

    const publication = db.prepare(`SELECT current_version_id, position_space_id, parser_format AS parserFormat, parser_version AS parserVersion, normalization_version AS normalizationVersion, redaction_epoch AS redactionEpoch FROM conversation_sources WHERE conversation_id = ?
      ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`).get(id) as ({ current_version_id: string; position_space_id: string } & ConversationSourceEpochs) | undefined;
    if (body.expected_position_space_id && body.expected_position_space_id !== publication?.position_space_id) {
      return sendJson(res, 409, { code: 'position_space_changed', error: 'position_space_changed', position_space_id: publication?.position_space_id ?? null });
    }
    let range: { start: number; end: number } | undefined;
    if (body.speaker_run_start !== undefined) {
      if (!Number.isSafeInteger(body.speaker_run_start) || body.speaker_run_start < 0 || !body.expected_position_space_id) return sendJson(res, 400, { error: 'A speaker run requires a canonical start and expected position space.' });
      const context = publication ? getConversationStructureCache(db).readReadingContext(id, publication.current_version_id, body.speaker_run_start, body.speaker_run_start, publication)?.[0] : null;
      if (!context || context.action_scope.start !== body.speaker_run_start) return sendJson(res, 409, { error: 'scope_unavailable', code: 'scope_unavailable' });
      range = context.action_scope;
    }
    const selected = body.block_ids ? new Set(body.block_ids) : null;
    if (selected) {
      const positions = [...selected].map(ref => sparseConversationBlockPosition(id, ref));
      if (positions.some(position => position === null) || positions.length === 0) return sendJson(res, 400, { error: 'Invalid block selection' });
      range = { start: Math.min(...positions as number[]), end: Math.max(...positions as number[]) };
    }
    let readable: Awaited<ReturnType<typeof readAllBlocks>>;
    try {
      if (range) {
        const result = await sourceReader.readRange(id, range.start, range.end, { expectedSourceVersionId: publication?.current_version_id });
        if (result.status !== 'source') return sendJson(res, 409, { error: 'source_unavailable', message: result.reason });
        readable = { blocks: result.value, bodySource: 'source' };
      } else readable = await readAllBlocks(sourceReader, id);
    } catch (error) {
      if (sendFreshnessError(res, error)) return;
      return sendJson(res, 503, { error: 'freshness_error', message: error instanceof Error ? error.message : String(error) });
    }
    const currentSpace = db.prepare('SELECT position_space_id FROM conversation_sources WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1').get(id) as { position_space_id: string } | undefined;
    if (currentSpace?.position_space_id !== publication?.position_space_id) return sendJson(res, 409, { error: 'position_space_changed', code: 'position_space_changed', position_space_id: currentSpace?.position_space_id ?? null });
    const blocks = selected ? readable.blocks.filter(block => selected.has(block.id)) : readable.blocks;

    const blockTypes = body.block_types ? new Set(body.block_types) : undefined;

    let output: string;
    let contentType: string;

    const exportConversation = maskSourceBackedConversationRow(conv);

    if (format === "mdx") {
      output = exportToMdx(exportConversation, blocks, blockTypes);
      contentType = "text/mdx";
    } else if (format === "json") {
      output = exportToJson(exportConversation, blocks, blockTypes);
      contentType = "application/json";
    } else {
      output = exportToMarkdown(exportConversation, blocks, blockTypes);
      contentType = "text/markdown";
    }

    sendJson(res, 200, {
      format,
      content_type: contentType,
      content: output,
      block_count: blockTypes
        ? blocks.filter((b) => blockTypes.has(b.type)).length
        : blocks.length,
      body_source: readable!.bodySource,
      covered_member_keys: [...new Set(blocks.flatMap(block => {
        const metadata = JSON.parse(block.metadata_json) as { chat_item?: import('../parsers/types.js').ChatItem; client_intent_id?: string };
        return metadata.chat_item ? readingMemberKeys(metadata.chat_item, metadata.client_intent_id) : [];
      }))],
    });
  }, { operation: { id: "post:/api/conversations/:id/export", effects: ["files:production"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow", refs: { params: { id: entityRefs.conversation } } });

}
