import { updateConversationMetadata } from "../conversations/metadata.js";
import { mapConversation, maskSourceBackedConversationRow } from "../conversations/response-mapping.js";
import { parseSinceQuery, sourceFromQuery } from "../conversations/search-query.js";
import type { LedgerReader } from "../ledger-reads/index.js";
import type { ConversationRow } from "../ledger-reads/conversations.js";
// API routes for the chat log / conversation system.

import { getDb } from "../db.js";
import { entityRefs, resolveSessionRef } from "../entity-refs.js";
import { sessionAliasIds } from "../session-liveness.js";
import { sessionConversationsSql } from "../session-summary.js";
import { decompressContent, decompressContentAsync } from "../compression.js";
import {
  ClientAuthzError,
  attributionForRequest,
  operatorOnlyManagedSessionRoute,
  requireOperator,
} from "../client-auth/authz.js";
import {
  backfillCredentialLeakScan,
  remediationFor,
  scanBlocksForCredentialLeaks,
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

interface BlockRow {
  id: string;
  conversation_id: string;
  type: string;
  role: string;
  content: Buffer | string;
  compressed: number;
  position: number;
  timestamp: string | null;
  parent_id: string | null;
  metadata_json: string;
  dag_uuid: string | null;
  dag_parent_uuid: string | null;
}


// Bug: bce7370 — return metadata_json as a raw string so the client type
// ConversationBlock.metadata_json (string) receives the correct field name.
// Previously returned as `metadata` (parsed object), which left the client's
// `block.metadata_json` undefined, causing all tool-use metadata to be empty.
function mapBlock(row: BlockRow) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    type: row.type,
    role: row.role,
    // Bug: e5a945d — transparently decompress gzipped content
    content: decompressContent(row.content, row.compressed === 1),
    position: row.position,
    timestamp: row.timestamp,
    parent_id: row.parent_id,
    metadata_json: row.metadata_json,
    dag_uuid: row.dag_uuid ?? null,
    dag_parent_uuid: row.dag_parent_uuid ?? null,
  };
}

function mapReadableBlock(row: BlockRow | SourceBackedConversationBlock) {
  return "compressed" in row ? mapBlock(row) : row;
}

function projectDisplayBlock(row: SourceBackedConversationBlock): SourceBackedConversationBlock & { details_loaded?: false } {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    throw new Error(`block ${row.id} has invalid metadata and cannot be safely projected`);
  }
  const item = metadata.chat_item;
  const activity = item && typeof item === "object" && !Array.isArray(item)
    && (item as Record<string, unknown>).type === "activity";
  const targeted = row.type === "tool_use" || row.type === "tool_result" || row.type === "thinking" || activity;
  if (!targeted) return row;
  const reasoningSummary = row.type === "thinking" && metadata.source_event_type === "reasoning_summary";
  const reasoningLines = reasoningSummary
    ? row.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  if (reasoningSummary) metadata.display_has_body = reasoningLines.length > 1;
  delete metadata.tool_input;
  delete metadata.tool_output;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const compactItem = { ...(item as Record<string, unknown>) };
    delete compactItem.input;
    delete compactItem.output;
    if (reasoningSummary) {
      compactItem.parts = reasoningLines.length > 0 ? [{ type: "text", text: reasoningLines[0] }] : [];
    } else if (row.type === "thinking") {
      compactItem.parts = [];
    } else if (row.type === "tool_use" || row.type === "tool_result" || activity) {
      compactItem.parts = [];
    }
    metadata.chat_item = compactItem;
  }

  const content = reasoningSummary
    ? (reasoningLines[0] ?? "")
    : row.type === "tool_use"
      ? (typeof metadata.tool_name === "string" ? metadata.tool_name : "Tool call")
      : row.type === "tool_result"
        ? ""
        : row.type === "thinking" ? "Thought" : "";
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    type: row.type,
    role: row.role,
    content,
    position: row.position,
    timestamp: row.timestamp,
    parent_id: row.parent_id,
    metadata_json: JSON.stringify(metadata),
    dag_uuid: row.dag_uuid,
    dag_parent_uuid: row.dag_parent_uuid,
    locator: row.locator,
    details_loaded: false,
  };
}

type PositionTargetKind = "initial" | "latest" | "position" | "block" | "turn";

function turnIdForBlock(db: ReturnType<typeof getDb>, block: Pick<BlockRow, "id" | "conversation_id" | "position" | "type">): string {
  if (block.type === "user_message") return block.id;
  const first = db.prepare(
    `SELECT id
       FROM conversation_blocks
      WHERE conversation_id = ?
        AND position <= ?
        AND position > COALESCE((
          SELECT MAX(position)
            FROM conversation_blocks
           WHERE conversation_id = ? AND position <= ? AND type = 'user_message'
        ), -1)
        AND type != 'user_message'
      ORDER BY position ASC
      LIMIT 1`,
  ).get(block.conversation_id, block.position, block.conversation_id, block.position) as { id: string } | undefined;
  return first?.id ?? block.id;
}

function resolvePositionTarget(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  kind: PositionTargetKind,
  requestedValue: string | number | null,
): { block: BlockRow | null; turnId: string | null } | null {
  let block: BlockRow | undefined;
  if (kind === "initial" || kind === "latest") {
    block = db.prepare(
      "SELECT * FROM conversation_blocks WHERE conversation_id = ? ORDER BY position DESC LIMIT 1",
    ).get(conversationId) as BlockRow | undefined;
  } else if (kind === "position") {
    block = db.prepare(
      "SELECT * FROM conversation_blocks WHERE conversation_id = ? AND position = ?",
    ).get(conversationId, requestedValue) as BlockRow | undefined;
  } else {
    block = db.prepare(
      "SELECT * FROM conversation_blocks WHERE conversation_id = ? AND id = ?",
    ).get(conversationId, requestedValue) as BlockRow | undefined;
  }
  if (!block) return kind === "initial" || kind === "latest" ? { block: null, turnId: null } : null;
  const turnId = turnIdForBlock(db, block);
  if (kind === "turn" && turnId !== requestedValue) return null;
  return { block, turnId };
}

async function readAllBlocks(
  reader: ConversationSourceReader,
  conversationId: string,
): Promise<{ blocks: SourceBackedConversationBlock[]; bodySource: "source" | "legacy" }> {
  const result = await reader.readAll(conversationId);
  if (result.status !== "source" && result.status !== "legacy") {
    throw new ConversationFreshnessError("source_unavailable", result.reason);
  }
  return { blocks: result.value, bodySource: result.status };
}

function conversationRequiresSourceReader(
  db: ReturnType<typeof getDb>,
  conversationId: string,
): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM conversation_sources
     WHERE conversation_id = ?
     LIMIT 1
  `).get(conversationId));
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

/** A BlockRow after decompression — content is guaranteed to be a string. */
type DecompressedBlock = Omit<BlockRow, "content"> & { content: string };

/** Decompress a batch of BlockRows, returning rows with string content.
 *  Bug: e5a945d — used by export helpers that access block.content directly. */
function decompressBlocks(rows: BlockRow[]): DecompressedBlock[] {
  return rows.map((row) => ({
    ...row,
    content: decompressContent(row.content, row.compressed === 1),
  }));
}

// --- Export helpers ---

function exportToMarkdown(
  conversation: ConversationRow,
  blocks: DecompressedBlock[],
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
  blocks: DecompressedBlock[],
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
  blocks: DecompressedBlock[],
  blockTypes?: Set<string>,
): string {
  const filteredBlocks = blockTypes
    ? blocks.filter((b) => blockTypes.has(b.type))
    : blocks;
  return JSON.stringify(
    {
      conversation: mapConversation(conversation),
      blocks: filteredBlocks.map(mapBlock),
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
  const displaySourceReader = new ConversationSourceReader(db, { legacyFallback: false });
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
    const aliases = sessionAliasIds(resolved.resolution);
    const candidates = db.prepare(`SELECT DISTINCT c.id FROM conversations c WHERE ${
      aliases.map(() => sessionConversationsSql("c")).join(" OR ")
    } LIMIT 2`).all(...aliases.flatMap((id) => [id, id])) as Array<{ id: string }>;
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
  // On-demand sweep of the normalized index for leaked Mandible credentials.
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
      const result = backfillCredentialLeakScan(scanDb, {
        conversationId,
        limit: requestedLimit,
        record: body.record === false ? false : undefined,
      });
      const detections = new Map(result.detections.map((detection) => [detection.event_id, detection]));
      const sourceErrors: Array<{ conversation_id: string; error: string }> = [];
      let scannedSourceBlocks = 0;
      let scannedSourceConversations = 0;
      let sourceTruncated = false;
      if (!result.skipped && result.scanned_blocks < requestedLimit) {
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
        const rawReader = new ConversationSourceReader(scanDb, { legacyFallback: false, maskCredentials: false });
        for (const conversation of sourceConversations) {
          let offset = 0;
          let scannedConversation = false;
          while (result.scanned_blocks + scannedSourceBlocks < requestedLimit) {
            const take = Math.min(100, requestedLimit - result.scanned_blocks - scannedSourceBlocks);
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
          if (result.scanned_blocks + scannedSourceBlocks >= requestedLimit) break;
        }
      }
      sendJson(res, 200, {
        scanned_blocks: result.scanned_blocks + scannedSourceBlocks,
        scanned_conversations: result.scanned_conversations + scannedSourceConversations,
        truncated: result.truncated || sourceTruncated,
        skipped: result.skipped ?? null,
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
    const result = await reader.run("conversation_sidebar", { query: req.query ?? {} });
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
    const result = await reader.run("conversation_list", { query: req.query ?? {} });
    if (res.jsonText) res.status(result.status).jsonText!(result.json);
    else sendJson(res, result.status, JSON.parse(result.json));
  }, { operation: { id: "get:/api/conversations", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // GET /api/conversations/search — Search the normalized conversation index.
  server.get("/api/conversations/search", async (req, res) => {
    const result = await reader.run("conversation_search", { query: req.query ?? {} });
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
      SELECT current_version_id FROM conversation_sources
       WHERE conversation_id = ? AND current_version_id IS NOT NULL
       ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1
    `).get(id) as { current_version_id: string } | undefined;
    const version = source?.current_version_id ?? null;
    const cached = version === null ? null : getConversationStructureCache(db).readStructure(id, version);
    const dense = cached === null ? db.prepare(`
      SELECT id, position, type, role, parent_block_id, record_offset, record_length
        FROM conversation_structural_blocks
       WHERE conversation_id = ? AND status = 'current' ORDER BY position
    `).all(id) as Array<{ id: string; position: number; type: string; role: string;
      parent_block_id: string | null; record_offset: number | null; record_length: number | null }> : [];
    const densePositionById = new Map(dense.map((row) => [row.id, row.position]));
    const legacy = cached === null && dense.length === 0 ? db.prepare(`
      SELECT id, position, type, role, parent_id, length(content) AS record_length
        FROM conversation_blocks WHERE conversation_id = ? ORDER BY position
    `).all(id) as Array<{ id: string; position: number; type: string; role: string;
      parent_id: string | null; record_length: number }> : [];
    const rows = cached ?? (dense.length > 0 ? dense.map((row) => ({
      id: row.id, position: row.position, type: row.type, role: row.role,
      parent_position: row.parent_block_id ? densePositionById.get(row.parent_block_id) ?? null : null,
      record_offset: row.record_offset, record_length: row.record_length ?? 0,
    })) : legacy.map((row) => ({
      id: row.id, position: row.position, type: row.type, role: row.role,
      parent_position: null, record_offset: null, record_length: row.record_length,
    })));
    const expected = db.prepare("SELECT block_count FROM conversations WHERE id = ?")
      .get(id) as { block_count: number } | undefined;
    if (!expected) return sendJson(res, 404, { error: "Conversation not found" });
    if (rows.length !== expected.block_count) {
      return sendJson(res, 409, { error: "freshness_pending", code: "freshness_pending",
        message: "conversation structure is incomplete; retry after indexing" });
    }
    const current = db.prepare(`SELECT current_version_id FROM conversation_sources
      WHERE conversation_id = ? AND current_version_id IS NOT NULL
      ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`
    ).get(id) as { current_version_id: string } | undefined;
    if ((current?.current_version_id ?? null) !== version) {
      return sendJson(res, 409, { error: "freshness_pending", code: "freshness_pending",
        message: "conversation source changed during structure read" });
    }
    sendJson(res, 200, { conversation_id: id, source_version_id: version, total: rows.length,
      rows: rows.map((row) => ({
        id: "id" in row ? row.id : sparseConversationBlockId(id, row.position),
        position: row.position, type: row.type, role: row.role,
        parent_position: "parentPosition" in row ? row.parentPosition : row.parent_position,
        record_offset: "recordOffset" in row ? row.recordOffset : row.record_offset,
        record_length: "recordLength" in row ? row.recordLength : row.record_length,
      })) });
  }, { operation: { id: "get:/api/conversations/:id/structure", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow", refs: { params: { id: entityRefs.conversation } } });

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
    const sourceBacked = conversationRequiresSourceReader(db, id);
    const useSourceReader = displayView || sourceBacked
      || query.source_backed === "true" || query.source_backed === "1";
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
    let blocks: BlockRow[] = [];
    let readableBlocks: Array<BlockRow | SourceBackedConversationBlock> = [];
    let bodySource: "source" | "legacy" = "legacy";
    let resolvedBlock: BlockRow | SourceBackedConversationBlock | null = null;
    let resolvedTurnId: string | null = null;
    let sourceVersionId: string | null = null;
    if (useSourceReader) {
      const source = db.prepare(`
        SELECT current_version_id FROM conversation_sources
         WHERE conversation_id = ? AND current_version_id IS NOT NULL
         ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1
      `).get(id) as { current_version_id: string } | undefined;
      sourceVersionId = source?.current_version_id ?? null;
      const structureCache = getConversationStructureCache(db);
      const cachedTotal = source
        ? structureCache.blockCount(id, source.current_version_id)
        : null;
      const retainedStructuralTotal = (db.prepare(`
        SELECT COUNT(*) AS total FROM conversation_structural_blocks
         WHERE conversation_id = ? AND status = 'current'
      `).get(id) as { total: number }).total;
      const retainedLegacyTotal = (db.prepare(`
        SELECT COUNT(*) AS total FROM conversation_blocks
         WHERE conversation_id = ? AND payload_state = 'legacy'
      `).get(id) as { total: number }).total;
      // A projected or retention-bounded database can preserve the conversation's
      // logical block_count while retaining only a readable tail. Page offsets are
      // ordinals within the retained representation, not global block positions.
      const retainedTotal = Math.max(cachedTotal ?? 0, retainedStructuralTotal, retainedLegacyTotal);
      if (cachedTotal !== null) total = cachedTotal;
      if (query.limit === undefined && (targetKind === "initial" || targetKind === "latest")
          && source && cachedTotal !== null && cachedTotal === retainedTotal && total > 0) {
        const turnStart = structureCache.turnWindowStart(id, source.current_version_id, total - 1);
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
        const densePosition = sparsePosition === null && typeof requestedValue === "string"
          ? db.prepare(`
              SELECT position FROM conversation_structural_blocks
               WHERE conversation_id = ? AND status = 'current'
                 AND id = COALESCE((
                   SELECT block_id FROM conversation_block_aliases WHERE alias = ?
                 ), ?)
            `).get(id, requestedValue, requestedValue) as { position: number } | undefined
          : undefined;
        anchorPosition = sparsePosition ?? densePosition?.position ?? null;
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
        .readPage(id, { offset: windowOffset, limit });
      if (sourcePage.status !== "source" && sourcePage.status !== "legacy") {
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
      readableBlocks = sourcePage.value.blocks;
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
        ? structureCache.turnPosition(id, source.current_version_id, anchorPosition)
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
    } else {
      const resolved = resolvePositionTarget(db, id, targetKind, requestedValue);
      if (!resolved) {
        sendJson(res, 404, { error: `${targetKind === "turn" ? "Turn" : targetKind === "block" ? "Block" : "Position"} anchor not found` });
        return;
      }
      total = (db.prepare(
        "SELECT COUNT(*) AS total FROM conversation_blocks WHERE conversation_id = ?",
      ).get(id) as { total: number }).total;
      resolvedBlock = resolved.block;
      resolvedTurnId = resolved.turnId;
      if (resolved.block) {
        if (targetKind === "initial" || targetKind === "latest") {
          if (query.limit === undefined) {
            const turnStart = db.prepare(`
              SELECT MAX(position) AS position FROM conversation_blocks
               WHERE conversation_id = ? AND position <= ? AND type = 'user_message'
            `).get(id, resolved.block.position) as { position: number | null };
            const firstPosition = turnStart.position ?? (db.prepare(`
              SELECT MIN(position) AS position FROM conversation_blocks
               WHERE conversation_id = ? AND position <= ?
            `).get(id, resolved.block.position) as { position: number | null }).position;
            const completeTurnSize = firstPosition === null ? null : (db.prepare(`
              SELECT COUNT(*) AS total FROM conversation_blocks
               WHERE conversation_id = ? AND position >= ? AND position <= ?
            `).get(id, firstPosition, resolved.block.position) as { total: number }).total;
            if (completeTurnSize !== null && completeTurnSize <= 500) {
              limit = Math.max(limit, completeTurnSize);
            }
          }
          blocks = db.prepare(
            `SELECT * FROM (
               SELECT * FROM conversation_blocks
                WHERE conversation_id = ?
                ORDER BY position DESC LIMIT ?
             ) ORDER BY position ASC`,
          ).all(id, limit) as BlockRow[];
        } else {
          const before = Math.floor((limit - 1) / 2);
          const start = db.prepare(
            `SELECT position FROM conversation_blocks
              WHERE conversation_id = ? AND position <= ?
              ORDER BY position DESC LIMIT 1 OFFSET ?`,
          ).get(id, resolved.block.position, before) as { position: number } | undefined;
          const first = start ?? db.prepare(
            "SELECT MIN(position) AS position FROM conversation_blocks WHERE conversation_id = ?",
          ).get(id) as { position: number };
          blocks = db.prepare(
            `SELECT * FROM conversation_blocks
              WHERE conversation_id = ? AND position >= ?
              ORDER BY position ASC LIMIT ?`,
          ).all(id, first.position, limit) as BlockRow[];
        }
      }
      readableBlocks = blocks;
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
    const mapped = useSourceReader
      ? mapConversation(maskSourceBackedConversationRow(conv), externalNavigation)
      : mapConversation(conv, externalNavigation);
    mapped.children_count = children.length;
    const hasBefore = startPosition !== null && (useSourceReader
      ? startPosition > 0
      : Boolean(db.prepare(`SELECT 1 FROM conversation_blocks
          WHERE conversation_id = ? AND position < ? LIMIT 1`).get(id, startPosition)));
    const afterCount = endPosition === null
      ? 0
      : useSourceReader
        ? Math.max(0, total - endPosition - 1)
        : (db.prepare(`SELECT COUNT(*) AS count FROM conversation_blocks
            WHERE conversation_id = ? AND position > ?`).get(id, endPosition) as { count: number }).count;

    sendJson(res, 200, {
      conversation: mapped,
      body_source: bodySource,
      source_version_id: sourceVersionId,
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
        ? projectDisplayBlock(mapReadableBlock(block) as SourceBackedConversationBlock)
        : mapReadableBlock(block)),
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

    const sourceBacked = conversationRequiresSourceReader(db, id);
    if (sourceBacked) {
      const read = await sourceReader.readAll(id);
      if (read.status !== "source" && read.status !== "legacy") {
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

    const hasStructuralForkRows = Boolean(db.prepare(`
      SELECT 1 FROM conversation_structural_blocks
       WHERE conversation_id = ? AND status = 'current' LIMIT 1
    `).get(id));
    const forkTable = hasStructuralForkRows ? "conversation_structural_blocks" : "conversation_blocks";
    const forkStatus = hasStructuralForkRows ? "AND status = 'current'" : "";

    // Find fork points: dag_parent_uuid values with multiple distinct dag_uuid children
    const forkPoints = db
      .prepare(
        `SELECT dag_parent_uuid, COUNT(DISTINCT dag_uuid) as branch_count
         FROM ${forkTable}
         WHERE conversation_id = ? ${forkStatus} AND dag_parent_uuid IS NOT NULL
         GROUP BY dag_parent_uuid
         HAVING COUNT(DISTINCT dag_uuid) > 1`
      )
      .all(id) as Array<{ dag_parent_uuid: string; branch_count: number }>;

    const forkParentUuids = new Set(forkPoints.map((fp) => fp.dag_parent_uuid));
    const childRows = db
      .prepare(
        `SELECT dag_parent_uuid, dag_uuid
         FROM ${forkTable}
         WHERE conversation_id = ? ${forkStatus} AND dag_parent_uuid IS NOT NULL AND dag_uuid IS NOT NULL
         GROUP BY dag_parent_uuid, dag_uuid
         ORDER BY MIN(position) ASC`,
      )
      .all(id) as Array<{ dag_parent_uuid: string; dag_uuid: string }>;

    const previewRows = db
      .prepare(
        `SELECT dag_parent_uuid, dag_uuid, id${hasStructuralForkRows ? "" : ", content, compressed"}
         FROM (
           SELECT dag_parent_uuid, dag_uuid, id${hasStructuralForkRows ? "" : ", content, compressed"},
                  ROW_NUMBER() OVER (
                    PARTITION BY dag_parent_uuid, dag_uuid
                    ORDER BY position ASC
                  ) AS rn
             FROM ${forkTable}
            WHERE conversation_id = ?
              ${forkStatus}
              AND dag_parent_uuid IS NOT NULL
              AND dag_uuid IS NOT NULL
              AND type IN ('assistant_message', 'assistant')
         )
         WHERE rn = 1`,
      )
      .all(id) as Array<{
        dag_parent_uuid: string;
        dag_uuid: string;
        id: string;
        content?: Buffer | string;
        compressed?: number;
      }>;

    const countRows = db
      .prepare(
        `SELECT dag_uuid, COUNT(*) as cnt
         FROM ${forkTable}
         WHERE conversation_id = ? ${forkStatus} AND dag_uuid IS NOT NULL
         GROUP BY dag_uuid`,
      )
      .all(id) as Array<{ dag_uuid: string; cnt: number }>;

    const previews = new Map<string, string>();
    await Promise.all(previewRows
      .filter((row) => forkParentUuids.has(row.dag_parent_uuid))
      .map(async (row) => {
        if (!hasStructuralForkRows) {
          const text = await decompressContentAsync(row.content ?? "", row.compressed === 1);
          previews.set(`${row.dag_parent_uuid}\0${row.dag_uuid}`, text.slice(0, 60));
          return;
        }
        const read = await sourceReader.readBlock(row.id);
        if (read.status === "source" || read.status === "legacy") {
          previews.set(`${row.dag_parent_uuid}\0${row.dag_uuid}`, read.value.content.slice(0, 60));
        }
      }));

    const blockCounts = new Map(countRows.map((row) => [row.dag_uuid, row.cnt]));
    const childUuidsByParent = new Map<string, string[]>();
    for (const child of childRows) {
      if (!forkParentUuids.has(child.dag_parent_uuid)) continue;
      const children = childUuidsByParent.get(child.dag_parent_uuid) ?? [];
      children.push(child.dag_uuid);
      childUuidsByParent.set(child.dag_parent_uuid, children);
    }

    const forks = forkPoints.map((fp) => ({
      parent_dag_uuid: fp.dag_parent_uuid,
      branches: (childUuidsByParent.get(fp.dag_parent_uuid) ?? []).map((dagUuid) => ({
        dag_uuid: dagUuid,
        first_text: previews.get(`${fp.dag_parent_uuid}\0${dagUuid}`) ?? "",
        block_count: blockCounts.get(dagUuid) ?? 0,
      })),
    }));

    sendJson(res, 200, { forks });
  }, { operation: { id: "get:/api/conversations/:id/forks", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow", refs: { params: { id: entityRefs.conversation } } });

  // POST /api/conversations/:id/fork — Fork a conversation at a specific message
  // Bug: 40f0298 — DAG branching: create a new session by forking at a message
  server.post("/api/conversations/:id/fork", operatorOnlyManagedSessionRoute(async (req, res) => {
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
    const useSourceReader = (query.source_backed !== "false" && query.source_backed !== "0")
      || conversationRequiresSourceReader(db, id);
    if (!useSourceReader) {
      const params: unknown[] = [id];
      const conditions = ["conversation_id = ?"];
      if (types && types.length > 0) {
        conditions.push(`type IN (${types.map(() => "?").join(",")})`);
        params.push(...types);
      }
      const where = conditions.join(" AND ");
      const total = (db.prepare(`SELECT COUNT(*) AS total FROM conversation_blocks WHERE ${where}`)
        .get(...params) as { total: number }).total;
      const blocks = db.prepare(`
        SELECT * FROM conversation_blocks WHERE ${where}
         ORDER BY position ASC LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as BlockRow[];
      sendJson(res, 200, {
        blocks: blocks.map(mapBlock),
        body_source: "legacy",
        total,
        offset,
        page: Math.floor(offset / limit) + 1,
        limit,
        requested_limit: requestedLimit,
        cap: 500,
        pages: Math.ceil(total / limit),
        truncated: offset + blocks.length < total,
      });
      return;
    }

    const result = await sourceReader.readPage(id, { offset, limit, types });
    if (result.status !== "source" && result.status !== "legacy") {
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
      source_backed?: boolean;
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

    let readable: Awaited<ReturnType<typeof readAllBlocks>> | null = null;
    const useSourceReader = body.source_backed !== false
      || conversationRequiresSourceReader(db, id);
    if (useSourceReader) {
      try {
        readable = await readAllBlocks(sourceReader, id);
      } catch (error) {
        if (sendFreshnessError(res, error)) return;
        sendJson(res, 503, { error: "freshness_error", message: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    const blocks = readable
      ? readable.blocks.map((block) => ({ ...block, compressed: 0 })) as DecompressedBlock[]
      : decompressBlocks(db.prepare(
        "SELECT * FROM conversation_blocks WHERE conversation_id = ? ORDER BY position ASC",
      ).all(id) as BlockRow[]);

    const blockTypes = body.block_types ? new Set(body.block_types) : undefined;

    let output: string;
    let contentType: string;

    const exportConversation = useSourceReader
      ? maskSourceBackedConversationRow(conv)
      : conv;

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
      body_source: readable?.bodySource ?? "legacy",
    });
  }, { operation: { id: "post:/api/conversations/:id/export", effects: ["files:production"], requestSchema: null, reportingCategory: "conversations" }, fileRpc: "allow", refs: { params: { id: entityRefs.conversation } } });

}
